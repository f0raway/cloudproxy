"""Private EdgeOne deployment records never become repository content."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location("edgeone_check", Path(__file__).with_name("edgeone_check.py"))
edgeone = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(edgeone)


class EdgeOneCheckTests(unittest.TestCase):
    def test_node_token_is_random_private_and_not_logged(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(os.environ, {"CLOUDPROXY_PRIVATE_DIR": directory}):
            with mock.patch.object(edgeone.subprocess, "run") as run:
                token = edgeone.node_token("edgeone", "cloudproxy-test")
                self.assertEqual(edgeone.node_token("edgeone", "cloudproxy-test"), token)
                self.assertGreaterEqual(len(token), 48)
                path = Path(directory) / "edgeone-node-token"
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                self.assertEqual(token, run.call_args.args[0][5])
                self.assertNotIn(token, run.call_args.args[0][:4])

    def test_deploy_access_record_is_private(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(os.environ, {"CLOUDPROXY_PRIVATE_DIR": directory}):
            record = {"status": "success", "url": "https://node.example/?eo_token=private", "projectId": "test"}
            calls = [subprocess.CompletedProcess([], 0, stdout=""), subprocess.CompletedProcess([], 0, stdout=json.dumps(record) + "\n")]
            with mock.patch.object(edgeone, "node_token", return_value="private-node-token"), mock.patch.object(edgeone.subprocess, "run", side_effect=calls) as run:
                edgeone.deploy("edgeone", "cloudproxy-test", "overseas")
                self.assertIn("--mode", run.call_args_list[0].args[0])
                self.assertIn("overseas", run.call_args_list[0].args[0])
            saved = Path(directory) / "edgeone-access.json"
            self.assertEqual(json.loads(saved.read_text()), record)
            self.assertEqual(saved.stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
