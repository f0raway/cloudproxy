#!/usr/bin/env python3
"""Authenticated local checks. Never contacts upstream nodes or targets."""
import base64
import json
from pathlib import Path
import socket
import urllib.request


def address(value):
    host, port = value.rsplit(":", 1)
    host = host.strip("[]")
    if host in ("", "0.0.0.0"):
        host = "127.0.0.1"
    if host == "::":
        host = "::1"
    return host, int(port)


def check(config_path):
    config = json.loads(Path(config_path).read_text())
    settings = config.get("settings_path")
    if not settings and config.get("ledger_path"):
        settings = str(Path(config["ledger_path"]).with_name("settings.json"))
    if settings and Path(settings).exists():
        overrides = json.loads(Path(settings).read_text())
        config["user"], config["password"] = overrides["user"], overrides["password"]
    host, port = address(config["dashboard_addr"])
    url_host = "[" + host + "]" if ":" in host else host
    request = urllib.request.Request(f"http://{url_host}:{port}/api/stats")
    credentials = base64.b64encode((config["user"] + ":" + config["password"]).encode()).decode()
    request.add_header("Authorization", "Basic " + credentials)
    # HTTP_PROXY/ALL_PROXY may point back at this very service.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=5) as response:
        stats = json.load(response)
    if not stats.get("nodes") or stats.get("mode") != "tcp-tunnel-no-mitm":
        raise ValueError("invalid local status")
    for key in ("http_addr", "socks_addr"):
        with socket.create_connection(address(config[key]), timeout=5):
            pass
    return stats

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="/etc/scf-tunnel-proxy/agent.json")
    args = parser.parse_args()
    try:
        stats = check(args.config)
        print(json.dumps({"local_service": "ok", "upstream_readiness": stats.get("readiness", "unknown"),
                          "eligible_nodes": stats.get("eligible_nodes"), "version": stats.get("version")}))
    except Exception as error:
        raise SystemExit("Local health check failed: " + type(error).__name__)
