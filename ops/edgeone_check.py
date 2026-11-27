#!/usr/bin/env python3
"""Deploy or verify a privately authorized EdgeOne node without logging secrets."""
import argparse
import http.cookiejar
import json
import os
from pathlib import Path
import secrets
import subprocess
import urllib.error
from urllib.parse import urlsplit, urlunsplit
import urllib.request


def private_dir():
    return Path(os.environ.get("CLOUDPROXY_PRIVATE_DIR", Path.home() / "Library/Application Support/cloudproxy"))


def private_write(path, text):
    path.touch(mode=0o600, exist_ok=True)
    path.write_text(text)


def node_token(cli, project):
    path = private_dir() / "edgeone-node-token"
    if not path.exists():
        private_write(path, secrets.token_urlsafe(48))
    token = path.read_text().strip()
    subprocess.run([cli, "makers", "env", "set", "CLOUDPROXY_NODE_TOKEN", token, "-e", "production"],
                   cwd=Path(__file__).parent.parent / "workers/edgeone", capture_output=True, text=True, check=True)
    return token


def deploy(cli, project, area):
    directory = Path(__file__).parent.parent / "workers/edgeone"
    private_dir().mkdir(mode=0o700, parents=True, exist_ok=True)
    subprocess.run([cli, "makers", "link", "-n", project, "-a", area, "--mode", "auto", "--skip-env-sync", "--json"],
                   cwd=directory, capture_output=True, text=True, check=True)
    node_token(cli, project)
    result = subprocess.run([cli, "makers", "deploy", "-n", project, "-a", area, "--skip-ai-gateway-sync", "--json"],
                            cwd=directory, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError("EdgeOne deployment failed; inspect the official CLI directly for details")
    record = json.loads(result.stdout.strip().splitlines()[-1])
    if record.get("status") != "success":
        raise RuntimeError("EdgeOne deployment did not succeed")
    private_write(private_dir() / "edgeone-access.json", json.dumps(record))
    print("EdgeOne deployment succeeded; checking TCP separately")


def cookies(url):
    jar = http.cookiejar.CookieJar()
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args):
            return None
    try:
        urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), NoRedirect).open(url, timeout=15)
    except urllib.error.HTTPError:
        pass
    return "; ".join(item.name + "=" + item.value for item in jar)


def check(path):
    access = json.loads((private_dir() / "edgeone-access.json").read_text())
    parsed = urlsplit(access["url"])
    env = dict(os.environ)
    env["EDGEONE_LIVE_URL"] = urlunsplit(("wss", parsed.netloc, path, "", ""))
    env["EDGEONE_LIVE_TOKEN"] = (private_dir() / "edgeone-node-token").read_text().strip()
    env["EDGEONE_ACCESS_COOKIE"] = cookies(access["url"])
    subprocess.run(["go", "test", "-run", "^TestEdgeOneLiveTCP$", "-v", "-count=1", "."],
                   cwd=Path(__file__).parent.parent, env=env, check=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--deploy", action="store_true")
    parser.add_argument("--project", default="cloudproxy-node")
    parser.add_argument("--path", default="/tunnel")
    parser.add_argument("--area", default="global", choices=("global", "overseas"))
    parser.add_argument("--cli", default=os.environ.get("EDGEONE_CLI", "edgeone"))
    args = parser.parse_args()
    if args.deploy:
        deploy(args.cli, args.project, args.area)
    check(args.path)
