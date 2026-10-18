/**
 * Builds the Claude Desktop bundle: var/mcpb/metu-mcp-<version>.mcpb.
 *
 * The bundle holds the stdio server only (dist/, data/, production node_modules). It reads the database the collector
 * worker fills (docs/local.md), so it never scrapes anything itself. The manifest's tool and prompt lists are read from
 * the server, so they cannot drift from the code. Run with `pnpm mcpb` (builds dist/ first).
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createServer } from '../src/server.js';
import { openDb } from '../src/store/db.js';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'var/mcpb');
const stage = path.join(out, 'stage');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  license: string;
  dependencies: Record<string, string>;
};

// 1. Tool and prompt descriptions from the real server (empty in-memory database).
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await createServer(openDb(':memory:')).connect(serverTransport);
const client = new Client({ name: 'build-mcpb', version: pkg.version });
await client.connect(clientTransport);
const firstSentence = (s = '') => (/^.*?[.!?](\s|$)/.exec(s.replace(/\s+/g, ' '))?.[0] ?? s).trim();
const tools = (await client.listTools()).tools.map((t) => ({ name: t.name, description: firstSentence(t.description) }));
const prompts = (await client.listPrompts()).prompts.map((p) => ({
  name: p.name,
  description: firstSentence(p.description),
  arguments: (p.arguments ?? []).map((a) => a.name),
  // Desktop shows the prompt; the server produces the actual text.
  text: `Use the ${p.name} prompt of the METU server.`,
}));
await client.close();

// 2. Stage the files the server needs at run time.
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const dir of ['dist', 'data']) cpSync(path.join(root, dir), path.join(stage, dir), { recursive: true });
// The server announces its icon from assets/ (read at start-up); the bundle icon is the same mark.
mkdirSync(path.join(stage, 'assets'));
for (const f of ['icon-256.png', 'icon-64.png']) cpSync(path.join(root, 'assets', f), path.join(stage, 'assets', f));
cpSync(path.join(root, 'assets/icon-256.png'), path.join(stage, 'icon.png'));
writeFileSync(
  path.join(stage, 'package.json'),
  JSON.stringify({ name: pkg.name, version: pkg.version, type: 'module', license: pkg.license, dependencies: pkg.dependencies }, null, 2),
);
execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts', '--no-package-lock'], { cwd: stage, stdio: 'inherit' });

// 3. Manifest.
const manifest = {
  manifest_version: '0.3',
  name: pkg.name,
  display_name: 'METU / ODTÜ (unofficial)',
  version: pkg.version,
  description: 'Unofficial METU (ODTÜ) student information: announcements, academic calendar, menus, campus, courses.',
  long_description:
    'Answers from official METU websites, collected on a schedule by the metu-mcp worker on this computer: announcements ' +
    'of the Registrar, departments and units, the academic calendar, cafeteria menus, campus places and ring buses, ' +
    'parking rules, the course catalog and curricula, health center, library, dormitories, theses and more. Every answer ' +
    'states when its source was last checked and links the official page. Not affiliated with METU. Requires the ' +
    'collector worker (see the project\'s docs/local.md); this bundle only reads its database.',
  author: { name: 'metu-mcp contributors' },
  icon: 'icon.png',
  server: {
    type: 'node',
    entry_point: 'dist/launch.js',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/dist/launch.js', 'serve', '--stdio'],
      env: { METU_MCP_DB: '${user_config.database}' },
    },
  },
  user_config: {
    database: {
      type: 'string',
      title: 'Database file',
      description: 'SQLite file filled by the metu-mcp collector worker (default location of the macOS install).',
      default: '${HOME}/Library/Application Support/metu-mcp/metu.db',
      required: true,
    },
  },
  tools,
  prompts,
  keywords: ['metu', 'odtu', 'odtü', 'university', 'student', 'ankara', 'turkey'],
  license: pkg.license,
  compatibility: { platforms: ['darwin', 'linux'], runtimes: { node: '>=24.0.0' } },
};
writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// 4. Validate and pack.
const mcpb = (...args: string[]) => execFileSync('npx', ['-y', '@anthropic-ai/mcpb@2', ...args], { cwd: out, stdio: 'inherit' });
mcpb('validate', path.join(stage, 'manifest.json'));
const file = path.join(out, `${pkg.name}-${pkg.version}.mcpb`);
rmSync(file, { force: true });
mcpb('pack', stage, file);
console.log(`\n${path.relative(root, file)} (${tools.length} tools, ${prompts.length} prompts)`);
