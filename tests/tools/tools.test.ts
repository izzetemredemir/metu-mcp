import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { collectAnnouncements } from '../../src/collectors/announcements.js';
import { collectCalendar } from '../../src/collectors/calendar.js';
import { collectCatalogDetails, collectSyllabi, parseCourseDetail, parseProgramCourses, saveProgramCourses } from '../../src/collectors/catalog.js';
import { collectClassrooms } from '../../src/collectors/classrooms.js';
import { parseCurriculum, parseSpecialPrograms } from '../../src/collectors/curriculum.js';
import { collectDining } from '../../src/collectors/dining.js';
import { collectDoctors } from '../../src/collectors/doctors.js';
import { collectEvents } from '../../src/collectors/events.js';
import { collectFaqAnswers, parseFaqGroupList } from '../../src/collectors/faq.js';
import { setFetchImpl } from '../../src/collectors/http.js';
import { collectPages } from '../../src/collectors/pages.js';
import { collectTheses } from '../../src/collectors/theses.js';
import { collectTrainingDetails, collectTrainings } from '../../src/collectors/trainings.js';
import { parseMarkers } from '../../src/collectors/places.js';
import type { CollectorContext } from '../../src/collectors/runner.js';
import { THESIS_SETS } from '../../src/config.js';
import { createServer } from '../../src/server.js';
import { transaction } from '../../src/store/db.js';
import { upsertRecord } from '../../src/store/records.js';
import { recordRunSuccess } from '../../src/store/runs.js';
import { resetLiveCache } from '../../src/tools/transport.js';
import { fixture, fixtureBytes, memoryDb } from '../helpers.js';

/** URL → fixture file served by the fake network. Everything else is a 404. */
const ROUTES: [RegExp, string][] = [
  [/oidb\.metu\.edu\.tr\/tr\/akademik-takvim$/, 'oidb-calendar-index.html'],
  [/oidb\.metu\.edu\.tr\/en\/academic-calendar$/, 'oidb-calendar-index-en.html'],
  [/odtu-ankara-ve-erdemli-kampusleri-2026-2027-akademik-takvim$/, 'oidb-calendar-2026-2027.html'],
  [/metu-ankara-and-erdemli-campuses-2026-2027-academic-year-calendar$/, 'oidb-calendar-2026-2027-en.html'],
  [/oidb\.metu\.edu\.tr\/tr\/announcements$/, 'oidb-announcements.html'],
  [/www\.metu\.edu\.tr\/tr\/rss\.xml$/, 'metu-rss.xml'],
  [/kafeterya\.metu\.edu\.tr\/\?date_filter.*03%2F10%2F2026$/, 'kafeterya-2026-10-03.html'],
  [/kafeterya\.metu\.edu\.tr\/\?date_filter/, 'kafeterya-today.html'],
  [/kafeterya\.metu\.edu\.tr\/yemek-saatleri$/, 'kafeterya-hours.html'],
  [/kafeterya\.metu\.edu\.tr\/tabldot-yemek-fiyatlari$/, 'kafeterya-prices.html'],
  [/ihm\.metu\.edu\.tr\/tr\/tasit-pulu-turune-gore-park-yerleri$/, 'ihm-park-yerleri.html'],
  [/ihm\.metu\.edu\.tr\/tr\/ogrenci$/, 'ihm-ogrenci.html'],
  [/tim\.metu\.edu\.tr\/tr\/sari-kirmizi-ring$/, 'tim-sari-kirmizi.html'],
  [/ring\.metu\.edu\.tr\/ring\.json$/, 'ring.json'],
  [/kim\.metu\.edu\.tr\/tr\/etkinlikler$/, 'kim-etkinlikler.html'],
  [/faq\.cc\.metu\.edu\.tr\/tr$/, 'bidb-faq-home.html'],
  [/faq\.cc\.metu\.edu\.tr\/tr\/groups\/eduroam$/, 'bidb-faq-group-eduroam.html'],
  [/faq\.cc\.metu\.edu\.tr\/tr\/sss\/eduroam-sifremi-unuttum-ne-yapmaliyim$/, 'bidb-faq-eduroam-sifre.html'],
  [/70yil\.metu\.edu\.tr\/tr\/events\/all-events$/, '70yil-all-events.html'],
  [/70yil\.metu\.edu\.tr\/tr\/(bote-bolumu-mezunlar-bulusmasi|guz-26-kariyer-fuari)$/, '70yil-event-kariyer-fuari.html'],
  [/spormd\.metu\.edu\.tr\/tr\/tesislerimiz$/, 'spormd-tesislerimiz.html'],
  // Untranslated placeholder: the English URL serves the Turkish node.
  [/spormd\.metu\.edu\.tr\/en\/node\/8$/, 'spormd-en-node-8.html'],
  [/lib\.metu\.edu\.tr\/tr\/odunc-verme-hizmetleri$/, 'lib-odunc-verme.html'],
  [/spormd\.metu\.edu\.tr\/tr\/hizli-baglantilar$/, 'spormd-hizli-baglantilar.html'],
  [/oidb\.metu\.edu\.tr\/tr\/orta-dogu-teknik-universitesi-lisans-egitim-ogretim-yonetmeligi$/, 'oidb-lisans-yonetmeligi.html'],
  [/www\.metu\.edu\.tr\/location-classrooms-metu-campus$/, 'metu-classrooms.html'],
  [/srm\.metu\.edu\.tr\/tr\/doktorlarimiz$/, 'srm-doktorlarimiz.html'],
  [/catalog\.metu\.edu\.tr\/course\.php\?prog=571&course_code=5710213$/, 'catalog-course-5710213.html'],
  [/catalog\.metu\.edu\.tr\/program\.php\?fac_prog=571$/, 'catalog-program-571.html'],
  [/catalog\.metu\.edu\.tr\/course\.php\?prog=571&course_code=5710140$/, 'catalog-course-5710140.html'],
  [/catalog\.metu\.edu\.tr\/course\.php\?prog=571&course_code=5710351$/, 'catalog-course-5710351.html'],
  // METULearn: every list page serves the first page (cards are de-duplicated), plus the detail fragments we recorded.
  [/learn\.metu\.edu\.tr\/egitimler\/(\?sayfa=\d+)?$/, 'learn-trainings-page1.html'],
  [/learn\.metu\.edu\.tr\/api\/course\/sem-352\/$/, 'learn-course-sem-352.html'],
  [/learn\.metu\.edu\.tr\/api\/course\/sem-327\/$/, 'learn-course-sem-327.html'],
  [/learn\.metu\.edu\.tr\/api\/course\/moodle-722\/$/, 'learn-course-moodle-722.html'],
  [/learn\.metu\.edu\.tr\/api\/course\/moodle-1180\/$/, 'learn-course-moodle-1180.html'],
  [/dil\.metu\.edu\.tr\/kurslar\/yuz-yuze\/$/, 'dil-courses-in-person.html'],
  [/dil\.metu\.edu\.tr\/kurslar\/yuz-yuze\/toefl\/$/, 'dil-course-campus-toefl.html'],
  // KKM venue calendar: every year view serves the recorded 2025 year.
  [/kkm\.metu\.edu\.tr\/calendar-node-field-etkinlik-tarihi\/year\/\d{4}$/, 'kkm-year-2025.html'],
  // OpenMETU OAI-PMH: the last page of an unfinished Marine Sciences pass, and nothing new in incremental passes.
  [/open\.metu\.edu\.tr\/oai\/request\?verb=ListRecords&resumptionToken=oai_dc%2F%2F%2Fcom_11511_15%2F1400$/, 'openmetu-oai-ims-last.xml'],
  [/open\.metu\.edu\.tr\/oai\/request\?verb=ListRecords&metadataPrefix=oai_dc&set=com_11511_\d+&from=/, 'openmetu-oai-no-records.xml'],
  [/yurtlar\.metu\.edu\.tr\/tr\/oda-olanaklari-ve-fiyatlari$/, 'yurtlar-oda-fiyatlari.html'],
  [/yurtlar\.metu\.edu\.tr\/sites\/yurtlar\.metu\.edu\.tr\/files\/2026-2027_1_eylul_2026_31_agustos_2027_yurt_ucretleri_1\.xls$/, 'yurt-ucretleri-2026-2027.xls.gz'],
];

// Syllabus fragments are addressed by opaque package tokens taken from the recorded course page.
const syllabusUrls = parseCourseDetail(fixture('catalog-course-5710213.html'))!.syllabus_urls;
ROUTES.push(
  [new RegExp(`^${syllabusUrls.objectives!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), 'syllabus-5710213-objectives.html'],
  [new RegExp(`^${syllabusUrls.outcomes!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), 'syllabus-5710213-outcomes.html'],
);

function fakeFetch(input: string | URL | Request): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const hit = ROUTES.find(([re]) => re.test(url));
  const body = hit ? (hit[1].endsWith('.gz') ? fixtureBytes(hit[1]) : fixture(hit[1])) : 'not found';
  const res = new Response(body, { status: hit ? 200 : 404 });
  Object.defineProperty(res, 'url', { value: url });
  return Promise.resolve(res);
}

let db: DatabaseSync;
let client: Client;

async function call(name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[]).map((c) => c.text).join('\n');
  return { res, text, data: res.structuredContent as Record<string, unknown> };
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-30T10:00:00+03:00'));
  setFetchImpl(fakeFetch as typeof fetch, { noDelay: true });
  db = memoryDb();
  const ctx: CollectorContext = { db, log: () => {} };
  await collectCalendar(ctx);
  await collectAnnouncements(ctx, ['oidb', 'metu']);
  await collectDining(ctx);
  await collectPages(ctx, ['ihm-parking-by-permit', 'ihm-student-permit', 'cafeteria-hours', 'cafeteria-prices', 'ring-yellow-red', 'sports-facilities', 'sports-files', 'library-borrowing', 'regulation-undergraduate', 'dil-courses-in-person', 'dil-campus-toefl', 'dorm-fees']);
  await collectTrainings(ctx);
  await collectTrainingDetails(ctx);
  await collectDoctors(ctx);
  await collectEvents(ctx);
  // OpenMETU: Marine Sciences resumes an unfinished first pass; the other graduate schools are already harvested.
  for (const { set } of THESIS_SETS) {
    db.prepare('INSERT INTO oai_state (set_spec, from_date, token, pass_started) VALUES (?, ?, ?, ?)').run(
      set, set === 'com_11511_15' ? null : '2026-09-01T00:00:00Z', set === 'com_11511_15' ? 'oai_dc///com_11511_15/1400' : null,
      set === 'com_11511_15' ? '2026-09-29T22:00:00Z' : null,
    );
  }
  await collectTheses(ctx);
  // BİDB FAQ: queue the eduroam group (the weekly index walks all ~40 groups), then fetch the answer we have a fixture for.
  for (const it of parseFaqGroupList(fixture('bidb-faq-group-eduroam.html'))) {
    db.prepare('INSERT INTO faq_queue (url, question, grp, listed_at, fetched_at) VALUES (?, ?, ?, ?, ?)').run(
      it.url, it.question, 'eduroam', new Date().toISOString(), it.url.endsWith('eduroam-sifremi-unuttum-ne-yapmaliyim') ? null : new Date().toISOString(),
    );
  }
  await collectFaqAnswers(ctx, 1);
  // Map markers: load the parking-lot fixture directly (the real collector POSTs one request per category).
  const lots = [
    ...parseMarkers(fixture('map-type7.html'), 7),
    ...parseMarkers(fixture('map-type29.html'), 29),
    ...parseMarkers(fixture('map-type23.html'), 23),
  ];
  transaction(db, () => {
    const ins = db.prepare('INSERT INTO places (id, name, category_id, category, lat, lng, description, source, search_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const p of lots) ins.run(p.id, p.name, p.category_id, p.category, p.lat, p.lng, p.description, 'metu-map', p.name.toLowerCase());
  });
  upsertRecord(db, { id: 'places:metu-map', kind: 'places', source: 'metu-map', lang: 'en', title: 'map', url: 'https://map.metu.edu.tr/' });
  recordRunSuccess(db, 'places', lots.length);
  await collectClassrooms(ctx);
  // Course catalog: one department's course list, then the detail pages we have fixtures for.
  saveProgramCourses(
    db,
    { prog: 571, name: 'Computer Engineering', degree: 'B.S.', faculty_id: 500, faculty: 'Faculty of Engineering' },
    parseProgramCourses(fixture('catalog-prog-courses-571.html')),
    new Date().toISOString(),
  );
  recordRunSuccess(db, 'catalog', 147);
  db.prepare(`UPDATE courses SET detail_fetched_at = ? WHERE code NOT IN ('5710213', '5710140', '5710351')`).run(new Date().toISOString());
  await collectCatalogDetails(ctx, 3);
  await collectSyllabi(ctx);
  // Curriculum: stored the way collectCurricula stores it (the collector walks every undergraduate programme).
  upsertRecord(db, {
    id: 'curriculum:571', kind: 'curriculum', source: 'catalog', lang: 'en', title: 'Computer Engineering undergraduate curriculum',
    body: 'curriculum', url: 'https://catalog.metu.edu.tr/program.php?fac_prog=571',
    data: { prog: 571, department: 'Computer Engineering', semesters: parseCurriculum(fixture('catalog-program-571.html')) },
  });
  upsertRecord(db, {
    id: 'curriculum-minor:571', kind: 'curriculum', source: 'catalog', lang: 'en', title: 'Computer Engineering minor programme',
    body: 'minor', url: 'https://catalog.metu.edu.tr/program.php?min_prog=571',
    data: { prog: 571, department: 'Computer Engineering', programs: parseSpecialPrograms(fixture('catalog-minor-571.html')) },
  });
  recordRunSuccess(db, 'curriculum', 1);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(db).connect(serverTransport);
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client?.close();
  vi.useRealTimers();
  resetLiveCache();
});

describe('tool surface', () => {
  it('announces the server icon', () => {
    const icons = client.getServerVersion()?.icons ?? [];
    expect(icons.map((i) => i.sizes?.[0])).toEqual(['256x256', '64x64']);
    expect(icons[0]!.src).toMatch(/^data:image\/png;base64,iVBORw0KGgo/);
  });

  it('lists read-only, namespaced tools with output schemas', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'metu_announcements', 'metu_calendar_events', 'metu_calendar_next', 'metu_campus_place', 'metu_campus_route', 'metu_campus_services', 'metu_course_eligibility', 'metu_course_info', 'metu_degree_audit', 'metu_dining_menu',
      'metu_doctors_on_duty', 'metu_events', 'metu_find_link', 'metu_gpa_calculator', 'metu_it_help', 'metu_parking_check', 'metu_program_curriculum', 'metu_recent_changes',
      'metu_search', 'metu_status', 'metu_theses', 'metu_today', 'metu_trainings', 'metu_transport', 'metu_vehicle_permit',
    ]);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.outputSchema).toBeDefined();
      expect(t.inputSchema.properties).toHaveProperty('lang');
    }
  });
});

describe('academic calendar', () => {
  it('answers "ekle-sil ne zaman?" in Turkish with freshness', async () => {
    const { text, data } = await call('metu_calendar_events', { query: 'ekle-sil', lang: 'tr' });
    expect(text).toContain('Ders Ekleme - Bırakma');
    expect(text).toContain('5 Ekim 2026 Pazartesi – 9 Ekim 2026 Cuma');
    expect(text).toMatch(/— Kaynak: oidb\.metu\.edu\.tr · son kontrol 2026-09-30 10:00/);
    expect((data.freshness as { status: string }[])[0]!.status).toBe('fresh');
  });

  it('answers the same in English from the English calendar', async () => {
    const { text, data } = await call('metu_calendar_events', { tag: 'add-drop', lang: 'en' });
    expect(text).toContain('Add - Drop');
    expect((data.events as { lang: string }[]).every((e) => e.lang === 'en')).toBe(true);
    expect(text).toContain('Source: oidb.metu.edu.tr');
  });

  it('lists upcoming deadlines', async () => {
    const { data } = await call('metu_calendar_next', { days: 14, lang: 'tr' });
    const titles = (data.events as { title: string }[]).map((e) => e.title);
    expect(titles).toContain('Ders Ekleme - Bırakma');
  });
});

describe('announcements and search', () => {
  it('finds the amnesty announcement accent-insensitively', async () => {
    const { text } = await call('metu_announcements', { query: 'gecici 85 madde', lang: 'tr' });
    expect(text).toContain('7592 Sayılı Kanun');
    expect(text).toContain('Öğrenci İşleri Daire Başkanlığı');
  });

  it('marks Turkish-only content for English users', async () => {
    const { text } = await call('metu_announcements', { source: 'metu', lang: 'en' });
    expect(text).toContain('Bundan sonrası ODTÜ');
  });

  it('search combines stored pages and official links', async () => {
    const { text, data } = await call('metu_search', { query: 'kahverengi taşıt pulu', lang: 'tr' });
    expect((data.hits as { kind: string }[]).some((h) => h.kind === 'page')).toBe(true);
    expect(text).toContain('Resmi sayfalar');
  });
});

describe('official link fallback', () => {
  it('sends personal-data questions to the login-protected system', async () => {
    const { text, data } = await call('metu_find_link', { query: 'transkript', lang: 'tr' });
    const links = data.links as { id: string; requires_login: string | null }[];
    expect(links[0]).toMatchObject({ id: 'oibs', requires_login: 'oibs' });
    expect(text).toContain('giriş gerekir: oibs');
  });

  it('finds the amnesty links in English', async () => {
    const { data } = await call('metu_find_link', { query: 'amnesty application', lang: 'en' });
    expect((data.links as { id: string }[]).map((l) => l.id)).toContain('amnesty-7592-application');
  });

  it('returns an actionable error when nothing matches', async () => {
    const { res } = await call('metu_find_link', { query: 'xyzzy qwerty', lang: 'en' });
    expect(res.isError).toBe(true);
  });
});

describe('cafeteria', () => {
  it('shows today\'s menu with hours and student price', async () => {
    const { text } = await call('metu_dining_menu', { lang: 'tr' });
    expect(text).toContain('Öğle yemeği (11:30–14:00): MERCİMEK ÇORBA');
    expect(text).toContain('Öğrenci yemek ücreti: 50 TL');
    expect(text).toContain('30 Eylül 2026 Çarşamba');
    expect(text).not.toContain('Dish names');
  });

  it('shows a future day in English', async () => {
    const { text } = await call('metu_dining_menu', { date: '2026-10-03', meal: 'lunch', lang: 'en' });
    expect(text).toContain('Lunch (12:00–14:00): YAYLA ÇORBA, ADANA KÖFTE');
    expect(text).toContain('Dish names are published in Turkish only.');
  });
});

describe('parking', () => {
  it('evaluates "brown permit, evening, near the library"', async () => {
    const { text, data } = await call('metu_parking_check', {
      place: 'kütüphane',
      permit: 'brown',
      at: '2026-10-06T19:00:00+03:00',
      lang: 'tr',
    });
    const lots = data.lots as { name: string; verdict: string }[];
    expect(lots[0]).toMatchObject({ name: 'Library Parking Lot', verdict: 'no' });
    expect(text).toContain('Resmi kural');
    expect(text).toContain('tabelalar');
  });

  it('allows a yellow permit at the library during the day', async () => {
    const { data } = await call('metu_parking_check', { place: 'Library', permit: 'yellow', at: '2026-10-06T10:00:00+03:00', lang: 'en' });
    expect((data.lots as { verdict: string }[])[0]!.verdict).toBe('yes');
  });

  it('explains the vehicle permit with application links', async () => {
    const { text } = await call('metu_vehicle_permit', { lang: 'tr' });
    expect(text).toContain('tpkura.metu.edu.tr');
    expect(text).toContain('Öğrenci sarı taşıt pulu');
  });
});

describe('transport', () => {
  it('estimates live arrivals at a stop and lists departures', async () => {
    const { text, data } = await call('metu_transport', { stop: 'Egitim Fak', ring: 'yellow-red', lang: 'en' });
    expect((data.arrivals as unknown[]).length).toBeGreaterThan(0);
    expect(text).toContain('Rings approaching');
    expect((data.timetable as { all_departures: string[] }).all_departures[0]).toBe('09:00');
  });
});

describe('resources', () => {
  it('exports the academic calendar as iCalendar', async () => {
    const res = await client.readResource({ uri: 'metu://calendar/2026-2027/tr.ics' });
    const text = (res.contents[0] as { text: string }).text;
    expect(text).toContain('BEGIN:VCALENDAR');
    expect(text).toContain('SUMMARY:Ders Ekleme - Bırakma');
  });
});

describe('course catalog', () => {
  it('answers by course code with prerequisites and reverse prerequisites', async () => {
    const { text, data } = await call('metu_course_info', { query: 'ceng 213', lang: 'en' });
    expect(data.mode).toBe('exact');
    const course = (data.courses as Record<string, unknown>[])[0]!;
    expect(course).toMatchObject({ short_code: 'CENG213', name: 'DATA STRUCTURES', credit_text: '4(3-2)', ects: 7, offered_semester: 'Fall Semesters' });
    expect(course.prerequisites).toEqual([[{ code: '5710140', short_code: 'CENG140', name: 'C PROGRAMMING' }]]);
    expect((course.required_by as { short_code: string }[]).map((r) => r.short_code)).toContain('CENG351');
    expect(text).toContain('Prerequisite: CENG140 (C PROGRAMMING)');
    expect(text).toMatch(/Objectives: This course aims to introduce the abstract concepts/);
    expect(course.learning_outcomes).toContain('implement data structures in C++');
    expect(text).toContain('Source: catalog.metu.edu.tr');
    expect(text).toContain('oibs2.metu.edu.tr');
  });

  it('lists alternative prerequisite sets and keeps Turkish characters', async () => {
    const { text } = await call('metu_course_info', { query: 'CENG351', lang: 'tr' });
    expect(text).toContain('Önkoşul (bu setlerden herhangi biri):');
    expect(text).toMatch(/1\. CENG213 \(DATA STRUCTURES\)/);
    expect(text).toContain('İSMAİL SENGÖR ALTINGÖVDE');
  });

  it('lists a department and searches by title', async () => {
    const dept = await call('metu_course_info', { query: 'CENG', limit: 5, lang: 'en' });
    expect(dept.data.mode).toBe('department');
    expect(dept.data.total).toBe(147);
    const page2 = await call('metu_course_info', { query: 'Bilgisayar Mühendisliği bölümü', limit: 5, offset: 5, lang: 'tr' });
    expect(page2.data.mode).toBe('department');
    expect((page2.data.courses as unknown[]).length).toBe(5);
    expect(page2.text).toContain('offset=10');
    const search = await call('metu_course_info', { query: 'data structures', lang: 'en' });
    expect((search.data.courses as { short_code: string }[]).map((c) => c.short_code)).toContain('CENG213');
  });

  it('says when details are not collected yet', async () => {
    const { text } = await call('metu_course_info', { query: 'CENG100', lang: 'en' });
    expect(text).toContain('details not collected yet');
  });
});

describe('campus services', () => {
  it('returns sports facility pages and filters by query', async () => {
    const all = await call('metu_campus_services', { topic: 'sports', lang: 'tr' });
    expect((all.data.pages as { id: string }[]).map((p) => p.id)).toContain('sports-facilities');
    expect(all.text).toContain('Güncel duyurular için: metu_announcements (source: sports, pools)');
    const tennis = await call('metu_campus_services', { topic: 'sports', query: 'tenis', lang: 'tr' });
    const page = (tennis.data.pages as { text: string }[])[0]!;
    expect(page.text.toLowerCase()).toContain('tenis');
    expect(page.text.length).toBeLessThan(all.text.length);
  });

  it('lists the current fee table file', async () => {
    const { text } = await call('metu_campus_services', { topic: 'sports', query: 'ücret', lang: 'tr' });
    expect(text).toContain('https://spormd.metu.edu.tr/sites/spormd.metu.edu.tr/files/tesis_kullanim_ucretleri_2026_ocak.jpeg');
  });

  it('does not store an untranslated /en/node page as English', async () => {
    const { text, data } = await call('metu_campus_services', { topic: 'sports', lang: 'en' });
    expect((data.pages as { id: string; lang: string }[]).find((p) => p.id === 'sports-facilities')?.lang).toBe('tr');
    expect(text).toContain('No English version is published');
  });

  it('answers library borrowing limits with freshness', async () => {
    const { text } = await call('metu_campus_services', { topic: 'library', query: 'lisans öğrencileri', lang: 'tr' });
    expect(text).toContain('Lisans öğrencileri 15 kitabı 15 gün');
    expect(text).toMatch(/Kaynak: lib\.metu\.edu\.tr/);
  });

  it('falls back to the other language when the query only matches there', async () => {
    const { text } = await call('metu_campus_services', { topic: 'library', query: 'lisans öğrencileri', lang: 'en' });
    expect(text).toContain('Lisans öğrencileri 15 kitabı 15 gün');
    expect(text).toContain('No English version is published');
  });

  it('warns about uncollected pages', async () => {
    const { data } = await call('metu_campus_services', { topic: 'health', lang: 'en' });
    expect((data.freshness as { status: string }[]).every((f) => f.status === 'no_data')).toBe(true);
  });
});

describe('doctors on duty', () => {
  it('filters by an everyday specialty word and shows statuses', async () => {
    const { text, data } = await call('metu_doctors_on_duty', { specialty: 'eye', lang: 'en' });
    expect(data.doctors).toEqual([
      { specialty: 'GÖZ HASTALIKLARI (OPHTHALMOLOGY)', name: 'PELİN ATMACA SÖNMEZ', status: 'on_duty', status_text: '', note: '' },
    ]);
    expect(text).toContain('• PELİN ATMACA SÖNMEZ: on duty');
    expect(text).toContain('Source: srm.metu.edu.tr');
  });

  it('lists only doctors on duty, in Turkish', async () => {
    const { text, data } = await call('metu_doctors_on_duty', { specialty: 'pratisyen', only_on_duty: true, lang: 'tr' });
    const doctors = data.doctors as { status: string }[];
    expect(doctors.length).toBeGreaterThan(0);
    expect(doctors.every((d) => d.status === 'on_duty')).toBe(true);
    expect(text).toContain(': burada');
  });

  it('suggests specialties when nothing matches', async () => {
    const { res, text } = await call('metu_doctors_on_duty', { specialty: 'kardiyoloji', lang: 'tr' });
    expect(res.isError).toBe(true);
    expect(text).toContain('DİŞ HEKİMİ (DENTIST)');
  });
});

describe('events', () => {
  it('lists upcoming club and university events in the next 30 days', async () => {
    const { text, data } = await call('metu_events', { lang: 'tr' });
    const titles = (data.events as { title: string }[]).map((e) => e.title);
    expect(titles).toContain('GÖL ŞENLİĞİ');
    expect(titles).toContain('KUTUP BİLİMLERİ KONFERANSI');
    expect(titles).not.toContain('FİNANS KONGRESİ'); // 12 December: outside the default window
    expect(text).toMatch(/4 Ekim 2026 Pazar 12:00–19:00: GÖL ŞENLİĞİ — MÜZİK TOPLULUĞU · EYMİR GÖLÜ/);
    expect(text).toContain('Kaynak: kim.metu.edu.tr');
  });

  it('finds the career fair from the university calendar by words', async () => {
    const { data } = await call('metu_events', { query: 'kariyer fuarı', source: '70yil', lang: 'en' });
    expect(data.events).toEqual([
      expect.objectContaining({ start: '2026-10-22T10:00:00+03:00', end: '2026-10-23T17:00:00+03:00', venue: 'ODTÜ Kültür ve Kongre Merkezi' }),
    ]);
  });
});

describe('IT help', () => {
  it('answers from the BİDB FAQ in Turkish', async () => {
    const { text, data } = await call('metu_it_help', { query: 'eduroam şifremi unuttum', lang: 'tr' });
    expect((data.answers as { question: string }[])[0]!.question).toBe('eduroam şifremi unuttum, ne yapmalıyım?');
    expect(text).toContain('ODTÜ kullanıcı kodu ve şifrenizi');
    expect(text).toMatch(/Kaynak: faq\.cc\.metu\.edu\.tr .* sayfanın güncellenme tarihi 2019-12-13/);
  });

  it('lists matching questions whose answer is not collected yet, ignoring question words', async () => {
    const { text, data } = await call('metu_it_help', { query: 'How do I connect to eduroam on my iPhone?', lang: 'en' });
    const answers = data.answers as { question: string; answer_collected: boolean }[];
    expect(answers[0]).toMatchObject({ question: 'iPhone telefonumdan eduroam kablosuz ağına nasıl bağlanabilirim?', answer_collected: false });
    expect(text).toContain('Answer not collected yet');
  });

  it('matches English questions and finds FAQ answers through metu_search', async () => {
    const en = await call('metu_it_help', { query: 'forgot eduroam password', lang: 'en' });
    expect(en.text).toContain('eduroam şifremi unuttum');
    expect(en.text).toContain('No English version is published');
    const search = await call('metu_search', { query: 'eduroam şifre', lang: 'tr' });
    expect((search.data.hits as { kind: string }[]).some((h) => h.kind === 'faq')).toBe(true);
  });
});

describe('GPA calculator', () => {
  it('uses catalog credits and the regulation rules', async () => {
    const { text, data } = await call('metu_gpa_calculator', {
      courses: [
        { course: 'CENG140', grade: 'FF', term: 'Güz' },
        { course: 'CENG111', grade: 'BA', term: 'Güz' },
        { course: 'CENG100', credit: 0, grade: 'S', term: 'Güz' },
        { course: 'ceng 140', grade: 'AA', term: 'Bahar' },
      ],
      lang: 'tr',
    });
    expect(data.cgpa).toBe(3.75); // CENG140 FF replaced by AA (4 credits), CENG111 BA (4 credits)
    expect((data.terms as { gpa: number }[]).map((t) => t.gpa)).toEqual([1.75, 4]);
    expect(text).toContain('Genel not ortalaması (GNO): 3.75');
    expect(text).toContain('CENG140 FF (sonra tekrarlandı; son not geçerli)');
    expect(text).toMatch(/Kaynak: oidb\.metu\.edu\.tr/);
  });

  it('asks for credits it cannot find and rejects unknown grades', async () => {
    const missing = await call('metu_gpa_calculator', { courses: [{ course: 'XYZ999', grade: 'AA' }], lang: 'en' });
    expect(missing.res.isError).toBe(true);
    expect(missing.text).toContain('XYZ999');
    const bad = await call('metu_gpa_calculator', { courses: [{ credit: 3, grade: 'A+' }], lang: 'en' });
    expect(bad.text).toContain('Unknown grade');
  });

  it('answers regulation questions through campus services', async () => {
    const { text } = await call('metu_campus_services', { topic: 'regulations', query: 'sınamalı', lang: 'tr' });
    expect(text).toContain('sınamalı (probation)');
  });
});

describe('programme curriculum', () => {
  it('lists a semester by department code with electives and choice groups', async () => {
    const { text, data } = await call('metu_program_curriculum', { department: 'Bilgisayar Mühendisliği', semester: 3, lang: 'tr' });
    expect(data.department).toBe('Computer Engineering');
    expect(text).toContain('3. Dönem (Third Semester) — dönem toplamı 32 AKTS');
    expect(text).toContain('• CENG213 DATA STRUCTURES · 4 kredi · 7 AKTS');
    expect(text).toMatch(/Şunlardan 1 tanesi: HIST2201.*\/ HIST2205 \(HISTORY OF THE TURKISH REVOLUTION I\)/);
  });

  it('lists all semesters for "CENG" and counts elective slots', async () => {
    const { data } = await call('metu_program_curriculum', { department: 'CENG', lang: 'en' });
    const semesters = data.semesters as { items: { kind: string; label?: string }[] }[];
    expect(semesters.length).toBe(8);
    const technical = semesters.flatMap((s) => s.items).filter((i) => i.kind === 'elective' && i.label === 'TECHNICAL ELECTIVE');
    expect(technical.length).toBeGreaterThanOrEqual(4);
  });
});

describe('classrooms and routes', () => {
  it('finds the building of a classroom code', async () => {
    const { text, data } = await call('metu_campus_place', { query: 'BMB-G102 nerede?', lang: 'tr' });
    expect(text).toContain('Derslik BMB G102: Computer Center Building');
    expect((data.places as { lat: number }[])[0]!.lat).toBeCloseTo(39.8915, 3);
    const yp = await call('metu_campus_place', { query: 'yp d101', lang: 'en' });
    expect(yp.text).toContain('Classroom YP-D101: Yüksel Proje Lecture Hall');
  });

  it('gives distance, walking time, nearby ring stops and a route link', async () => {
    const { text, data } = await call('metu_campus_route', { from: 'BMB G102', to: 'HZA105', lang: 'tr' });
    expect(data.distance_m).toBeGreaterThan(500);
    expect(data.walk_minutes).toBe(Math.max(1, Math.round(((data.distance_m as number) * 1.25) / 75)));
    expect(text).toMatch(/yürüyerek yaklaşık \d+ dk/);
    expect(text).toContain('https://www.openstreetmap.org/directions?engine=fossgis_osrm_foot&route=');
    expect((data.from_stops as unknown[]).length + (data.to_stops as unknown[]).length).toBeGreaterThan(0);
  });

  it('names the ring line to take on longer trips, from the official route table', async () => {
    const { text, data } = await call('metu_campus_route', { from: 'A2 Metro Gate Bus Station', to: 'East Dormitory Territory Bus Station', lang: 'tr' });
    const rings = data.rings as { ring: string; board: string; alight: string; stops: number; timetable_url: string }[];
    expect(rings[0]).toMatchObject({ ring: 'Sarı - Kırmızı ring', board: 'A-2 Metro Kapısı', alight: 'Doğu Yurtlar', timetable_url: 'https://tim.metu.edu.tr/tr/sari-kirmizi-ring' });
    expect(text).toContain('A-2 Metro Kapısı durağında bin');
  });

  it('says which end it could not find', async () => {
    const { res, text } = await call('metu_campus_route', { from: 'BMB G102', to: 'Hogwarts', lang: 'en' });
    expect(res.isError).toBe(true);
    expect(text).toContain('Hogwarts');
  });
});

describe('prompts', () => {
  it('lists the planning prompts and completes department codes', async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(expect.arrayContaining(['course_planning', 'exam_week', 'weekly_summary']));
    const res = await client.complete({ ref: { type: 'ref/prompt', name: 'course_planning' }, argument: { name: 'department', value: 'ce' } });
    expect(res.completion.values).toContain('CENG');
    const msg = await client.getPrompt({ name: 'course_planning', arguments: { department: 'CENG', semester: '3', lang: 'tr' } });
    expect((msg.messages[0]!.content as { text: string }).text).toContain('metu_program_curriculum');
  });
});

describe('trainings (METULearn)', () => {
  it('finds a certificate programme with price, dates, registration status and enrolment link', async () => {
    const { text, data } = await call('metu_trainings', { query: 'yapay zeka sertifika', lang: 'tr' });
    const trainings = data.trainings as { title: string; provider: string; price: string; start_date: string; registration_status: string; url: string }[];
    expect(trainings[0]).toMatchObject({
      title: 'Eğitimde Yapay Zeka Kullanımı Sertifika Programı',
      provider: 'ODTÜ-SEM',
      price: '10.000 TL',
      start_date: '2026-09-29',
      registration_status: 'Kayıtlar Açık',
      url: 'https://harman.cc.metu.edu.tr/courses/egitim_1/',
    });
    expect(text).toContain('yüz yüze');
    expect(text).toMatch(/Kaynak: learn\.metu\.edu\.tr/);
  });

  it('filters by format and links to the catalog until details are collected', async () => {
    const { data } = await call('metu_trainings', { format: 'online', limit: 30, lang: 'en' });
    const trainings = data.trainings as { format: string; url: string; start: string | null }[];
    expect(trainings.length).toBeGreaterThan(5);
    expect(trainings.every((t) => t.format === 'online')).toBe(true);
    expect(trainings.some((t) => t.url.startsWith('https://learn.metu.edu.tr/egitimler/?q='))).toBe(true);
    expect(data.total_matches).toBe(trainings.length);
  });

  it('answers with official links when nothing matches', async () => {
    const { text, data } = await call('metu_trainings', { query: 'kuantum dalgıçlık', lang: 'en' });
    expect(data.trainings).toEqual([]);
    expect(text).toContain('No matching results.');
  });
});

describe('double major and minor', () => {
  it('answers a department\'s minor requirements', async () => {
    const { text, data } = await call('metu_program_curriculum', { department: 'Bilgisayar Mühendisliği', program: 'minor', lang: 'tr' });
    expect(text).toContain('Minor Program in Information Systems');
    expect(text).toContain('Total minimum credit: 21');
    expect(text).toContain('CENG301');
    expect((data.programs as unknown[]).length).toBe(1);
  });

  it('says when a department has no collected double major', async () => {
    const { text, res } = await call('metu_program_curriculum', { department: 'CENG', program: 'double_major', lang: 'en' });
    expect(res.isError).toBeFalsy();
    expect(text).toContain('No double major programme of Computer Engineering');
  });
});

describe('study planning', () => {
  it('lists courses whose prerequisite set is now complete, and those missing one', async () => {
    const { text, data } = await call('metu_course_eligibility', { passed: ['CENG 140'], department: 'CENG', lang: 'en' });
    expect(data.eligible).toEqual([
      expect.objectContaining({ short_code: 'CENG213', satisfied_by: ['CENG140'] }),
    ]);
    expect(text).toContain('CENG213');
    // The test catalog marks every course as fetched, so no incomplete-data warning.
    expect(text).not.toContain('⚠️');
    expect((data.prerequisites_coverage as { courses: number; with_details: number }).with_details).toBe(
      (data.prerequisites_coverage as { courses: number }).courses,
    );
    const next = await call('metu_course_eligibility', { passed: ['CENG140', 'CENG213'], lang: 'en' });
    expect((next.data.eligible as { short_code: string }[]).map((c) => c.short_code)).toEqual(['CENG351']);
  });

  it('checks degree progress against the curriculum and reports unknown codes', async () => {
    const { text, data } = await call('metu_degree_audit', { department: 'CENG', passed: ['CENG140', 'CENG213', 'NOPE123'], lang: 'tr' });
    const missing = (data.missing_must as { short_code: string }[]).map((m) => m.short_code);
    expect(missing).not.toContain('CENG140');
    expect(missing).toContain('CENG351');
    expect(data.ects_completed).toBe(11);
    expect(data.unknown_codes).toEqual(['NOPE123']);
    expect((data.elective_slots as { label: string; count: number }[]).length).toBeGreaterThan(0);
    expect(text).toContain('resmi bir mezuniyet kontrolü değildir');
  });
});

describe('course resource', () => {
  it('serves a catalog course as JSON and completes course codes', async () => {
    const res = await client.readResource({ uri: 'metu://course/CENG213' });
    const course = JSON.parse((res.contents[0] as { text: string }).text) as { short_code: string; prerequisites: { short_code: string }[][] };
    expect(course.short_code).toBe('CENG213');
    expect(course.prerequisites[0]![0]!.short_code).toBe('CENG140');
    const done = await client.complete({ ref: { type: 'ref/resource', uri: 'metu://course/{code}' }, argument: { name: 'code', value: 'ceng 21' } });
    expect(done.completion.values).toContain('CENG213');
  });
});

describe('spelling-tolerant search', () => {
  it('retries a query without results with misspelled words corrected from the index', async () => {
    const { text, data } = await call('metu_search', { query: 'kütüpane ödnç', lang: 'tr' });
    expect(data.corrected_query).toBe('kutuphane odunc');
    expect((data.hits as unknown[]).length).toBeGreaterThan(0);
    expect(text).toContain('"kütüpane ödnç" için sonuç yoktu; "kutuphane odunc" arandı.');
  });

  it('leaves queries with results alone', async () => {
    const { data } = await call('metu_search', { query: 'kütüphane', lang: 'tr' });
    expect(data.corrected_query).toBeNull();
  });
});

describe('status', () => {
  it('summarises freshness per source family and lists failing sources', async () => {
    const { text, data } = await call('metu_status', { lang: 'en' });
    const areas = data.areas as { area: string; units: number }[];
    expect(areas.map((a) => a.area)).toEqual(expect.arrayContaining(['announcements', 'calendar', 'page', 'events']));
    expect(Array.isArray(data.problems)).toBe(true);
    expect(text).toMatch(/• announcements: \d+ units/);
  });
});

describe('today', () => {
  it('combines menu, calendar, doctors on duty and recent Registrar news in one answer', async () => {
    const { text, data } = await call('metu_today', { lang: 'tr' });
    expect(data.date).toBe('2026-09-30');
    expect((data.menu as { lunch: string[] }).lunch.length).toBeGreaterThan(0);
    expect((data.calendar as unknown[]).length).toBeGreaterThan(0);
    expect((data.doctors_on_duty as unknown[]).length).toBeGreaterThan(0);
    expect(text).toContain('## Yemekhane');
    expect(text).toContain('## Akademik takvim');
    expect(text).toContain('## Sağlık merkezinde nöbetçi');
  });
});

describe('theses (OpenMETU)', () => {
  it('finds a thesis by words in its abstract, with advisor, year, department and record link', async () => {
    const { text, data } = await call('metu_theses', { query: 'Caspian circulation', lang: 'en' });
    const theses = data.theses as { title: string; advisors: string; year: number; degree: string; url: string }[];
    expect(theses[0]).toMatchObject({ advisors: 'Özsoy, Emin', year: 2008, degree: 'phd', url: 'https://open.metu.edu.tr/handle/11511/17663' });
    expect(text).toContain('advisor: Özsoy, Emin');
    expect(data.index_complete).toBe(true);
    expect(text).toMatch(/Source: open\.metu\.edu\.tr/);
  });

  it('filters by advisor (accent-insensitive) and degree, newest first without a query', async () => {
    const { data } = await call('metu_theses', { advisor: 'kideys', lang: 'tr' });
    expect((data.theses as { year: number }[]).map((t) => t.year)).toEqual([2002]);
    const masters = (await call('metu_theses', { degree: 'master', lang: 'en' })).data.theses as { year: number; degree: string }[];
    expect(masters.map((t) => t.year)).toEqual([2002, 1987, 1987, 1979]);
  });

  it('finishes the pass: the set becomes incremental', () => {
    const row = db.prepare(`SELECT from_date, token FROM oai_state WHERE set_spec = 'com_11511_15'`).get();
    expect(row).toEqual({ from_date: '2026-09-29T22:00:00Z', token: null });
  });
});

describe('dormitories and KKM events', () => {
  it('answers the monthly fee of a dormitory room from the fee spreadsheet', async () => {
    const { text } = await call('metu_campus_services', { topic: 'dormitory', query: 'Faika Demiray', lang: 'tr' });
    expect(text).toContain('Faika Demiray Yurdu (Kadın) | Oda Tipi (Kişi): 2 Kişi | Aylık Ücret ( ₺ ): 5504');
    expect(text).toContain('https://yurtlar.metu.edu.tr/tr/oda-olanaklari-ve-fiyatlari');
    expect(text).toContain('source: yurtlar');
  });

  it('lists Culture and Convention Center events with time and hall', async () => {
    const { text } = await call('metu_events', { source: 'kkm', from: '2025-01-01', to: '2025-01-31', lang: 'en' });
    expect(text).toContain('Mehtaplı Gecelerde Konseri');
    expect(text).toContain('20:00');
    expect(text).toContain('Kemal Kurdaş Salonu');
  });
});

describe('language courses and library guides', () => {
  it('answers TOEFL course fees and schedule from the School of Foreign Languages pages', async () => {
    const { text, data } = await call('metu_campus_services', { topic: 'language', query: 'TOEFL', lang: 'tr' });
    const pages = data.pages as { id: string }[];
    expect(pages.map((p) => p.id)).toEqual(expect.arrayContaining(['dil-courses-in-person', 'dil-campus-toefl']));
    expect(text).toContain('79.928 TL');
    expect(text).toContain('26 Eylül 2026');
    expect(text).toMatch(/Kaynak: dil\.metu\.edu\.tr/);
  });
});
