#!/usr/bin/env bash
# Generic systemd installation/upgrade. Preserves ledgers and rolls back service files on failure.
set -euo pipefail
if [[ ${EUID} -ne 0 || $# -ne 2 ]]; then
  echo 'Usage: sudo bash ops/install.sh BINARY AGENT_CONFIG' >&2
  exit 2
fi
BINARY=$(realpath "$1")
AGENT_CONFIG=$(realpath "$2")
OPS_DIR=$(cd "$(dirname "$0")" && pwd)
python3 - "$AGENT_CONFIG" "$BINARY" <<'PY'
import json,sys,platform
from pathlib import Path
machine={'x86_64':62,'aarch64':183}.get(platform.machine())
data=Path(sys.argv[2]).read_bytes()[:20]
if machine is None or len(data)<20 or data[:4]!=b'\x7fELF' or data[4]!=2 or int.from_bytes(data[18:20],'little')!=machine:
    raise SystemExit('Use a Linux amd64/arm64 binary matching this server')
c=json.load(open(sys.argv[1]))
if c.get('ledger_path')!='/var/lib/scf-tunnel-proxy/usage.json':
    raise SystemExit('Generic installer requires /var/lib/scf-tunnel-proxy/usage.json; see existing-deployment docs')
if c.get('settings_path','/var/lib/scf-tunnel-proxy/settings.json')!='/var/lib/scf-tunnel-proxy/settings.json':
    raise SystemExit('Generic installer requires settings inside /var/lib/scf-tunnel-proxy')
if c.get('dashboard_addr','').rsplit(':',1)[0] not in ('127.0.0.1','localhost','[::1]'):
    raise SystemExit('Dashboard must be loopback-only; use an SSH tunnel to open it')
PY
"$BINARY" -check -config "$AGENT_CONFIG"
if ! getent passwd scftunnel >/dev/null; then
  useradd --system --home /var/lib/scf-tunnel-proxy --shell /usr/sbin/nologin scftunnel
fi
install -d -m 755 /opt/scf-tunnel-proxy
install -d -m 750 -o root -g scftunnel /etc/scf-tunnel-proxy
install -d -m 700 -o scftunnel -g scftunnel /var/lib/scf-tunnel-proxy
install -d -m 755 /var/backups
BACKUP_DIR=$(mktemp -d "/var/backups/cloudproxy-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
chmod 700 "$BACKUP_DIR"
FILES=(/opt/scf-tunnel-proxy/scf-tunnel /opt/scf-tunnel-proxy/watchdog.py /opt/scf-tunnel-proxy/local_health.py /opt/scf-tunnel-proxy/billing_sync.py /etc/scf-tunnel-proxy/agent.json /etc/systemd/system/scf-tunnel-proxy.service /etc/systemd/system/scf-tunnel-proxy-watchdog.service /etc/systemd/system/scf-tunnel-proxy-watchdog.timer)
for path in "${FILES[@]}"; do
  if [[ -f "$path" ]]; then mkdir -p "$BACKUP_DIR$(dirname "$path")"; cp -p "$path" "$BACKUP_DIR$path"; fi
done
WAS_ACTIVE=false; TIMER_ACTIVE=false
if systemctl is-active --quiet scf-tunnel-proxy; then WAS_ACTIVE=true; fi
if systemctl is-active --quiet scf-tunnel-proxy-watchdog.timer; then TIMER_ACTIVE=true; fi
rollback() {
  status=$?
  trap - ERR
  set +e
  systemctl stop scf-tunnel-proxy-watchdog.timer scf-tunnel-proxy-watchdog.service scf-tunnel-proxy
  for path in "${FILES[@]}"; do
    if [[ -f "$BACKUP_DIR$path" ]]; then cp -p "$BACKUP_DIR$path" "$path"; else rm -f -- "$path"; fi
  done
  systemctl daemon-reload
  if $WAS_ACTIVE; then systemctl start scf-tunnel-proxy; fi
  if $TIMER_ACTIVE; then systemctl start scf-tunnel-proxy-watchdog.timer; fi
  echo "Upgrade failed. Previous service files restored; usage ledgers were not rolled back. Backup: $BACKUP_DIR" >&2
  exit "$status"
}
trap rollback ERR
# Stop the checker itself as well as the timer before touching the process or files.
systemctl stop scf-tunnel-proxy-watchdog.timer scf-tunnel-proxy-watchdog.service 2>/dev/null || true
systemctl stop scf-tunnel-proxy 2>/dev/null || true
# A stopped process gives a consistent private data snapshot. Never auto-restore usage ledgers.
(umask 077; tar -czf "$BACKUP_DIR/data.tar.gz" -C /var/lib scf-tunnel-proxy)
install -m 755 "$BINARY" /opt/scf-tunnel-proxy/.binary-new
mv /opt/scf-tunnel-proxy/.binary-new /opt/scf-tunnel-proxy/scf-tunnel
install -o root -g scftunnel -m 640 "$AGENT_CONFIG" /etc/scf-tunnel-proxy/.config-new
mv /etc/scf-tunnel-proxy/.config-new /etc/scf-tunnel-proxy/agent.json
for helper in watchdog.py local_health.py billing_sync.py; do install -m 755 "$OPS_DIR/$helper" "/opt/scf-tunnel-proxy/$helper"; done
install -m 644 "$OPS_DIR/scf-tunnel-proxy.service" /etc/systemd/system/scf-tunnel-proxy.service
cat > /etc/systemd/system/scf-tunnel-proxy-watchdog.service <<'SERVICE'
[Unit]
Description=Check CloudProxy local entry without contacting upstream nodes
After=scf-tunnel-proxy.service
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /opt/scf-tunnel-proxy/watchdog.py
SERVICE
cat > /etc/systemd/system/scf-tunnel-proxy-watchdog.timer <<'TIMER'
[Unit]
Description=Check CloudProxy entry every two minutes
[Timer]
OnBootSec=3min
OnUnitActiveSec=2min
AccuracySec=15s
[Install]
WantedBy=timers.target
TIMER
runuser -u scftunnel -- /opt/scf-tunnel-proxy/scf-tunnel -check -config /etc/scf-tunnel-proxy/agent.json
systemctl daemon-reload
systemctl start scf-tunnel-proxy
HEALTHY=false
for attempt in {1..20}; do
  if python3 /opt/scf-tunnel-proxy/local_health.py >/dev/null 2>&1; then HEALTHY=true; break; fi
  sleep 0.5
done
$HEALTHY
systemctl enable scf-tunnel-proxy
systemctl enable --now scf-tunnel-proxy-watchdog.timer
trap - ERR
printf 'CloudProxy installed; authenticated local check passed. Backup: %s\n' "$BACKUP_DIR"
printf 'Upstream forwarding still requires an authenticated TCP/TLS test. No firewall rules were changed.\n'
