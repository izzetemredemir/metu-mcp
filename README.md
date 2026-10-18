# metu-mcp

An [MCP](https://modelcontextprotocol.io) server that lets METU (ODTÜ, Middle East Technical University) students ask an
AI assistant about university life: announcements, the academic calendar, the cafeteria menu, courses and prerequisites, sports, health and library services, student clubs, where they may park, vehicle
permits, the campus map and ring buses. It works in **Turkish and English**, like METU itself.

> **Unofficial.** A student project, not run, endorsed or supported by METU. Answers come from METU's public web pages
> and may be out of date: always check the official link each answer cites.

## Principles

1. **Every answer is sourced and dated.** Each tool result ends with the official source, when we last checked it, and
   the page's own "last updated" date. Stale or unreachable sources produce an explicit ⚠️ warning. See [docs/freshness.md](docs/freshness.md).
2. **No made-up answers.** When the data needs a login (grades, transcript, fee balance, personal exam schedule) or is
   not collected, the server points to the right official page from a curated catalog ([data/links.yaml](data/links.yaml)).
3. **Polite, read-only scraping.** Scheduled collectors respect robots.txt and crawl-delay, use conditional requests,
   and never run during a tool call (except the 30-second-cached live ring feed). See [docs/scraping-policy.md](docs/scraping-policy.md).
4. **No personal data.** The server never asks for or stores credentials or user data.

## Tools

| Tool | What it answers |
|---|---|
| `metu_today` | One call for today: menu, academic-calendar entries, campus events, doctors on duty, recent Registrar and department news |
| `metu_search` | One-shot search over everything (announcements, rule pages, calendars, official links); retries misspelled queries ("kütüpane") |
| `metu_find_link` | "Where do I …?" — official page, and whether it needs a METU login |
| `metu_announcements` | Announcements from the main site, Registrar (ÖİDB), 35 departments and language units, graduate schools and institutes, Erasmus, BİDB, IHM, dorms, library, sports, pools, health center, cafeteria notices, Career Center job/internship postings, the *Bu Hafta* bulletin and the Alumni Office |
| `metu_calendar_events` | Academic calendar search ("ekle-sil ne zaman?", finals, holidays, tuition) |
| `metu_calendar_next` | Upcoming deadlines |
| `metu_course_info` | Course catalog: credits, ECTS, prerequisites (and what a course is a prerequisite for), content — by code, department or keywords |
| `metu_campus_services` | Sports facilities and pools, health center (doctors on duty, counselling), library hours and rules, student clubs and events, security contacts, accessibility office, regulations (probation, double major, resits, summer school), School of Foreign Languages courses (TOEFL/IELTS/General English fees and term dates, placement exam, TOEFL iBT centre), dormitories (monthly fee of every room type from the official fee spreadsheet, payment accounts, placement points, regulation), Registrar FAQ and forms, scholarships, International Students Office (residence permit, insurance, tuition, cost of living) |
| `metu_doctors_on_duty` | Which doctors are at the health center (Medico) today, by specialty |
| `metu_events` | Upcoming student club events, university events (talks, fairs, festivals) and the Culture and Convention Center (KKM) calendar |
| `metu_theses` | Master's and PhD theses from OpenMETU: search titles/abstracts, filter by department, advisor, author, degree, year; record and PDF links |
| `metu_it_help` | BİDB IT FAQ: Wi-Fi/eduroam, VPN, e-mail, passwords, licensed software, smart card |
| `metu_trainings` | METULearn catalog (~576 trainings): ODTÜ-SEM certificate programmes, Bilgeİş and METU OCW courses — format, price, start date, registration status, enrolment link |
| `metu_program_curriculum` | Semester-by-semester undergraduate curriculum of a department: must courses, elective slots, "choose one of" groups, ECTS totals; also its double major and minor programmes |
| `metu_course_eligibility` | From the courses passed: which courses' prerequisites are now met, and which miss one |
| `metu_degree_audit` | Unofficial progress check against the curriculum: missing must courses, open choice groups, elective slots, ECTS |
| `metu_gpa_calculator` | Term and cumulative GPA from letter grades, with the regulation's scale, repeat rule, honor ranges and probation line (collected, not hard-coded) |
| `metu_campus_route` | Getting from A to B on campus: distance, walking time, nearest ring stops, which ring to take (from the official route tables), walking-route link (classroom codes work too) |
| `metu_recent_changes` | What changed: new announcements, moved calendar dates, edited rule pages |
| `metu_status` | How fresh the data is per source family, and which sources are failing |
| `metu_dining_menu` | Cafeteria menu (today … +7 days), meal hours, student price |
| `metu_campus_place` | Buildings, lots, gates, ATMs … with coordinates (understands "MM", "KKM", "BÖTE", "çarşı", and Turkish names from OpenStreetMap such as "Mediko", "Üçlü Amfi") and classroom codes ("BMB G102", "U2"); building outlines from OpenStreetMap |
| `metu_parking_check` | "Can I park here?" for a permit type and time, with the official rule text |
| `metu_vehicle_permit` | Student vehicle permits: types, eligibility, documents, where to apply |
| `metu_transport` | Live ring bus arrivals and ring timetables |

Resources: `metu://links`, `metu://parking/rules`, `metu://status`, `metu://calendar/{year}/{lang}.ics`, `metu://course/{code}` (with code completion).
Prompts: `weekly_summary`, `semester_start_checklist`, `course_planning` (department completes from the catalog), `exam_week`.

Every tool takes `lang: "tr" | "en"` (default `tr`). See [docs/mcp-design.md](docs/mcp-design.md).

## Quick start

Requires **Node.js 24.21.0** (`nvm use`) and pnpm.

```bash
pnpm install
pnpm refresh                 # collect all sources once (takes several minutes: crawl-delay is respected)
pnpm serve                   # HTTP endpoint on http://127.0.0.1:8787/mcp
pnpm dev serve --stdio       # or stdio for local clients
pnpm worker                  # scheduled collection (production)
pnpm test                    # parser + tool tests against recorded fixtures, no network
```

Connect a client:

```bash
# Claude Code, local
claude mcp add metu -- npx tsx /path/to/metu-mcp/src/cli.ts serve --stdio
# Claude Code, remote
claude mcp add --transport http metu https://mcp.example.edu.tr/mcp
# MCP Inspector
pnpm inspector
```

In Claude (web/desktop): Settings → Connectors → Add custom connector → `https://<your-host>/mcp`.

## Running locally on macOS

The usual setup is local: a launchd agent runs the collector worker and Claude Code talks to the server over stdio.
`pnpm local:install` sets it up — see [docs/local.md](docs/local.md).

## Configuration

See [.env.example](.env.example). Optional public deployment on an Ubuntu VPS (systemd + Caddy): [docs/deploy.md](docs/deploy.md).

## Documentation

- [docs/services-catalog.md](docs/services-catalog.md) — METU web services, formats and how each is (or is not) used
- [docs/mcp-design.md](docs/mcp-design.md) — tool design, bilingual behaviour, output format
- [docs/freshness.md](docs/freshness.md) — how data currency is tracked and shown
- [docs/scraping-policy.md](docs/scraping-policy.md) — politeness, robots.txt, security
- [docs/links.md](docs/links.md) — generated list of the official link catalog
- [docs/local.md](docs/local.md) — running on this Mac (launchd worker + stdio)
- [docs/deploy.md](docs/deploy.md) — optional VPS deployment
- [docs/roadmap.md](docs/roadmap.md) — what's next

## License

Code: MIT ([LICENSE](LICENSE)). `tests/fixtures/` holds copies of public METU web pages recorded for parser tests; their
content belongs to METU. OpenStreetMap data © OpenStreetMap contributors (ODbL). METU and ODTÜ are names of Middle East
Technical University, which has no part in this project.
