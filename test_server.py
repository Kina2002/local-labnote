"""Focused tests for the AI access boundary and local record flow."""

import base64
import io
import sqlite3
import tempfile
import unittest
import zipfile
from contextlib import closing
from pathlib import Path

import pymupdf
from PIL import Image

import server


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

    def test_remote_ai_endpoint_is_rejected(self):
        server.update_section(self.id, "purpose", {"content": "allowed", "ai_allowed": True})
        old_url = server.LOCAL_MODEL_URL
        server.LOCAL_MODEL_URL = "https://example.com/v1/chat/completions"
        try:
            with self.assertRaisesRegex(ValueError, "localhost"):
                server.call_local_ai(self.id, "분석")
        finally:
            server.LOCAL_MODEL_URL = old_url

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
            db.execute("INSERT INTO sections VALUES(?, 'method', ?, 0, ?)", (self.id, original, server.now()))
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
