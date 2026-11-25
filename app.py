"""Desktop window for the original research notebook interface."""

from __future__ import annotations

import ctypes
import importlib.util
import os
import sys
import threading
import time
import traceback
from http.server import ThreadingHTTPServer
from pathlib import Path

import server as labnote


def app_directory() -> Path:
    return Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent


def configure_paths(module=labnote, source_directory: Path | None = None) -> None:
    if getattr(sys, "frozen", False):
        module.WEB = Path(sys._MEIPASS) / "web"
    else:
        module.WEB = app_directory() / "web"
    if source_directory is not None:
        module.WEB = source_directory / "web"
    module.DATA = Path(os.environ.get("LABNOTE_DATA_DIR", app_directory() / "data"))
    module.FILES = module.DATA / "files"
    module.DB = module.DATA / "labnote.sqlite3"


def load_source_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"소스 파일을 읽지 못했습니다: {path.name}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_live_backend(previous, source_directory: Path, port: int):
    literature = load_source_module("labnote_live_papers", source_directory / "papers.py")
    candidate = load_source_module("labnote_live_server", source_directory / "server.py")
    candidate.literature = literature
    configure_paths(candidate, source_directory)
    candidate.TOKEN = previous.TOKEN
    candidate.PORT = port
    candidate.LIVE_MODE = True
    candidate.LIVE_VERSION = previous.LIVE_VERSION
    candidate.init_db()
    return candidate


class LiveReloader:
    def __init__(self, source_directory: Path, module, http: ThreadingHTTPServer):
        self.source_directory = source_directory
        self.module = module
        self.http = http
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self.run, name="labnote-live-reload", daemon=True)

    def snapshot(self) -> dict[str, tuple[int, int]]:
        paths = [self.source_directory / "server.py", self.source_directory / "papers.py"]
        paths.extend(path for path in (self.source_directory / "web").rglob("*")
                     if path.is_file() and path.suffix in {".html", ".css", ".js"})
        result = {}
        for path in paths:
            try:
                stat = path.stat()
                result[str(path.relative_to(self.source_directory))] = (stat.st_mtime_ns, stat.st_size)
            except FileNotFoundError:
                continue
        return result

    def run(self) -> None:
        previous = self.snapshot()
        while not self.stop_event.wait(0.75):
            changed = self.snapshot()
            if changed == previous:
                continue
            if self.stop_event.wait(0.45):
                break
            stable = self.snapshot()
            if stable != changed:
                continue
            backend_changed = any(previous.get(name) != stable.get(name) for name in ("server.py", "papers.py"))
            try:
                if backend_changed:
                    candidate = load_live_backend(self.module, self.source_directory, self.http.server_address[1])
                    self.http.RequestHandlerClass = candidate.Handler
                    self.module = candidate
                self.module.LIVE_VERSION = str(time.time_ns())
                (self.module.DATA / "live-reload-error.log").unlink(missing_ok=True)
            except Exception:
                (self.module.DATA / "live-reload-error.log").write_text(traceback.format_exc(), encoding="utf-8")
            previous = stable

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        self.thread.join(timeout=5)


def main() -> None:
    import webview

    source_directory = app_directory()
    live = all((source_directory / name).is_file() for name in ("server.py", "papers.py", "web/index.html"))
    configure_paths(labnote, source_directory if live else None)
    module = labnote
    if live:
        try:
            module = load_live_backend(labnote, source_directory, 0)
        except Exception:
            module.DATA.mkdir(parents=True, exist_ok=True)
            (module.DATA / "live-reload-error.log").write_text(traceback.format_exc(), encoding="utf-8")
            module.LIVE_MODE = True
            module.LIVE_VERSION = str(time.time_ns())
            module.init_db()
    else:
        module.init_db()
    http = ThreadingHTTPServer((module.HOST, 0), module.Handler)
    module.PORT = http.server_address[1]
    thread = threading.Thread(target=http.serve_forever, name="labnote-local", daemon=True)
    thread.start()
    reloader = LiveReloader(source_directory, module, http) if live else None
    if reloader:
        reloader.start()
    try:
        url = f"http://{module.HOST}:{module.PORT}/"
        webview.create_window(
            "연구노트 · 전자랩노트", url, width=1320, height=860,
            min_size=(900, 620), background_color="#edf2ee",
        )
        webview.start(gui="edgechromium", private_mode=True)
    finally:
        if reloader:
            reloader.stop()
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
