#!/usr/bin/env python3
"""Optional read-only SCF account bill cache. Does not invoke SCF functions."""
import argparse
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import grp
import json
import os
from pathlib import Path
import tempfile
import tomllib


def summary(response, month, now):
    if "Response" in response:
        response = response["Response"]
    rows = response.get("SummaryOverview")
    if not isinstance(rows, list):
        raise ValueError("invalid billing response")
    total = Decimal("0")
    for row in rows:
        if row.get("BusinessCode") == "p_scf":
            total += Decimal(str(row["RealTotalCost"]))
    if not total.is_finite() or total < 0:
        raise ValueError("invalid SCF bill amount")
    return {"month": month, "scf_total_yuan": float(total),
            "updated_at": now.isoformat(), "scope": "account_scf"}


def write_cache(path, payload, group=None):
    path = Path(path)
    path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    name = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, prefix=".billing-", delete=False) as temporary:
            name = temporary.name
            json.dump(payload, temporary)
            temporary.write("\n")
            if group:
                os.fchown(temporary.fileno(), -1, grp.getgrnam(group).gr_gid)
            os.fchmod(temporary.fileno(), 0o640)
        os.replace(name, path)
    finally:
        if name and os.path.exists(name):
            os.unlink(name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--credentials", required=True, help="private TOML with [tencent] secret_id/secret_key")
    parser.add_argument("--output", required=True)
    parser.add_argument("--group", help="group permitted to read the cache")
    args = parser.parse_args()
    try:
        from tencentcloud.common import credential
        from tencentcloud.common.common_client import CommonClient
        from tencentcloud.common.profile.client_profile import ClientProfile
        from tencentcloud.common.profile.http_profile import HttpProfile
        credentials = tomllib.loads(Path(args.credentials).read_text())["tencent"]
        http = HttpProfile()
        http.endpoint, http.reqTimeout = "billing.tencentcloudapi.com", 20
        profile = ClientProfile()
        profile.httpProfile = http
        client = CommonClient("billing", "2018-07-09", credential.Credential(
            credentials["secret_id"], credentials["secret_key"], credentials.get("token")), "", profile)
        now = datetime.now(timezone(timedelta(hours=8)))
        month = now.strftime("%Y-%m")
        response = client.call_json("DescribeBillSummaryByProduct", {"BeginTime": month, "EndTime": month})
        write_cache(args.output, summary(response, month, now), args.group)
        print("SCF account bill cache updated; billing data can be delayed.")
        return 0
    except Exception as error:
        # Never print SDK messages or configuration values, which may echo credentials.
        code = getattr(error, "get_code", lambda: type(error).__name__)()
        print("SCF billing sync failed:", code, "previous cache retained")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
