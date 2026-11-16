import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from email.parser import BytesParser
from email.policy import default

SPEC = importlib.util.spec_from_file_location("cloudflare_deploy", Path(__file__).with_name("cloudflare.py"))
cloudflare = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cloudflare)

class CloudflareTests(unittest.TestCase):
    def test_multipart_modules_secret_binding_and_no_paid_resources(self):
        directory = Path(__file__).resolve().parents[1] / "workers" / "cloudflare"
        body, mime = cloudflare.multipart(directory, "dummy-node-token")
        message = BytesParser(policy=default).parsebytes(("Content-Type: " + mime + "\r\nMIME-Version: 1.0\r\n\r\n").encode() + body)
        parts = {part.get_param("name", header="content-disposition"): part for part in message.iter_parts()}
        metadata = json.loads(parts["metadata"].get_payload(decode=True))
        self.assertEqual(metadata["main_module"], "worker.mjs")
        self.assertEqual(metadata["bindings"], [{"type":"secret_text","name":"CLOUD_PROXY_TOKEN","text":"dummy-node-token"}])
        self.assertNotIn("durable_objects", metadata)
        self.assertNotIn("kv_namespaces", metadata)
        self.assertFalse(metadata["observability"]["enabled"])
        self.assertEqual(parts["bridge.mjs"].get_content_type(), "application/javascript+module")
        self.assertIn(b"cloudflare:sockets", parts["worker.mjs"].get_payload(decode=True))
    def test_private_state_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state"
            cloudflare.private_write(path, "dummy")
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(path.read_text(), "dummy")


class CustomDomainTests(unittest.TestCase):
    def test_uses_bound_domain_without_modifying_dns(self):
        class FakeAPI:
            def __init__(self): self.calls = []
            def call(self, method, path):
                self.calls.append((method, path))
                return [{"hostname":"proxy.example.com", "service":"managed-worker", "enabled":True}]
        api = FakeAPI()
        endpoint = cloudflare.custom_endpoint(api, "account", "managed-worker", "Proxy.Example.COM.")
        self.assertEqual(endpoint, "wss://proxy.example.com/tunnel")
        self.assertEqual(api.calls, [("GET", "/accounts/account/workers/domains")])

    def test_refuses_wrong_worker_disabled_or_unbound_domain(self):
        for records in ([], [{"hostname":"proxy.example.com","service":"other","enabled":True}],
                        [{"hostname":"proxy.example.com","service":"managed-worker","enabled":False}]):
            class FakeAPI:
                def call(self, method, path): return records
            with self.assertRaises(cloudflare.DeploymentError):
                cloudflare.custom_endpoint(FakeAPI(), "account", "managed-worker", "proxy.example.com")

    def test_rejects_urls_paths_ports_and_invalid_hostnames(self):
        for value in ("https://proxy.example.com", "proxy.example.com:443", "proxy.example.com/tunnel", "user@proxy.example.com", "-bad.example.com", "localhost"):
            with self.assertRaises(cloudflare.DeploymentError):
                cloudflare.custom_endpoint(None, "account", "managed-worker", value)

if __name__ == "__main__":
    unittest.main()
