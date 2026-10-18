#!/usr/bin/env node
/**
 * Entry point of the Claude Desktop bundle (.mcpb). Desktop may start the server with its own Node runtime, so check
 * what the server needs before loading it (node:sqlite is imported statically and would otherwise fail without a hint).
 */
import { existsSync } from 'node:fs';

const [major = 0] = process.versions.node.split('.').map(Number);
try {
  if (major < 22) throw new Error(`Node ${process.versions.node}`);
  await import('node:sqlite');
} catch (err) {
  console.error(
    `metu-mcp needs Node.js 24 with the built-in node:sqlite module (this runtime: ${(err as Error).message}). ` +
      'Install Node 24 and add the server to claude_desktop_config.json with its absolute path (see docs/local.md).',
  );
  process.exit(1);
}

const db = process.env.METU_MCP_DB;
if (db && !existsSync(db)) {
  console.error(
    `metu-mcp: no database at ${db}. Install the collector worker first (pnpm local:install, see docs/local.md); ` +
      'until it has run, answers only contain official links.',
  );
}

await import('./cli.js');
