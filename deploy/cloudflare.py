#!/usr/bin/env python3
"""Deploy the protocol-2 Worker without enabling a paid plan or creating KV/DOs."""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import secrets
import sys
import tomllib
import urllib.error
import urllib.request

MANAGED_TAG = "scf-tunnel-proxy-managed"

class DeploymentError(Exception):
    pass

class API:
    def __init__(self, token):
        self.token = token
    def call(self, method, path, body=None, content_type="application/json", missing=False):
        if body is not None and not isinstance(body, bytes):
            body = json.dumps(body).encode()
        request = urllib.request.Request("https://api.cloudflare.com/client/v4" + path,
            data=body, method=method, headers={"Authorization": "Bearer " + self.token,
                "Content-Type": content_type})
        try:
            with urllib.request.urlopen(request, timeout=40) as response:
                result = json.load(response)
        except urllib.error.HTTPError as error:
            if missing and error.code == 404:
                return None
            try:
                codes = [str(e.get("code")) for e in json.load(error).get("errors", [])]
            except Exception:
                codes = []
            raise DeploymentError("Cloudflare API HTTP " + str(error.code) + " codes=" + ",".join(codes)) from None
        if not result.get("success"):
            raise DeploymentError("Cloudflare API rejected request; verify account, token permissions and Worker name")
        return result.get("result")


def multipart(directory, token):
    boundary = "cloudtunnel-" + secrets.token_hex(12)
    metadata = {"main_module": "worker.mjs", "compatibility_date": "2025-01-01",
        "bindings": [{"type": "secret_text", "name": "CLOUD_PROXY_TOKEN", "text": token}],
        "tags": [MANAGED_TAG], "observability": {"enabled": False}}
    parts = [("metadata", None, "application/json", json.dumps(metadata).encode())]
    for name in ("worker.mjs", "bridge.mjs"):
        parts.append((name, name, "application/javascript+module", (Path(directory) / name).read_bytes()))
    chunks = []
    for name, filename, mime, data in parts:
        disposition = f'Content-Disposition: form-data; name="{name}"'
        if filename:
            disposition += f'; filename="{filename}"'
        chunks.append(("--" + boundary + "\r\n" + disposition + "\r\nContent-Type: " + mime + "\r\n\r\n").encode() + data + b"\r\n")
    chunks.append(("--" + boundary + "--\r\n").encode())
    return b"".join(chunks), "multipart/form-data; boundary=" + boundary


def private_write(path, text):
    path = Path(path)
    temporary = path.with_name(path.name + ".new")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.chmod(temporary, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write(text)
    os.replace(temporary, path)


def register_node(agent_path, endpoint, token, account):
    agent = json.loads(Path(agent_path).read_text())
    overlay = Path(agent.get("settings_path") or Path(agent["ledger_path"]).with_name("settings.json"))
    if overlay.exists():
        effective = json.loads(overlay.read_text())
        agent.update({k:effective[k] for k in ("user", "password")})
    host, port = agent["dashboard_addr"].rsplit(":", 1)
    if host in ("0.0.0.0", ""):
        host = "127.0.0.1"
    if host == "[::]":
        host = "[::1]"
    base = f"http://{host}:{port}"
    authorization = "Basic " + base64.b64encode((agent["user"] + ":" + agent["password"]).encode()).decode()
    request = urllib.request.Request(base + "/api/settings", headers={"Authorization": authorization})
    with urllib.request.urlopen(request, timeout=10) as response:
        result = json.load(response)
    settings = result["settings"]
    node = {"provider": "cloudflare", "region": "Cloudflare Global", "url": endpoint,
            "token": token, "quota_group": "cf-" + account}
    nodes = [n for n in settings["nodes"] if n["url"] != endpoint]
    settings["nodes"] = nodes + [node]
    request = urllib.request.Request(base + "/api/settings", method="POST", data=json.dumps(settings).encode(),
        headers={"Authorization": authorization, "X-CSRF-Token": result["csrf_token"], "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=10) as response:
        if not json.load(response).get("saved"):
            raise DeploymentError("Worker deployed but registration was not acknowledged")


def custom_endpoint(api, account, worker, hostname):
    hostname = hostname.strip().lower().rstrip(".")
    labels = hostname.split(".")
    if len(hostname) > 253 or len(labels) < 2 or any(
        not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in labels
    ):
        raise DeploymentError("custom_domain must be a hostname, without URL scheme, path or port")
    domains = api.call("GET", "/accounts/" + account + "/workers/domains")
    matches = [domain for domain in domains if domain.get("hostname", "").lower() == hostname]
    if len(matches) != 1 or matches[0].get("service") != worker or not matches[0].get("enabled"):
        raise DeploymentError("custom_domain must already be enabled and bound to this managed Worker in the selected account")
    return "wss://" + hostname + "/tunnel"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--credentials", default="config/cloudflare.toml")
    parser.add_argument("--agent-config", default="/etc/scf-tunnel-proxy/agent.json")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--no-register", action="store_true")
    args = parser.parse_args(argv)
    directory = Path(__file__).resolve().parents[1] / "workers" / "cloudflare"
    if args.dry_run:
        package, _ = multipart(directory, "dry-run-placeholder")
        print(json.dumps({"platform": "cloudflare", "package_bytes": len(package),
            "paid_plan_changes": False, "durable_objects": False, "cloud_calls": 0}))
        return 0
    path = Path(args.credentials)
    if path.stat().st_mode & 0o077:
        raise DeploymentError("Cloudflare credential file must have permission 600")
    config = tomllib.loads(path.read_text())["cloudflare"]
    account, token = config.get("account_id", ""), config.get("api_token", "")
    name = config.get("worker_name", "cloud-tunnel-proxy")
    if not re.fullmatch(r"[a-fA-F0-9]{32}", account) or not token:
        raise DeploymentError("Fill cloudflare.account_id (32 hex characters) and api_token in the private file")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", name):
        raise DeploymentError("Worker name must use lowercase letters, digits and hyphens")
    api = API(token)
    prefix = "/accounts/" + account + "/workers"
    existing = api.call("GET", prefix + "/scripts/" + name + "/settings", missing=True)
    if existing is not None and MANAGED_TAG not in existing.get("tags", []):
        raise DeploymentError("Worker name is already in use by an unmanaged script; choose another worker_name")
    custom = config.get("custom_domain", "")
    endpoint = custom_endpoint(api, account, name, custom) if custom else None
    subdomain = None
    if not custom:
        subdomain = api.call("GET", prefix + "/subdomain", missing=True)
        if not subdomain or not subdomain.get("subdomain"):
            subdomain = api.call("PUT", prefix + "/subdomain", {"subdomain": "cloud-tunnel-" + secrets.token_hex(5)})
    token_path = path.with_name("cloudflare-node-token")
    node_token = token_path.read_text().strip() if token_path.exists() else secrets.token_urlsafe(40)
    if len(node_token) < 24:
        raise DeploymentError("Stored Cloudflare node token is too short")
    private_write(token_path, node_token)
    payload, content_type = multipart(directory, node_token)
    api.call("PUT", prefix + "/scripts/" + name, payload, content_type)
    if not custom:
        api.call("POST", prefix + "/scripts/" + name + "/subdomain", {"enabled": True, "previews_enabled": False})
        endpoint = "wss://" + name + "." + subdomain["subdomain"] + ".workers.dev/tunnel"
    if not args.no_register:
        register_node(args.agent_config, endpoint, node_token, account)
    private_write(path.with_name("cloudflare-node.json"), json.dumps({"url": endpoint, "token": node_token,
        "provider": "cloudflare", "quota_group": "cf-" + account}, indent=2))
    print("Cloudflare Worker deployed" + (" and registered" if not args.no_register else "") + "; no paid plan, KV or Durable Objects enabled.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except DeploymentError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        # No raw exceptions: URLs and SDK payloads can contain credentials.
        print("Cloudflare deployment failed: " + type(error).__name__ + "; private configuration preserved", file=sys.stderr)
        sys.exit(1)
