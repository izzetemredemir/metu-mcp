# Deploying on an Ubuntu VPS

Two systemd services share one SQLite file: `metu-mcp-worker` (collectors, the only writer) and `metu-mcp-serve`
(stateless MCP HTTP endpoint, read-only). Caddy terminates TLS in front.

## 1. System setup (once)

```bash
# Node.js 24.21.0 LTS
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs sqlite3 git
node -v   # v24.x — pin 24.21.0 if needed: sudo npm i -g n && sudo n 24.21.0
sudo corepack enable

# Caddy (https://caddyserver.com/docs/install#debian-ubuntu-raspbian)
sudo apt-get install -y caddy

# Service user and directories
sudo useradd --system --home /opt/metu-mcp --shell /usr/sbin/nologin metu
sudo mkdir -p /opt/metu-mcp /var/lib/metu-mcp
sudo chown metu:metu /opt/metu-mcp /var/lib/metu-mcp

# Firewall
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable
```

## 2. Code and configuration

```bash
sudo -u metu git clone <repo-url> /opt/metu-mcp
cd /opt/metu-mcp
sudo -u metu corepack pnpm install --frozen-lockfile
sudo -u metu corepack pnpm build

sudo cp .env.example /etc/metu-mcp.env && sudo chmod 640 /etc/metu-mcp.env && sudo chgrp metu /etc/metu-mcp.env
sudoedit /etc/metu-mcp.env   # set METU_MCP_CONTACT, METU_MCP_ALLOWED_HOSTS=<your domain>, METU_MCP_DB=/var/lib/metu-mcp/metu.db
```

## 3. Services

```bash
sudo cp deploy/metu-mcp-serve.service deploy/metu-mcp-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now metu-mcp-worker   # first start collects every source (a few minutes)
sudo systemctl enable --now metu-mcp-serve
journalctl -u metu-mcp-worker -f
```

## 4. HTTPS

Point a DNS record (e.g. `mcp.example.com`) at the VPS, then:

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # replace mcp.example.com
sudo systemctl reload caddy
curl https://mcp.example.com/healthz
```

## 5. Operations

- **Update:** `scripts/deploy.sh` (git pull, install, build, restart, health check).
- **Backups:** `sudo crontab -u metu -e` → `30 3 * * * /opt/metu-mcp/scripts/backup.sh` (7 days kept). The data can be
  re-collected, but change history (`record_versions`) cannot.
- **Monitoring:** `/healthz` reports collectors failing 3+ times; `node dist/cli.js status` prints every collector.
  Worker logs mark repeated failures with `ERROR` — usually a METU page layout change: record a new fixture, fix the
  parser, add a test.
- **Parking rules:** when `metu_parking_check` warns that the official page changed, re-read it, update
  `data/parking_rules.yaml` and bump `verified_on`.

## 6. Connecting clients

- Claude (web/desktop): Settings → Connectors → Add custom connector → `https://mcp.example.com/mcp`
- Claude Code: `claude mcp add --transport http metu https://mcp.example.com/mcp`
- MCP Inspector: `npx @modelcontextprotocol/inspector --server-url https://mcp.example.com/mcp --transport http`
