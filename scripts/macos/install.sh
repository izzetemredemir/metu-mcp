#!/usr/bin/env bash
# Runs metu-mcp on this Mac: builds the project, installs a launchd agent for the collector worker (starts at login,
# restarted if it exits) and prints the command that connects Claude Code over stdio.
#
#   scripts/macos/install.sh [--seed-from path/to/existing.db]
#
# Data:  ~/Library/Application Support/metu-mcp/metu.db
# Logs:  ~/Library/Logs/metu-mcp/worker.log
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
LABEL="local.metu-mcp.worker"
DATA_DIR="$HOME/Library/Application Support/metu-mcp"
DB="$DATA_DIR/metu.db"
LOG_DIR="$HOME/Library/Logs/metu-mcp"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
WANT_NODE="$(cat "$REPO/.nvmrc")"

SEED=""
if [[ "${1:-}" == "--seed-from" ]]; then SEED="${2:?path to a database}"; fi

# launchd does not load nvm: resolve an absolute path to the right Node version.
NODE="$(command -v node || true)"
if [[ -z "$NODE" || "$("$NODE" -v)" != "v$WANT_NODE" ]]; then
  NODE="$HOME/.nvm/versions/node/v$WANT_NODE/bin/node"
fi
[[ -x "$NODE" && "$("$NODE" -v)" == "v$WANT_NODE" ]] || { echo "Node $WANT_NODE not found (nvm install $WANT_NODE)"; exit 1; }

echo "Building with $NODE"
(cd "$REPO" && PATH="$(dirname "$NODE"):$PATH" pnpm build)

mkdir -p "$DATA_DIR" "$LOG_DIR" "$(dirname "$PLIST")"
if [[ -n "$SEED" && ! -f "$DB" ]]; then
  echo "Seeding $DB from $SEED"
  "$NODE" -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync(process.argv[1]).exec(\"VACUUM INTO '\"+process.argv[2].replace(/'/g,\"''\")+\"'\")" "$SEED" "$DB"
fi

CONTACT_ENTRY=""
if [[ -n "${METU_MCP_CONTACT:-}" ]]; then
  CONTACT_ENTRY="<key>METU_MCP_CONTACT</key><string>${METU_MCP_CONTACT}</string>"
fi

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$REPO/dist/cli.js</string><string>worker</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>METU_MCP_DB</key><string>$DB</string>
    $CONTACT_ENTRY
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOG_DIR/worker.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/worker.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Worker started ($LABEL). Log: $LOG_DIR/worker.log"
echo
echo "Connect Claude Code (all projects):"
echo "  claude mcp add -s user metu -e METU_MCP_DB=\"$DB\" -- \"$NODE\" \"$REPO/dist/cli.js\" serve --stdio"
echo
echo "Claude Desktop: add under \"mcpServers\" in ~/Library/Application Support/Claude/claude_desktop_config.json, then restart it:"
cat <<JSON
  "metu": {
    "command": "$NODE",
    "args": ["$REPO/dist/cli.js", "serve", "--stdio"],
    "env": { "METU_MCP_DB": "$DB" }
  }
JSON
