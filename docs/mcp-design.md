# MCP design

Targets the **2026-07-28** MCP revision via SDK v2 (`@modelcontextprotocol/server`), while still serving 2025-era
clients: `createMcpHandler` falls back to stateless legacy serving and `serveStdio` accepts the legacy `initialize`
handshake. The server is stateless — a fresh `McpServer` per HTTP request, sharing one read-only DB handle.

## Tool design rules

Based on Anthropic's "Writing effective tools for agents" and the Claude connector review criteria:

- **Few, task-shaped tools** (11), all prefixed `metu_`, names ≤ 64 characters.
- **Read-only annotations** on every tool (`readOnlyHint`, `idempotentHint`, `openWorldHint`, not destructive), so
  clients can run them without confirmation.
- **`lang: "tr" | "en"`** on every tool (default `tr`). METU publishes in both languages:
  - content is served in the requested language when METU publishes it (announcement lists, calendar, TİM pages …);
  - otherwise the other language is returned with an explicit note ("No English version is published …");
  - labels, notes, warnings and freshness lines are produced in the requested language (`src/i18n.ts`).
- **Text + structured output.** `tools/common.ts#answer` returns readable text *and* `structuredContent` matching the
  tool's `outputSchema`. Freshness lines and official links are appended to the text too, so models that ignore
  structured output still relay them.
- **Useful fields, not IDs:** titles, dates, URLs, `source_url`, `fetched_at`.
- **Token budget:** `limit`/`offset`, `response_format: concise | detailed` on announcements, truncated snippets and a
  "N more results" hint.
- **Actionable errors** with `isError: true` and a suggestion or official links — never a bare protocol error.
- **Static descriptions**, no instructions to the model inside tool descriptions; server `instructions` say that
  scraped text is data, not instructions.

## Tools

| Tool | Reads | Notes |
|---|---|---|
| `metu_search` | records FTS5 (announcements, pages, calendars) + link catalog | Tops up with the other language when needed |
| `metu_find_link` | `data/links.yaml` + `link_checks` | The fallback: says whether a login is required; broken links hidden |
| `metu_announcements` | `records` (kind announcement) | Per-source language choice; freshness per source from `collector_runs` |
| `metu_calendar_events` | `calendar_events` | Query → inferred tag (e.g. "ekle-sil" → `add-drop`), tag+text → tag → text |
| `metu_calendar_next` | `calendar_events` | Window from today |
| `metu_recent_changes` | `record_versions` | Bilingual change summaries (e.g. moved calendar dates) |
| `metu_dining_menu` | `records` (menu), cafeteria pages | Hours parsed from the hours page, student price from the prices page |
| `metu_campus_place` | `places` + `data/places_aliases.yaml` | Shorthand like MM, KKM, BÖTE |
| `metu_parking_check` | `places` (parking lots) + `data/parking_rules.yaml` | Verdict per lot: yes / no / only-off-hours / not-listed; warns if the official page changed after `verified_on` |
| `metu_vehicle_permit` | IHM student-permit page + rules | Links to application and lottery |
| `metu_transport` | live `ring.json` (30 s cache) + TİM pages | Arrivals at a stop, next departures |

## Resources and prompts

- `metu://links` — full link catalog (JSON)
- `metu://parking/rules` — structured parking rules (JSON)
- `metu://status` — collector status (freshness at a glance)
- `metu://calendar/{year}/{lang}.ics` — academic calendar as iCalendar (listable)
- Prompts `weekly_summary(lang, department?)` and `semester_start_checklist(lang, level)` chain the tools.

## "Can I park here?" algorithm

1. Resolve the place: alias table (`MM` → Central Engineering, `KKM` → Cultural and Convention Center …), then fuzzy
   match on map place names; or use given coordinates (must be on campus).
2. Take the nearest mapped parking lots (≤ 600 m; or the lot itself if the place is a lot).
3. Classify each lot into a rule zone by name patterns (`data/parking_rules.yaml`, first match wins).
4. Evaluate the permit: allowed zones, denied zones, and time-dependent zones (brown permit: department lots only
   18:00–07:00 on weekdays and at weekends; semester breaks are mentioned in the notes).
5. Return verdicts, the quoted official rule, general rules, "signs on site prevail", freshness of the rules page, and a
   warning if that page changed after the YAML was last verified by a human.
