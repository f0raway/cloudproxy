"""Exercise authenticated local monitoring without invoking cloud nodes."""
import base64
import contextlib
import http.server
import importlib.util
import json
from pathlib import Path
import socket
import tempfile
import threading
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location("watchdog", Path(__file__).with_name("watchdog.py"))
watchdog = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(watchdog)

class WatchdogTests(unittest.TestCase):
    def test_upstream_failure_is_not_a_local_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            state=Path(directory)/"state"
            with mock.patch.object(watchdog,"STATE",state), mock.patch.object(watchdog,"check",return_value={"readiness":"blocked"}), mock.patch.object(watchdog.subprocess,"run") as restart:
                watchdog.main()
                self.assertEqual(state.read_text(),"0")
                restart.assert_not_called()

    def test_corrupt_counter_recovers_and_requires_two_failures(self):
        with tempfile.TemporaryDirectory() as directory:
            state=Path(directory)/"state";state.write_text("interrupted-write")
            with mock.patch.object(watchdog,"STATE",state), mock.patch.object(watchdog,"check",side_effect=TimeoutError), mock.patch.object(watchdog.subprocess,"run") as restart, mock.patch("builtins.print"):
                watchdog.main();self.assertEqual(state.read_text(),"1");restart.assert_not_called()
                watchdog.main();restart.assert_called_once()

    def test_authenticated_local_check_and_failure_threshold(self):
        expected = "Basic " + base64.b64encode(b"test-user:test-password").decode()
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                if self.headers.get("Authorization") != expected:
                    self.send_response(401)
                    self.end_headers()
                    return
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"nodes":[{}],"mode":"tcp-tunnel-no-mitm"}')
            def log_message(self, *args):
                pass
        with tempfile.TemporaryDirectory() as directory, contextlib.ExitStack() as stack:
            server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            stack.callback(server.server_close)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            stack.callback(server.shutdown)
            sockets = [stack.enter_context(socket.socket()) for _ in range(2)]
            for sock in sockets:
                sock.bind(("127.0.0.1", 0))
                sock.listen(4)
            config = {"dashboard_addr": f"127.0.0.1:{server.server_port}",
                      "http_addr": f"127.0.0.1:{sockets[0].getsockname()[1]}",
                      "socks_addr": f"127.0.0.1:{sockets[1].getsockname()[1]}",
                      "user": "test-user", "password": "test-password"}
            path = Path(directory) / "agent.json"
            path.write_text(json.dumps(config))
            state = Path(directory) / "state"
            with mock.patch.object(watchdog, "CONFIG", path), mock.patch.object(watchdog, "STATE", state), mock.patch.object(watchdog.subprocess, "run") as restart:
                watchdog.main()
                self.assertEqual(state.read_text(), "0")
                restart.assert_not_called()
                overlay = Path(directory) / "settings.json"
                overlay.write_text(json.dumps({"user":"test-user", "password":"test-password"}))
                config["settings_path"] = str(overlay)
                config["password"] = "old-password"
                path.write_text(json.dumps(config))
                watchdog.main()
                self.assertEqual(state.read_text(), "0")
                restart.assert_not_called()
                overlay.unlink()
                config["password"] = "incorrect"
                path.write_text(json.dumps(config))
                with mock.patch("builtins.print"):
                    watchdog.main()
                    self.assertEqual(state.read_text(), "1")
                    restart.assert_not_called()
                    watchdog.main()
                restart.assert_called_once_with(["systemctl", "restart", "scf-tunnel-proxy"], check=True)
                self.assertEqual(state.read_text(), "0")

if __name__ == "__main__":
    unittest.main()
