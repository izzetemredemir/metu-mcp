# Scraping policy and security

metu-mcp is an unofficial project, not run or endorsed by METU. It reads only public pages and behaves like a good
citizen on METU's servers.

## Politeness

- **Scheduled, not on demand.** Collectors run in the `worker` process on fixed schedules (`SCHEDULES` in
  `src/config.ts`). Tool calls read the database only. Single exception: the live ring feed `ring.json`, cached for 30 s
  and single-flight (concurrent calls share one request).
- **robots.txt** is fetched per host (cached 24 h) and honoured: `Disallow`/`Allow` (longest match, all groups for the
  agent combined as RFC 9309 requires) and `Crawl-delay` (www.metu.edu.tr and kafeterya.metu.edu.tr ask for 10 s).
  There is no way to override it.
- **Sites that bar AI agents are not collected**, even when the rules name only other bots: LibGuides
  (`libguides.lib.metu.edu.tr`) blocks GPTBot, ChatGPT-User, Google-Extended and others, so it is link-only.
- **One request per host at a time**, at least 3 s apart (or the crawl-delay).
- **Conditional GET** (`If-None-Match` / `If-Modified-Since`); a 304 reuses the cached body.
- **Backoff** on 429/503 (honours `Retry-After`) and on network errors, max 2 retries.
- **Identifying User-Agent** with a contact address (`METU_MCP_CONTACT`).
- Announcement detail pages are fetched once per new item (max 8 per source per run).

Approximate load: well under 200 requests per hour across all METU hosts.

## Hosts with `Disallow: /`

`oibs2.metu.edu.tr`, `sis.metu.edu.tr` and `librarycatalog.metu.edu.tr` publish `Disallow: /`. They are never crawled:
`politeFetch` has no way to override robots.txt, and the server only links to these systems.

The User-Agent identifies the project only (`metu-mcp/<version> (unofficial METU student-info project)`) plus the
contact address of whoever runs the worker; no personal data of users is ever sent to METU servers.

Login-protected systems (OİBS, student portal, ODTÜClass, METU Mail, reservation systems) are never scraped and the
server never accepts credentials.

## Security

- **SSRF:** requests only go to `*.metu.edu.tr` (checked again after redirects), plus one fixed exception:
  `overpass.kumi.systems`, a public Overpass API instance queried once a week for OpenStreetMap building names and
  outlines on campus (`ALLOWED_EXTRA_HOSTS`; overpass-api.de is not used because its robots.txt disallows `/api/`).
  OSM data is © OpenStreetMap contributors (ODbL); answers that use it carry the attribution. No tool accepts a URL.
- **Prompt injection:** scraped text is untrusted. `src/lib/sanitize.ts` removes scripts, styles, hidden elements
  (`hidden`, `display:none`, `aria-hidden`), zero-width and bidi control characters, and caps lengths. Content is
  returned as attributed data fields; tool descriptions are static; server instructions tell the model that scraped
  text is data, not instructions.
- **Rate limiting:** per-IP token bucket on `/mcp` (`METU_MCP_RATE_PER_MIN`, default 60/min), DNS-rebinding
  protection via `METU_MCP_ALLOWED_HOSTS`.
- **No personal data:** no accounts, no credentials, no logging of tool arguments beyond errors.
