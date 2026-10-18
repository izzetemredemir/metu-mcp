import { describe, expect, it } from 'vitest';
import { itemLang, parseBulletinIssues, parseDatedLinks, parseDrupalList, parseRss } from '../../src/collectors/announcements.js';
import { findYearPages, parseCalendarTable } from '../../src/collectors/calendar.js';
import { normalizeCourseCode, parseCourseDetail, parseFacultyPrograms, parseProgramCourses, parseSyllabusFragment } from '../../src/collectors/catalog.js';
import { parseCurriculum, parseSpecialPrograms } from '../../src/collectors/curriculum.js';
import { normalizeRoomCode, parseClassrooms } from '../../src/collectors/classrooms.js';
import { parseDiningPage } from '../../src/collectors/dining.js';
import { extractPage } from '../../src/collectors/extract.js';
import { fileLinks } from '../../src/collectors/pages.js';
import { normalizeDutyStatus, parseDoctors } from '../../src/collectors/doctors.js';
import { organizerName, parse70yilEvent, parse70yilList, parseKimEvents, parseKkmYear } from '../../src/collectors/events.js';
import { parseFaqAnswer, parseFaqGroupList, parseFaqGroups } from '../../src/collectors/faq.js';
import { parseMarkers } from '../../src/collectors/places.js';
import { normalizeFormat, parseTrainingDetail, parseTrainingList } from '../../src/collectors/trainings.js';
import { parseMealHours, parseStudentPrices } from '../../src/tools/dining.js';
import { parseDepartures, parseRingJson } from '../../src/tools/transport.js';
import { spreadsheetText } from '../../src/collectors/spreadsheet.js';
import { parseOaiPage } from '../../src/collectors/theses.js';
import { parseRingRoutes } from '../../src/ring.js';
import { fixture, fixtureBytes } from '../helpers.js';

describe('academic calendar', () => {
  it('finds year pages on the Turkish index', () => {
    const years = findYearPages(fixture('oidb-calendar-index.html'), 'https://oidb.metu.edu.tr/tr/akademik-takvim');
    expect(years.map((y) => y.year)).toContain('2026-2027');
    expect(years.find((y) => y.year === '2026-2027')!.url).toMatch(/^https:\/\/oidb\.metu\.edu\.tr\/tr\//);
  });

  it('parses the Turkish 2026-2027 table', () => {
    const events = parseCalendarTable(fixture('oidb-calendar-2026-2027.html'), '2026-2027');
    expect(events.length).toBeGreaterThan(140);
    const addDrop = events.filter((e) => e.tags.includes('add-drop'));
    expect(addDrop.map((e) => [e.start, e.end])).toEqual([
      ['2026-10-05', '2026-10-09'],
      ['2027-02-22', '2027-02-26'],
    ]);
    expect(events.find((e) => e.title.startsWith('Dönem sonu sınavları'))).toMatchObject({ start: '2027-01-04', end: '2027-01-16', term: 'fall' });
    expect(events.find((e) => e.start === '2027-02-15' && e.tags.includes('classes-start'))?.term).toBe('spring-summer');
    expect(events.filter((e) => e.precision === 'month').length).toBeGreaterThan(0);
  });

  it('parses the English 2026-2027 table the same way', () => {
    const tr = parseCalendarTable(fixture('oidb-calendar-2026-2027.html'), '2026-2027');
    const en = parseCalendarTable(fixture('oidb-calendar-2026-2027-en.html'), '2026-2027');
    expect(en.length).toBe(tr.length);
    expect(en.find((e) => e.tags.includes('add-drop'))).toMatchObject({ start: '2026-10-05', end: '2026-10-09', title: 'Add - Drop' });
    // "undergraduate" must not be tagged as a graduate-programme event.
    const ykS = en.filter((e) => e.title.startsWith('Registration of students who are placed in undergraduate'));
    expect(ykS.length).toBeGreaterThan(0);
    expect(ykS.every((e) => !e.tags.includes('graduate'))).toBe(true);
  });
});

describe('announcements', () => {
  it('splits Bu Hafta issues into items and skips births and deaths', () => {
    const items = parseBulletinIssues(fixture('buhafta-pages.json'), 'https://buhafta.metu.edu.tr/');
    const issue = items.filter((i) => i.id!.startsWith('announcement:bulletin:1530:'));
    expect(issue.length).toBeGreaterThanOrEqual(12);
    expect(issue[0]).toMatchObject({
      url: 'https://buhafta.metu.edu.tr/?page_id=1451',
      published_at: '2026-09-21T20:46:50.000Z',
      full_text: true,
    });
    expect(issue[0]!.title).toMatch(/^ARAŞTIRMA ÜNİVERSİTELERİ 2026/);
    expect(issue[0]!.summary).toMatch(/^Bu Hafta 1530 · Haberler\n\nAraştırma Üniversiteleri Destek Programı/);
    expect(issue.some((i) => i.summary.startsWith('Bu Hafta 1530 · Etkinlikler'))).toBe(true);
    expect(items.some((i) => /ACI KAYIPLARIMIZ|HOŞ GELDİN BEBEK/.test(i.title))).toBe(false);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });

  it('parses the Alumni Office feed', () => {
    const items = parseRss(fixture('mezun-feed.xml'), 'https://mezun.metu.edu.tr/feed/');
    expect(items.length).toBe(10);
    expect(items[0]).toMatchObject({ url: 'https://mezun.metu.edu.tr/ani-madalyasi-basvurulari-basladi/' });
  });

  it('parses the cafeteria card list with dd/mm/yyyy dates', () => {
    const items = parseDrupalList(fixture('kafeterya-announcements.html'), 'https://kafeterya.metu.edu.tr/tr/tum-duyurular');
    expect(items.length).toBeGreaterThanOrEqual(5);
    expect(items[0]).toMatchObject({
      url: 'https://kafeterya.metu.edu.tr/duyuru/kafeterya-ekiml-ayi-yemek-menusu-hk-about-monthly-menu-cafeteria-october',
      published_at: '2026-09-29T21:00:00.000Z',
    });
    expect(items[0]!.title).toMatch(/^Kafeterya Ekiml Ayı Yemek Menüsü/);
  });

  it('strips utm tracking parameters from WordPress feed links (Career Planning Center)', () => {
    const items = parseRss(fixture('kpm-feed.xml'), 'https://kpm.metu.edu.tr/feed/');
    expect(items.length).toBe(10);
    expect(items.every((i) => !i.url.includes('utm_'))).toBe(true);
    expect(items[0]!.url).toMatch(/^https:\/\/kpm\.metu\.edu\.tr\/[a-z0-9-]+\/$/);
    expect(items[0]!.published_at).toMatch(/^2026-/);
  });

  it('parses the ÖİDB Drupal list', () => {
    const items = parseDrupalList(fixture('oidb-announcements.html'), 'https://oidb.metu.edu.tr/tr/announcements');
    expect(items.length).toBeGreaterThanOrEqual(10);
    const amnesty = items.find((i) => i.url.endsWith('/7592-sayili-af-kanununun-gecici-85-maddesi-ile-ilgili-uygulama-esaslari'));
    expect(amnesty).toMatchObject({ published_at: '2026-09-23T14:20:41.000Z' });
    expect(amnesty!.summary).toContain('DAYANAK');
  });

  it('parses a Drupal 7 table list (Graduate School of Informatics)', () => {
    const items = parseDrupalList(fixture('ii-announcements.html'), 'https://ii.metu.edu.tr/tr/all-announcements');
    expect(items.length).toBeGreaterThanOrEqual(5);
    expect(items[1]).toMatchObject({
      title: '7592 Sayılı Af Kanunu Kapsamında Enformatik Enstitüsü Uygulama Esasları',
      url: 'https://ii.metu.edu.tr/tr/duyuru/7592-sayili-af-kanunu-kapsaminda-enformatik-enstitusu-uygulama-esaslari',
    });
    expect(items.every((i) => !i.url.includes('announcement-categories'))).toBe(true);
  });

  it('parses the Music and Fine Arts card list (mgsb, /tum-duyurular)', () => {
    const items = parseDrupalList(fixture('mgsb-tum-duyurular.html'), 'https://mgsb.metu.edu.tr/tr/tum-duyurular');
    expect(items.length).toBeGreaterThan(40);
    expect(items[1]).toMatchObject({
      title: 'Saksafon / Klarnet Derslerinin seçme günü değişikliği hakkında duyuru!',
      url: 'https://mgsb.metu.edu.tr/tr/duyuru/saksafon-klarnet-derslerinin-secme-gunu-degisikligi-hakkinda-duyuru',
      published_at: '2026-09-27T21:00:00.000Z',
    });
    expect(items[1]!.summary).toContain('Derslik 4');
  });

  it('parses the School of Foreign Languages list under /index.php/', () => {
    const items = parseDrupalList(fixture('ydyom-announcements.html'), 'https://ydyom.metu.edu.tr/index.php/tr/announcements');
    expect(items.map((i) => i.url)).toContain('https://ydyom.metu.edu.tr/tr/announcements/odtu-ingilizce-yeterlik-sinavi-iys-metu-english-proficiency-exam-epe');
    expect(items.every((i) => i.published_at)).toBe(true);
  });

  it('parses the Faculty of Architecture table list (no dates, unprefixed URLs)', () => {
    const items = parseDrupalList(fixture('arch-all-announcements.html'), 'https://arch.metu.edu.tr/tr/all-announcements');
    expect(items.length).toBeGreaterThan(100);
    expect(items[0]).toMatchObject({
      title: '2026-2027 Akademik Yılı Güz Dönemi için Yatay Geçiş Başvuruları',
      url: 'https://arch.metu.edu.tr/announcement/2026-2027-akademik-yili-guz-donemi-icin-yatay-gecis-basvurulari',
      published_at: null,
    });
    expect(itemLang(items[0]!.url)).toBeUndefined();
  });

  it('parses the Basic English dated file links (dd/mm/yyyy)', () => {
    const items = parseDatedLinks(fixture('dbe-announcements.html'), 'https://dbe.metu.edu.tr/_announcements.php');
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      title: '7 Ekim 2026 TİB Oryantasyon & Online Seviye Belirleme Sınavi Hk.',
      published_at: '2026-09-27T21:00:00.000Z',
      full_text: true,
    });
    expect(items[0]!.url).toMatch(/^http:\/\/dbe064\.dbe\.metu\.edu\.tr\/Uploads\/.*%20.*\.pdf$/);
  });

  it('parses RSS and strips slider boilerplate', () => {
    const items = parseRss(fixture('metu-rss.xml'), 'https://www.metu.edu.tr/tr/rss.xml');
    expect(items.length).toBe(10);
    expect(items[0]).toMatchObject({ title: 'Bundan sonrası ODTÜ', url: 'https://www.metu.edu.tr/tr/duyuru/bundan-sonrasi-odtu' });
    expect(items.every((i) => !/slider cover image/i.test(i.summary))).toBe(true);
  });
});

describe('KKM venue calendar', () => {
  it('parses the year view with ISO start, title link and hall', () => {
    const events = parseKkmYear(fixture('kkm-year-2025.html'), 'https://kkm.metu.edu.tr/calendar-node-field-etkinlik-tarihi/year/2025');
    expect(events.length).toBeGreaterThan(5);
    expect(events[0]).toEqual({
      id: 'kkm:mehtapli-gecelerde-konseri:2025-01-03',
      source: 'kkm',
      title: 'Mehtaplı Gecelerde Konseri',
      organizer: '',
      start: '2025-01-03T20:00:00+03:00',
      end: null,
      venue: 'Kemal Kurdaş Salonu',
      description: '',
      url: 'https://kkm.metu.edu.tr/etkinlik/mehtapli-gecelerde-konseri',
    });
    expect(events.every((e) => e.start?.startsWith('2025-'))).toBe(true);
  });
});

describe('OpenMETU theses (OAI-PMH)', () => {
  it('keeps theses with both titles, advisors, department, issue year and PDF; drops other item types', () => {
    const page = parseOaiPage(fixture('openmetu-oai-fbe.xml'));
    expect(page.theses).toHaveLength(19);
    expect(page.removed).toEqual([60501]); // a "Project" record
    expect(page.token).toBe('oai_dc///com_11511_16/100');
    expect(page.error).toBeNull();
    expect(page.theses.find((t) => t.id === 16114)).toEqual({
      id: 16114,
      title: 'Spectral (h-p) element methods approach to the solution of Poisson and Helmholtz equations using Matlab',
      title_alt: 'Spektral (h-p) eleman metodu yaklaşımıyla Poisson ve Helmholtz denlemlerinin Matlab kullanılarak çözümü',
      author: 'Maral, Tuğrul',
      advisors: 'Tarı, İlker',
      department: 'Department of Mechanical Engineering',
      year: 2006,
      degree: 'master',
      language: 'en',
      abstract: expect.stringMatching(/^A spectral element solver program using MATLAB/),
      subjects: 'Numerical Analysis; Mechanical Engineering',
      pdf_url: 'http://etd.lib.metu.edu.tr/upload/3/12607945/index.pdf',
      url: 'https://open.metu.edu.tr/handle/11511/16114',
      datestamp: '2021-05-20T14:25:27Z',
    });
    // Unpadded issue dates ("2026-1-23") and the degree line kept out of the abstract.
    const recent = page.theses.find((t) => t.id === 118705)!;
    expect(recent).toMatchObject({ year: 2026, degree: 'phd', advisors: 'Güzer, Celal Abdi', department: 'Department of Architecture' });
    expect(recent.abstract).not.toContain('Doctoral Program');
    expect(recent.abstract).toContain('\n\nBu doktora tezi');
  });

  it('ends a pass on an empty resumption token and reads OAI errors', () => {
    const last = parseOaiPage(fixture('openmetu-oai-ims-last.xml'));
    expect(last.token).toBeNull();
    expect(last.theses.map((t) => t.degree).sort()).toEqual(['master', 'master', 'master', 'master', 'phd']);
    expect(parseOaiPage(fixture('openmetu-oai-no-records.xml'))).toMatchObject({ theses: [], token: null, error: 'noRecordsMatch' });
  });
});

describe('double major and minor programmes', () => {
  it('parses the minor: title, description, must courses, a choice group and the free-text requirements', () => {
    const [minor, ...rest] = parseSpecialPrograms(fixture('catalog-minor-571.html'));
    expect(rest).toEqual([]);
    expect(minor!.title).toBe('Minor Program in Information Systems');
    expect(minor!.description).toMatch(/^Information Systems minor program aims/);
    expect(minor!.items.map((i) => (i.kind === 'course' ? i.short_code : i.kind))).toEqual(['CENG240', 'CENG350', 'CENG351', 'choice']);
    expect(minor!.items[3]).toMatchObject({ kind: 'choice', pick: 1, options: [{ short_code: 'CENG301' }, { short_code: 'CENG310' }] });
    expect(minor!.notes).toBe('3 elective course(s) approved by the Department of Computer Engineering. Total minimum credit: 21');
  });

  it('parses the double major for EE students', () => {
    const [dm] = parseSpecialPrograms(fixture('catalog-dm-571.html'));
    expect(dm!.title).toBe('Double Major Program in Computer Engineering For Electrical and Electronics Engineering Students');
    expect(dm!.items.filter((i) => i.kind === 'course').length).toBeGreaterThan(30);
    expect(dm!.notes).toContain('elective course(s) approved by the Department of Computer Engineering');
  });
});

describe('ring routes', () => {
  it('merges the two-column route tables in order, including the red ring that continues at 21', () => {
    const routes = parseRingRoutes(extractPage(fixture('tim-sari-kirmizi.html')).text);
    expect(routes.map((r) => [r.name, r.stops.length])).toEqual([['Sarı Ring Güzergahı', 20], ['Kırmızı Ring Güzergahı', 13]]);
    // Left column 1–11 (two stops are numbered 11 on the page), then the right column.
    expect(routes[0]!.stops.slice(9, 13)).toEqual(['Gıda Mühendisliği', 'Jeoloji Mühendisliği', 'Makina Mühendisliği', 'Endüstri Mühendisliği']);
    expect(routes[0]!.stops[0]).toBe('A-2 Metro Kapısı');
    expect(routes[1]!.stops[0]).toBe('Doğu Yurtlar');
    expect(routes[1]!.stops.at(-1)).toBe('A-2');
  });
});

describe('cafeteria', () => {
  it('parses a day menu', () => {
    const menu = parseDiningPage(fixture('kafeterya-2026-10-03.html'), '2026-10-03')!;
    expect(menu.lunch).toEqual(['YAYLA ÇORBA', 'ADANA KÖFTE', 'ŞEHRİYELİ BULGUR PİLAVI', 'MEYVE']);
    expect(menu.dinner.length).toBeGreaterThan(0);
  });

  it('parses today\'s page with breakfast, vegetarian and Faculty Club', () => {
    const menu = parseDiningPage(fixture('kafeterya-today.html'), '2026-09-30')!;
    expect(menu.breakfast).toEqual(['MERCİMEK ÇORBA']);
    expect(menu.vegetarian).toEqual(['PATATESLİ NOHUTLU MANTI']);
    expect(menu.vegan).toEqual(['MEYVE']);
    expect(menu.faculty_club).toContainEqual({ name: 'ŞEHRİYE ÇORBA', kcal: 150 });
  });

  it('refuses a page showing another date', () => {
    expect(parseDiningPage(fixture('kafeterya-2026-10-03.html'), '2026-10-04')).toBeUndefined();
  });

  it('parses meal hours and student prices', () => {
    const hours = parseMealHours(extractPage(fixture('kafeterya-hours.html')).text);
    expect(hours).toContainEqual({ meal: 'lunch', weekend: false, from: '11:30', to: '14:00' });
    expect(hours).toContainEqual({ meal: 'breakfast', weekend: true, from: '09:00', to: '10:30' });
    expect(parseStudentPrices(extractPage(fixture('kafeterya-prices.html')).text)).toEqual({ student_meal_try: 50, student_breakfast_try: 10 });
  });
});

describe('spreadsheets', () => {
  it('renders the dormitory fee table with labelled values and section paragraphs', () => {
    const text = spreadsheetText(fixtureBytes('yurt-ucretleri-2026-2027.xls.gz'));
    expect(text.startsWith('2026-2027 ÖĞRENİM YILI 1 EYLÜL 2026 - 31 AĞUSTOS 2027 DÖNEMİ YURT ÜCRETLERİ')).toBe(true);
    expect(text).toContain('Faika Demiray Yurdu (Kadın) | Oda Tipi (Kişi): 2 Kişi | Aylık Ücret ( ₺ ): 5504 | Alan m²: 20.3');
    // Section headings start paragraphs; the feature matrix (•) is dropped.
    expect(text).toContain('\n\n16. Konukevi - Kadın\n1 Kişilik ( banyolu ) | Oda Tipi (Kişi): 1 Kişi | Aylık Ücret ( ₺ ): 19523');
    expect(text).not.toContain('•');
  });

  it('finds the fee spreadsheet link on the dormitory rooms page', () => {
    const files = fileLinks(fixture('yurtlar-oda-fiyatlari.html'), 'https://yurtlar.metu.edu.tr/tr/oda-olanaklari-ve-fiyatlari', /yurt_ucret|dormitory_fees/i);
    expect(files.map((f) => f.url)).toEqual([
      'https://yurtlar.metu.edu.tr/sites/yurtlar.metu.edu.tr/files/2026-2027_1_eylul_2026_31_agustos_2027_yurt_ucretleri_1.xls',
    ]);
  });
});

describe('info pages', () => {
  it('extracts body text and the Drupal 8 "Son güncelleme" stamp', () => {
    const page = extractPage(fixture('ihm-park-yerleri.html'));
    expect(page.text).toContain('Öğrenci kahverengi taşıt pulu');
    expect(page.text).not.toContain('Dumlupınar Bulvarı');
    expect(page.updatedAt).toBe('2026-07-11T11:31:28.000Z');
  });

  it('extracts the Drupal 7 stamp', () => {
    expect(extractPage(fixture('tim-sari-kirmizi.html')).updatedAt).toBe('2024-11-19T12:14:00.000Z');
  });

  it('discovers translations but ignores untranslated placeholders', () => {
    const cal = extractPage(fixture('oidb-calendar-2026-2027.html'), 1000, 'https://oidb.metu.edu.tr/tr/x');
    expect(cal.alternates.en).toBe('https://oidb.metu.edu.tr/en/metu-ankara-and-erdemli-campuses-2026-2027-academic-year-calendar');
    expect(extractPage(fixture('kafeterya-hours.html'), 1000, 'https://kafeterya.metu.edu.tr/x').alternates.en).toBeUndefined();
  });
});

describe('campus map and ring', () => {
  it('parses parking-lot markers and decodes escapes', () => {
    const lots = parseMarkers(fixture('map-type7.html'), 7);
    expect(lots.length).toBe(109);
    expect(lots.find((l) => l.name === '1st Dormitory Parking Lot')).toMatchObject({ category: 'Parking lot', lat: 39.890719059606 });
    expect(lots.some((l) => l.name === 'İsa Demiray Dormitory Parking Lot')).toBe(true);
  });

  it('parses live ring.json', () => {
    const buses = parseRingJson(fixture('ring.json'));
    expect(buses.length).toBeGreaterThan(0);
    expect(buses[0]).toMatchObject({ plate: '06 DV 5326', route_color: 'yellow', segment: 'Garajlar → BOTE-MYO' });
    expect(buses[0]!.next_stops[0]).toMatchObject({ stop: 'BOTE-MYO', eta_min: 1 });
  });

  it('parses ring departures from the timetable page', () => {
    const deps = parseDepartures(extractPage(fixture('tim-sari-kirmizi.html')).text);
    expect(deps[0]).toBe(9 * 60);
    expect(deps).toContain(17 * 60 + 35);
    expect(deps.length).toBe(26);
  });
});

describe('course catalog', () => {
  it('lists the programmes of a faculty', () => {
    const { faculty, programs } = parseFacultyPrograms(fixture('catalog-faculty-500.html'), 500);
    expect(faculty).toBe('Faculty of Engineering');
    expect(programs.length).toBe(15);
    expect(programs.find((p) => p.prog === 571)).toEqual({ prog: 571, name: 'Computer Engineering', degree: 'B.S.' });
  });

  it('lists graduate school programmes (inst_prog links, several degrees)', () => {
    const { faculty, programs } = parseFacultyPrograms(fixture('catalog-faculty-900.html'), 900);
    expect(faculty).toBe('Graduate School of Informatics');
    expect(programs.length).toBeGreaterThanOrEqual(10);
    expect(programs.find((p) => p.prog === 902)).toEqual({ prog: 902, name: 'Cognitive Sciences', degree: 'M.S.(1, 2), Ph.D.(4, 5)' });
  });

  it('parses the course table of a department', () => {
    const { department, courses } = parseProgramCourses(fixture('catalog-prog-courses-571.html'));
    expect(department).toBe('Computer Engineering');
    expect(courses.length).toBe(147);
    expect(courses.find((c) => c.code === '5710213')).toEqual({
      code: '5710213', short_code: 'CENG213', name: 'DATA STRUCTURES', metu_credit: 4, contact_hours: 3, lab_hours: 2, ects: 7,
    });
  });

  it('parses a course page with one prerequisite set', () => {
    const c = parseCourseDetail(fixture('catalog-course-5710213.html'))!;
    expect(c).toMatchObject({
      code: '5710213', short_code: 'CENG213', name: 'DATA STRUCTURES', credit_text: '4(3-2)', ects: 7,
      language: 'English', level: 'Undergraduate', offered_semester: 'Fall Semesters', prerequisites: [['5710140']],
    });
    expect(c.coordinator).toContain('ÇİÇEKLİ');
    expect(c.content).toMatch(/^Classification of data structures/);
    expect(c.content).not.toContain('iframe');
  });

  it('parses alternative prerequisite sets and courses without prerequisites', () => {
    expect(parseCourseDetail(fixture('catalog-course-5710351.html'))!.prerequisites).toEqual([['5710213'], ['5710301'], ['5710310']]);
    expect(parseCourseDetail(fixture('catalog-course-5710140.html'))).toMatchObject({ prerequisites: [], prerequisite_note: null });
  });

  it('normalizes course codes', () => {
    expect(normalizeCourseCode('ceng 213')).toBe('CENG213');
    expect(normalizeCourseCode('MATH-119')).toBe('MATH119');
  });
});

describe('health center doctors', () => {
  it('parses specialty, name, status and standing note', () => {
    const doctors = parseDoctors(fixture('srm-doktorlarimiz.html'));
    expect(doctors.length).toBeGreaterThan(15);
    expect(doctors[0]).toEqual({
      specialty: 'DERMATOLOJİ (DERMATOLOGY)',
      name: 'NESİBE DEREN ÖZCAN',
      status: 'unknown',
      status_text: '',
      note: 'HER PAZARTESİ-SALI-ÇARŞAMBA SADECE SABAH BURADA - RANDEVU SADECE ONLİNE ALINIYOR',
    });
    expect(doctors.find((d) => d.name === 'DENİZ DİDEM SAVCI MAĞOL')?.status).toBe('off_duty');
  });

  it('normalizes status cells', () => {
    expect(normalizeDutyStatus('BURADA (ON DUTY)')).toBe('on_duty');
    expect(normalizeDutyStatus('İZİNLİ (OFF DUTY)')).toBe('off_duty');
    expect(normalizeDutyStatus('-')).toBe('unknown');
    expect(normalizeDutyStatus('KONGREDE')).toBe('other');
  });
});

describe('events', () => {
  it('parses the hand-edited KİM club events list', () => {
    const events = parseKimEvents(fixture('kim-etkinlikler.html'), 'https://kim.metu.edu.tr/tr/etkinlikler');
    expect(events.length).toBe(5);
    expect(events[0]).toMatchObject({
      title: 'OYUN NASIL OYNANMALI?', organizer: 'TÜRK HALK BİLİMİ TOPLULUĞU', venue: 'MİMARLIK AMFİSİ',
      start: '2026-10-02T20:00:00+03:00', end: '2026-10-03T22:00:00+03:00',
    });
    // Two events under one club heading keep the organizer.
    expect(events.filter((e) => e.organizer === 'İŞLETME TOPLULUĞU').map((e) => e.title)).toEqual(['EYMİR GÖLÜ LİDERLİK OYUNLARI', 'FİNANS KONGRESİ']);
  });

  it('parses the 70th-anniversary event list and an event page', () => {
    const list = parse70yilList(fixture('70yil-all-events.html'), 'https://70yil.metu.edu.tr/tr/events/all-events');
    expect(list.length).toBe(10);
    expect(list[0]!.url).toBe('https://70yil.metu.edu.tr/tr/bote-bolumu-mezunlar-bulusmasi');
    const ev = parse70yilEvent(fixture('70yil-event-kariyer-fuari.html'), 'https://70yil.metu.edu.tr/tr/guz-26-kariyer-fuari', 'Güz 26 Kariyer Fuarı');
    expect(ev).toMatchObject({
      id: '70yil:guz-26-kariyer-fuari', start: '2026-10-22T10:00:00+03:00', end: '2026-10-23T17:00:00+03:00',
      venue: 'ODTÜ Kültür ve Kongre Merkezi', organizer: 'Kariyer Planlama Uygulama ve Araştırma Merkezi',
    });
    expect(ev.description).toContain('50 katılımcı firma');
  });
});

describe('BİDB FAQ', () => {
  it('lists groups and the questions of a group', () => {
    const groups = parseFaqGroups(fixture('bidb-faq-home.html'));
    expect(groups.length).toBeGreaterThanOrEqual(40);
    expect(groups).toContainEqual({ slug: 'lisansli-yazilimlar', name: expect.any(String) });
    const items = parseFaqGroupList(fixture('bidb-faq-group-eduroam.html'));
    expect(items.length).toBe(13);
    expect(items[0]!.url).toMatch(/^https:\/\/faq\.cc\.metu\.edu\.tr\/tr\/sss\/android-/);
  });

  it('parses an answer page', () => {
    expect(parseFaqAnswer(fixture('bidb-faq-eduroam-sifre.html'))).toMatchObject({
      question: 'eduroam şifremi unuttum, ne yapmalıyım?',
      groups: ['eduroam', 'Ağ'],
      updated_at: '2019-12-13T09:00:00.000Z',
    });
    expect(parseFaqAnswer(fixture('bidb-faq-eduroam-sifre.html'))!.answer).toMatch(/^Eduroam yayınına bağlanabilmek için/);
  });
});

describe('page file links', () => {
  it('lists matching file links with readable titles', () => {
    const files = fileLinks(fixture('spormd-hizli-baglantilar.html'), 'https://spormd.metu.edu.tr/tr/hizli-baglantilar', /ucret|kural|talimat/i);
    expect(files.map((f) => f.url)).toEqual([
      'https://spormd.metu.edu.tr/sites/spormd.metu.edu.tr/files/tesis_kullanim_ucretleri_2026_ocak.jpeg',
      'https://spormd.metu.edu.tr/sites/spormd.metu.edu.tr/files/odtu_spor_tesisleri_genel_kullanim_kurallari_1_1.pdf',
      'https://spormd.metu.edu.tr/sites/spormd.metu.edu.tr/files/odtu_fitness_salonlari_kullanma_talimati_2025.pdf',
    ]);
    expect(files.every((f) => f.title.length > 0)).toBe(true);
  });
});

describe('small helpers', () => {
  it('keeps only the unit name of an event contact', () => {
    expect(organizerName('ODTÜ Spor Müdürlüğü 0312 210 21 96 spormd.metu.edu.tr')).toBe('ODTÜ Spor Müdürlüğü');
    expect(organizerName('Kariyer Planlama Uygulama ve Araştırma Merkezi kpm@metu.edu.tr +90 (312) 210 4129')).toBe('Kariyer Planlama Uygulama ve Araştırma Merkezi');
    expect(organizerName('Mimarlık Fakültesi')).toBe('Mimarlık Fakültesi');
  });

  it('takes an announcement language from its URL prefix', () => {
    expect(itemLang('https://math.metu.edu.tr/en/announcements/x')).toBe('en');
    expect(itemLang('https://oidb.metu.edu.tr/tr/duyuru/x')).toBe('tr');
    expect(itemLang('https://kpm.metu.edu.tr/stajyer-x/')).toBeUndefined();
  });
});

describe('curriculum', () => {
  it('parses eight semesters with must courses, electives, choice groups and ECTS totals', () => {
    const semesters = parseCurriculum(fixture('catalog-program-571.html'));
    expect(semesters.map((s) => s.ects_total)).toEqual([33, 31.5, 32, 32, 40, 31.5, 28, 27]);
    expect(semesters[0]!.items[0]).toEqual({ kind: 'course', code: '2300105', short_code: 'PHYS105', name: 'GENERAL PHYSICS I', credit: 4, ects: 7 });
    expect(semesters[2]!.items.at(-1)).toMatchObject({ kind: 'choice', pick: 1, options: [{ short_code: 'HIST2201' }, { short_code: 'HIST2205' }] });
    expect(semesters[6]!.items.filter((i) => i.kind === 'elective').map((i) => (i as { label: string }).label)).toEqual(['TECHNICAL ELECTIVE', 'TECHNICAL ELECTIVE']);
  });

  it('returns nothing for a page without a curriculum', () => {
    expect(parseCurriculum('<html><body>Graduate Program</body></html>')).toEqual([]);
  });
});

describe('classroom locations', () => {
  it('maps classroom codes to buildings and map place ids, block by block', () => {
    const buildings = parseClassrooms(fixture('metu-classrooms.html'));
    expect(buildings.length).toBe(40);
    expect(buildings[0]).toEqual({ building: 'Computer Center Building', place_id: 'map:679', codes: ['BMB G102'] });
    const blockA = buildings.find((b) => b.building.endsWith('A Block'))!;
    expect(blockA).toMatchObject({ building: 'Department of Basic English Building — A Block', place_id: 'map:668' });
    expect(blockA.codes).toContain('HZA105');
    expect(buildings.every((b) => b.place_id)).toBe(true);
    expect(normalizeRoomCode('yp-d101')).toBe('YPD101');
  });
});

describe('METULearn trainings', () => {
  it('parses list cards, the page count and the total', () => {
    const { cards, maxPage, total } = parseTrainingList(fixture('learn-trainings-page1.html'));
    expect(cards).toHaveLength(24);
    expect(maxPage).toBe(24);
    expect(total).toBe(576);
    expect(cards.find((c) => c.id === 'sem-352')).toEqual({
      id: 'sem-352',
      provider: 'ODTÜ-SEM',
      title: 'Eğitimde Yapay Zeka Kullanımı Sertifika Programı',
      description: expect.stringMatching(/^● Yapay Zeka Araçlarının Kullanımını Öğrenme/),
      category: 'Bilişim Teknolojileri',
      language: 'Türkçe',
      format: 'in-person',
      price: '10.000 TL',
      duration: null,
    });
    // Open courseware shows a module count where others show the format.
    expect(cards.find((c) => c.id === 'moodle-1180')).toMatchObject({
      provider: 'METU OCW', category: 'Modern Diller Bölümü', language: 'English', format: null, price: 'Ücretsiz', duration: '139 modül',
    });
    expect(cards.find((c) => c.id === 'moodle-722')).toMatchObject({ provider: 'Bilgeİş', format: 'online', price: 'Ücretsiz' });
  });

  it('parses a detail fragment with a dated start and registration window', () => {
    expect(parseTrainingDetail(fixture('learn-course-sem-352.html'))).toMatchObject({
      format: 'in-person',
      price: '10.000 TL',
      start_text: '29.09.2026 – 29.09.2026',
      start_date: '2026-09-29',
      end_date: '2026-09-29',
      registration: '29.09.2026 – 29.09.2026',
      registration_status: 'Kayıtlar Açık',
      enroll_url: 'https://harman.cc.metu.edu.tr/courses/egitim_1/',
      description: expect.stringContaining('Çevrimiçi Eğitimin Artan Popülaritesi'),
    });
  });

  it('keeps self-paced starts as text and reads single dates', () => {
    const selfPaced = parseTrainingDetail(fixture('learn-course-sem-327.html'));
    expect(selfPaced).toMatchObject({ start_text: 'İstediğiniz zaman başlayabilirsiniz', start_date: null, end_date: null, registration_status: null });
    const ocw = parseTrainingDetail(fixture('learn-course-moodle-1180.html'));
    expect(ocw).toMatchObject({ start_date: '2016-10-03', end_date: '2016-10-03', format: null, enroll_url: 'https://ocw.metu.edu.tr/course/view.php?id=252' });
    expect(parseTrainingDetail(fixture('learn-course-moodle-722.html')).enroll_url).toBe('https://bilgeis.net/course/view.php?id=113');
  });

  it('normalizes formats', () => {
    expect(['Online', 'Yüz Yüze', 'Çevrim İçi', 'Hibrit', 'İletişim Becerileri'].map(normalizeFormat)).toEqual(['online', 'in-person', 'online', 'hybrid', null]);
  });
});

describe('School of Foreign Languages pages', () => {
  it('extracts the course list with hours and fees, ignoring commented-out courses', () => {
    const page = extractPage(fixture('dil-courses-in-person.html'), 30000, 'https://dil.metu.edu.tr/kurslar/yuz-yuze/');
    expect(page.title).toBe('Yüz Yüze Kurslar');
    expect(page.text).toContain('TOEFL');
    expect(page.text).toContain('128 Saat\n79.928 TL');
    expect(page.text).not.toContain('2.860 TL');
    expect(page.text).not.toContain('Gizlilik Sözleşmesi');
  });

  it('extracts a course schedule and its details PDF', () => {
    const url = 'https://dil.metu.edu.tr/kurslar/yuz-yuze/toefl/';
    const page = extractPage(fixture('dil-course-campus-toefl.html'), 30000, url);
    expect(page.title).toBe('TOEFL');
    expect(page.text).toContain('Kurs Başlangıç\n26 Eylül 2026');
    expect(page.text).toContain('Kayıt Bitiş\n07 Eylül 2026');
    expect(fileLinks(fixture('dil-course-campus-toefl.html'), url, /\/kursdetaylari\//i).map((f) => f.url)).toEqual([
      'https://dil.metu.edu.tr/uploads/documents/kursdetaylari/yuz-yuze/toefl.pdf',
    ]);
  });
});

describe('course syllabus', () => {
  it('finds the embedded syllabus fragments on a course page and reads them', () => {
    const urls = parseCourseDetail(fixture('catalog-course-5710213.html'))!.syllabus_urls;
    expect(urls.objectives).toMatch(/^https:\/\/odtusyllabus\.metu\.edu\.tr\/get\.php\?package=/);
    expect(urls.outcomes).toMatch(/^https:\/\/odtusyllabus\.metu\.edu\.tr\/get\.php\?package=/);
    expect(parseSyllabusFragment(fixture('syllabus-5710213-objectives.html'))).toMatch(/^This course aims to introduce the abstract concepts/);
    const outcomes = parseSyllabusFragment(fixture('syllabus-5710213-outcomes.html'));
    expect(outcomes).toMatch(/^At the end of this course, students will be able to:/);
    expect(outcomes).toContain('implement data structures in C++');
    expect(outcomes).not.toContain('Course Learning Outcomes');
  });
});
