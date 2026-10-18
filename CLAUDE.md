# metu-mcp — notes for AI assistants

- Language: **all code, comments, docs, tool descriptions and server messages are English.** User-facing server text is
  bilingual through `src/i18n.ts` (`t(lang, key)`) or inline `lang === 'tr' ? … : …`. Scraped METU content is stored
  as-is (Turkish and/or English) with a `lang` column.
- Runtime: Node **24.21.0** (see `.nvmrc`), TypeScript strict, ESM, pnpm. SQLite via built-in `node:sqlite` (FTS5 included).
- MCP SDK v2: `@modelcontextprotocol/server` (`McpServer.registerTool` with `zod/v4` schemas, `createMcpHandler` for
  stateless HTTP, `serveStdio` for stdio). Tests use `@modelcontextprotocol/client` + `InMemoryTransport`.

## Architecture

- `src/collectors/*` — scheduled scrapers (`worker` process, the only DB writer). All HTTP goes through
  `collectors/http.ts#politeFetch` (domain allowlist, robots.txt, per-host serialization, ETag cache, backoff).
  Each unit reports to `collector_runs` via `runner.ts#runUnit`.
- `src/store/*` — schema/migrations (`db.ts`), versioned records with change summaries (`records.ts`), freshness (`freshness.ts`).
- `src/tools/*` — MCP tools. They only read the DB (exception: live `ring.json`, cached 30 s). Every answer goes through
  `tools/common.ts#answer`, which appends freshness lines and official links to the text and returns structuredContent.
- `data/links.yaml` (official link fallback), `data/parking_rules.yaml` (structured parking rules), `data/places_aliases.yaml`.

## Rules

- Never add a tool that fetches arbitrary URLs. New sources go into `src/config.ts` and must be `*.metu.edu.tr`. The one
  exception is `ALLOWED_EXTRA_HOSTS` (the Overpass instance for weekly OpenStreetMap data); answers using OSM data carry
  `OSM_ATTRIBUTION`.
- Unofficial project, not run by METU: no METU logo, public pages only, robots.txt always obeyed. Hosts with
  `Disallow: /` (oibs2, SIS, Koha) and sites that bar AI agents (LibGuides) are link-only.
- Fixtures must not carry personal notices (deaths, births) or student names: replace them with placeholders.
- Never send personal data (developer's or users') to METU servers; the User-Agent names the project only.
- Every new tool: `metu_` prefix, `READ_ONLY` annotations, `lang` param, outputSchema incl. `COMMON_OUTPUT`, freshness.
- Parser changes need a fixture in `tests/fixtures/` (record the real page) and a test in `tests/collectors/`.
- `pnpm typecheck && pnpm test` must pass.
