# METU web services catalog

Inventory of METU (ODTÜ) web services relevant to students, researched and verified on **2026-09-30**, extended on **2026-10-04** (sports, health, library, career, clubs, IT, security) and **2026-10-05** (METULearn, language courses, LibGuides, WeBWorK, METU App).
For each: where the data is, its format, whether it needs a login, robots.txt status, and how this server uses it.

Legend — **Use**: `collected` (scraped on a schedule), `live` (fetched at tool time, cached), `link` (only pointed to via
`data/links.yaml`), `blocked` (robots.txt forbids crawling; link only), `later` (planned).

## Academic & administrative

| Service | URL(s) | Format | Login | robots.txt | Languages | Use |
|---|---|---|---|---|---|---|
| Academic calendar | Index `oidb.metu.edu.tr/tr/akademik-takvim`, `/en/academic-calendar` → year pages (`…-2026-2027-akademik-takvim`, `…-2026-2027-academic-year-calendar`) | One HTML `<table>`: date cell + event cell, term heading rows; **no iCal/PDF** | no | ok | tr, en | `collected` (daily) → events + `.ics` resource |
| Registrar (ÖİDB) announcements | `oidb.metu.edu.tr/{tr,en}/announcements?page=N` | Drupal 8+ Views (`.views-row`, `a.list-group-item__title`, `time[datetime]`); `/rss.xml` is empty | no | ok | tr, en | `collected` (20 min) |
| Registrar info pages | `/tr/kim-nasil-kayit-yapmali`, `/tr/katki-payi-odemeleri`, `/tr/katki-payi-miktarlari`, `/tr/ogrenci-belgesi`, `/tr/dersten-cekilme`, `/tr/formlar`, `/tr/yonetmelikler`, `/tr/sikca-sorulan-sorular-sss` | Drupal HTML | no | ok | tr (+en where translated) | `collected` (some) + `link` |
| Law 7592 amnesty (2026) | ÖİDB announcements `…/7592-sayili-af-kanununun-gecici-85-maddesi-…`, `…-basvuru-surecleri-…`, `…temel-ingilizce-birimi-7592-…` | Drupal HTML | no | ok | tr | `collected` via ÖİDB list + `link` |
| Main site news & announcements | `www.metu.edu.tr/tr/rss.xml` (RSS 2.0, 10 items) | RSS | no | Crawl-delay 10 | tr | `collected` |
| Department sites | `<dept>.metu.edu.tr/{tr,en}/announcements` (most), `/tum-duyurular` (crp, id, ce, ie, che), `/butun-duyurular` (eee), `ceng…/rss.xml`; soc and mete publish English lists only; music `mgsb…/{tr,en}/tum-duyurular` (card list), arch `…/tr/all-announcements` and ims `…/all-announcements` (Drupal 7 tables, no dates), YDYO `ydyom…/index.php/{tr,en}/announcements`, MLD `mld…/{tr,en}/announcements`, DBE (prep school, static site) loads `dbe…/_announcements.php` (`<a>file</a> (dd/mm/yyyy)` lines); chem `/news` has no years (link only); gene redirects to bio; ece, adm and Turkish Language have no reachable site (2026-10-05) | Shared Drupal "miys" theme | no | ok | tr, en | `collected`: 35 departments/units + iam, ims (CEIT, CENG every 20 min, the rest hourly) |
| Graduate schools | `fbe.metu.edu.tr/{tr,en}/announcements`, `sbe.metu.edu.tr/{tr,en}/announcements`, `ii.metu.edu.tr/tr/all-announcements` | Drupal HTML | no | ok | tr, en (II: tr) | `collected` |
| Course catalog | `catalog.metu.edu.tr`: `fac_inst.php?fac_inst=<id>` (programmes) → `prog_courses.php?prog=<id>` (course table: code, name, credit, contact/lab hours, ECTS) → `course.php?prog=<id>&course_code=<7 digits>` (details, prerequisite sets as `Set N:` links); NCC faculties 995–998 skipped | Server-rendered HTML, **ISO-8859-9** (`<meta charset>`, no header charset) | no | none (404) | en | `collected` (lists weekly, details 1000/night; graduate schools use `program.php?inst_prog=<id>`) → `metu_course_info` |
| Offered courses / sections | `oibs2.metu.edu.tr/View_Program_Course_Details_64/` | HTML forms | no | **Disallow: /** | tr/en | `link` only, never crawled |
| METU-SIS | `sis.metu.edu.tr` | — | no | **Disallow: /** | en | not used |
| Exam schedules | No central public page; some departments publish (e.g. `mem-ie.metu.edu.tr/en/exam-schedule`); personal schedule in `student.metu.edu.tr` | mixed | personal: yes | — | — | `link` |
| Student portal / OİBS | `oibs.metu.edu.tr`, `student.metu.edu.tr` | — | **yes** | — | — | `link` only, never scraped |
| ODTÜClass (Moodle) | `odtuclass.metu.edu.tr` → current term host (`odtuclass2026f.metu.edu.tr`) | — | **yes** | — | en | `link` only, never scraped |
| Library | `lib.metu.edu.tr/{tr,en}/announcements` (Drupal views; `/rss.xml` empty); hours block on the home page (main building and reserve hall 24/7); `/tr/odunc-verme-hizmetleri` (undergrad 15 books / 15 days, MSc 20/30, PhD 25/30, fine per day); `/tr/yerleske-disindan-erisim` (VPN); carrels, lockers, Wi-Fi, photocopy pages; no online group-room booking or laptop loan. Koha OPAC `librarycatalog.metu.edu.tr` | HTML | no | lib: ok; Koha: **Disallow: /** | tr, en | announcements + pages `collected`; Koha `link` only |
| OpenMETU (theses, publications) | `open.metu.edu.tr` (DSpace); OAI-PMH at `/oai/request` (`oai_dc`, 100 records per page, stateless `resumptionToken` = `oai_dc///<set>/<offset>`, `from=` incremental, deletions `transient`); graduate-school communities `com_11511_13…17` (~45 000 records incl. articles); thesis PDFs on `etd.lib.metu.edu.tr` | OAI-PMH XML | no | robots.txt disallows `/discover`, `/admin/*`, `/submit`, `/login` only | tr, en | theses `collected` nightly (150 pages per run; the first full pass takes a few nights) → `metu_theses`; other publications `later` |
| Library subject guides (LibGuides) | `libguides.lib.metu.edu.tr` | Springshare HTML | no | robots.txt bars AI agents (GPTBot, ChatGPT-User, Google-Extended, …) | en | `link` only, not collected |
| METULearn trainings | `learn.metu.edu.tr/egitimler/?sayfa=N` (24 cards per page, 576 trainings; out-of-range pages repeat the last page); card detail is an htmx fragment `/api/course/<sem-N|moodle-N>/` (source, category, language, format, start date or "İstediğiniz zaman", registration window/status, price, enrolment link to `harman.cc`, `bilgeis.net` or `ocw.metu.edu.tr`). No JSON API | Django + htmx HTML | no | none (404) | tr (course languages tr/en) | `collected` (list weekly, 60 details/day) → `metu_trainings` |
| WeBWorK | `webwork.metu.edu.tr/webwork2/` (course list currently ME210, ME305, ME306) | WeBWorK | **yes** | — | en | `link` |
| Scholarships | ÖİDB `/tr/burs-ve-yardim-basvurulari` | HTML | no | ok | tr | `link` / `later` |
| International office (Erasmus) | `ico.metu.edu.tr/rss.xml` | RSS | no | ok | tr/en mixed | `collected` |
| Computer Center (BİDB) | `bidb.metu.edu.tr/{tr,en}/announcements`, FAQ `faq.cc.metu.edu.tr` | Drupal 10 | no | ok | tr, en | `collected` + `link` |

## Campus life

| Service | URL(s) | Format | Login | robots.txt | Languages | Use |
|---|---|---|---|---|---|---|
| Cafeteria menu | `kafeterya.metu.edu.tr/?date_filter[value][date]=DD/MM/YYYY` (any day); breakfast `.views-field-field-kahvalti`, lunch/dinner after `h3.title`, vegetarian/vegan fields, Faculty Club table with kcal; monthly PDF | Drupal 7 HTML | no | Crawl-delay 10 | tr (dish names tr only) | `collected` (today +7 days, twice a day) |
| Meal hours / prices | `/yemek-saatleri`, `/tabldot-yemek-fiyatlari` | HTML | no | Crawl-delay 10 | tr | `collected` |
| Vehicle permits (taşıt pulu) | `ihm.metu.edu.tr/tr/tasit-pulu-sefligi`, `/tr/ogrenci`; fee PDF `/sites/ihm.metu.edu.tr/files/IHM/tasitpulu/fiyat_2026.pdf`; apply `tasitpulu.metu.edu.tr`; undergraduate lottery `tpkura.metu.edu.tr` | Drupal 10 + PDF | apply: yes | ok | tr | `collected` + `link` |
| Parking rules | `ihm…/tr/tasit-pulu-turune-gore-park-yerleri`, `/tr/otopark-kurallari`, `/tr/yerleske-trafik-kurallari-uygulama-usul-ve-esaslari` | Drupal 10 | no | ok | tr | `collected` (change-watched) + hand-verified `data/parking_rules.yaml` |
| Campus map | `map.metu.edu.tr`: `POST /getmarker.php type=<category>` returns `createMarker(lat, lng, "name", type, "desc", w, h, id, slug)` script blocks. Categories: 3 academic, 5 ATM, 6 sports, 7 parking (109 lots), 8 food, 9 buildings/dorms, 11 health, 12 gates, 13 banks, 14 post, 16 libraries, 17 shopping, 23 transport, 25 PC labs, 29 classrooms, 32 admin, 35 societies | JS in HTML | no | ok | en | `collected` weekly (~540 places) |
| OpenStreetMap (campus) | Overpass API at `overpass.kumi.systems` (the only non-METU host; overpass-api.de disallows `/api/` in robots.txt): named buildings (~210 of ~1070 have names), amenities and leisure ways in the campus bbox, with outlines (`out tags geom`); Turkish names (map.metu.edu.tr is English only), few `short_name`/`alt_name` | Overpass JSON | no | no robots.txt | tr (some `name:en`) | `collected` weekly → `osm_features`, linked to the map place inside each outline; used by `metu_campus_place` search and outlines; © OpenStreetMap contributors (ODbL) |
| OpenStreetMap | Relation 6899696 (campus): 144 parking areas, 391 buildings | Overpass | no | — | tr/en | `later` (enrich short names) |
| Ring buses (live) | `ring.metu.edu.tr/ring.json`: plate, position, route colour, next stops with minutes | JSON | no | ok | mixed | `live` (30 s cache) |
| Ring timetables & transport | `tim.metu.edu.tr/tr/{sari-kirmizi-ring, acik-kahverengi-ring, gri-ring-gunduz, gri-ring-aksam, mor-ring, lacivert-ring, turuncu-ring, turkuaz-ring}`; English pages are separate nodes under `/tr/` (`yellow-red-ring-bus`, …); `ego-hat-bilgisi`, `dolmus-guzergahi`, district shuttles | Drupal 7 HTML | no | ok | tr, en | `collected` |
| Dormitories | `yurtlar.metu.edu.tr/{tr,en}/announcements`; fees only as BIFF8 `.xls` linked from `/tr/oda-olanaklari-ve-fiyatlari` (`…yurt_ucretleri…xls`) and `/en/room-facilities-and-prices` (`…dormitory_fees…xls`); general features, placement point table, regulation, contacts | Drupal 10 + Excel | no | ok | tr, en | announcements + pages `collected`; fee table parsed from the spreadsheet (SheetJS) into the page text → `metu_campus_services` (dormitory) |
| Health center (Medico/SRM) | `srm.metu.edu.tr/tr/doktorlarimiz` (specialty → doctor → status such as BURADA / İZİNLİ; the "dated list" stamp is written by client JS, not real), `/tr/birimler` (08:30–16:30, polyclinic 09–12 / 13:30–16), `/tr/personel-iletisim` (phones), `/tr/pdrm` (free counselling, 210 4928), `/{tr,en}/announcements`; `/rss.xml` mixes doctor nodes with news; appointments `rez-srm.metu.edu.tr` | HTML | appointments: yes | ok | tr, en | pages + announcements `collected` |
| Sports | `spormd.metu.edu.tr/tr/tesislerimiz` (stadium, halls, fitness 07:30–23:00, tennis/padel/pickleball courts, turf pitches, Eymir boathouse, running tracks), `/tr/spor-takimlarimiz`, `/{tr,en}/announcements` (SİS, yoga, pilates courses; tournaments; holiday hours; `/rss.xml` empty); fee table only as a **JPEG** (`/tr/hizli-baglantilar`; 585×851 px, OCR tried 2026-10-05 and rejected: misread prices and dropped rows); reservations `rez.metu.edu.tr` (padel/pickleball moved there 2026-08-16; no-show = 1-week ban) | HTML + image | reservations: yes | ok | tr (en partial; `/en/node/N` serves untranslated Turkish) | pages + announcements `collected`; fees `link` |
| Swimming pools | `hm.metu.edu.tr/tr/ogrenci` (student per-session fee, no membership needed), `/tr/announcements` (both pools closed for strengthening/renovation since June 2026), timetable PDF | HTML + PDF | no | ok | tr | `collected` |
| Career Planning Center | `kpm.metu.edu.tr` (WordPress): `/feed/` (RSS, last 10), `/wp-json/wp/v2/posts?categories=35` jobs, `38` internships, `40` events | RSS, WP JSON | no | ok | tr (some en) | `collected` (RSS) |
| Clubs and events (KİM) | `kim.metu.edu.tr/tr/ogrenci-topluluklari` (~105 societies: description, advisor, room, website), `/tr/etkinlikler` (hand-edited block: club / date-time / event / venue) | free-text HTML | no | ok | tr (`/en/node/N` untranslated) | pages `collected` |
| University events | `70yil.metu.edu.tr/tr/events/all-events` (per-event iCal), `kkm.metu.edu.tr/etkinlikler` (venue calendar; its webcal export is broken), `buhafta.metu.edu.tr` (bulletin, WP JSON pages) | HTML, iCal, WP JSON | no | Crawl-delay 10 (kkm, 70yil) | tr, en | 70yil + Bu Hafta `collected`; KKM `collected` from the year view (`…/calendar-node-field-etkinlik-tarihi/year/YYYY`, ISO start + hall per row) |
| Campus security | `ihm.metu.edu.tr/tr/iletisim`: 24 h duty desk (Nöbetçi Amirlik) 0312 210 2113 / 2114 | HTML | no | ok | tr | page `collected` + `link` |
| IT help (BİDB FAQ) | `faq.cc.metu.edu.tr/tr/groups/<group>` (~445 FAQs: eduroam/meturoam, VPN, e-mail, licensed software, smart card, PC labs and their hours) | HTML (Drupal 7; generic extractor finds no text, own parser) | no | Crawl-delay 10 | tr | `collected` (index weekly, 120 answers/night) → `metu_it_help` |
| Smart card (ODTÜ kart) | `kafeterya.metu.edu.tr/akilli-kart-para-yukleme`, `odtucard.metu.edu.tr` (login) | HTML | top-up: yes | ok | tr | `link` |
| Cafeteria notices | `kafeterya.metu.edu.tr/tr/tum-duyurular` (cards: title, teaser, dd/mm/yyyy; bilingual bodies) | Drupal 7 HTML | no | Crawl-delay 10 | tr+en in one node | `collected` |
| Food outlets and shopping | `www.metu.edu.tr/food-drink` (canteens 08–16, dorm canteens 07:30–23:30, Çarşı 08:30–23:30; last updated 2021), `/shopping` (2013) | HTML | no | Crawl-delay 10 | en, tr | `later` (stale) |
| Part-time student jobs, scholarships | `www.metu.edu.tr/tr/kismi_zamanli_ogrenci_ilanlari` (index of units), `oidb…/tr/burs-ve-yardim-basvurulari` | HTML | no | ok | tr | `link` |
| International students | `iso.metu.edu.tr/en` (residence permit, foreign ID no., insurance, cost of living) | HTML | no | Crawl-delay 10 | en, tr | `link` |
| Academic Writing Center | `awc.metu.edu.tr/en` (graduate tutorials via `awcapp`, seminars) | HTML | booking: yes | ok | en | `link` |
| Clubs & events | `kim.metu.edu.tr/tr/etkinlikler`, `/tr/ogrenci-topluluklari` | free-text HTML | no | ok | tr, en | `link` (`later`) |
| Accessibility | `engelsiz.metu.edu.tr` | HTML | no | ok | tr | `link` |
| Language courses (School of Foreign Languages) | `dil.metu.edu.tr/kurslar/{yuz-yuze,cevrim-ici}/` (lists: hours and fees), `/kurslar/<format>/<course>/` (term schedule: placement exam, start/end, registration window, class days; "kurs detayları" PDF), `/seviye-tespit/sinav/`, `/hakkimizda/toefl-ibt-merkezi/`, `/sss/` | Classic ASP + Bootstrap HTML, **ISO-8859-9** (`http-equiv` meta, no header charset), no `<h1>`/`<main>` | registration: by phone/office | none (robots.txt URL returns the HTML home page) | tr | `collected` (27 pages daily, topic `language`) → `metu_campus_services` |
| METU App | `metuapp.ceng.metu.edu.tr` — student-made mobile app (CENG students; map, ring, menu, ODTÜClass, calendar) | — | app | — | en | `link` (marked unofficial) |

## Existing open-source work (reference)

| Project | Relevance |
|---|---|
| th0th/metu-cafeteria-menu, Mehmet-Emre-Dogan/metuFoodScraper, … | Cafeteria scrapers |
| ulassekerci/metu-ring-logger | ring.json poller |
| purdue-mcp, ScottyLabs/mcp-server (CMU), ohio-state-mcp-server | Campus MCP architecture references |

Not found / not usable (2026-10-04): campus bike sharing (only a student petition), an official ombudsman or student council
site, a lost-and-found page, a current Ankara EPE (English proficiency exam) date page (`epe.metu.edu.tr` is from 2023),
laptop loans. `burs.metu.edu.tr` is a placeholder; the guest house is closed for renovation.

⚠️ `odtuoibs.github.io` looks like a phishing clone of OİBS — never link to it.

No official METU open-data portal or public API exists as of 2026-09-30.
