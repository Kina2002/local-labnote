"""Focused tests for the AI access boundary and local record flow."""

import base64
import http.client
import io
import json
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import zipfile
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

import pymupdf
from PIL import Image

import server


def paper_provider_fixture(url, headers=None):
    """Three independent lookup paths with overlap and an upstream error."""
    request = urllib.parse.urlsplit(url)
    item = {
        "DOI": "10.1234/COATING", "title": ["Waterborne self-healing coating"],
        "author": [{"given": "A", "family": "River"}], "published": {"date-parts": [[2024]]},
        "container-title": ["Coatings Research"],
        "abstract": "<jats:p>Methods and results for polyurethane coatings.</jats:p>",
    }
    if request.hostname == "api.crossref.org":
        query = urllib.parse.parse_qs(request.query)["query.bibliographic"][0]
        if query == "offline coating":
            raise urllib.error.HTTPError(url, 429, "rate limited", {}, None)
        if query == "scratch recovery":
            item = {**item, "DOI": "https://doi.org/10.1234/coating"}
        return {"message": {"items": [item]}}
    direction = request.path.rsplit("/", 1)[-1]
    item = {
        "paperId": "a" * 40, "title": "Coating recovery methods", "year": 2025,
        "authors": [{"name": "B Lee"}], "externalIds": {"DOI": "10.1234/RELATED"},
    }
    return {"data": [
        {"citedPaper" if direction == "references" else "citingPaper": item}
    ]}


class NotebookTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old = server.DB, server.FILES
        server.DB = Path(self.temp.name) / "labnote.sqlite3"
        server.FILES = Path(self.temp.name) / "files"
        server.init_db()
        self.experiment = server.create_experiment("비공개 실험 제목", "2026-11-19")
        self.id = self.experiment["id"]

    def tearDown(self):
        server.DB, server.FILES = self.old
        self.temp.cleanup()

    def test_book_and_experiment_plans_are_independent_and_editable(self):
        book = server.create_notebook('표면 연구')
        first = server.create_experiment('첫 실험', '', book['id'])
        second = server.create_experiment('둘째 실험', '', book['id'])
        book_plan = server.get_planning('notebook_id', book['id'])
        experiment_plan = first['planning']
        self.assertEqual(len(book_plan['blocks']), 5)
        self.assertEqual(len(experiment_plan['blocks']), 4)
        self.assertEqual(first['experiment_date'], '')
        self.assertEqual(first['start_time'], '')
        book_block = book_plan['blocks'][0]['id']
        experiment_block = experiment_plan['blocks'][0]['id']
        server.change_planning('notebook_id', book['id'], {'content': '공통 연구 목적'}, book_block)
        server.change_planning('experiment_id', first['id'], {'content': '지난 결과를 바꿔 볼 이유'}, experiment_block)
        self.assertEqual(server.get_planning('notebook_id', book['id'])['blocks'][0]['content'], '공통 연구 목적')
        self.assertEqual(server.get_experiment(first['id'])['planning']['blocks'][0]['content'], '지난 결과를 바꿔 볼 이유')
        self.assertEqual(server.get_experiment(second['id'])['planning']['blocks'][0]['content'], '')
        self.assertEqual(server.get_experiment(first['id'])['sections']['references']['content'], '')
        self.assertEqual([row['id'] for row in server.list_experiments(notebook_id=book['id'], query='지난 결과')], [first['id']])

    def test_book_design_default_forms_can_be_edited_and_repeated(self):
        book = server.create_notebook('관절 드레싱 연구')
        blocks = server.get_planning('notebook_id', book['id'])['blocks']
        self.assertEqual([block['title'] for block in blocks], server.BOOK_PLAN_TITLES)
        self.assertEqual(server.BOOK_PLAN_TITLES, ['연구 배경·문제', '연구 목적·질문', '자료조사', '가설·아이디어', '평가·판단 기준'])
        self.assertEqual([field['label'] for field in blocks[0]['form']['groups'][0]['fields']],
                         ['연구를 시작한 배경', '해결하거나 이해할 문제', '확인된 사실', '아직 모르는 점'])
        self.assertEqual([field['label'] for field in blocks[2]['form']['groups'][0]['fields']],
                         ['자료명·출처', '핵심 내용', '연구와의 관련성', '자료의 한계'])
        self.assertTrue(all(block['form']['groups'] for block in blocks))
        background = blocks[0]
        form = json.loads(json.dumps(background['form']))
        form['groups'][0]['fields'][0]['label'] = '해결하려는 상황'
        form['groups'][0]['fields'][0]['value'] = '관절을 굽힐 때 소재 균열'
        form['groups'][0]['fields'].pop()
        form['groups'][0]['fields'].append({'id': server.uuid.uuid4().hex, 'label': '추가 질문', 'kind': 'long', 'value': '들뜸도 조사'})
        saved = server.change_planning('notebook_id', book['id'], {'form': form}, background['id'])
        self.assertEqual(saved['blocks'][0]['form'], form)
        literature = blocks[2]
        repeated = json.loads(json.dumps(literature['form']))
        repeated['groups'].append({'id': server.uuid.uuid4().hex, 'title': '자료 2',
                                   'fields': [{'id': server.uuid.uuid4().hex, 'label': field['label'], 'kind': field['kind'], 'value': ''}
                                              for field in repeated['template']]})
        server.change_planning('notebook_id', book['id'], {'form': repeated}, literature['id'])
        server.change_planning('notebook_id', book['id'], {'ai_allowed': True}, background['id'])
        item = next(item for item in server.selectable_book_ai_items(book['id']) if item['id'] == f"plan:{background['id']}")
        self.assertIn('해결하려는 상황: 관절을 굽힐 때 소재 균열', item['text'])
        self.assertIn('추가 질문: 들뜸도 조사', item['text'])
        server.init_db()
        self.assertEqual(len(server.get_planning('notebook_id', book['id'])['blocks']), 5)
        self.assertEqual(len(server.get_planning('notebook_id', book['id'])['blocks'][2]['form']['groups']), 2)
        with self.assertRaises(ValueError):
            server.change_planning('notebook_id', book['id'], {'form': {'mode': [], 'repeat_label': '', 'template': [], 'groups': []}}, background['id'])

    def test_subject_specific_form_upgrade_preserves_written_and_custom_fields(self):
        book = server.create_notebook('기존 양식을 쓰는 연구')
        blocks = server.get_planning('notebook_id', book['id'])['blocks']

        def old_form(labels, mode='single', repeat_label=''):
            fields = [{'id': server.uuid.uuid4().hex, 'label': label, 'kind': 'long', 'value': ''} for label in labels]
            return {'mode': mode, 'repeat_label': repeat_label,
                    'template': [{'label': label, 'kind': 'long'} for label in labels],
                    'groups': [{'id': server.uuid.uuid4().hex, 'title': f'{repeat_label} 1' if repeat_label else '', 'fields': fields}]}

        background = old_form(['해결하고 싶은 상황', '갈라짐·들뜸 중 관찰한 문제', '직접 확인한 사실', '아직 추측인 점'])
        background['groups'][0]['fields'][0].update(label='내가 정한 질문', value='직접 쓴 내용')
        background['groups'][0]['fields'][1]['value'] = '관찰한 현상'
        references = old_form(['자료명·DOI·주소', '원문 확인 여부', '사용한 소재', '시험 조건',
                               '측정한 성능', '결과', '우리 연구와의 관련성·한계'], 'repeat', '자료')
        references['groups'][0]['fields'][2]['value'] = '기존에 기록한 재료'
        references['groups'][0]['fields'][5]['value'] = '핵심 결과'
        references['groups'][0]['fields'].append({'id': server.uuid.uuid4().hex, 'label': '나의 추가 칸',
                                                  'kind': 'short', 'value': '추가 기록'})
        ideas = old_form(['아이디어', '어떤 문제에 도움이 될까', '그렇게 생각하는 이유',
                          '근거 자료', '우려되는 점', '확인할 방법'], 'repeat', '아이디어')
        evaluation = old_form(['평가할 성능', '왜 필요한지', '측정 방법 후보', '비교 대상', '목표값의 근거'],
                              'repeat', '성능 항목')
        with server.connect() as db:
            for block, title, form in [(blocks[0], '연구 배경·문제', background),
                                       (blocks[2], '자료조사', references),
                                       (blocks[3], '가설·소재 아이디어', ideas),
                                       (blocks[4], '필요 성능·평가 기준', evaluation)]:
                db.execute('UPDATE planning_blocks SET title=?,form_json=? WHERE id=?',
                           (title, json.dumps(form, ensure_ascii=False), block['id']))
            db.execute("DELETE FROM app_settings WHERE key='book_design_form_v2'")
        server.init_db()
        migrated = server.get_planning('notebook_id', book['id'])['blocks']
        self.assertEqual([block['title'] for block in migrated], server.BOOK_PLAN_TITLES)
        bg_fields = migrated[0]['form']['groups'][0]['fields']
        self.assertEqual((bg_fields[0]['label'], bg_fields[0]['value']), ('내가 정한 질문', '직접 쓴 내용'))
        self.assertEqual((bg_fields[1]['label'], bg_fields[1]['value']), ('해결하거나 이해할 문제', '관찰한 현상'))
        ref_fields = migrated[2]['form']['groups'][0]['fields']
        self.assertIn(('다룬 대상·재료', '기존에 기록한 재료'), [(field['label'], field['value']) for field in ref_fields])
        self.assertIn(('핵심 내용', '핵심 결과'), [(field['label'], field['value']) for field in ref_fields])
        self.assertIn(('나의 추가 칸', '추가 기록'), [(field['label'], field['value']) for field in ref_fields])
        self.assertNotIn('조사·시험 조건', [field['label'] for field in ref_fields])
        self.assertIn('자료의 한계', [field['label'] for field in ref_fields])
        self.assertEqual([field['label'] for field in migrated[2]['form']['template']],
                         ['자료명·출처', '핵심 내용', '연구와의 관련성', '자료의 한계'])
        self.assertEqual(migrated[4]['form']['groups'][0]['title'], '평가 항목 1')
        server.init_db()
        self.assertEqual(server.get_planning('notebook_id', book['id'])['blocks'], migrated)

    def test_legacy_book_notes_survive_form_upgrade(self):
        book = server.create_notebook('기존 연구')
        with server.connect() as db:
            db.execute("DELETE FROM planning_blocks WHERE notebook_id=?", (book['id'],))
            db.execute("DELETE FROM app_settings WHERE key='book_design_form_v1'")
            stamp = server.now()
            for order, (title, content) in enumerate([('연구 목적·질문', '기존 목적'), ('배경·자료 조사', '예전 자료 메모'), ('전체 가설·아이디어', '')]):
                db.execute("INSERT INTO planning_blocks(id,notebook_id,title,content,form_json,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                           (server.uuid.uuid4().hex, book['id'], title, content, '{}', order * 10, stamp, stamp))
        server.init_db()
        blocks = server.get_planning('notebook_id', book['id'])['blocks']
        self.assertEqual(len(blocks), 6)
        self.assertEqual(next(block for block in blocks if block['title'] == '배경·자료 조사')['content'], '예전 자료 메모')
        self.assertTrue(next(block for block in blocks if block['title'] == '연구 목적·질문')['form']['groups'])
        self.assertTrue(next(block for block in blocks if block['title'] == '연구 배경·문제')['form']['groups'])

    def test_planning_layout_collapse_restore_and_actual_times(self):
        self.assertEqual(server.get_experiment(self.id)['start_time'], '')
        block = self.experiment['planning']['blocks'][0]['id']
        server.change_planning('experiment_id', self.id, {'width': 55, 'min_height': 200, 'pos_x': 30, 'pos_y': 140, 'event_at': '2026-11-18T14:45'}, block)
        server.change_planning('experiment_id', self.id, {'collapsed': True})
        server.change_planning('experiment_id', self.id, {'removed': 1}, block)
        server.init_db()
        plan = server.get_experiment(self.id)['planning']
        self.assertTrue(plan['collapsed'])
        self.assertEqual((plan['blocks'][0]['width'], plan['blocks'][0]['pos_x'], plan['blocks'][0]['pos_y']), (55, 30, 140))
        self.assertEqual(plan['blocks'][0]['event_at'], '2026-11-18T14:45')
        self.assertEqual(plan['blocks'][0]['removed'], 1)
        self.assertEqual(len(plan['blocks']), 4)
        server.change_planning('experiment_id', self.id, {'removed': 0}, block)
        self.assertEqual(server.get_experiment(self.id)['planning']['blocks'][0]['removed'], 0)
        server.update_experiment(self.id, {'experiment_date': '2026-11-19', 'start_time': '09:30'})
        server.update_section(self.id, 'results', {'event_at': '2026-11-21T16:10'})
        created = server.create_record_block(self.id, {'kind': 'memo', 'content': '늦게 확인한 내용'})
        memo_id = created['blocks'][-1]['id']
        server.update_record_block(self.id, memo_id, {'event_at': '2026-11-22'})
        record = server.get_experiment(self.id)
        self.assertEqual(record['start_time'], '09:30')
        self.assertEqual(record['sections']['results']['event_at'], '2026-11-21T16:10')
        self.assertEqual(record['blocks'][-1]['event_at'], '2026-11-22')
        with self.assertRaises(ValueError):
            server.update_experiment(self.id, {'experiment_date': '', 'start_time': '09:30'})
        with self.assertRaises(ValueError):
            server.change_planning('experiment_id', self.id, {'width': 80, 'pos_x': 30}, block)

    def test_archived_planning_is_read_only_and_delete_cleans_blocks(self):
        book = server.create_notebook('보관할 연구')
        experiment = server.create_experiment('보관할 실험', '', book['id'])
        server.archive_experiment(experiment['id'])
        with self.assertRaises(ValueError):
            server.change_planning('experiment_id', experiment['id'], {'title': '추가'})
        server.set_notebook_archived(book['id'], True)
        with self.assertRaises(ValueError):
            server.change_planning('notebook_id', book['id'], {'title': '추가'})
        server.delete_notebook(book['id'], book['title'])
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM planning_blocks WHERE notebook_id=? OR experiment_id=?', (book['id'], experiment['id'])).fetchone()[0], 0)

    def test_book_and_experiment_design_are_separate_ai_sources(self):
        book_id = 'personal'
        book_block = server.get_planning('notebook_id', book_id)['blocks'][0]['id']
        experiment_block = self.experiment['planning']['blocks'][0]['id']
        server.change_planning('notebook_id', book_id, {'content': '책_연구_질문'}, book_block)
        server.change_planning('experiment_id', self.id, {'content': '이번_실험_가설'}, experiment_block)
        catalog = server.ai_source_catalog(book_id)['records']
        book = next(record for record in catalog if record['scope'] == 'book')
        experiment = next(record for record in catalog if record['id'] == self.id)
        self.assertFalse(book['items'][0]['allowed'])
        self.assertEqual(book['items'][0]['excerpt'], '')
        self.assertFalse(next(item for item in experiment['items'] if item['id'] == f'plan:{experiment_block}')['allowed'])
        with self.assertRaisesRegex(ValueError, '잠겼거나 삭제된'):
            server.build_selected_ai_messages([{'notebook_id': book_id, 'items': [f'plan:{book_block}']}], '연구 질문은?')
        server.change_planning('notebook_id', book_id, {'ai_allowed': True}, book_block)
        server.change_planning('experiment_id', self.id, {'ai_allowed': True}, experiment_block)
        selections = [
            {'notebook_id': book_id, 'items': [f'plan:{book_block}']},
            {'experiment_id': self.id, 'items': [f'plan:{experiment_block}']},
        ]
        messages, preview = server.build_selected_ai_messages(selections, '대조군을 점검해 줘')
        prompt = messages[1]['content'][0]['text']
        self.assertIn('책_연구_질문', prompt)
        self.assertIn('이번_실험_가설', prompt)
        self.assertEqual((len(preview['records']), preview['item_count']), (2, 2))
        http_preview = self.paper_request('/api/ai-selection-preview', {'selections': selections, 'question': '대조군을 점검해 줘'})
        self.assertEqual(http_preview['item_count'], 2)
        server.change_planning('experiment_id', self.id, {'removed': 1}, experiment_block)
        self.assertFalse(server.get_experiment(self.id)['planning']['blocks'][0]['ai_allowed'])
        with self.assertRaisesRegex(ValueError, '잠겼거나 삭제된'):
            server.build_selected_ai_messages(selections, '대조군을 점검해 줘')

    def test_paper_reference_can_append_to_book_or_experiment_design(self):
        book_id = 'personal'
        book_block = server.get_planning('notebook_id', book_id)['blocks'][1]['id']
        experiment_block = self.experiment['planning']['blocks'][-1]['id']
        server.change_planning('notebook_id', book_id, {'content': '책 자료 조사'}, book_block)
        server.change_planning('experiment_id', self.id, {'content': '실험 자료 조사'}, experiment_block)
        self.paper_request(f'/api/notebooks/{book_id}/planning/{book_block}/append-reference', {'draft': '논문 A'})
        server.append_planning_reference('experiment_id', self.id, experiment_block, '논문 B')
        self.assertEqual(server.get_planning('notebook_id', book_id)['blocks'][1]['content'], '책 자료 조사\n\n논문 A')
        self.assertEqual(server.get_experiment(self.id)['planning']['blocks'][-1]['content'], '실험 자료 조사\n\n논문 B')
        self.assertEqual(server.get_experiment(self.id)['sections']['references']['content'], '')
        server.append_planning_reference('notebook_id', book_id, book_block, '논문 A')
        self.assertEqual(server.get_planning('notebook_id', book_id)['blocks'][1]['content'].count('논문 A'), 1)

    def test_section_layout_persists_and_deleted_block_can_be_restored(self):
        server.update_section(self.id, 'results', {'content': '측정값 12'})
        attachment = server.save_attachment(self.id, {'section_key': 'results', 'name': 'values.csv', 'data': base64.b64encode(b'x,y\n1,12\n').decode()})
        file_id = attachment['attachments'][0]['id']
        server.change_section_layout(self.id, {'key': 'results', 'width': 57, 'min_height': 287, 'pos_x': 31, 'pos_y': 425})
        order = [key for key, _ in server.SECTION_LABELS]
        order.remove('results')
        order.insert(0, 'results')
        server.change_section_layout(self.id, {'order': order})
        deleted = server.change_section_layout(self.id, {'key': 'results', 'removed': 1})
        self.assertEqual(deleted['sections']['results']['content'], '측정값 12')
        self.assertEqual(deleted['attachments'][0]['id'], file_id)
        self.assertEqual(deleted['sections']['results']['removed'], 1)
        self.assertEqual(deleted['sections']['results']['width'], 57)
        self.assertEqual(deleted['sections']['results']['min_height'], 287)
        self.assertEqual(deleted['sections']['results']['pos_x'], 31)
        self.assertEqual(deleted['sections']['results']['pos_y'], 425)
        self.assertEqual(deleted['sections']['results']['sort_order'], 10)
        restored = server.change_section_layout(self.id, {'key': 'results', 'shown': 1, 'removed': 0})
        self.assertEqual(restored['sections']['results']['content'], '측정값 12')
        self.assertEqual(restored['attachments'][0]['id'], file_id)
        self.assertEqual(restored['sections']['results']['removed'], 0)
        self.assertEqual(restored['sections']['results']['shown'], 1)

    def test_section_layout_rejects_bad_values_and_archived_records(self):
        for payload in ({'key': 'results', 'width': 5}, {'key': 'results', 'min_height': -1},
                        {'key': 'results', 'width': 70, 'pos_x': 50},
                        {'order': ['results']}, {'key': 'unknown', 'shown': 1},
                        {'layout': [{'key': 'results', 'width': 50, 'min_height': 100, 'pos_x': 60, 'pos_y': 0}]}):
            with self.assertRaises(ValueError):
                server.change_section_layout(self.id, payload)
        moved = server.change_section_layout(self.id, {'layout': [
            {'key': 'results', 'width': 43, 'min_height': 333, 'pos_x': 55, 'pos_y': 518},
            {'key': 'purpose', 'width': 100, 'min_height': 0, 'pos_x': 0, 'pos_y': 0},
        ]})
        self.assertEqual((moved['sections']['results']['width'], moved['sections']['results']['pos_x'], moved['sections']['results']['pos_y']), (43, 55, 518))
        server.archive_experiment(self.id)
        with self.assertRaises(ValueError):
            server.change_section_layout(self.id, {'key': 'results', 'shown': 1})

    def test_delete_and_vertical_compaction_save_together(self):
        first = server.create_record_block(self.id, {'kind': 'section', 'category': 'conditions'})['blocks'][0]
        second = server.create_record_block(self.id, {'kind': 'section', 'category': 'results'})['blocks'][1]
        server.change_section_layout(self.id, {'key': second['id'], 'width': 50, 'pos_x': 50, 'pos_y': 330})
        result = server.change_section_layout(self.id, {'key': first['id'], 'removed': 1, 'layout': [
            {'key': second['id'], 'width': 50, 'min_height': 0, 'pos_x': 50, 'pos_y': 110},
        ]})
        self.assertEqual(result['blocks'][0]['removed'], 1)
        self.assertEqual((result['blocks'][1]['pos_x'], result['blocks'][1]['width'], result['blocks'][1]['pos_y']), (50, 50, 110))
        with self.assertRaises(ValueError):
            server.change_section_layout(self.id, {'key': second['id'], 'removed': 1, 'layout': [
                {'key': second['id'], 'width': 50, 'min_height': 0, 'pos_x': 50, 'pos_y': 0},
            ]})
        self.assertEqual(server.get_experiment(self.id)['blocks'][1]['removed'], 0)

    def test_old_section_table_gains_free_layout_columns(self):
        legacy_db = Path(self.temp.name) / 'legacy.sqlite3'
        with closing(sqlite3.connect(legacy_db)) as db:
            db.execute("CREATE TABLE sections (experiment_id TEXT NOT NULL, key TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', ai_allowed INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY (experiment_id,key))")
            db.execute("CREATE TABLE attachments (id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL, section_key TEXT NOT NULL, original_name TEXT NOT NULL, stored_name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, ai_allowed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)")
            db.commit()
        server.DB = legacy_db
        server.init_db()
        with server.connect() as db:
            columns = {row['name'] for row in db.execute('PRAGMA table_info(sections)')}
            attachment_columns = {row['name'] for row in db.execute('PRAGMA table_info(attachments)')}
        self.assertTrue({'shown', 'removed', 'width', 'min_height', 'pos_x', 'pos_y', 'sort_order'} <= columns)
        self.assertIn('block_id', attachment_columns)

    def test_independent_blocks_keep_category_content_and_attachments(self):
        first = server.create_record_block(self.id, {'kind': 'memo', 'category': 'conditions', 'title': '조건 A'})['blocks'][0]
        second = server.create_record_block(self.id, {'kind': 'memo', 'category': 'conditions', 'title': '조건 B'})['blocks'][1]
        drawing = server.create_record_block(self.id, {'kind': 'drawing', 'category': 'results'})['blocks'][2]
        reference = server.create_record_block(self.id, {'kind': 'reference', 'category': 'references', 'title': '관련 논문', 'url': '10.3390/ijms24032575'})['blocks'][3]
        self.assertNotEqual(first['id'], second['id'])
        self.assertEqual(reference['url'], 'https://doi.org/10.3390/ijms24032575')
        updated = server.update_record_block(self.id, first['id'], {'content': '온도 25도', 'ai_allowed': True})
        self.assertEqual(updated['blocks'][0]['content'], '온도 25도')
        self.assertIn('조건 A', server.ai_preview(self.id)['sections'])
        self.assertEqual(server.list_experiments(query='온도 25도')[0]['id'], self.id)
        payload = self.drawing_payload()
        payload['block_id'] = drawing['id']
        attached = server.save_drawing(self.id, payload)
        self.assertEqual(attached['attachments'][0]['block_id'], drawing['id'])
        self.assertEqual(attached['attachments'][0]['editable_drawing'], 1)
        removed = server.change_section_layout(self.id, {'key': drawing['id'], 'removed': 1})
        self.assertEqual(removed['blocks'][2]['removed'], 1)
        self.assertEqual(removed['attachments'][0]['block_id'], drawing['id'])
        restored = server.change_section_layout(self.id, {'key': drawing['id'], 'shown': 1, 'removed': 0})
        self.assertEqual(restored['blocks'][2]['removed'], 0)

    def test_reference_block_rejects_unsafe_link(self):
        with self.assertRaises(ValueError):
            server.create_record_block(self.id, {'kind': 'reference', 'url': 'javascript:alert(1)'})
        with self.assertRaises(ValueError):
            server.create_record_block(self.id, {'kind': 'memo', 'category': 'unknown'})

    def test_record_categories_create_repeatable_section_blocks(self):
        first = server.create_record_block(self.id, {'kind': 'section', 'category': 'conditions'})['blocks'][0]
        second = server.create_record_block(self.id, {'kind': 'section', 'category': 'conditions'})['blocks'][1]
        self.assertEqual((first['title'], second['title']), ('조건', '조건'))
        self.assertNotEqual(first['id'], second['id'])
        saved = server.update_record_block(self.id, second['id'], {'content': '온도 25°C'})
        self.assertEqual(saved['blocks'][1]['content'], '온도 25°C')
        with self.assertRaises(ValueError):
            server.create_record_block(self.id, {'kind': 'section', 'category': 'general'})

    def test_paper_search_api_sends_only_selected_queries_and_merges_dois(self):
        with patch.object(server.literature, "get_json", side_effect=paper_provider_fixture) as provider:
            with patch.object(server, "request_local_model", side_effect=ValueError):
                result = self.paper_request("/api/papers/suggest", {
                    "question": "상온에서 흠집이 회복되는 투명 수계 폴리우레탄 코팅",
                })
            self.assertGreaterEqual(len(result["queries"]), 2)
            provider.assert_not_called()
            self.paper_request("/api/papers/search", {"queries": []}, status=400)
            provider.assert_not_called()
            result = self.paper_request("/api/papers/search", {
                "queries": ["self-healing coating", "scratch recovery", "offline coating"],
                "question": "PRIVATE_NOTE",
            })
            requested = [urllib.parse.parse_qs(urllib.parse.urlsplit(call.args[0]).query) for call in provider.call_args_list]
            self.assertCountEqual([params["query.bibliographic"][0] for params in requested],
                                  ["self-healing coating", "scratch recovery", "offline coating"])
            self.assertTrue(all(set(params) == {"query.bibliographic", "rows", "select"} for params in requested))
            self.assertEqual([paper["doi"] for paper in result["papers"]], ["10.1234/coating"])
            self.assertEqual([item["query"] for item in result["papers"][0]["origins"]],
                             ["self-healing coating", "scratch recovery"])
            self.assertEqual([attempt["status"] for attempt in result["attempts"]], ["ok", "ok", "error"])
            self.assertIn("제한", result["attempts"][2]["error"])

    def test_paper_citation_api_uses_only_public_id_and_requested_direction(self):
        with patch.object(server.literature, "get_json", side_effect=paper_provider_fixture) as provider:
            self.paper_request("/api/papers/citations", {"identifier": "private title", "direction": "references"}, status=400)
            provider.assert_not_called()
            for direction in ("references", "citations"):
                result = self.paper_request("/api/papers/citations", {
                    "identifier": "DOI:10.1234/coating", "direction": direction, "title": "PRIVATE_NOTE",
                })
                self.assertEqual(result["papers"][0]["doi"], "10.1234/related")
                self.assertEqual(result["papers"][0]["origins"][0]["direction"], direction)
                request = urllib.parse.urlsplit(provider.call_args.args[0])
                self.assertEqual(request.hostname, "api.semanticscholar.org")
                self.assertEqual(urllib.parse.unquote(request.path), f"/graph/v1/paper/DOI:10.1234/coating/{direction}")
                self.assertEqual(set(urllib.parse.parse_qs(request.query)), {"fields", "limit"})

    def test_empty_provider_reference_list_is_a_successful_lookup(self):
        with patch.object(server.literature, "get_json", return_value={"data": None}):
            result = self.paper_request("/api/papers/citations", {
                "identifier": "DOI:10.1234/coating", "direction": "references",
            })
        self.assertEqual(result["papers"], [])
        self.assertEqual(result["attempts"][0]["status"], "ok")
        self.assertEqual(result["attempts"][0]["count"], 0)

    def test_paper_reference_save_appends_and_keeps_current_permission(self):
        server.update_section(self.id, "references", {"content": "기존 참고 자료", "ai_allowed": True})
        path = f"/api/experiments/{self.id}/paper-references"
        draft = "자료명: 새 자료\nDOI: 10.1234/related\n선정 이유: 조건 확인"
        self.paper_request(path, {"draft": draft, "ai_allowed": False})
        self.paper_request(path, {"draft": draft})
        references = server.get_experiment(self.id)["sections"]["references"]
        self.assertEqual(references["content"], "기존 참고 자료\n\n" + draft)
        self.assertEqual(references["ai_allowed"], 1)
        server.archive_experiment(self.id)
        self.paper_request(path, {"draft": "추가 자료"}, status=400)
        self.assertEqual(server.get_experiment(self.id)["sections"]["references"], references)

    def paper_request(self, path, data, status=200):
        with server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler) as app:
            worker = threading.Thread(target=app.serve_forever, kwargs={"poll_interval": 0.01})
            worker.start()
            try:
                with closing(http.client.HTTPConnection("127.0.0.1", app.server_port, timeout=5)) as connection:
                    connection.request("POST", path, json.dumps(data), {
                        "Content-Type": "application/json", "X-Labnote-Token": server.TOKEN,
                    })
                    response = connection.getresponse()
                    body = json.loads(response.read())
                    self.assertEqual(response.status, status, body)
                    return body
            finally:
                app.shutdown()
                worker.join()

    def test_backup_contains_saved_record_and_attachment(self):
        server.update_section(self.id, "purpose", {"content": "BACKUP_MARKER", "ai_allowed": False})
        payload = self.drawing_payload()
        saved = server.save_drawing(self.id, payload)
        attachment = saved["attachments"][0]
        archive_path = server.create_backup()
        try:
            with zipfile.ZipFile(archive_path) as archive:
                self.assertIsNone(archive.testzip())
                self.assertIn("data/labnote.sqlite3", archive.namelist())
                self.assertIn("backup-info.json", archive.namelist())
                with tempfile.TemporaryDirectory() as restore_dir:
                    archive.extractall(restore_dir)
                    with closing(sqlite3.connect(Path(restore_dir) / "data" / "labnote.sqlite3")) as db:
                        content = db.execute("SELECT content FROM sections WHERE experiment_id=? AND key='purpose'", (self.id,)).fetchone()[0]
                        stored_name = db.execute("SELECT stored_name FROM attachments WHERE id=?", (attachment["id"],)).fetchone()[0]
                    self.assertEqual(content, "BACKUP_MARKER")
                    self.assertTrue((Path(restore_dir) / "data" / "files" / stored_name).is_file())
        finally:
            archive_path.unlink(missing_ok=True)

    def test_delete_keeps_records_when_topic_removed_and_cleans_experiment_files(self):
        book = server.create_notebook("잘못 만든 책")
        topic = server.create_topic(book["id"], "잘못 만든 주제")
        record = server.create_experiment("잘못 만든 실험", "2026-11-20", book["id"], topic["id"])
        saved = server.save_drawing(record["id"], self.drawing_payload())
        attachment = saved["attachments"][0]
        file_path = server.FILES / server.attachment_row(attachment["id"])["stored_name"]
        server.archive_experiment(record["id"])
        result = self.paper_request(f"/api/topics/{topic['id']}/delete", {"title": topic["title"]})
        self.assertEqual(result["records_moved"], 1)
        self.assertIsNone(server.get_experiment(record["id"])["topic_id"])
        self.paper_request(f"/api/experiments/{record['id']}/delete", {"title": "다른 제목"}, status=400)
        self.assertTrue(file_path.is_file())
        self.paper_request(f"/api/experiments/{record['id']}/delete", {"title": record["title"]})
        self.assertFalse(file_path.exists())
        with server.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM experiments WHERE id=?", (record["id"],)).fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM attachments WHERE id=?", (attachment["id"],)).fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM drawing_documents WHERE attachment_id=?", (attachment["id"],)).fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM revisions WHERE experiment_id=?", (record["id"],)).fetchone()[0], 0)
        self.paper_request(f"/api/notebooks/{book['id']}/delete", {"title": book["title"]})
        self.assertNotIn(book["id"], [item["id"] for item in server.list_notebooks()])

    def test_default_book_can_be_archived_and_deleted_without_reappearing(self):
        self.paper_request("/api/notebooks/personal/archive", {})
        self.assertEqual(server.list_notebooks(), [])
        self.assertEqual(server.list_notebooks(archived=True)[0]["id"], "personal")
        server.init_db()
        self.assertEqual(server.list_notebooks(), [])
        self.paper_request("/api/notebooks/personal/restore", {})
        self.assertEqual(server.list_notebooks()[0]["id"], "personal")
        self.paper_request("/api/notebooks/personal/delete", {"title": "다른 이름"}, status=400)
        deleted = self.paper_request("/api/notebooks/personal/delete", {"title": "내 연구"})
        self.assertEqual(deleted["records_deleted"], 1)
        server.init_db()
        self.assertEqual(server.list_notebooks(), [])
        self.assertEqual(server.list_experiments(), [])
        book = server.create_notebook("새 연구")
        record = server.create_experiment("새 기록", "2026-11-25", book["id"])
        self.assertEqual(record["notebook_id"], book["id"])

    def test_book_archive_restore_and_delete_with_records(self):
        book = server.create_notebook("보관할 책")
        topic = server.create_topic(book["id"], "첫 주제")
        active = server.create_experiment("활성 기록", "2026-11-20", book["id"], topic["id"])
        kept_archived = server.create_experiment("이미 보관한 기록", "2026-11-21", book["id"])
        server.archive_experiment(kept_archived["id"])
        saved = server.save_drawing(active["id"], self.drawing_payload())
        attachment_id = saved["attachments"][0]["id"]
        file_path = server.FILES / server.attachment_row(attachment_id)["stored_name"]

        self.paper_request(f"/api/notebooks/{book['id']}/archive", {})
        self.assertNotIn(book["id"], [row["id"] for row in server.list_notebooks()])
        self.assertIn(book["id"], [row["id"] for row in server.list_notebooks(archived=True)])
        self.assertNotIn(active["id"], [row["id"] for row in server.list_experiments()])
        self.assertNotIn(kept_archived["id"], [row["id"] for row in server.list_experiments(archived=True)])
        self.assertNotIn(active["id"], [row["id"] for row in server.ai_source_catalog()["records"]])
        with self.assertRaisesRegex(ValueError, "보관한 책"):
            server.create_experiment("잘못 추가", "2026-11-22", book["id"])
        server.init_db()
        self.assertEqual(server.list_notebooks(archived=True)[0]["id"], book["id"])

        self.paper_request(f"/api/notebooks/{book['id']}/restore", {})
        self.assertIn(active["id"], [row["id"] for row in server.list_experiments()])
        self.assertIn(kept_archived["id"], [row["id"] for row in server.list_experiments(archived=True)])
        self.assertTrue(file_path.is_file())
        self.paper_request(f"/api/notebooks/{book['id']}/archive", {})
        self.paper_request(f"/api/notebooks/{book['id']}/delete", {"title": "틀린 제목"}, status=400)
        self.assertTrue(file_path.is_file())
        deleted = self.paper_request(f"/api/notebooks/{book['id']}/delete", {"title": book["title"]})
        self.assertEqual(deleted["records_deleted"], 2)
        self.assertFalse(file_path.exists())
        with server.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM experiments WHERE notebook_id=?", (book["id"],)).fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM topics WHERE notebook_id=?", (book["id"],)).fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM attachments WHERE id=?", (attachment_id,)).fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM drawing_documents WHERE attachment_id=?", (attachment_id,)).fetchone()[0], 0)

    def test_only_explicitly_allowed_section_reaches_ai(self):
        server.update_section(self.id, "purpose", {"content": "VISIBLE_MARKER", "ai_allowed": True})
        server.update_section(self.id, "results", {"content": "SECRET_MARKER", "ai_allowed": False})
        messages, preview = server.build_ai_messages(self.id, "해석해 주세요")
        prompt = messages[1]["content"][0]["text"]
        self.assertIn("VISIBLE_MARKER", prompt)
        self.assertNotIn("SECRET_MARKER", prompt)
        self.assertNotIn("비공개 실험 제목", prompt)
        self.assertEqual(preview["sections"], ["목적"])

    def drawing_payload(self, mode="sketch"):
        buffer = io.BytesIO()
        Image.new("RGB", (12, 12), "white").save(buffer, "PNG")
        return {"name": "그림.png", "section_key": "observations", "data": base64.b64encode(buffer.getvalue()).decode(),
                "document": {"version": 1, "mode": mode, "width": 1200, "height": 800,
                             "atoms": [], "bonds": [], "marks": [{"kind": "text", "color": "#bd4335", "points": [{"x": 10, "y": 30}], "text": "SECRET_ANNOTATION"}]}}

    def test_drawing_roundtrip_and_ai_lock(self):
        payload = self.drawing_payload()
        result = server.save_drawing(self.id, payload)
        file = result["attachments"][0]
        self.assertEqual(file["editable_drawing"], 1)
        self.assertEqual(file["ai_allowed"], 0)
        self.assertEqual(server.drawing_document(file["id"]), payload["document"])
        self.assertEqual(server.ai_preview(self.id)["attachments"], [])
        server.init_db()
        self.assertEqual(server.drawing_document(file["id"]), payload["document"])

    def test_sketch_shapes_roundtrip_and_validation(self):
        payload = self.drawing_payload()
        kinds = ("line", "dashed", "circle", "rectangle", "triangle", "roundedRectangle", "roundedTriangle", "textbox")
        payload["document"]["marks"] = [
            {"kind": kind, "color": "#bd4335", "points": [{"x": 40, "y": 50}, {"x": 220, "y": 170}],
             "text": "상자 내용" if kind == "textbox" else ""} for kind in kinds
        ]
        file = server.save_drawing(self.id, payload)["attachments"][0]
        self.assertEqual(server.drawing_document(file["id"])["marks"], payload["document"]["marks"])
        payload["document"]["marks"][-1]["text"] = "  "
        with self.assertRaises(ValueError):
            server.save_drawing(self.id, payload)
        payload["document"]["marks"][-1]["text"] = "상자 내용"
        payload["document"]["marks"][0]["points"] = [{"x": 40, "y": 50}]
        with self.assertRaises(ValueError):
            server.save_drawing(self.id, payload)

    def test_image_layout_persists_without_changing_source_or_ai_permission(self):
        file = server.save_drawing(self.id, self.drawing_payload())["attachments"][0]
        path = server.FILES / server.attachment_row(file["id"])["stored_name"]
        raw = path.read_bytes()
        server.update_attachment(file["id"], True)
        server.change_image_layout(file["id"], {"width": 45, "alignment": "right", "placement": "before"})
        server.init_db()
        saved = server.get_experiment(self.id)["attachments"][0]
        self.assertEqual((saved["display_width"], saved["display_align"], saved["display_placement"]), (45, "right", "before"))
        self.assertEqual(saved["ai_allowed"], 1)
        self.assertEqual(path.read_bytes(), raw)
        with self.assertRaises(ValueError):
            server.change_image_layout(file["id"], {"width": 101})
        server.archive_experiment(self.id)
        with self.assertRaises(ValueError):
            server.change_image_layout(file["id"], {"removed": True})

    def test_polymer_repeat_and_chemistry_colors_roundtrip(self):
        payload = self.drawing_payload("molecule")
        payload["document"]["atoms"] = [{"x":100,"y":100,"label":"C","color":"#7b36a8"},{"x":164,"y":100,"label":"O","color":"#0066cc"}]
        payload["document"]["bonds"] = [{"a":0,"b":1,"order":1,"color":"#7b36a8"}]
        payload["document"]["marks"] = [{"kind":"repeat","color":"#7b36a8","points":[{"x":70,"y":60},{"x":190,"y":150}],"text":"n"}]
        file = server.save_drawing(self.id, payload)["attachments"][0]
        self.assertEqual(server.drawing_document(file["id"]), payload["document"])
        self.assertEqual(file["ai_allowed"], 0)
        for collection in ("atoms", "bonds"):
            payload["document"][collection][0]["color"] = "url(https://example.org)"
            with self.assertRaises(ValueError):
                server.save_drawing(self.id, payload)
            payload["document"][collection][0]["color"] = "#7b36a8"
        payload["document"]["marks"][0]["points"] = [{"x":10,"y":10}]
        with self.assertRaises(ValueError):
            server.save_drawing(self.id, payload)

    def test_image_removal_restores_editable_document_and_excludes_ai(self):
        payload = self.drawing_payload()
        file = server.save_drawing(self.id, payload)["attachments"][0]
        server.update_attachment(file["id"], True)
        removed = server.change_image_layout(file["id"], {"removed": True})
        self.assertEqual(removed["attachments"], [])
        self.assertEqual(removed["removed_attachments"][0]["id"], file["id"])
        self.assertEqual(server.ai_preview(self.id)["attachments"], [])
        with self.assertRaises(ValueError):
            server.update_attachment(file["id"], True)
        restored = server.change_image_layout(file["id"], {"removed": False})
        self.assertEqual(restored["attachments"][0]["ai_allowed"], 0)
        self.assertEqual(server.drawing_document(file["id"]), payload["document"])

    def test_image_order_is_local_to_section_and_placement(self):
        first = server.save_drawing(self.id, self.drawing_payload())["attachments"][0]["id"]
        result = server.save_drawing(self.id, self.drawing_payload())
        ids = [f["id"] for f in result["attachments"]]
        result = server.change_image_layout(ids[1], {"move": -1})
        self.assertEqual([f["id"] for f in result["attachments"]], ids[::-1])
        server.change_image_layout(first, {"placement": "before"})
        prior = [f["id"] for f in server.get_experiment(self.id)["attachments"]]
        server.change_image_layout(first, {"move": 1})
        self.assertEqual([f["id"] for f in server.get_experiment(self.id)["attachments"]], prior)

    def test_photo_annotations_preserve_source_and_are_independently_locked(self):
        payload = self.drawing_payload()
        original = server.save_attachment(self.id, payload)["attachments"][0]
        source_path = server.FILES / server.attachment_row(original["id"])["stored_name"]
        original_bytes = source_path.read_bytes()
        server.update_attachment(original["id"], True)
        payload["document"].update(mode="photo", source_id=original["id"], regions=[])
        result = server.save_drawing(self.id, payload)
        derivative = next(f for f in result["attachments"] if f["id"] != original["id"])
        self.assertEqual(derivative["ai_allowed"], 0)
        self.assertEqual(source_path.read_bytes(), original_bytes)
        self.assertEqual(server.drawing_document(derivative["id"])["source_id"], original["id"])
        other = server.create_experiment("다른 실험", "2026-11-20")
        with self.assertRaises(ValueError):
            server.save_drawing(other["id"], payload)

    def test_invalid_or_archived_drawing_is_not_saved(self):
        payload = self.drawing_payload("molecule")
        payload["document"]["atoms"] = [{"x": 20, "y": 30, "label": "C"}]
        payload["document"]["bonds"] = [{"a": 0, "b": 4, "order": 1}]
        with self.assertRaises(ValueError):
            server.save_drawing(self.id, payload)
        self.assertEqual(server.get_experiment(self.id)["attachments"], [])
        payload["document"]["bonds"] = []
        payload["document"]["width"] = float("nan")
        with self.assertRaises(ValueError):
            server.save_drawing(self.id, payload)
        payload["document"]["width"] = 1200
        server.archive_experiment(self.id)
        with self.assertRaises(ValueError):
            server.save_drawing(self.id, payload)

    def test_books_group_experiments_without_changing_records(self):
        book = server.create_notebook("읽고 있는 논문", "https://example.org/paper")
        second = server.create_experiment("접촉각 측정", "2026-11-19", book["id"])
        books = {item["id"]: item for item in server.list_notebooks()}
        self.assertEqual(books["personal"]["experiment_count"], 1)
        self.assertEqual(books[book["id"]]["experiment_count"], 1)
        self.assertEqual(server.get_experiment(self.id)["notebook_id"], "personal")
        self.assertEqual(server.get_experiment(second["id"])["notebook_id"], book["id"])

    def test_topics_and_free_form_numbers_survive_search_repeat_and_migration(self):
        book = server.create_notebook("코팅 연구")
        topic = server.create_topic(book["id"], "KP의 첫 주제")
        first = server.create_experiment("접착력", "2026-11-20", book["id"], topic["id"], "KP-01-01")
        second = server.create_experiment("내열성", "2026-11-21", book["id"], topic["id"], "KP-01-01")
        self.assertEqual(first["record_code"], "KP-01-01")
        self.assertEqual(first["topic_title"], "KP의 첫 주제")
        self.assertEqual([row["id"] for row in server.list_experiments(notebook_id=book["id"], query="KP-01-01")], [second["id"], first["id"]])
        self.assertEqual([row["id"] for row in server.list_experiments(notebook_id=book["id"], query="첫 주제")], [second["id"], first["id"]])
        renamed = server.rename_topic(topic["id"], "자유 형식 주제")
        self.assertEqual(renamed["title"], server.get_experiment(first["id"])["topic_title"])
        changed = server.update_experiment(first["id"], {"record_code": "실험 A / 2026", "topic_id": None})
        self.assertEqual((changed["record_code"], changed["topic_id"]), ("실험 A / 2026", None))
        repeated = server.repeat_experiment(second["id"])
        self.assertEqual(repeated["topic_id"], topic["id"])
        self.assertEqual(repeated["record_code"], "")
        with self.assertRaises(ValueError):
            server.update_experiment(second["id"], {"topic_id": "missing"})
        server.init_db()
        self.assertEqual(server.get_experiment(second["id"])["record_code"], "KP-01-01")
        self.assertEqual(server.get_experiment(self.id)["record_code"], "")

    def test_existing_record_gets_locked_reference_field(self):
        server.update_section(self.id, "purpose", {"content": "기존 내용"})
        with server.connect() as db:
            db.execute("DELETE FROM sections WHERE experiment_id=? AND key='references'", (self.id,))
        server.init_db()
        record = server.get_experiment(self.id)
        self.assertEqual(record["sections"]["purpose"]["content"], "기존 내용")
        self.assertEqual(record["sections"]["references"]["content"], "")
        self.assertEqual(record["sections"]["references"]["ai_allowed"], 0)

    def test_repeat_keeps_plan_but_never_old_results_or_permissions(self):
        server.update_section(self.id, 'conditions', {'content':'공통 조건', 'ai_allowed':True})
        server.update_section(self.id, 'results', {'content':'이전 회차 결과', 'ai_allowed':True})
        second = server.repeat_experiment(self.id)
        third = server.repeat_experiment(second['id'])
        self.assertEqual([second['run_number'], third['run_number']], [2,3])
        self.assertEqual(third['series_id'], self.id)
        self.assertEqual(second['sections']['conditions']['content'], '공통 조건')
        self.assertEqual(second['sections']['results']['content'], '')
        self.assertTrue(all(not x['ai_allowed'] for x in second['sections'].values()))

    def test_first_actual_run_from_literature_is_run_one(self):
        with server.connect() as db:
            db.execute("UPDATE experiments SET record_type='literature',run_number=NULL WHERE id=?",(self.id,))
        actual = server.repeat_experiment(self.id)
        self.assertEqual(actual['run_number'], 1)

    def test_archive_view_and_restore_preserve_record(self):
        server.update_section(self.id, 'results', {'content':'보관할 결과', 'ai_allowed':False})
        attached = server.save_attachment(self.id, {'section_key':'results', 'name':'result.csv', 'data':base64.b64encode(b'x,y\n1,2\n').decode()})
        file_id = attached['attachments'][0]['id']
        server.archive_experiment(self.id)
        self.assertEqual(server.list_experiments(), [])
        self.assertEqual(server.list_experiments(archived=True)[0]['id'], self.id)
        restored = server.restore_experiment(self.id)
        self.assertFalse(restored['archived'])
        self.assertEqual(restored['number'], self.experiment['number'])
        self.assertEqual(restored['sections']['results']['content'], '보관할 결과')
        self.assertFalse(restored['sections']['results']['ai_allowed'])
        self.assertEqual(restored['attachments'][0]['id'], file_id)
        self.assertEqual(server.list_experiments(archived=True), [])
        self.assertEqual(server.list_experiments()[0]['id'], self.id)

    def test_attachment_is_locked_by_default_and_can_be_allowed(self):
        image = Image.new("RGB", (10, 10), "red")
        stream = io.BytesIO()
        image.save(stream, format="PNG")
        experiment = server.save_attachment(self.id, {
            "section_key": "results", "name": "secret.png",
            "data": base64.b64encode(stream.getvalue()).decode(),
        })
        file = experiment["attachments"][0]
        self.assertEqual(file["ai_allowed"], 0)
        self.assertEqual(server.ai_preview(self.id)["attachments"], [])
        with self.assertRaises(ValueError):
            server.build_ai_messages(self.id, "사진 설명")
        server.update_attachment(file["id"], True)
        messages, preview = server.build_ai_messages(self.id, "사진 설명")
        self.assertEqual(preview["attachments"], ["secret.png"])
        self.assertEqual(messages[1]["content"][1]["type"], "image_url")

    def test_region_views_preserve_original_file_and_ai_lock(self):
        import json
        stream = io.BytesIO()
        Image.new('RGB', (20, 10), 'blue').save(stream, format='PNG')
        raw = stream.getvalue()
        record = server.save_attachment(self.id, {'section_key':'observations','name':'figure.png','data':base64.b64encode(raw).decode()})
        attachment = record['attachments'][0]
        regions = [{'label':'처리 전 (a)','x':0,'y':0,'width':10,'height':10}, {'label':'처리 후 (b)','x':10,'y':0,'width':10,'height':10}]
        with server.connect() as db:
            db.execute('INSERT INTO attachment_regions VALUES(?,?)', (attachment['id'],json.dumps(regions)))
        server.init_db()
        viewed = server.get_experiment(self.id)['attachments'][0]
        self.assertEqual(viewed['regions'], regions)
        self.assertFalse(viewed['ai_allowed'])
        original = server.FILES / server.attachment_row(attachment['id'])['stored_name']
        self.assertEqual(original.read_bytes(), raw)
        self.assertEqual(server.ai_preview(self.id)['attachments'], [])

    def test_search_title_date_body_stays_in_book_and_excludes_archives(self):
        server.update_section(self.id, 'conditions', {'content':'특수 첨가제 100% A_B', 'ai_allowed':False})
        book = server.create_notebook('다른 책')
        other = server.create_experiment('비공개 실험 제목', '2026-11-19', book['id'])
        server.update_section(other['id'], 'conditions', {'content':'특수 첨가제 100% A_B'})
        for query in ('비공개','특수 첨가제','2026.11.19','2026/11/19','2026년11월19일','2026.11','100%','A_B','EXP-001'):
            self.assertEqual([r['id'] for r in server.list_experiments(notebook_id='personal',query=query)], [self.id], query)
        self.assertEqual(server.list_experiments(notebook_id='personal',query='존재하지않음'), [])
        self.assertEqual(server.list_experiments(notebook_id='personal',query='특수 미포함'), [])
        self.assertEqual(server.ai_preview(self.id)['sections'], [])
        server.archive_experiment(self.id)
        self.assertEqual(server.list_experiments(notebook_id='personal',query='비공개'), [])

    def test_search_treats_sql_wildcards_as_literal_text(self):
        server.update_section(self.id, 'results', {'content':'공백 없는 일반 결과'})
        self.assertEqual(server.list_experiments(query='%'), [])
        self.assertEqual(server.list_experiments(query='_'), [])
        self.assertEqual(server.list_experiments(query="' OR 1=1 --"), [])

    def test_local_model_status_explains_missing_server_and_model(self):
        with patch.object(server.urllib.request, 'build_opener') as factory:
            factory.return_value.open.side_effect = ConnectionRefusedError()
            self.assertFalse(server.local_model_status()['ready'])
            self.assertIn('서버', server.local_model_status()['message'])
            factory.return_value.open.side_effect = None
            factory.return_value.open.return_value = io.BytesIO(b'{"data": []}')
            self.assertIn('모델', server.local_model_status()['message'])
            factory.return_value.open.return_value = io.BytesIO(b'{"data": [{"id": "local-test"}]}')
            self.assertEqual(server.local_model_status(), {'ready': True, 'message': '로컬 AI 연결됨 · local-test'})

    def test_remote_ai_endpoint_is_rejected(self):
        server.update_section(self.id, "purpose", {"content": "allowed", "ai_allowed": True})
        old_url = server.LOCAL_MODEL_URL
        server.LOCAL_MODEL_URL = "https://example.com/v1/chat/completions"
        try:
            with self.assertRaisesRegex(ValueError, "localhost"):
                server.call_local_ai(self.id, "분석")
        finally:
            server.LOCAL_MODEL_URL = old_url

    def test_select_specific_items_across_experiments_for_local_ai(self):
        server.update_section(self.id, 'conditions', {'content': '조건_A 25°C', 'ai_allowed': True})
        server.update_section(self.id, 'results', {'content': '결과_A 회복', 'ai_allowed': True})
        server.update_section(self.id, 'purpose', {'content': '잠긴_목적', 'ai_allowed': False})
        second = server.create_experiment('비교 실험', '2026-11-20')
        server.update_section(second['id'], 'conditions', {'content': '조건_B 40°C', 'ai_allowed': True})
        server.update_section(second['id'], 'observations', {'content': '관찰_B 흠집', 'ai_allowed': True})
        catalog = server.ai_source_catalog('personal')['records']
        first_items = next(record['items'] for record in catalog if record['id'] == self.id)
        self.assertEqual({item['id'] for item in first_items}, {'section:conditions', 'section:results', 'section:purpose'})
        self.assertEqual(next(item for item in first_items if item['id'] == 'section:purpose')['excerpt'], '')
        self.assertFalse(next(item for item in first_items if item['id'] == 'section:purpose')['allowed'])
        selections = [
            {'experiment_id': self.id, 'items': ['section:conditions']},
            {'experiment_id': second['id'], 'items': ['section:conditions']},
        ]
        messages, preview = server.build_selected_ai_messages(selections, '조건 차이를 비교해 주세요')
        prompt = messages[1]['content'][0]['text']
        self.assertIn('조건_A 25°C', prompt)
        self.assertIn('조건_B 40°C', prompt)
        self.assertNotIn('결과_A 회복', prompt)
        self.assertNotIn('잠긴_목적', prompt)
        self.assertEqual((len(preview['records']), preview['item_count']), (2, 2))
        with patch.object(server, 'request_local_model', return_value='비교 초안') as model:
            result = server.call_selected_ai(selections, '조건 차이를 비교해 주세요')
        self.assertEqual(result['answer'], '비교 초안')
        self.assertEqual(model.call_count, 1)
        with self.assertRaisesRegex(ValueError, '잠겼거나 삭제된'):
            server.build_selected_ai_messages([{'experiment_id': self.id, 'items': ['section:purpose']}], '')

    def test_removed_section_and_file_cannot_enter_ai_selection(self):
        server.update_section(self.id, 'conditions', {'content': '삭제된_조건', 'ai_allowed': True})
        attached = server.save_attachment(self.id, {'section_key': 'conditions', 'name': 'values.csv',
                                                        'data': base64.b64encode(b'x,y\n1,2\n').decode()})
        file_id = attached['attachments'][0]['id']
        server.update_attachment(file_id, True)
        removed = server.change_section_layout(self.id, {'key': 'conditions', 'removed': 1})
        self.assertFalse(removed['sections']['conditions']['ai_allowed'])
        self.assertFalse(removed['attachments'][0]['ai_allowed'])
        self.assertEqual(server.ai_preview(self.id)['sections'], [])
        self.assertEqual(server.ai_preview(self.id)['attachments'], [])
        with self.assertRaisesRegex(ValueError, '잠겼거나 삭제된'):
            server.build_selected_ai_messages([{'experiment_id': self.id, 'items': [f'attachment:{file_id}']}], '')

    def test_selected_table_file_includes_rows_and_unselected_text_stays_out(self):
        server.update_section(self.id, 'results', {'content': '미선택_결과', 'ai_allowed': True})
        attached = server.save_attachment(self.id, {'section_key': 'results', 'name': 'trial.csv',
                                                        'data': base64.b64encode(b'temperature,score\n25,12\n40,19\n').decode()})
        file_id = attached['attachments'][0]['id']
        server.update_attachment(file_id, True)
        messages, preview = server.build_selected_ai_messages([
            {'experiment_id': self.id, 'items': [f'attachment:{file_id}']},
        ], '수치를 비교해 주세요')
        prompt = messages[1]['content'][0]['text']
        self.assertIn('temperature', prompt)
        self.assertIn('40', prompt)
        self.assertNotIn('미선택_결과', prompt)
        self.assertEqual(preview['file_count'], 1)

    def test_edit_preserves_previous_section_text(self):
        server.update_section(self.id, "observations", {"content": "첫 관찰"})
        updated = server.update_section(self.id, "observations", {"content": "수정 관찰"})
        self.assertEqual(updated["sections"]["observations"]["content"], "수정 관찰")
        self.assertEqual(updated["revisions"][0]["previous_value"], "첫 관찰")

    def test_allowed_pdf_is_read_locally_with_page_reference(self):
        document = pymupdf.open()
        page = document.new_page()
        page.insert_text((50, 50), "PUBLIC_PAPER_MARKER")
        raw = document.tobytes()
        document.close()
        experiment = server.save_attachment(self.id, {
            "section_key": "procedure", "name": "paper.pdf",
            "data": base64.b64encode(raw).decode(),
        })
        file = experiment["attachments"][0]
        server.update_attachment(file["id"], True)
        messages, _ = server.build_ai_messages(self.id, "논문을 설명해 주세요")
        prompt = messages[1]["content"][0]["text"]
        self.assertIn("PUBLIC_PAPER_MARKER", prompt)
        self.assertIn("[PDF 1쪽]", prompt)

    def test_legacy_split_preserves_text_files_locks_and_is_idempotent(self):
        original = '재료와 조건이 섞인 자유 형식 원본\n수정하지 않고 보존'
        attached = server.save_attachment(self.id, {'section_key':'procedure', 'name':'old.csv', 'data':base64.b64encode(b'x,y\n1,2\n').decode()})
        with server.connect() as db:
            db.execute("INSERT INTO sections(experiment_id,key,content,ai_allowed,updated_at) VALUES(?, 'method', ?, 0, ?)", (self.id, original, server.now()))
            db.execute("UPDATE attachments SET section_key='method' WHERE experiment_id=?", (self.id,))
        server.init_db()
        server.init_db()
        record = server.get_experiment(self.id)
        self.assertNotIn('method', record['sections'])
        self.assertEqual(record['sections']['procedure']['content'], original)
        self.assertTrue(all(not item['ai_allowed'] for item in record['sections'].values()))
        self.assertEqual(record['attachments'][0]['id'], attached['attachments'][0]['id'])
        self.assertEqual(record['attachments'][0]['section_key'], 'procedure')
        self.assertEqual(record['revisions'][0]['previous_value'], original)

    def test_reviewed_demo_split_keeps_all_lines_in_the_right_sections(self):
        from scripts.rebuild_reviewed_demo import make_sections
        parts = make_sections(1, 'DMAM', 20, 20, 'a,b')
        self.assertIn('Nikon', parts['materials'])
        self.assertIn('첨가량:', parts['conditions'])
        self.assertIn('절차 5.', parts['procedure'])
        self.assertNotIn('절차', parts['materials'])
        self.assertNotIn('method', parts)


if __name__ == "__main__":
    unittest.main()
