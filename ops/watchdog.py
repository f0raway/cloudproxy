#!/usr/bin/env python3
"""Restart only an unhealthy local entry; upstream outages must not cause restart loops."""
from pathlib import Path
import subprocess
from local_health import address, check

CONFIG = Path("/etc/scf-tunnel-proxy/agent.json")
STATE = Path("/var/lib/scf-tunnel-proxy/watchdog-failures")


def main():
    try:
        check(CONFIG)
    except Exception as error:
        try:
            previous = max(0, int(STATE.read_text().strip()))
        except (OSError, ValueError):
            previous = 0
        count = min(previous + 1, 2)
        STATE.write_text(str(count))
        print("local_health_failure", count, type(error).__name__)
        if count >= 2:
            subprocess.run(["systemctl", "restart", "scf-tunnel-proxy"], check=True)
            STATE.write_text("0")
    else:
        STATE.write_text("0")

if __name__ == "__main__":
    main()
