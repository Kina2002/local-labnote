"""The live desktop launcher keeps one window while source files change."""

import os
import shutil
import tempfile
import threading
import time
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import app
import server


class LiveReloadTests(unittest.TestCase):
    def test_assets_and_backend_reload_without_restarting_http_server(self):
        project = Path(__file__).resolve().parent
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "web").mkdir()
            for name in ("server.py", "papers.py"):
                shutil.copyfile(project / name, root / name)
            (root / "web" / "index.html").write_text("__SESSION_TOKEN__<!--LIVE_RELOAD-->", encoding="utf-8")

            with patch.dict(os.environ, {"LABNOTE_DATA_DIR": str(root / "data")}):
                module = app.load_live_backend(server, root, 0)
                http = ThreadingHTTPServer(("127.0.0.1", 0), module.Handler)
                module.PORT = http.server_address[1]
                serving = threading.Thread(target=http.serve_forever, daemon=True)
                serving.start()
                reloader = app.LiveReloader(root, module, http)
                reloader.start()
                try:
                    base = f"http://127.0.0.1:{module.PORT}"

                    def get(path):
                        request = urllib.request.Request(base + path, headers={"X-Labnote-Token": module.TOKEN})
                        with urllib.request.urlopen(request, timeout=2) as response:
                            return response.read().decode()

                    def wait_for_version(previous):
                        deadline = time.monotonic() + 6
                        while time.monotonic() < deadline:
                            version = get("/api/live-version")
                            if version != previous:
                                return version
                            time.sleep(0.2)
                        self.fail("Live version did not change")

                    self.assertIn('/live-reload.js', get("/"))
                    initial = get("/api/live-version")
                    (root / "web" / "new-style.css").write_text("body{font-size:12px}", encoding="utf-8")
                    updated = wait_for_version(initial)
                    first_handler = http.RequestHandlerClass
                    with (root / "server.py").open("a", encoding="utf-8") as source:
                        source.write("\n# live reload test\n")
                    wait_for_version(updated)
                    self.assertIsNot(http.RequestHandlerClass, first_handler)
                    self.assertEqual(http.server_address[1], module.PORT)
                finally:
                    reloader.stop()
                    http.shutdown()
                    http.server_close()
                    serving.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
