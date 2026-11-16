import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC=importlib.util.spec_from_file_location("configure",Path(__file__).with_name("configure.py"))
configure=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(configure)

class ConfigureTests(unittest.TestCase):
    def test_private_per_node_config_without_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"agent.json"
            rates={"compute_yuan_per_second":0,"traffic_yuan_per_gb":0,"request_yuan":0}
            configure.create_config(path,"custom","wss://example.org/tunnel","node-token","user","test-password",8,rates)
            config=json.loads(path.read_text())
            self.assertNotIn("token",config)
            self.assertEqual(config["nodes"][0]["token"],"node-token")
            self.assertEqual(path.stat().st_mode&0o777,0o600)
            before=path.read_bytes()
            with self.assertRaises(FileExistsError):
                configure.create_config(path,"custom","wss://example.org/tunnel","other","user","test-password",8,rates)
            self.assertEqual(path.read_bytes(),before)

    def test_rejects_missing_cost_model_and_unsafe_url(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"agent.json"
            for url,rates in [("wss://example.org/tunnel",None),("wss://user:password@example.org/tunnel",{})]:
                with self.assertRaises(ValueError):
                    configure.create_config(path,"custom",url,"token","user","test-password",8,rates)
                self.assertFalse(path.exists())
