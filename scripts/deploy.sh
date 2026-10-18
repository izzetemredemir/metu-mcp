#!/usr/bin/env bash
# Update the running deployment on the VPS. Run as a sudo-capable user from /opt/metu-mcp.
set -euo pipefail
cd /opt/metu-mcp
sudo -u metu git pull --ff-only
sudo -u metu corepack pnpm install --frozen-lockfile
sudo -u metu corepack pnpm build
sudo systemctl restart metu-mcp-worker metu-mcp-serve
sleep 2
curl -fsS http://127.0.0.1:8787/healthz && echo
