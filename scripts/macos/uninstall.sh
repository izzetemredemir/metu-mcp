#!/usr/bin/env bash
# Stops and removes the metu-mcp launchd worker. The database and logs are kept.
set -euo pipefail
LABEL="local.metu-mcp.worker"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "Removed $LABEL. Data kept in ~/Library/Application Support/metu-mcp (delete it manually if wanted)."
echo "Disconnect Claude Code with: claude mcp remove -s user metu"
