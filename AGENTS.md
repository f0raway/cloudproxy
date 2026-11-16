# CloudProxy product direction

The primary purpose is a stable, vendor-independent proxy pool for public users.
Tencent SCF, Cloudflare Workers and compatible WSS/TCP providers are upstream
implementations, not the product identity. AI Agent security testing is one use
case, not the only audience.

Preserve these priorities in future changes:

- Keep an established TCP connection on its chosen upstream. Never silently
  replay application bytes or migrate a live connection to another exit.
- Distinguish a running local entry, a selectable node, an observed successful
  connection, and an HTTP/business result. Do not invent health guarantees.
- Base cost scheduling on explicit rates; keep provider-specific constraints in
  their own scope. A new provider must implement the documented tunnel protocol.
- Make configuration understandable and deployment repeatable. Preserve private
  settings, usage/quota ledgers and unchanged node health when applying changes.
- Bound queues, memory and logs. Recover local processes without restart loops
  caused solely by remote outages. Keep restart/upgrade limitations explicit.
- Never commit real credentials, endpoint inventories, production logs or bills.
  UI error messages remain text, with existing secret redaction intact.
- Run the relevant Go race tests, Python operations tests and frontend checks.
  Changes to installation require a fresh-install/upgrade/rollback exercise in
  an isolated service before claiming operational verification.

Compatibility: historical binary names, systemd unit names and existing config
keys remain supported unless a documented migration is supplied.
