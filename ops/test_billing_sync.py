"""Billing parsing and cache tests never use Tencent credentials or APIs."""
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import stat
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("billing_sync", Path(__file__).with_name("billing_sync.py"))
billing = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(billing)

class BillingTests(unittest.TestCase):
    def test_scf_only_and_current_month_label(self):
        now = datetime(2026, 11, 16, tzinfo=timezone.utc)
        payload = billing.summary({"SummaryOverview": [
            {"BusinessCode": "p_scf", "RealTotalCost": "3.50"},
            {"BusinessCode": "p_cvm", "RealTotalCost": "9000"}]}, "2026-11", now)
        self.assertEqual(payload["scf_total_yuan"], 3.5)
        self.assertEqual(payload["scope"], "account_scf")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bill.json"
            billing.write_cache(path, payload)
            self.assertEqual(json.loads(path.read_text()), payload)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o640)
            self.assertEqual(list(path.parent.glob(".billing-*")), [])

    def test_invalid_response_cannot_be_published_as_zero(self):
        for response in ({}, {"SummaryOverview": "invalid"},
                         {"SummaryOverview": [{"BusinessCode": "p_scf", "RealTotalCost": "NaN"}]},
                         {"SummaryOverview": [{"BusinessCode": "p_scf", "RealTotalCost": "-1"}]}):
            with self.assertRaises((ValueError, KeyError)):
                billing.summary(response, "2026-11", datetime.now(timezone.utc))

if __name__ == "__main__":
    unittest.main()
