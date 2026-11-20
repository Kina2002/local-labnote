"""Local research notebook. Only the literature endpoint makes an external request."""

from __future__ import annotations

import base64
import io
import json
import os
import re
import secrets
import sqlite3
import sys
import threading
import urllib.parse
import urllib.request
import uuid
import webbrowser
from contextlib import contextmanager
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pandas as pd
from PIL import Image

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
FILES = DATA / "files"
DB = DATA / "labnote.sqlite3"
WEB = ROOT / "web"
HOST = "127.0.0.1"
PORT = 8765
MAX_UPLOAD = 15 * 1024 * 1024
ALLOWED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".csv", ".xlsx", ".pdf"}
SECTION_LABELS = [
    ("purpose", "목적"),
    ("materials", "재료"),
    ("conditions", "조건"),
    ("procedure", "과정"),
    ("observations", "관찰"),
    ("results", "결과"),
    ("reflection", "내 생각"),
    ("references", "참고 자료"),
]
TOKEN = secrets.token_urlsafe(32)
LOCAL_MODEL_URL = os.environ.get(
    "LABNOTE_LOCAL_MODEL_URL", "http://127.0.0.1:1234/v1/chat/completions"
)


def now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


@contextmanager
def connect():
    connection = sqlite3.connect(DB)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def split_legacy_method(content: str) -> dict[str, str]:
    """Separate the reviewed demo's labelled lines; preserve arbitrary old notes whole."""
    parts = {"materials": [], "conditions": [], "procedure": []}
    if content.startswith("[논문에 보고된 조건 — §2.2, §3.3, §3.4.5]"):
        for line in content.splitlines()[1:]:
            if line.startswith(("재료:", "장비:")):
                parts["materials"].append(line)
            elif line.startswith("절차 "):
                parts["procedure"].append(line)
                if line.startswith("절차 1. 공중합체를 ") and line.endswith("에 10% w/v 농도로 용해한다."):
                    solvent = line.removeprefix("절차 1. 공중합체를 ").removesuffix("에 10% w/v 농도로 용해한다.")
                    parts["materials"].append("용매: " + solvent)
                    parts["conditions"].append("공중합체 용액 농도: 10% w/v.")
                if line == "절차 3. 실온에서 10일 건조한다. 논문은 건조 복합 필름 두께를 약 0.3 mm로 보고한다.":
                    parts["conditions"].append("필름 제조: 실온에서 10일 건조. 건조 복합 필름 두께 약 0.3 mm.")
                if line == "절차 5. 흠집에 피펫으로 물방울을 더하고 실온에서 건조한다. 물이 완전히 증발한 뒤 동일 손상 부위를 관찰한다.":
                    parts["conditions"].append("회복 관찰: 물 첨가 후 실온 건조. 물이 완전히 증발한 뒤 동일 부위 관찰.")
            else:
                parts["conditions"].append(line)
        return {key: "\n".join(lines) for key, lines in parts.items()}
    return {"materials": "", "conditions": "", "procedure": content}


def init_db() -> None:
    FILES.mkdir(parents=True, exist_ok=True)
    with connect() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS notebooks (
              id TEXT PRIMARY KEY, title TEXT NOT NULL,
              source_url TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS experiments (
              id TEXT PRIMARY KEY, number INTEGER UNIQUE NOT NULL,
              title TEXT NOT NULL, experiment_date TEXT NOT NULL,
              created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
              notebook_id TEXT REFERENCES notebooks(id)
            );
            CREATE TABLE IF NOT EXISTS sections (
              experiment_id TEXT NOT NULL REFERENCES experiments(id),
              key TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
              ai_allowed INTEGER NOT NULL DEFAULT 0,
              updated_at TEXT NOT NULL,
              PRIMARY KEY (experiment_id, key)
            );
            CREATE TABLE IF NOT EXISTS attachments (
              id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL REFERENCES experiments(id),
              section_key TEXT NOT NULL, original_name TEXT NOT NULL,
              stored_name TEXT NOT NULL, mime_type TEXT NOT NULL,
              size INTEGER NOT NULL, ai_allowed INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS revisions (
              id INTEGER PRIMARY KEY AUTOINCREMENT, experiment_id TEXT NOT NULL,
              target TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL,
              previous_value TEXT
            );
            CREATE TABLE IF NOT EXISTS attachment_regions (
              attachment_id TEXT PRIMARY KEY REFERENCES attachments(id),
              regions_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS drawing_documents (
              attachment_id TEXT PRIMARY KEY REFERENCES attachments(id),
              document_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS attachment_layout (
              attachment_id TEXT PRIMARY KEY REFERENCES attachments(id),
              width INTEGER NOT NULL DEFAULT 100,
              alignment TEXT NOT NULL DEFAULT 'center',
              placement TEXT NOT NULL DEFAULT 'after',
              sort_order INTEGER NOT NULL DEFAULT 0,
              removed INTEGER NOT NULL DEFAULT 0
            );
            """
        )
        columns = {row["name"] for row in db.execute("PRAGMA table_info(revisions)")}
        if "previous_value" not in columns:
            db.execute("ALTER TABLE revisions ADD COLUMN previous_value TEXT")
        columns = {row["name"] for row in db.execute("PRAGMA table_info(experiments)")}
        if "notebook_id" not in columns:
            db.execute("ALTER TABLE experiments ADD COLUMN notebook_id TEXT REFERENCES notebooks(id)")
        for name, definition in {"archived": "INTEGER NOT NULL DEFAULT 0", "record_type": "TEXT NOT NULL DEFAULT 'experiment'", "series_id": "TEXT", "run_number": "INTEGER DEFAULT 1"}.items():
            if name not in columns:
                db.execute(f"ALTER TABLE experiments ADD COLUMN {name} {definition}")
        db.execute("UPDATE experiments SET series_id=id WHERE series_id IS NULL")
        book_columns = {row["name"] for row in db.execute("PRAGMA table_info(notebooks)")}
        if "overview" not in book_columns:
            db.execute("ALTER TABLE notebooks ADD COLUMN overview TEXT NOT NULL DEFAULT ''")
        db.execute(
            "INSERT OR IGNORE INTO notebooks(id,title,source_url,created_at) VALUES(?,?,?,?)",
            ("personal", "내 연구", "", now()),
        )
        db.execute("UPDATE experiments SET notebook_id='personal' WHERE notebook_id IS NULL")
        for key, _ in SECTION_LABELS:
            db.execute(
                "INSERT OR IGNORE INTO sections(experiment_id,key,content,ai_allowed,updated_at) "
                "SELECT id,?,'',0,? FROM experiments",
                (key, now()),
            )
        # One-time migration; keep original text in history and never widen AI access.
        for old in db.execute("SELECT * FROM sections WHERE key='method'").fetchall():
            parts = split_legacy_method(old["content"])
            for key, content in parts.items():
                existing = db.execute("SELECT * FROM sections WHERE experiment_id=? AND key=?", (old["experiment_id"], key)).fetchone()
                if not content:
                    continue
                combined = (existing["content"] + "\n\n" + content).strip() if existing["content"] else content
                allowed = bool(old["ai_allowed"]) and (not existing["content"] or bool(existing["ai_allowed"]))
                db.execute("UPDATE sections SET content=?,ai_allowed=?,updated_at=? WHERE experiment_id=? AND key=?", (combined, allowed, now(), old["experiment_id"], key))
            record_revision(db, old["experiment_id"], "method", "split_into_sections", old["content"])
            db.execute("UPDATE attachments SET section_key='procedure' WHERE experiment_id=? AND section_key='method'", (old["experiment_id"],))
            db.execute("DELETE FROM sections WHERE experiment_id=? AND key='method'", (old["experiment_id"],))


def create_notebook(title: str, source_url: str = "") -> dict:
    title = title.strip()[:160]
    if not title:
        raise ValueError("책 이름을 입력해 주세요.")
    if source_url and not source_url.startswith(("https://", "http://")):
        raise ValueError("출처 주소는 http 또는 https로 시작해야 합니다.")
    notebook_id = uuid.uuid4().hex
    with connect() as db:
        db.execute(
            "INSERT INTO notebooks(id,title,source_url,created_at) VALUES(?,?,?,?)",
            (notebook_id, title, source_url[:500], now()),
        )
    return {"id": notebook_id, "title": title, "source_url": source_url[:500], "experiment_count": 0}


def list_notebooks() -> list[dict]:
    with connect() as db:
        rows = db.execute(
            "SELECT n.id,n.title,n.source_url,n.overview,n.created_at,COUNT(e.id) AS experiment_count "
            "FROM notebooks n LEFT JOIN experiments e ON e.notebook_id=n.id AND e.archived=0 "
            "GROUP BY n.id ORDER BY CASE WHEN n.id='personal' THEN 0 ELSE 1 END,n.created_at DESC"
        ).fetchall()
    return [dict(row) for row in rows]


def record_revision(db: sqlite3.Connection, experiment_id: str, target: str,
                    action: str, previous_value: str | None = None) -> None:
    db.execute(
        "INSERT INTO revisions(experiment_id,target,action,created_at,previous_value) VALUES(?,?,?,?,?)",
        (experiment_id, target, action, now(), previous_value),
    )


def create_experiment(title: str, experiment_date: str, notebook_id: str = "personal") -> dict:
    title = title.strip()[:160] or "새 실험"
    if not experiment_date or len(experiment_date) != 10:
        experiment_date = datetime.now().date().isoformat()
    experiment_id = uuid.uuid4().hex
    timestamp = now()
    with connect() as db:
        if db.execute("SELECT 1 FROM notebooks WHERE id=?", (notebook_id,)).fetchone() is None:
            raise ValueError("책을 찾을 수 없습니다.")
        number = db.execute("SELECT COALESCE(MAX(number), 0) + 1 FROM experiments").fetchone()[0]
        db.execute(
            "INSERT INTO experiments(id,number,title,experiment_date,created_at,updated_at,notebook_id) VALUES(?,?,?,?,?,?,?)",
            (experiment_id, number, title, experiment_date, timestamp, timestamp, notebook_id),
        )
        db.executemany(
            "INSERT INTO sections(experiment_id,key,content,ai_allowed,updated_at) VALUES(?,?,?,0,?)",
            [(experiment_id, key, "", timestamp) for key, _ in SECTION_LABELS],
        )
        db.execute("UPDATE experiments SET series_id=id WHERE id=?", (experiment_id,))
        record_revision(db, experiment_id, "experiment", "created")
    return get_experiment(experiment_id)


def list_experiments(archived: bool = False, notebook_id: str | None = None, query: str = "") -> list[dict]:
    clauses = ["e.archived=?"]
    values = [int(archived)]
    if notebook_id:
        clauses.append("e.notebook_id=?")
        values.append(notebook_id)
    # Accept common date spellings; search stays within the local database.
    query = query.strip()[:200]
    query = re.sub(r"(\d{4})[./년-]\s*(\d{1,2})(?:[./월-]\s*(\d{1,2})일?)?", lambda m: f"{m[1]}-{int(m[2]):02d}" + (f"-{int(m[3]):02d}" if m[3] else ""), query)
    for term in query.split():
        pattern = "%" + term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        clauses.append("(e.title LIKE ? ESCAPE '\\' OR e.experiment_date LIKE ? ESCAPE '\\' "
                       "OR (CASE WHEN e.record_type='literature' THEN 'LIT-' ELSE 'EXP-' END || printf('%03d',e.number)) LIKE ? ESCAPE '\\' "
                       "OR EXISTS(SELECT 1 FROM sections s WHERE s.experiment_id=e.id AND s.content LIKE ? ESCAPE '\\'))")
        values.extend([pattern] * 4)
    with connect() as db:
        rows = db.execute(
            "SELECT e.id,e.number,e.title,e.experiment_date,e.created_at,e.updated_at,e.notebook_id,e.record_type,e.series_id,e.run_number,e.archived "
            "FROM experiments e WHERE " + " AND ".join(clauses) + " ORDER BY " + ("e.number ASC" if archived else "e.experiment_date DESC,e.number DESC"),
            values,
        ).fetchall()
    return [dict(row) for row in rows]


def restore_experiment(experiment_id: str) -> dict:
    with connect() as db:
        row = db.execute("SELECT archived FROM experiments WHERE id=?", (experiment_id,)).fetchone()
        if row is None:
            raise ValueError("기록을 찾을 수 없습니다.")
        if row["archived"]:
            db.execute("UPDATE experiments SET archived=0 WHERE id=?", (experiment_id,))
            record_revision(db, experiment_id, "experiment", "restored")
    return get_experiment(experiment_id)


def archive_experiment(experiment_id: str) -> dict:
    with connect() as db:
        row = db.execute("SELECT archived FROM experiments WHERE id=?", (experiment_id,)).fetchone()
        if row is None:
            raise ValueError("기록을 찾을 수 없습니다.")
        if not row["archived"]:
            db.execute("UPDATE experiments SET archived=1 WHERE id=?", (experiment_id,))
            record_revision(db, experiment_id, "experiment", "archived")
    return get_experiment(experiment_id)


def repeat_experiment(experiment_id: str) -> dict:
    source = get_experiment(experiment_id)
    entry = create_experiment(source["title"], "", source["notebook_id"])
    with connect() as db:
        series = source["series_id"] or source["id"]
        run = db.execute("SELECT COALESCE(MAX(run_number),0)+1 FROM experiments WHERE series_id=? AND record_type!='literature'", (series,)).fetchone()[0]
        db.execute("UPDATE experiments SET series_id=?,run_number=?,record_type='plan' WHERE id=?", (series, run, entry["id"]))
        for key in ("purpose", "materials", "conditions", "procedure", "references"):
            db.execute("UPDATE sections SET content=?,ai_allowed=0 WHERE experiment_id=? AND key=?", (source["sections"][key]["content"], entry["id"], key))
        record_revision(db, entry["id"], "experiment", "repeat_created", source["id"])
    return get_experiment(entry["id"])


def get_experiment(experiment_id: str) -> dict:
    with connect() as db:
        row = db.execute("SELECT * FROM experiments WHERE id=?", (experiment_id,)).fetchone()
        if row is None:
            raise ValueError("실험을 찾을 수 없습니다.")
        sections = db.execute(
            "SELECT key,content,ai_allowed,updated_at FROM sections WHERE experiment_id=?",
            (experiment_id,),
        ).fetchall()
        files = db.execute(
            "SELECT a.id,a.section_key,a.original_name,a.mime_type,a.size,a.ai_allowed,a.created_at,r.regions_json, "
            "EXISTS(SELECT 1 FROM drawing_documents d WHERE d.attachment_id=a.id) AS editable_drawing, "
            "COALESCE(l.width,100) AS display_width, COALESCE(l.alignment,'center') AS display_align, "
            "COALESCE(l.placement,'after') AS display_placement, COALESCE(l.removed,0) AS removed "
            "FROM attachments a LEFT JOIN attachment_regions r ON r.attachment_id=a.id "
            "LEFT JOIN attachment_layout l ON l.attachment_id=a.id "
            "WHERE a.experiment_id=? ORDER BY COALESCE(l.sort_order,0),a.created_at DESC,a.id",
            (experiment_id,),
        ).fetchall()
        revisions = db.execute(
            "SELECT target,action,created_at,previous_value FROM revisions WHERE experiment_id=? ORDER BY id DESC LIMIT 12",
            (experiment_id,),
        ).fetchall()
    result = dict(row)
    result["sections"] = {section["key"]: dict(section) for section in sections}
    result["attachments"] = [dict(file) for file in files]
    for file in result["attachments"]:
        file["regions"] = json.loads(file.pop("regions_json") or "[]")
    result["removed_attachments"] = [file for file in result["attachments"] if file["removed"]]
    result["attachments"] = [file for file in result["attachments"] if not file["removed"]]
    result["revisions"] = [dict(revision) for revision in revisions]
    return result


def update_experiment(experiment_id: str, data: dict) -> dict:
    with connect() as db:
        current = db.execute("SELECT title,experiment_date,record_type FROM experiments WHERE id=?", (experiment_id,)).fetchone()
        if not current:
            raise ValueError("실험을 찾을 수 없습니다.")
        title = str(data.get("title", current["title"])).strip()[:160] or current["title"]
        date = str(data.get("experiment_date", current["experiment_date"]))
        if len(date) != 10 and not (date == '' and current['record_type'] == 'literature'):
            raise ValueError("실험 날짜를 확인해 주세요.")
        db.execute(
            "UPDATE experiments SET title=?,experiment_date=?,updated_at=? WHERE id=?",
            (title, date, now(), experiment_id),
        )
        record_revision(db, experiment_id, "experiment", "edited",
                        json.dumps(dict(current), ensure_ascii=False))
    return get_experiment(experiment_id)


def update_section(experiment_id: str, key: str, data: dict) -> dict:
    if key not in dict(SECTION_LABELS):
        raise ValueError("알 수 없는 항목입니다.")
    with connect() as db:
        row = db.execute(
            "SELECT content,ai_allowed FROM sections WHERE experiment_id=? AND key=?",
            (experiment_id, key),
        ).fetchone()
        if row is None:
            raise ValueError("항목을 찾을 수 없습니다.")
        content = str(data.get("content", row["content"]))[:30000]
        allowed = int(bool(data.get("ai_allowed", row["ai_allowed"])))
        db.execute(
            "UPDATE sections SET content=?,ai_allowed=?,updated_at=? WHERE experiment_id=? AND key=?",
            (content, allowed, now(), experiment_id, key),
        )
        db.execute("UPDATE experiments SET updated_at=? WHERE id=?", (now(), experiment_id))
        record_revision(db, experiment_id, key,
                        "edited" if content != row["content"] else "ai_access_changed",
                        row["content"] if content != row["content"] else None)
    return get_experiment(experiment_id)


def save_attachment(experiment_id: str, payload: dict, drawing: dict | None = None) -> dict:
    get_experiment(experiment_id)
    section_key = str(payload.get("section_key", "results"))
    if section_key not in dict(SECTION_LABELS):
        raise ValueError("첨부 위치를 확인해 주세요.")
    name = Path(str(payload.get("name", "file"))).name[:180]
    extension = Path(name).suffix.lower()
    if extension not in ALLOWED_EXTENSIONS:
        raise ValueError("PNG, JPG, WEBP, CSV, XLSX, PDF만 첨부할 수 있습니다.")
    try:
        raw = base64.b64decode(payload["data"], validate=True)
    except (KeyError, ValueError) as exc:
        raise ValueError("파일을 읽을 수 없습니다.") from exc
    if not raw or len(raw) > MAX_UPLOAD:
        raise ValueError("파일 크기는 15MB 이하여야 합니다.")
    mime = "image/" + ("jpeg" if extension in {".jpg", ".jpeg"} else extension[1:]) if extension in {".png", ".jpg", ".jpeg", ".webp"} else "application/octet-stream"
    if mime.startswith("image/"):
        try:
            Image.open(io.BytesIO(raw)).verify()
        except Exception as exc:
            raise ValueError("이미지 파일이 올바르지 않습니다.") from exc
    attachment_id = uuid.uuid4().hex
    stored_name = attachment_id + extension
    (FILES / stored_name).write_bytes(raw)
    try:
        with connect() as db:
            db.execute(
                "INSERT INTO attachments VALUES(?,?,?,?,?,?,?,0,?)",
                (attachment_id, experiment_id, section_key, name, stored_name, mime, len(raw), now()),
            )
            record_revision(db, experiment_id, section_key, "attachment_added")
            if drawing is not None:
                db.execute("INSERT INTO drawing_documents VALUES(?,?)",
                           (attachment_id, json.dumps(drawing, ensure_ascii=False)))
    except Exception:
        (FILES / stored_name).unlink(missing_ok=True)
        raise
    return get_experiment(experiment_id)


def drawing_document(attachment_id: str) -> dict:
    with connect() as db:
        row = db.execute("SELECT document_json FROM drawing_documents WHERE attachment_id=?", (attachment_id,)).fetchone()
    if not row:
        raise ValueError("편집할 그림을 찾을 수 없습니다.")
    return json.loads(row[0])


def save_drawing(experiment_id: str, payload: dict) -> dict:
    experiment = get_experiment(experiment_id)
    if experiment["archived"]:
        raise ValueError("보관한 기록은 복원한 다음 편집해 주세요.")
    document = payload.get("document")
    if not isinstance(document, dict) or document.get("version") != 1 or document.get("mode") not in {"molecule", "sketch", "photo"}:
        raise ValueError("그림 형식을 확인해 주세요.")
    # Only structured drawing data is persisted, never executable SVG or HTML.
    if len(json.dumps(document)) > 1500000:
        raise ValueError("그림이 너무 복잡합니다. 나누어 저장해 주세요.")
    def numeric(value, low=0, high=6000):
        return type(value) in (int, float) and low <= value <= high
    if not all(numeric(document.get(k), 100, 4096) for k in ("width", "height")):
        raise ValueError("그림 크기를 확인해 주세요.")
    atoms, bonds, marks = (document.get(k, []) for k in ("atoms", "bonds", "marks"))
    if not all(isinstance(items, list) for items in (atoms, bonds, marks)) or len(atoms) > 500 or len(bonds) > 1000 or len(marks) > 1000:
        raise ValueError("그림 항목 수를 확인해 주세요.")
    def point(p):
        return isinstance(p, dict) and numeric(p.get("x")) and numeric(p.get("y"))
    def valid_color(value):
        return isinstance(value, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", value)
    for atom in atoms:
        if not point(atom) or atom.get("label") not in {"C", "N", "O", "S", "P", "F", "Cl", "Br", "I", "H", "Si", "B", "R"}:
            raise ValueError("원자 정보를 확인해 주세요.")
        if "color" in atom and not valid_color(atom["color"]):
            raise ValueError("원자 색상을 확인해 주세요.")
    for bond in bonds:
        if not isinstance(bond, dict) or not all(type(bond.get(k)) is int and 0 <= bond[k] < len(atoms) for k in ("a", "b")) or bond["a"] == bond["b"] or bond.get("order") not in (1, 2, 3):
            raise ValueError("결합 정보를 확인해 주세요.")
        if "color" in bond and not valid_color(bond["color"]):
            raise ValueError("결합 색상을 확인해 주세요.")
    for mark in marks:
        if not isinstance(mark, dict) or mark.get("kind") not in {"pen", "arrow", "text", "repeat"} or not valid_color(mark.get("color")):
            raise ValueError("스케치 정보를 확인해 주세요.")
        points = mark.get("points", [])
        if not isinstance(points, list) or not 1 <= len(points) <= 10000 or not all(point(p) for p in points):
            raise ValueError("그림 좌표를 확인해 주세요.")
        if not isinstance(mark.get("text", ""), str) or len(mark.get("text", "")) > 300:
            raise ValueError("설명은 300자 이내로 입력해 주세요.")
        if mark["kind"] == "repeat":
            if len(points) != 2 or points[1]["x"] - points[0]["x"] < 24 or points[1]["y"] - points[0]["y"] < 30 or not re.fullmatch(r"[A-Za-z0-9]{1,12}", mark.get("text", "")):
                raise ValueError("반복 단위의 대괄호 크기와 반복수(n 등)를 확인해 주세요.")
    if not atoms and not marks:
        raise ValueError("그림이나 설명을 먼저 추가해 주세요.")
    if document["mode"] == "photo":
        source = attachment_row(str(document.get("source_id", "")))
        if source["experiment_id"] != experiment_id or not source["mime_type"].startswith("image/"):
            raise ValueError("같은 실험의 사진만 사용할 수 있습니다.")
        regions = document.get("regions", [])
        if not isinstance(regions, list) or len(regions) > 12:
            raise ValueError("사진 영역을 확인해 주세요.")
        for region in regions:
            if not point(region) or not all(numeric(region.get(k), 1, 20000) for k in ("width", "height")) or not isinstance(region.get("label", ""), str) or len(region.get("label", "")) > 100:
                raise ValueError("사진 영역을 확인해 주세요.")
    elif document.get("source_id"):
        raise ValueError("사진 출처를 확인해 주세요.")
    if not str(payload.get("name", "")).lower().endswith(".png"):
        raise ValueError("그림은 PNG로 저장해 주세요.")
    return save_attachment(experiment_id, payload, drawing=document)


def change_image_layout(attachment_id: str, data: dict) -> dict:
    row = attachment_row(attachment_id)
    experiment = get_experiment(row["experiment_id"])
    if experiment["archived"] or not row["mime_type"].startswith("image/"):
        raise ValueError("편집 가능한 기록의 그림만 변경할 수 있습니다.")
    valid_keys = {"width", "alignment", "placement", "move", "removed"}
    if not data or set(data) - valid_keys:
        raise ValueError("그림 설정을 확인해 주세요.")
    if "width" in data and (type(data["width"]) is not int or not 25 <= data["width"] <= 100):
        raise ValueError("그림 크기는 25~100%로 설정해 주세요.")
    if "alignment" in data and data["alignment"] not in {"left", "center", "right"}:
        raise ValueError("그림 정렬을 확인해 주세요.")
    if "placement" in data and data["placement"] not in {"before", "after"}:
        raise ValueError("그림 위치를 확인해 주세요.")
    if "move" in data and (type(data["move"]) is not int or data["move"] not in {-1, 1}):
        raise ValueError("이동 방향을 확인해 주세요.")
    if "removed" in data and type(data["removed"]) is not bool:
        raise ValueError("삭제 설정을 확인해 주세요.")
    with connect() as db:
        db.execute("INSERT OR IGNORE INTO attachment_layout(attachment_id) VALUES(?)", (attachment_id,))
        before = dict(db.execute("SELECT * FROM attachment_layout WHERE attachment_id=?", (attachment_id,)).fetchone())
        if before["removed"] and data != {"removed": False}:
            raise ValueError("삭제한 그림을 먼저 복원해 주세요.")
        for key in ("width", "alignment", "placement", "removed"):
            if key in data:
                db.execute(f"UPDATE attachment_layout SET {key}=? WHERE attachment_id=?", (data[key], attachment_id))
        if data.get("removed"):
            db.execute("UPDATE attachments SET ai_allowed=0 WHERE id=?", (attachment_id,))
        if "move" in data:
            placement = data.get("placement", before["placement"])
            siblings = [f["id"] for f in experiment["attachments"] if f["section_key"] == row["section_key"] and f["mime_type"].startswith("image/") and f["display_placement"] == placement]
            if attachment_id in siblings:
                index = siblings.index(attachment_id)
                target = index + data["move"]
                if 0 <= target < len(siblings):
                    siblings[index], siblings[target] = siblings[target], siblings[index]
                    for order, image_id in enumerate(siblings):
                        db.execute("INSERT INTO attachment_layout(attachment_id,sort_order) VALUES(?,?) ON CONFLICT(attachment_id) DO UPDATE SET sort_order=excluded.sort_order", (image_id, order))
        db.execute("UPDATE experiments SET updated_at=? WHERE id=?", (now(), row["experiment_id"]))
        action = "image_removed" if data.get("removed") else "image_restored" if "removed" in data else "image_layout_changed"
        record_revision(db, row["experiment_id"], attachment_id, action, json.dumps(before, ensure_ascii=False))
    return get_experiment(row["experiment_id"])


def update_attachment(attachment_id: str, ai_allowed: bool) -> dict:
    with connect() as db:
        removed = db.execute("SELECT removed FROM attachment_layout WHERE attachment_id=?", (attachment_id,)).fetchone()
        if removed and removed[0]:
            raise ValueError("삭제한 그림은 AI에 허용할 수 없습니다. 먼저 복원해 주세요.")
        row = db.execute("SELECT experiment_id,ai_allowed FROM attachments WHERE id=?", (attachment_id,)).fetchone()
        if not row:
            raise ValueError("첨부파일을 찾을 수 없습니다.")
        db.execute("UPDATE attachments SET ai_allowed=? WHERE id=?", (int(ai_allowed), attachment_id))
        record_revision(db, row["experiment_id"], attachment_id, "ai_access_changed",
                        "로컬 AI 허용" if row["ai_allowed"] else "AI 사용 금지")
    return get_experiment(row["experiment_id"])


def attachment_row(attachment_id: str) -> sqlite3.Row:
    with connect() as db:
        row = db.execute("SELECT * FROM attachments WHERE id=?", (attachment_id,)).fetchone()
    if row is None:
        raise ValueError("첨부파일을 찾을 수 없습니다.")
    return row


def read_table(path: Path) -> pd.DataFrame:
    if path.suffix == ".csv":
        try:
            table = pd.read_csv(path)
        except UnicodeDecodeError:
            table = pd.read_csv(path, encoding="cp949")
    else:
        table = pd.read_excel(path)
    if table.empty:
        raise ValueError("데이터가 비어 있습니다.")
    return table


def table_data(attachment_id: str) -> dict:
    row = attachment_row(attachment_id)
    path = FILES / row["stored_name"]
    if path.suffix not in {".csv", ".xlsx"}:
        raise ValueError("표 파일이 아닙니다.")
    table = read_table(path)
    table.columns = [str(column) for column in table.columns]
    numeric = [str(column) for column in table.select_dtypes(include="number").columns]
    preview = table.head(500).where(pd.notna(table.head(500)), None)
    rows = json.loads(preview.to_json(orient="records", date_format="iso"))
    return {"columns": list(table.columns), "numeric": numeric, "rows": rows,
            "total_rows": len(table), "shown_rows": len(rows)}


def ai_preview(experiment_id: str) -> dict:
    experiment = get_experiment(experiment_id)
    sections = [dict(SECTION_LABELS)[key] for key, item in experiment["sections"].items()
                if item["ai_allowed"] and item["content"].strip()]
    attachments = [file["original_name"] for file in experiment["attachments"] if file["ai_allowed"]]
    return {"sections": sections, "attachments": attachments,
            "locked_count": sum(bool(item["content"].strip()) and not item["ai_allowed"] for item in experiment["sections"].values())
            + sum(not file["ai_allowed"] for file in experiment["attachments"])}


def build_ai_messages(experiment_id: str, question: str) -> tuple[list[dict], dict]:
    experiment = get_experiment(experiment_id)
    preview = ai_preview(experiment_id)
    notes = []
    for key, label in SECTION_LABELS:
        section = experiment["sections"][key]
        if section["ai_allowed"] and section["content"].strip():
            notes.append(f"[{label}]\n{section['content'][:6000]}")
    images = []
    for file in experiment["attachments"]:
        if not file["ai_allowed"]:
            continue
        row = attachment_row(file["id"])
        path = FILES / row["stored_name"]
        if path.suffix in {".csv", ".xlsx"}:
            table = read_table(path)
            notes.append(f"[허용된 결과 파일: {file['original_name']}]\n행 {len(table)}개\n"
                         + table.describe(include="all").to_string()[:7000])
        elif path.suffix == ".pdf":
            import pymupdf
            with pymupdf.open(path) as pdf:
                text = "\n".join(f"[PDF {index + 1}쪽] {pdf[index].get_text()}" for index in range(min(len(pdf), 12)))
            notes.append(f"[허용된 PDF: {file['original_name']}]\n{text[:12000]}")
        elif path.suffix in {".png", ".jpg", ".jpeg", ".webp"}:
            with Image.open(path) as image:
                image.thumbnail((1400, 1400))
                output = io.BytesIO()
                image.convert("RGB").save(output, format="JPEG", quality=80)
            images.append({"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(output.getvalue()).decode()}})
            notes.append(f"[허용된 사진: {file['original_name']}]")
    if not notes and not images:
        raise ValueError("AI 사용을 허용한 내용이 없습니다. 필요한 항목만 🏠로 바꿔 주세요.")
    user_content = [{"type": "text", "text": "사용자가 허용한 자료만 아래에 있습니다. 잠긴 항목의 내용은 제공되지 않았습니다.\n\n" + "\n\n".join(notes) + "\n\n질문: " + question[:1000]}]
    user_content.extend(images)
    messages = [
        {"role": "system", "content": "당신은 연구 기록의 분석 보조자입니다. 제공된 자료만 근거로 설명하고, 관찰 사실과 추측을 분리하세요. 수치와 단위를 지어내지 마세요. 원인을 단정하지 말고 확인이 필요한 점을 알려주세요. 한국어로 간결하게 답하세요."},
        {"role": "user", "content": user_content},
    ]
    return messages, preview


def call_local_ai(experiment_id: str, question: str) -> dict:
    parsed = urllib.parse.urlparse(LOCAL_MODEL_URL)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("AI 주소는 이 컴퓨터(localhost)만 허용합니다.")
    messages, preview = build_ai_messages(experiment_id, question)
    try:
        model = os.environ.get("LABNOTE_LOCAL_MODEL")
        if not model:
            model_url = urllib.parse.urlunparse((parsed.scheme, parsed.netloc, "/v1/models", "", "", ""))
            with urllib.request.urlopen(model_url, timeout=5) as response:
                models = json.load(response).get("data", [])
            if not models:
                raise ValueError("실행 중인 로컬 모델이 없습니다.")
            model = models[0]["id"]
        body = json.dumps({"model": model, "messages": messages,
                           "temperature": 0.2, "stream": False}).encode()
        request = urllib.request.Request(LOCAL_MODEL_URL, data=body,
                                         headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(request, timeout=90) as response:
            result = json.load(response)
        answer = result["choices"][0]["message"]["content"]
    except Exception as exc:
        raise ValueError("로컬 AI에 연결하지 못했습니다. LM Studio에서 모델과 로컬 서버를 실행해 주세요. 사진 분석에는 이미지 지원 모델이 필요합니다.") from exc
    return {"answer": answer, "used": preview}


def search_papers(query: str) -> list[dict]:
    query = query.strip()
    if len(query) < 3 or len(query) > 250:
        raise ValueError("검색어는 3~250자로 입력해 주세요.")
    url = "https://api.crossref.org/works?" + urllib.parse.urlencode(
        {"query.bibliographic": query, "rows": "8", "select": "DOI,title,author,published,URL"}
    )
    request = urllib.request.Request(url, headers={"User-Agent": "LocalLabnote/0.1 (research notebook prototype)"})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            items = json.load(response)["message"]["items"]
    except Exception as exc:
        raise ValueError("논문 검색에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.") from exc
    papers = []
    for item in items:
        date_parts = item.get("published", {}).get("date-parts", [[]])
        papers.append({"title": (item.get("title") or ["제목 없음"])[0],
                       "doi": item.get("DOI", ""),
                       "year": date_parts[0][0] if date_parts and date_parts[0] else None,
                       "url": item.get("URL", "")})
    return papers


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args) -> None:
        # Request bodies, search queries and notebook contents are never logged.
        pass

    def send_json(self, value, status=200) -> None:
        raw = json.dumps(value, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(raw)

    def check_token(self) -> bool:
        host = self.headers.get("Host", "").split(":")[0]
        if host not in {"127.0.0.1", "localhost"} or self.headers.get("X-Labnote-Token") != TOKEN:
            self.send_json({"error": "접근이 허용되지 않았습니다."}, 403)
            return False
        return True

    def body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length > MAX_UPLOAD * 2:
            raise ValueError("요청 크기가 너무 큽니다.")
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self) -> None:
        try:
            path = urllib.parse.urlparse(self.path).path
            if self.headers.get("Host", "").split(":")[0] not in {"127.0.0.1", "localhost"}:
                return self.send_json({"error": "접근이 허용되지 않았습니다."}, 403)
            if path == "/":
                raw = (WEB / "index.html").read_text(encoding="utf-8").replace("__SESSION_TOKEN__", TOKEN).encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(raw)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'")
                self.end_headers()
                self.wfile.write(raw)
                return
            if path in {"/style.css", "/book.css", "/drawing.css", "/drawing.js", "/image-layout.js", "/editor.js", "/contents.js", "/app.js", "/shelf.js"}:
                raw = (WEB / path[1:]).read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "text/css" if path.endswith("css") else "text/javascript")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
                return
            if not self.check_token():
                return
            parts = path.strip("/").split("/")
            if path == "/api/notebooks":
                return self.send_json(list_notebooks())
            if path == "/api/experiments":
                query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                return self.send_json(list_experiments(notebook_id=query.get('notebook_id',[None])[0], query=query.get('q',[''])[0]))
            if path == "/api/archived-experiments":
                return self.send_json(list_experiments(archived=True))
            if len(parts) == 3 and parts[:2] == ["api", "experiments"]:
                return self.send_json(get_experiment(parts[2]))
            if len(parts) == 4 and parts[:2] == ["api", "experiments"] and parts[3] == "ai-preview":
                return self.send_json(ai_preview(parts[2]))
            if len(parts) == 4 and parts[:2] == ["api", "attachments"] and parts[3] == "data":
                return self.send_json(table_data(parts[2]))
            if len(parts) == 4 and parts[:2] == ["api", "attachments"] and parts[3] == "drawing":
                return self.send_json(drawing_document(parts[2]))
            if len(parts) == 3 and parts[:2] == ["api", "attachments"]:
                row = attachment_row(parts[2])
                raw = (FILES / row["stored_name"]).read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", row["mime_type"])
                self.send_header("Content-Disposition", "attachment; filename*=UTF-8''" + urllib.parse.quote(row["original_name"]))
                self.send_header("Content-Length", str(len(raw)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(raw)
                return
            self.send_json({"error": "찾을 수 없습니다."}, 404)
        except (ValueError, KeyError, sqlite3.Error) as exc:
            self.send_json({"error": str(exc)}, 400)

    def do_POST(self) -> None:
        if not self.check_token():
            return
        origin = self.headers.get("Origin")
        if origin and origin not in {f"http://{HOST}:{PORT}", f"http://localhost:{PORT}"}:
            return self.send_json({"error": "접근이 허용되지 않았습니다."}, 403)
        try:
            parts = urllib.parse.urlparse(self.path).path.strip("/").split("/")
            data = self.body()
            if parts == ["api", "notebooks"]:
                return self.send_json(create_notebook(str(data.get("title", "")), str(data.get("source_url", ""))))
            if parts == ["api", "experiments"]:
                return self.send_json(create_experiment(str(data.get("title", "")), str(data.get("experiment_date", "")), str(data.get("notebook_id", "personal"))))
            if len(parts) == 3 and parts[:2] == ["api", "experiments"]:
                return self.send_json(update_experiment(parts[2], data))
            if len(parts) == 4 and parts[:2] == ["api", "experiments"] and parts[3] == "repeat":
                return self.send_json(repeat_experiment(parts[2]))
            if len(parts) == 4 and parts[:2] == ["api", "experiments"] and parts[3] == "restore":
                return self.send_json(restore_experiment(parts[2]))
            if len(parts) == 4 and parts[:2] == ["api", "experiments"] and parts[3] == "archive":
                return self.send_json(archive_experiment(parts[2]))
            if len(parts) == 5 and parts[:2] == ["api", "experiments"] and parts[3] == "sections":
                return self.send_json(update_section(parts[2], parts[4], data))
            if len(parts) == 4 and parts[:2] == ["api", "experiments"] and parts[3] == "attachments":
                return self.send_json(save_attachment(parts[2], data))
            if len(parts) == 4 and parts[:2] == ["api", "experiments"] and parts[3] == "drawings":
                return self.send_json(save_drawing(parts[2], data))
            if len(parts) == 4 and parts[:2] == ["api", "attachments"] and parts[3] == "ai-access":
                return self.send_json(update_attachment(parts[2], bool(data.get("ai_allowed"))))
            if len(parts) == 4 and parts[:2] == ["api", "attachments"] and parts[3] == "layout":
                return self.send_json(change_image_layout(parts[2], data))
            if len(parts) == 4 and parts[:2] == ["api", "experiments"] and parts[3] == "analyze":
                return self.send_json(call_local_ai(parts[2], str(data.get("question", "이 실험에서 관찰되는 점을 설명해 주세요."))))
            if parts == ["api", "papers", "search"]:
                return self.send_json({"query": str(data.get("query", "")), "papers": search_papers(str(data.get("query", "")))})
            self.send_json({"error": "찾을 수 없습니다."}, 404)
        except (ValueError, KeyError, sqlite3.Error, json.JSONDecodeError) as exc:
            self.send_json({"error": str(exc)}, 400)


if __name__ == "__main__":
    init_db()
    ThreadingHTTPServer.allow_reuse_address = False
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"로컬 랩노트 실행 중: http://{HOST}:{PORT}")
    if "--no-browser" not in sys.argv:
        threading.Timer(0.6, lambda: webbrowser.open(f"http://{HOST}:{PORT}")).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()
        sys.exit(0)
