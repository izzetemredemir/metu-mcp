# Running on this Mac

metu-mcp runs locally: a **launchd agent** keeps the collector worker running in the background, and Claude Code
starts the MCP server over **stdio** whenever it needs it. Both use the same SQLite file.

| What | Where |
|---|---|
| Database | `~/Library/Application Support/metu-mcp/metu.db` |
| Worker log | `~/Library/Logs/metu-mcp/worker.log` (`pnpm local:logs`) |
| launchd agent | `~/Library/LaunchAgents/local.metu-mcp.worker.plist` (label `local.metu-mcp.worker`) |
| Claude Code entry | user scope, name `metu` (`claude mcp get metu`) |
| Claude Desktop entry | `mcpServers.metu` in `~/Library/Application Support/Claude/claude_desktop_config.json` |

## Install

```bash
nvm use                                   # Node 24.21.0
pnpm install
pnpm local:install                        # build, install + start the worker
# optional: start from an existing database instead of collecting from scratch
scripts/macos/install.sh --seed-from var/dev.db
```

The script prints the `claude mcp add -s user metu …` command; run it once. Then ask Claude things like
"Bugün yemekte ne var?" or "CENG 213'ün önkoşulu ne?" in any project.

### Claude Desktop

**Option A — bundle (.mcpb).** Build it and open it with Claude Desktop (double-click, or Settings → Extensions →
Install from file):

```bash
pnpm mcpb                                 # → var/mcpb/metu-mcp-<version>.mcpb
open var/mcpb/metu-mcp-*.mcpb
```

The bundle holds only the stdio server; it reads the database the worker fills (its "Database file" setting defaults to
`~/Library/Application Support/metu-mcp/metu.db`), so install the worker first. Its tool list is read from the server
when the bundle is built. Desktop starts bundles with its own Node runtime; the server needs Node 24 (`node:sqlite`)
and says so in Desktop's MCP log if the runtime is older — then use option B. Do not keep both: remove a manual `metu`
entry when you install the bundle.

**Option B — manual entry.** Add this under `mcpServers` in `~/Library/Application Support/Claude/claude_desktop_config.json` (keep the other
entries; the file stays `chmod 600` because it may hold other servers' tokens), then quit and reopen Claude Desktop:

```json
"metu": {
  "command": "/Users/<you>/.nvm/versions/node/v24.21.0/bin/node",
  "args": ["/path/to/metu-mcp/dist/cli.js", "serve", "--stdio"],
  "env": { "METU_MCP_DB": "/Users/<you>/Library/Application Support/metu-mcp/metu.db" }
}
```

Use absolute paths: Claude Desktop does not load nvm, so a bare `node` may be a different version or missing.
`install.sh` prints this block with your paths.

Set `METU_MCP_CONTACT=<your e-mail>` before installing to put a contact address in the scraper's User-Agent
(recommended by the scraping policy, so METU admins can reach you).

## After changing the code

```bash
pnpm local:restart                        # rebuild dist/ and restart the worker
```

Claude Code picks up the rebuilt server the next time it starts the MCP connection.

## Notes

- The worker only collects while the Mac is awake; launchd restarts it after reboots and crashes. Missed schedules are
  not replayed — the next run catches up, and every answer shows how fresh its source is.
- A fresh database is filled on first start (all collectors run once; the course catalog and BİDB FAQ details fill in
  over a few nights).
- `oibs2` / SIS / Koha are never crawled: their robots.txt forbids it regardless of where the crawler runs (see
  `docs/scraping-policy.md`); the server links to them instead.

## Uninstall

```bash
scripts/macos/uninstall.sh                # stop and remove the worker (database and logs are kept)
claude mcp remove -s user metu
# and delete the "metu" entry from claude_desktop_config.json
```
