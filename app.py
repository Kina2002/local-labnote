"""Desktop window for the original research notebook interface."""

from __future__ import annotations

import ctypes
import os
import sys
import threading
import traceback
from http.server import ThreadingHTTPServer
from pathlib import Path

import server as labnote


def configure_paths() -> None:
    if getattr(sys, "frozen", False):
        app_directory = Path(sys.executable).resolve().parent
        labnote.WEB = Path(sys._MEIPASS) / "web"
    else:
        app_directory = Path(__file__).resolve().parent
    labnote.DATA = Path(os.environ.get("LABNOTE_DATA_DIR", app_directory / "data"))
    labnote.FILES = labnote.DATA / "files"
    labnote.DB = labnote.DATA / "labnote.sqlite3"


def main() -> None:
    import webview

    configure_paths()
    labnote.init_db()
    http = ThreadingHTTPServer((labnote.HOST, 0), labnote.Handler)
    labnote.PORT = http.server_address[1]
    thread = threading.Thread(target=http.serve_forever, name="labnote-local", daemon=True)
    thread.start()
    try:
        url = f"http://{labnote.HOST}:{labnote.PORT}/"
        webview.create_window(
            "연구노트 · 전자랩노트", url, width=1320, height=860,
            min_size=(900, 620), background_color="#edf2ee",
        )
        webview.start(gui="edgechromium", private_mode=True)
    finally:
        http.shutdown()
        http.server_close()
        thread.join(timeout=5)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        configure_paths()
        labnote.DATA.mkdir(parents=True, exist_ok=True)
        (labnote.DATA / "app-error.log").write_text(traceback.format_exc(), encoding="utf-8")
        ctypes.windll.user32.MessageBoxW(None, str(exc), "전자랩노트 실행 오류", 0x10)
        raise
