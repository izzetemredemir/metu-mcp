#!/usr/bin/env bash
# Daily SQLite backup (cron: 30 3 * * * /opt/metu-mcp/scripts/backup.sh). Keeps 7 days.
set -euo pipefail
DB=${METU_MCP_DB:-/var/lib/metu-mcp/metu.db}
DIR=/var/lib/metu-mcp/backups
mkdir -p "$DIR"
sqlite3 "$DB" ".backup '$DIR/metu-$(date +%F).db'"
find "$DIR" -name 'metu-*.db' -mtime +7 -delete
