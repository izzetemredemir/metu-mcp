# Roadmap

## Done (MVP, 2026-09-30)

- Official link catalog (bilingual) with weekly link checks — the fallback for login-only data
- Announcements: main site, ÖİDB, CEIT, CENG, FBE, SBE, II, ICO, BİDB, IHM, dormitories (TR + EN where published)
- Academic calendar (TR + EN), upcoming deadlines, `.ics` export, change detection per event
- Cafeteria menus (today +7), meal hours, student price
- Campus map places (~540), alias table, "can I park here?", vehicle-permit info
- Live ring arrivals and ring timetables
- Freshness on every answer; `metu_recent_changes`
- stdio + Streamable HTTP (2026-07-28 with 2025 fallback), VPS deployment files

## Done (2026-10-04)

- Course catalog (`catalog.metu.edu.tr`): `metu_course_info` — credits, ECTS, prerequisite sets, reverse prerequisites
- New announcement sources: library, sports, pools, health center, cafeteria notices, Career Planning Center (jobs/internships)
- `metu_campus_services`: sports, health (doctors on duty), library, clubs, security, accessibility pages
- 15 more official links (counselling, security duty desk, IT: Wi-Fi/VPN/software, smart card, scholarships, …)

## Done (2026-10-04, later)

- `metu_doctors_on_duty` (hourly on weekdays), `metu_events` (KİM club events + 70th-anniversary calendar),
  `metu_it_help` (BİDB FAQ, nightly batches) — all collected by the worker, nothing hand-entered
- *Bu Hafta* bulletin (WordPress REST, one record per item; births/deaths skipped) and Alumni Office news
- 27 more department announcement lists (hourly tier)
- File-link tracking for pages: sports fee table image, facility rules, pool timetable PDF

## Done (2026-10-05)

- Curriculum, GPA calculator, regulations, classroom finder, campus routes, syllabus, METULearn trainings, language
  courses, backups, planning prompts

## Done (2026-10-05, public sources)

- `metu_theses`: OpenMETU theses harvested over OAI-PMH (graduate-school sets, incremental nightly; the first full pass
  spreads over a few nights)
- Dormitory fees: the fee spreadsheet (`.xls`) is downloaded and its table appended to the page text
  (`metu_campus_services` topic `dormitory`, with general features, placement points, regulation, contacts)
- KKM venue calendar in `metu_events` (source `kkm`, year view parsed)
- Department announcements: es, mus (mgsb), arch, mld, ydyo, dbe (dated file links) and the institutes iam, ims;
  chem is link-only (news without years); gene redirects to bio

## Next — public sources

- [ ] ece, adm, Turkish Language announcements: no reachable site on 2026-10-05 (`ece.metu.edu.tr`, `adm.metu.edu.tr`
      time out; no host found for Turkish Language). Re-check later
- [ ] Sports facility fees: published only as a 585×851 JPEG. OCR (Tesseract) was tried on 2026-10-05 and rejected — it
      misread prices ("§27" for 527) and dropped rows. Keep the file link; revisit if the directorate publishes a
      PDF/HTML table or a higher-resolution image

## Done (2026-10-05, study and daily life)

- `metu_today`, `metu_course_eligibility`, `metu_degree_audit`, `metu_status`; `metu://course/{code}` resource with
  completion; spelling correction in `metu_search` (against the index vocabulary)
- Double major / minor programmes from the catalog (`metu_program_curriculum`, `program` = double_major | minor)
- Ring line ↔ stop mapping from the TİM route tables + `data/ring_stops.yaml`; `metu_campus_route` names the ring
- Registrar FAQ and forms, scholarships, International Students Office pages (`metu_campus_services` topics
  `registrar`, `scholarships`, `international`)
- Department exam schedules: already arrive as department announcements; the tool description now points there
- Announcements stored twice under `/index.php/` are merged (URL canonicalisation + one-off cleanup migration)

## Done (2026-10-05, later)

- Claude Desktop bundle: `pnpm mcpb` builds `var/mcpb/metu-mcp-<version>.mcpb` (stdio server, manifest generated from
  the server's tool and prompt lists; reads the worker's database)
- OpenStreetMap enrichment: weekly Overpass query (`overpass.kumi.systems`) → `osm_features`; Turkish/short names and
  outlines in `metu_campus_place`, OSM-only places in the search, ODbL attribution

## Next — study and daily life

- [ ] OSM: record a real Overpass response as `tests/fixtures/overpass-campus.json` and add a `parseOverpass` test once
      `overpass.kumi.systems` answers again (down on 2026-10-05/06; the weekly collector reports failures until then)

- [ ] Monthly cafeteria menu: the monthly PDF is a 300 dpi scan without a text layer (OCR needed); the daily HTML
      menu already covers 7 days ahead, so skipped for now
- [ ] `metu_course_eligibility` waits for the catalog details (prerequisites) — ~1000 courses per night; the tool warns
      while coverage is incomplete

## Next

- [ ] Verify the lot → zone mapping in `data/parking_rules.yaml` with IHM: the map has no lot named after the Central
      Engineering Building (MM), so its restricted lot is not yet identified among the 109 mapped lots
- [ ] Cafeteria: structured meal hours/prices tool output; outlet directory from `www.metu.edu.tr/food-drink` (stale since 2021)
- [ ] Evaluation set: 30–50 real student questions with expected sources (`tests/evals/questions.yaml`)
- [ ] Claude Desktop: an `.mcpb` bundle or a documented `claude_desktop_config.json` entry (local stdio)
