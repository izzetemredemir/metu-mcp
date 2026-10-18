import path from 'node:path';

/** All source definitions, TTLs, staleness thresholds and feature flags live here. */

export const APP_NAME = 'metu-mcp';
export const APP_VERSION = '0.1.0';
export const TIMEZONE = 'Europe/Istanbul';

export const USER_AGENT =
  process.env.METU_MCP_USER_AGENT ??
  `${APP_NAME}/${APP_VERSION} (unofficial METU student-info project; contact: ${process.env.METU_MCP_CONTACT ?? 'metu-mcp@example.com'})`;

export const DB_PATH = process.env.METU_MCP_DB ?? path.resolve('var/metu.db');

/** Daily database copies kept by the maintenance job. */
export const BACKUP_KEEP = 7;

/** Requests are only ever sent to these domains (SSRF protection). */
export const ALLOWED_HOST_SUFFIXES = ['.metu.edu.tr'];

/**
 * The only non-METU host: a public Overpass API instance for OpenStreetMap building names and outlines (one query a
 * week, see OSM_*). overpass-api.de disallows /api/ in robots.txt; this instance publishes no robots.txt.
 */
export const ALLOWED_EXTRA_HOSTS = ['overpass.kumi.systems'];

/** Minimum gap between two requests to the same host (ms). A larger robots.txt Crawl-delay wins. */
export const DEFAULT_HOST_INTERVAL_MS = 3_000;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** METU publishes in Turkish and English; every record carries its language. */
export type Lang = 'tr' | 'en';
export const LANGS: Lang[] = ['tr', 'en'];

export type RecordKind = 'announcement' | 'calendar' | 'menu' | 'page' | 'places' | 'link' | 'course' | 'duty' | 'event' | 'faq' | 'curriculum' | 'training' | 'thesis';

/** Per record kind: if the source has not been verified for longer than this, answers carry a warning. */
export const STALE_AFTER_MS: Record<RecordKind, number> = {
  announcement: 2 * HOUR,
  menu: 1 * DAY,
  calendar: 7 * DAY,
  page: 7 * DAY,
  places: 30 * DAY,
  link: 30 * DAY,
  course: 30 * DAY,
  // Doctors on duty change during the day; collected hourly on weekdays.
  duty: 20 * HOUR,
  event: 2 * DAY,
  faq: 14 * DAY,
  curriculum: 30 * DAY,
  // METULearn catalog: listed weekly, details refreshed daily in batches.
  training: 10 * DAY,
  // OpenMETU theses: harvested nightly (new theses appear in batches after each graduation period).
  thesis: 3 * DAY,
};

/** After this many consecutive collector failures a source is reported as `source_unreachable`. */
export const UNREACHABLE_AFTER_FAILURES = 3;

export type AnnouncementCategory =
  | 'university'
  | 'registrar'
  | 'department'
  | 'graduate-school'
  | 'international'
  | 'it'
  | 'campus'
  | 'library'
  | 'sports'
  | 'health'
  | 'dining'
  | 'career';

export type Localized = Record<Lang, string>;

export interface AnnouncementSource {
  id: string;
  name: Localized;
  category: AnnouncementCategory;
  /**
   * `rss`: RSS 2.0 feed; `drupal`: announcement list of METU's shared Drupal theme ("miys");
   * `wp-bulletin`: "Bu Hafta" issues from the WordPress REST API, split into one item per news/event/notice;
   * `dated-links`: an HTML fragment of `<a>title</a> (dd/mm/yyyy)` lines, each linking a file (dbe.metu.edu.tr).
   */
  type: 'rss' | 'drupal' | 'wp-bulletin' | 'dated-links';
  /** Site root for building links when the list URL is an API endpoint. */
  site_url?: string;
  /** Polled hourly by `announcements-hourly` instead of every 20 minutes (most department sites post rarely). */
  hourly?: boolean;
  /** List URL per language. English lists are collected too where METU publishes them. */
  urls: Partial<Record<Lang, string>>;
  /** Number of list pages to crawl for drupal lists (?page=0..n-1). */
  pages?: number;
  department?: string;
}

export const ANNOUNCEMENT_SOURCES: AnnouncementSource[] = [
  { id: 'metu', name: { en: 'METU main site', tr: 'ODTÜ ana sayfa' }, category: 'university', type: 'rss', urls: { tr: 'https://www.metu.edu.tr/tr/rss.xml' } },
  { id: 'oidb', name: { en: 'Registrar\'s Office (ÖİDB)', tr: 'Öğrenci İşleri Daire Başkanlığı (ÖİDB)' }, category: 'registrar', type: 'drupal', urls: { tr: 'https://oidb.metu.edu.tr/tr/announcements', en: 'https://oidb.metu.edu.tr/en/announcements' }, pages: 2 },
  { id: 'ceit', name: { en: 'Computer Education and Instructional Technology (CEIT/BÖTE)', tr: 'Bilgisayar ve Öğretim Teknolojileri Eğitimi Bölümü (BÖTE)' }, category: 'department', type: 'drupal', urls: { tr: 'https://ceit.metu.edu.tr/tr/announcements', en: 'https://ceit.metu.edu.tr/en/announcements' }, department: 'ceit' },
  { id: 'ceng', name: { en: 'Computer Engineering (CENG)', tr: 'Bilgisayar Mühendisliği Bölümü' }, category: 'department', type: 'rss', urls: { tr: 'https://ceng.metu.edu.tr/rss.xml' }, department: 'ceng' },
  { id: 'math', name: { en: 'Mathematics (MATH)', tr: 'Matematik Bölümü' }, category: 'department', type: 'drupal', urls: { tr: 'https://math.metu.edu.tr/tr/announcements', en: 'https://math.metu.edu.tr/en/announcements' }, department: 'math', hourly: true },
  { id: 'phys', name: { en: 'Physics (PHYS)', tr: 'Fizik Bölümü' }, category: 'department', type: 'drupal', urls: { tr: 'https://phys.metu.edu.tr/tr/announcements', en: 'https://phys.metu.edu.tr/en/announcements' }, department: 'phys', hourly: true },
  { id: 'biol', name: { en: 'Biological Sciences (BIOL)', tr: 'Biyolojik Bilimler Bölümü' }, category: 'department', type: 'drupal', urls: { tr: 'https://bio.metu.edu.tr/tr/announcements', en: 'https://bio.metu.edu.tr/en/announcements' }, department: 'biol', hourly: true },
  { id: 'stat', name: { en: 'Statistics (STAT)', tr: 'İstatistik Bölümü' }, category: 'department', type: 'drupal', urls: { tr: 'https://stat.metu.edu.tr/tr/announcements', en: 'https://stat.metu.edu.tr/en/announcements' }, department: 'stat', hourly: true },
  { id: 'hist', name: { en: 'History (HIST)', tr: 'Tarih Bölümü' }, category: 'department', type: 'drupal', urls: { tr: 'https://hist.metu.edu.tr/tr/announcements', en: 'https://hist.metu.edu.tr/en/announcements' }, department: 'hist', hourly: true },
  { id: 'phil', name: { en: 'Philosophy (PHIL)', tr: 'Felsefe Bölümü' }, category: 'department', type: 'drupal', urls: { tr: 'https://phil.metu.edu.tr/tr/announcements', en: 'https://phil.metu.edu.tr/en/announcements' }, department: 'phil', hourly: true },
  { id: 'psy', name: { en: 'Psychology (PSY)', tr: 'Psikoloji Bölümü' }, category: 'department', type: 'drupal', urls: { tr: 'https://psy.metu.edu.tr/tr/announcements', en: 'https://psy.metu.edu.tr/en/announcements' }, department: 'psy', hourly: true },
  { id: 'soc', name: { en: 'Sociology (SOC)', tr: 'Sosyoloji Bölümü' }, category: 'department', type: 'drupal', urls: { en: 'https://soc.metu.edu.tr/en/announcements' }, department: 'soc', hourly: true },
  { id: 'econ', name: { en: 'Economics (ECON)', tr: 'İktisat Bölümü' }, category: 'department', type: 'drupal', urls: { tr: 'https://econ.metu.edu.tr/tr/announcements', en: 'https://econ.metu.edu.tr/en/announcements' }, department: 'econ', hourly: true },
  { id: 'ba', name: { en: 'Business Administration (BA)', tr: 'İşletme Bölümü' }, category: 'department', type: 'drupal', urls: { tr: 'https://ba.metu.edu.tr/tr/announcements', en: 'https://ba.metu.edu.tr/en/announcements' }, department: 'ba', hourly: true },
  { id: 'ir', name: { en: 'International Relations (IR)', tr: 'Uluslararası İlişkiler Bölümü' }, category: 'department', type: 'drupal', urls: { tr: 'https://ir.metu.edu.tr/tr/announcements', en: 'https://ir.metu.edu.tr/en/announcements' }, department: 'ir', hourly: true },
  { id: 'crp', name: { en: 'City and Regional Planning (CRP)', tr: 'Şehir ve Bölge Planlama Bölümü' }, category: 'department', type: 'drupal', urls: { tr: 'https://crp.metu.edu.tr/tr/tum-duyurular', en: 'https://crp.metu.edu.tr/en/tum-duyurular' }, department: 'crp', hourly: true },
  { id: 'id', name: { en: 'Industrial Design (ID)', tr: 'Endüstriyel Tasarım Bölümü' }, category: 'department', type: 'drupal', urls: { tr: 'https://id.metu.edu.tr/tr/tum-duyurular', en: 'https://id.metu.edu.tr/en/tum-duyurular' }, department: 'id', hourly: true },
  { id: 'eds', name: { en: 'Educational Sciences (EDS)', tr: 'Eğitim Bilimleri Bölümü' }, category: 'department', type: 'drupal', urls: { tr: 'https://eds.metu.edu.tr/tr/announcements', en: 'https://eds.metu.edu.tr/en/announcements' }, department: 'eds', hourly: true },
  { id: 'fle', name: { en: 'Foreign Language Education (FLE)', tr: 'Yabancı Diller Eğitimi Bölümü' }, category: 'department', type: 'drupal', urls: { tr: 'https://fle.metu.edu.tr/tr/announcements', en: 'https://fle.metu.edu.tr/en/announcements' }, department: 'fle', hourly: true },
  { id: 'ee', name: { en: 'Electrical and Electronics Engineering (EE)', tr: 'Elektrik ve Elektronik Mühendisliği Bölümü' }, category: 'department', type: 'drupal', urls: { tr: 'https://eee.metu.edu.tr/tr/butun-duyurular', en: 'https://eee.metu.edu.tr/en/butun-duyurular' }, department: 'ee', hourly: true },
  { id: 'me', name: { en: 'Mechanical Engineering (ME)', tr: 'Makina Mühendisliği Bölümü' }, category: 'department', type: 'drupal', urls: { tr: 'https://me.metu.edu.tr/tr/announcements', en: 'https://me.metu.edu.tr/en/announcements' }, department: 'me', hourly: true },
  { id: 'ce', name: { en: 'Civil Engineering (CE)', tr: 'İnşaat Mühendisliği Bölümü' }, category: 'department', type: 'drupal', urls: { tr: 'https://ce.metu.edu.tr/tr/tum-duyurular', en: 'https://ce.metu.edu.tr/en/tum-duyurular' }, department: 'ce', hourly: true },
  { id: 'ie', name: { en: 'Industrial Engineering (IE)', tr: 'Endüstri Mühendisliği Bölümü' }, category: 'department', type: 'drupal', urls: { tr: 'https://ie.metu.edu.tr/tr/tum-duyurular', en: 'https://ie.metu.edu.tr/en/tum-duyurular' }, department: 'ie', hourly: true },
  { id: 'che', name: { en: 'Chemical Engineering (CHE)', tr: 'Kimya Mühendisliği Bölümü' }, category: 'department', type: 'drupal', urls: { tr: 'https://che.metu.edu.tr/tr/tum-duyurular', en: 'https://che.metu.edu.tr/en/tum-duyurular' }, department: 'che', hourly: true },
  { id: 'enve', name: { en: 'Environmental Engineering (ENVE)', tr: 'Çevre Mühendisliği Bölümü' }, category: 'department', type: 'drupal', urls: { tr: 'https://enve.metu.edu.tr/tr/announcements', en: 'https://enve.metu.edu.tr/en/announcements' }, department: 'enve', hourly: true },
  { id: 'fde', name: { en: 'Food Engineering (FDE)', tr: 'Gıda Mühendisliği Bölümü' }, category: 'department', type: 'drupal', urls: { tr: 'https://fde.metu.edu.tr/tr/announcements', en: 'https://fde.metu.edu.tr/en/announcements' }, department: 'fde', hourly: true },
  { id: 'geoe', name: { en: 'Geological Engineering (GEOE)', tr: 'Jeoloji Mühendisliği Bölümü' }, category: 'department', type: 'drupal', urls: { tr: 'https://geoe.metu.edu.tr/tr/announcements', en: 'https://geoe.metu.edu.tr/en/announcements' }, department: 'geoe', hourly: true },
  { id: 'mine', name: { en: 'Mining Engineering (MINE)', tr: 'Maden Mühendisliği Bölümü' }, category: 'department', type: 'drupal', urls: { tr: 'https://mine.metu.edu.tr/tr/announcements', en: 'https://mine.metu.edu.tr/en/announcements' }, department: 'mine', hourly: true },
  { id: 'pete', name: { en: 'Petroleum and Natural Gas Engineering (PETE)', tr: 'Petrol ve Doğal Gaz Mühendisliği Bölümü' }, category: 'department', type: 'drupal', urls: { tr: 'https://pete.metu.edu.tr/tr/announcements', en: 'https://pete.metu.edu.tr/en/announcements' }, department: 'pete', hourly: true },
  { id: 'mete', name: { en: 'Metallurgical and Materials Engineering (METE)', tr: 'Metalurji ve Malzeme Mühendisliği Bölümü' }, category: 'department', type: 'drupal', urls: { en: 'https://mete.metu.edu.tr/en/announcements' }, department: 'mete', hourly: true },
  { id: 'pes', name: { en: 'Physical Education and Sports (PES)', tr: 'Beden Eğitimi ve Spor Bölümü' }, category: 'department', type: 'drupal', urls: { tr: 'https://pes.metu.edu.tr/tr/announcements', en: 'https://pes.metu.edu.tr/en/announcements' }, department: 'pes', hourly: true },
  { id: 'es', name: { en: 'Engineering Sciences (ES)', tr: 'Mühendislik Bilimleri Bölümü' }, category: 'department', type: 'drupal', urls: { tr: 'https://es.metu.edu.tr/tr/announcements', en: 'https://es.metu.edu.tr/en/announcements' }, department: 'es', hourly: true },
  { id: 'mus', name: { en: 'Music and Fine Arts (MUS)', tr: 'Müzik ve Güzel Sanatlar Bölümü' }, category: 'department', type: 'drupal', urls: { tr: 'https://mgsb.metu.edu.tr/tr/tum-duyurular', en: 'https://mgsb.metu.edu.tr/en/tum-duyurular' }, department: 'mus', hourly: true },
  // Drupal 7 table list without dates; the Turkish and English lists link the same unprefixed URLs, so only one is kept.
  { id: 'arch', name: { en: 'Faculty of Architecture (ARCH)', tr: 'Mimarlık Fakültesi' }, category: 'department', type: 'drupal', urls: { tr: 'https://arch.metu.edu.tr/tr/all-announcements' }, department: 'arch', hourly: true },
  { id: 'mld', name: { en: 'Modern Languages Department (MLD)', tr: 'Modern Diller Birimi' }, category: 'department', type: 'drupal', urls: { tr: 'https://mld.metu.edu.tr/tr/announcements', en: 'https://mld.metu.edu.tr/en/announcements' }, department: 'mld', hourly: true },
  { id: 'ydyo', name: { en: 'School of Foreign Languages (YDYO)', tr: 'Yabancı Diller Yüksekokulu (YDYO)' }, category: 'department', type: 'drupal', urls: { tr: 'https://ydyom.metu.edu.tr/index.php/tr/announcements', en: 'https://ydyom.metu.edu.tr/index.php/en/announcements' }, department: 'ydyo', hourly: true },
  // The home page loads its notices (placement exams, results; PDF links) from this fragment with jQuery.
  { id: 'dbe', name: { en: 'Department of Basic English (prep school)', tr: 'Temel İngilizce Birimi (hazırlık)' }, category: 'department', type: 'dated-links', urls: { tr: 'https://dbe.metu.edu.tr/_announcements.php' }, department: 'dbe', hourly: true },
  { id: 'iam', name: { en: 'Institute of Applied Mathematics (IAM)', tr: 'Uygulamalı Matematik Enstitüsü' }, category: 'graduate-school', type: 'drupal', urls: { tr: 'https://iam.metu.edu.tr/tr/announcements', en: 'https://iam.metu.edu.tr/en/announcements' }, hourly: true },
  // Drupal 7 table list without dates, English-only site.
  { id: 'ims', name: { en: 'Institute of Marine Sciences (IMS, Erdemli)', tr: 'Deniz Bilimleri Enstitüsü (Erdemli)' }, category: 'graduate-school', type: 'drupal', urls: { en: 'https://ims.metu.edu.tr/all-announcements' }, hourly: true },
  { id: 'fbe', name: { en: 'Graduate School of Natural and Applied Sciences (FBE)', tr: 'Fen Bilimleri Enstitüsü' }, category: 'graduate-school', type: 'drupal', urls: { tr: 'https://fbe.metu.edu.tr/tr/announcements', en: 'https://fbe.metu.edu.tr/en/announcements' } },
  { id: 'sbe', name: { en: 'Graduate School of Social Sciences (SBE)', tr: 'Sosyal Bilimler Enstitüsü' }, category: 'graduate-school', type: 'drupal', urls: { tr: 'https://sbe.metu.edu.tr/tr/announcements', en: 'https://sbe.metu.edu.tr/en/announcements' } },
  { id: 'ii', name: { en: 'Graduate School of Informatics (II)', tr: 'Enformatik Enstitüsü' }, category: 'graduate-school', type: 'drupal', urls: { tr: 'https://ii.metu.edu.tr/tr/all-announcements' } },
  { id: 'ico', name: { en: 'International Cooperations Office (Erasmus)', tr: 'Uluslararası İşbirliği Ofisi (Erasmus)' }, category: 'international', type: 'rss', urls: { tr: 'https://ico.metu.edu.tr/rss.xml' } },
  { id: 'bidb', name: { en: 'Computer Center (BİDB)', tr: 'Bilgi İşlem Daire Başkanlığı (BİDB)' }, category: 'it', type: 'drupal', urls: { tr: 'https://bidb.metu.edu.tr/tr/announcements', en: 'https://bidb.metu.edu.tr/en/announcements' } },
  { id: 'ihm', name: { en: 'Internal Services (vehicle permits, traffic)', tr: 'İç Hizmetler Müdürlüğü (taşıt pulu, trafik)' }, category: 'campus', type: 'drupal', urls: { tr: 'https://ihm.metu.edu.tr/tr/announcements', en: 'https://ihm.metu.edu.tr/en/announcements' } },
  { id: 'yurtlar', name: { en: 'Dormitories Directorate', tr: 'Yurtlar Müdürlüğü' }, category: 'campus', type: 'drupal', urls: { tr: 'https://yurtlar.metu.edu.tr/tr/announcements', en: 'https://yurtlar.metu.edu.tr/en/announcements' } },
  { id: 'library', name: { en: 'Library', tr: 'Kütüphane' }, category: 'library', type: 'drupal', urls: { tr: 'https://lib.metu.edu.tr/tr/announcements', en: 'https://lib.metu.edu.tr/en/announcements' } },
  { id: 'sports', name: { en: 'Directorate of Physical Education and Sports', tr: 'Beden Eğitimi ve Spor Müdürlüğü' }, category: 'sports', type: 'drupal', urls: { tr: 'https://spormd.metu.edu.tr/tr/announcements', en: 'https://spormd.metu.edu.tr/en/announcements' } },
  { id: 'pools', name: { en: 'Swimming Pools Directorate', tr: 'Havuz Müdürlüğü' }, category: 'sports', type: 'drupal', urls: { tr: 'https://hm.metu.edu.tr/tr/announcements' } },
  { id: 'health', name: { en: 'Health and Counseling Center (SRM / Medico)', tr: 'Sağlık ve Rehberlik Merkezi (SRM / Medico)' }, category: 'health', type: 'drupal', urls: { tr: 'https://srm.metu.edu.tr/tr/announcements', en: 'https://srm.metu.edu.tr/en/announcements' } },
  { id: 'cafeteria', name: { en: 'Cafeteria Directorate', tr: 'Kafeterya Müdürlüğü' }, category: 'dining', type: 'drupal', urls: { tr: 'https://kafeterya.metu.edu.tr/tr/tum-duyurular' } },
  { id: 'career', name: { en: 'Career Planning Center (jobs, internships, events)', tr: 'Kariyer Planlama Merkezi (iş, staj, etkinlik ilanları)' }, category: 'career', type: 'rss', urls: { tr: 'https://kpm.metu.edu.tr/feed/' } },
  { id: 'bulletin', name: { en: 'Bu Hafta (METU fortnightly bulletin)', tr: 'Bu Hafta (ODTÜ bülteni)' }, category: 'university', type: 'wp-bulletin', urls: { tr: 'https://buhafta.metu.edu.tr/wp-json/wp/v2/pages?per_page=4&orderby=date&order=desc&_fields=id,date_gmt,modified_gmt,link,title,content' }, site_url: 'https://buhafta.metu.edu.tr/' },
  { id: 'alumni', name: { en: 'Alumni Office', tr: 'Mezunlar Ofisi' }, category: 'university', type: 'rss', urls: { tr: 'https://mezun.metu.edu.tr/feed/' } },
];

export type PageTopic =
  | 'parking'
  | 'vehicle-permit'
  | 'dining'
  | 'transport'
  | 'registrar'
  | 'sports'
  | 'health'
  | 'library'
  | 'clubs'
  | 'safety'
  | 'accessibility'
  | 'regulations'
  | 'language'
  | 'dormitory'
  | 'scholarships'
  | 'international';

export interface PageSource {
  id: string;
  title: Localized;
  url: string;
  /**
   * English version, when it is not discoverable via the page's hreflang="en" link. Some Drupal 7 sites
   * (e.g. tim.metu.edu.tr) publish English pages as separate nodes under the /tr/ prefix.
   */
  url_en?: string;
  topic: PageTopic;
  /**
   * Case-insensitive regex for file links to list with the page text (e.g. a fee table published only as an image,
   * a timetable PDF). The link changes when METU uploads a new version, which shows up as a page change.
   */
  file_links?: string;
  /** Characters of page text kept (default 30 000); regulations are longer. */
  max_chars?: number;
  /**
   * Case-insensitive regex for a spreadsheet link (.xls/.xlsx) on the page whose table is downloaded and appended to the
   * page text (e.g. dormitory fees, published only as Excel). A new upload shows up as a page change.
   */
  spreadsheet?: string;
}

/** Info pages whose text is stored and whose changes are tracked. */
export const PAGE_SOURCES: PageSource[] = [
  { id: 'ihm-parking-by-permit', title: { en: 'Parking areas by vehicle permit type', tr: 'Taşıt pulu türüne göre park yerleri' }, url: 'https://ihm.metu.edu.tr/tr/tasit-pulu-turune-gore-park-yerleri', topic: 'parking' },
  { id: 'ihm-parking-rules', title: { en: 'Parking lot rules', tr: 'Otopark kuralları' }, url: 'https://ihm.metu.edu.tr/tr/otopark-kurallari', topic: 'parking' },
  { id: 'ihm-traffic-rules', title: { en: 'Campus traffic rules and procedures', tr: 'Yerleşke trafik kuralları uygulama usul ve esasları' }, url: 'https://ihm.metu.edu.tr/tr/yerleske-trafik-kurallari-uygulama-usul-ve-esaslari', topic: 'parking' },
  { id: 'ihm-student-permit', title: { en: 'Student vehicle permit', tr: 'Öğrenci taşıt pulu' }, url: 'https://ihm.metu.edu.tr/tr/ogrenci', topic: 'vehicle-permit' },
  { id: 'ihm-permit-office', title: { en: 'Vehicle permit office', tr: 'Taşıt Pulu Şefliği' }, url: 'https://ihm.metu.edu.tr/tr/tasit-pulu-sefligi', topic: 'vehicle-permit' },
  { id: 'cafeteria-hours', title: { en: 'Cafeteria meal hours', tr: 'Yemek saatleri' }, url: 'https://kafeterya.metu.edu.tr/yemek-saatleri', topic: 'dining' },
  { id: 'cafeteria-prices', title: { en: 'Cafeteria set-menu prices', tr: 'Tabldot yemek fiyatları' }, url: 'https://kafeterya.metu.edu.tr/tabldot-yemek-fiyatlari', topic: 'dining' },
  { id: 'ring-yellow-red', title: { en: 'Yellow-Red ring bus', tr: 'Sarı - Kırmızı ring' }, url: 'https://tim.metu.edu.tr/tr/sari-kirmizi-ring', url_en: 'https://tim.metu.edu.tr/tr/yellow-red-ring-bus', topic: 'transport' },
  { id: 'ring-light-brown', title: { en: 'Light Brown ring bus', tr: 'Açık Kahverengi ring' }, url: 'https://tim.metu.edu.tr/tr/acik-kahverengi-ring', url_en: 'https://tim.metu.edu.tr/tr/light-brown-a1-ring-bus', topic: 'transport' },
  { id: 'ring-gray-day', title: { en: 'Gray ring bus (day)', tr: 'Gri ring (gündüz)' }, url: 'https://tim.metu.edu.tr/tr/gri-ring-gunduz', url_en: 'https://tim.metu.edu.tr/tr/gray-ring-bus-day', topic: 'transport' },
  { id: 'ring-gray-night', title: { en: 'Gray ring bus (night)', tr: 'Gri ring (akşam)' }, url: 'https://tim.metu.edu.tr/tr/gri-ring-aksam', url_en: 'https://tim.metu.edu.tr/tr/gray-ring-bus-night', topic: 'transport' },
  { id: 'ring-purple', title: { en: 'Purple ring bus', tr: 'Mor ring' }, url: 'https://tim.metu.edu.tr/tr/mor-ring', url_en: 'https://tim.metu.edu.tr/tr/purple-ring-bus', topic: 'transport' },
  { id: 'ring-navy', title: { en: 'Navy ring bus', tr: 'Lacivert ring' }, url: 'https://tim.metu.edu.tr/tr/lacivert-ring', url_en: 'https://tim.metu.edu.tr/tr/navy-ring-bus', topic: 'transport' },
  { id: 'ring-orange', title: { en: 'Orange ring bus', tr: 'Turuncu ring' }, url: 'https://tim.metu.edu.tr/tr/turuncu-ring', url_en: 'https://tim.metu.edu.tr/tr/orange-ring-bus', topic: 'transport' },
  { id: 'ring-turquoise', title: { en: 'Turquoise ring bus', tr: 'Turkuaz ring' }, url: 'https://tim.metu.edu.tr/tr/turkuaz-ring', url_en: 'https://tim.metu.edu.tr/tr/turqoise-ring-bus', topic: 'transport' },
  { id: 'transport-ego', title: { en: 'EGO city bus lines to METU', tr: 'ODTÜ EGO hat bilgisi' }, url: 'https://tim.metu.edu.tr/tr/ego-hat-bilgisi', topic: 'transport' },
  { id: 'transport-dolmus', title: { en: 'Dolmuş (shared minibus) route', tr: 'ODTÜ dolmuş güzergahı' }, url: 'https://tim.metu.edu.tr/tr/dolmus-guzergahi', topic: 'transport' },
  { id: 'oidb-who-registers-how', title: { en: 'Registration: who registers how', tr: 'Kim nasıl kayıt yapmalı' }, url: 'https://oidb.metu.edu.tr/tr/kim-nasil-kayit-yapmali', topic: 'registrar' },
  { id: 'oidb-tuition-payments', title: { en: 'Tuition / contribution fee payments', tr: 'Katkı payı ödemeleri' }, url: 'https://oidb.metu.edu.tr/tr/katki-payi-odemeleri', topic: 'registrar' },
  { id: 'oidb-tuition-amounts', title: { en: 'Tuition / contribution fee amounts', tr: 'Katkı payı miktarları' }, url: 'https://oidb.metu.edu.tr/tr/katki-payi-miktarlari', topic: 'registrar' },
  { id: 'oidb-student-certificate', title: { en: 'Student certificate', tr: 'Öğrenci belgesi' }, url: 'https://oidb.metu.edu.tr/tr/ogrenci-belgesi', topic: 'registrar' },
  { id: 'oidb-course-withdrawal', title: { en: 'Course withdrawal', tr: 'Dersten çekilme' }, url: 'https://oidb.metu.edu.tr/tr/dersten-cekilme', topic: 'registrar' },
  { id: 'sports-facilities', title: { en: 'Sports facilities and opening hours', tr: 'Spor tesisleri ve çalışma saatleri' }, url: 'https://spormd.metu.edu.tr/tr/tesislerimiz', topic: 'sports' },
  { id: 'sports-teams', title: { en: 'University sports teams', tr: 'Spor takımlarımız' }, url: 'https://spormd.metu.edu.tr/tr/spor-takimlarimiz', topic: 'sports' },
  { id: 'pools-student', title: { en: 'Swimming pools: student use and fees', tr: 'Havuzlar: öğrenci kullanımı ve ücretler' }, url: 'https://hm.metu.edu.tr/tr/ogrenci', topic: 'sports' },
  { id: 'sports-files', title: { en: 'Sports fee table and facility rules (files)', tr: 'Spor tesisi ücret tablosu ve kurallar (dosyalar)' }, url: 'https://spormd.metu.edu.tr/tr/hizli-baglantilar', topic: 'sports', file_links: 'ucret|kural|talimat' },
  { id: 'pools-schedule', title: { en: 'Swimming pool session timetable (file)', tr: 'Havuz seans programı (dosya)' }, url: 'https://hm.metu.edu.tr/tr/program', topic: 'sports', file_links: '\\.pdf$' },
  { id: 'health-units', title: { en: 'Health center units and working hours', tr: 'Sağlık merkezi birimleri ve çalışma saatleri' }, url: 'https://srm.metu.edu.tr/tr/birimler', topic: 'health' },
  { id: 'health-counseling', title: { en: 'Psychological counselling and guidance (PDRM)', tr: 'Psikolojik danışma ve rehberlik (PDRM)' }, url: 'https://srm.metu.edu.tr/tr/pdrm', topic: 'health' },
  { id: 'health-contact', title: { en: 'Health center phone numbers', tr: 'Sağlık merkezi telefonları' }, url: 'https://srm.metu.edu.tr/tr/personel-iletisim', topic: 'health' },
  { id: 'library-hours', title: { en: 'Library opening hours', tr: 'Kütüphane çalışma saatleri' }, url: 'https://lib.metu.edu.tr/tr', topic: 'library' },
  { id: 'library-borrowing', title: { en: 'Library borrowing rules', tr: 'Kütüphane ödünç verme kuralları' }, url: 'https://lib.metu.edu.tr/tr/odunc-verme-hizmetleri', topic: 'library' },
  { id: 'library-remote-access', title: { en: 'Library e-resources from off campus', tr: 'Kütüphane e-kaynaklarına yerleşke dışından erişim' }, url: 'https://lib.metu.edu.tr/tr/yerleske-disindan-erisim', topic: 'library' },
  { id: 'clubs-list', title: { en: 'Student clubs and societies', tr: 'Öğrenci toplulukları' }, url: 'https://kim.metu.edu.tr/tr/ogrenci-topluluklari', topic: 'clubs' },
  { id: 'club-events', title: { en: 'Upcoming student club events', tr: 'Öğrenci topluluğu etkinlikleri' }, url: 'https://kim.metu.edu.tr/tr/etkinlikler', topic: 'clubs' },
  { id: 'ihm-contact', title: { en: 'Campus security and internal services contacts (24 h duty desk)', tr: 'Kampüs güvenliği ve iç hizmetler iletişim (24 saat nöbetçi amirlik)' }, url: 'https://ihm.metu.edu.tr/tr/iletisim', topic: 'safety' },
  { id: 'accessibility-contact', title: { en: 'Disability Support Office', tr: 'Engelsiz ODTÜ Birimi' }, url: 'https://engelsiz.metu.edu.tr/tr/node/82', url_en: 'https://engelsiz.metu.edu.tr/en/contact-us', topic: 'accessibility' },
  { id: 'regulation-undergraduate', title: { en: 'Undergraduate education regulation', tr: 'Lisans Eğitim-Öğretim Yönetmeliği' }, url: 'https://oidb.metu.edu.tr/tr/orta-dogu-teknik-universitesi-lisans-egitim-ogretim-yonetmeligi', topic: 'regulations', max_chars: 100_000 },
  { id: 'regulation-graduate', title: { en: 'Graduate education regulation', tr: 'Lisansüstü Eğitim-Öğretim Yönetmeliği' }, url: 'https://oidb.metu.edu.tr/tr/orta-dogu-teknik-universitesi-lisansustu-egitim-ogretim-yonetmeligi', topic: 'regulations', max_chars: 100_000 },
  { id: 'regulation-resit-summer', title: { en: 'Resit exams and summer school rules', tr: 'Bütünleme sınavları ve yaz öğretimi uygulama esasları' }, url: 'https://oidb.metu.edu.tr/tr/odtu-butunleme-sinavlari-ve-yaz-ogretimi-uygulama-esaslari', topic: 'regulations', max_chars: 60_000 },
  { id: 'regulation-max-duration', title: { en: 'Students exceeding the maximum study period', tr: 'Azami süre sonunda mezun olamayan lisans öğrencileri esasları' }, url: 'https://oidb.metu.edu.tr/tr/azami-sureler-sonunda-mezuniyet-kosullarini-saglayamayan-lisans-ogrencileri-hakkinda-uygulama', topic: 'regulations', max_chars: 60_000 },
  { id: 'oidb-faq', title: { en: 'Registrar FAQ (registration, prep school, add-drop, leave, graduation)', tr: 'ÖİDB sıkça sorulan sorular (kayıt, hazırlık, ekle-sil, kayıt dondurma, mezuniyet)' }, url: 'https://oidb.metu.edu.tr/tr/sikca-sorulan-sorular-sss', topic: 'registrar', max_chars: 60_000 },
  { id: 'oidb-forms', title: { en: 'Registrar forms (double major/minor, leave, transfer, pass, …)', tr: 'ÖİDB formları (çift anadal/yandal, kayıt dondurma, geçiş, pasaport …)' }, url: 'https://oidb.metu.edu.tr/tr/formlar', topic: 'registrar', file_links: '\\.(pdf|docx?)$' },
  // Scholarships (Registrar) and the International Students Office (ISO, crawl-delay 10).
  { id: 'scholarships-applications', title: { en: 'Scholarship and aid applications', tr: 'Burs ve yardım başvuruları' }, url: 'https://oidb.metu.edu.tr/tr/burs-ve-yardim-basvurulari', topic: 'scholarships' },
  { id: 'scholarships-documents', title: { en: 'Documents required for scholarship applications', tr: 'Burs başvurusu için gerekli belgeler' }, url: 'https://oidb.metu.edu.tr/tr/burs-basvurusu-icin-gerekli-belgeler', topic: 'scholarships' },
  { id: 'scholarships-turkish-citizens', title: { en: 'Scholarships for Turkish citizens', tr: 'TC uyruklu öğrenciler için burs olanakları' }, url: 'https://oidb.metu.edu.tr/tr/tc-uyruklu-ogrenciler-icin-burs-olanaklari', topic: 'scholarships' },
  { id: 'scholarships-yok-undergraduate', title: { en: 'YÖK undergraduate support scholarship', tr: 'YÖK lisans destek bursu' }, url: 'https://oidb.metu.edu.tr/tr/yok-lisans-destek-bursu', topic: 'scholarships' },
  { id: 'scholarships-100-2000-phd', title: { en: 'YÖK 100/2000 PhD scholarship', tr: '100/2000 doktora bursu' }, url: 'https://oidb.metu.edu.tr/tr/1002000-doktora-bursu', topic: 'scholarships' },
  { id: 'scholarships-yudap', title: { en: 'Research abroad scholarship (YUDAP)', tr: 'Yurt dışı araştırma bursu (YUDAP)' }, url: 'https://oidb.metu.edu.tr/tr/yurt-disi-arastirma-bursu-yudap', topic: 'scholarships' },
  { id: 'iso-scholarships', title: { en: 'Scholarships for international students', tr: 'Uluslararası öğrenciler için burs olanakları' }, url: 'https://iso.metu.edu.tr/tr/burs-olanaklari', url_en: 'https://iso.metu.edu.tr/en/scholarship-opportunities', topic: 'scholarships' },
  ...(
    [
      ['oturum-izni', 'residence-permit', 'residence-permit', 'Residence permit', 'Oturum izni'],
      ['yabanci-kimlik-numarasi', 'foreign-id-number', 'foreign-national-identity-number', 'Foreign national identity number', 'Yabancı kimlik numarası'],
      ['saglik-hizmetleri-ve-sigorta', 'health-insurance', 'health-care-services-and-insurance', 'Health care services and insurance', 'Sağlık hizmetleri ve sigorta'],
      ['ogrenim-ucreti', 'tuition-fee', 'tuition-fee', 'Tuition fee for international students', 'Uluslararası öğrenci öğrenim ücreti'],
      ['yasam-giderleri', 'cost-of-living', 'cost-living', 'Cost of living in Ankara', 'Ankara\'da yaşam giderleri'],
      ['basvuru-tarihleri', 'application-dates', 'application-dates', 'Application dates', 'Başvuru tarihleri'],
      ['nasil-basvuru-yapilir', 'how-to-apply', 'how-apply', 'How to apply', 'Nasıl başvuru yapılır'],
      ['basvuru-belgeleri', 'required-documents', 'required-documents', 'Required documents', 'Gerekli belgeler'],
      ['ingilizce-yeterlik', 'english-proficiency', 'english-proficiency', 'English proficiency', 'İngilizce yeterlik'],
    ] as const
  ).map(([slug, id, enSlug, en, tr]): PageSource => ({
    id: `iso-${id}`,
    title: { en, tr },
    url: `https://iso.metu.edu.tr/tr/${slug}`,
    // The site links its translations only from the menu, not with hreflang.
    url_en: `https://iso.metu.edu.tr/en/${enSlug}`,
    topic: 'international',
  })),
  // Dormitories: fees are published only as an Excel file linked from the rooms page (no English pages).
  { id: 'dorm-fees', title: { en: 'Dormitory rooms and monthly fees', tr: 'Yurt oda olanakları ve aylık ücretleri' }, url: 'https://yurtlar.metu.edu.tr/tr/oda-olanaklari-ve-fiyatlari', topic: 'dormitory', spreadsheet: 'yurt_ucret|dormitory_fees' },
  { id: 'dorm-features', title: { en: 'Dormitories: general features', tr: 'Yurtlar: genel özellikler' }, url: 'https://yurtlar.metu.edu.tr/tr/genel-ozellikler', topic: 'dormitory' },
  { id: 'dorm-placement-points', title: { en: 'Dormitory placement point table', tr: 'Yurt yerleştirme puan cetveli' }, url: 'https://yurtlar.metu.edu.tr/tr/2026-2027-egitim-ogretim-yili-yurt-yerlestirme-puan-cetveli', topic: 'dormitory' },
  { id: 'dorm-regulation', title: { en: 'Dormitories regulation', tr: 'Yurtlar yönetmeliği' }, url: 'https://yurtlar.metu.edu.tr/tr/yurtlar-yonetmeligi', topic: 'dormitory', max_chars: 60_000 },
  { id: 'dorm-contact', title: { en: 'Dormitories Directorate contacts', tr: 'Yurtlar Müdürlüğü iletişim' }, url: 'https://yurtlar.metu.edu.tr/tr/iletisim', topic: 'dormitory' },
  // School of Foreign Languages (YDYO) paid language courses: Turkish only, ISO-8859-9. The two list pages carry hours and
  // fees; each course page carries its term schedule (placement exam, start/end, registration window, class days).
  { id: 'dil-courses-in-person', title: { en: 'Language courses on campus: list, hours and fees', tr: 'Yüz yüze dil kursları: liste, saat ve ücretler' }, url: 'https://dil.metu.edu.tr/kurslar/yuz-yuze/', topic: 'language' },
  { id: 'dil-courses-online', title: { en: 'Online language courses: list, hours and fees', tr: 'Çevrim içi dil kursları: liste, saat ve ücretler' }, url: 'https://dil.metu.edu.tr/kurslar/cevrim-ici/', topic: 'language' },
  { id: 'dil-placement-exam', title: { en: 'Language course placement exam', tr: 'Dil kursu seviye tespit sınavı' }, url: 'https://dil.metu.edu.tr/seviye-tespit/sinav/', topic: 'language' },
  { id: 'dil-toefl-ibt-centre', title: { en: 'TOEFL iBT test centre at METU', tr: 'ODTÜ TOEFL iBT sınav merkezi' }, url: 'https://dil.metu.edu.tr/hakkimizda/toefl-ibt-merkezi/', topic: 'language' },
  { id: 'dil-faq', title: { en: 'Language courses FAQ (campus access, ID card, vehicle permit)', tr: 'Dil kursları SSS (kampüs girişi, kimlik, taşıt pulu)' }, url: 'https://dil.metu.edu.tr/sss/', topic: 'language' },
  ...(
    [
      ['yuz-yuze', 'toefl', 'TOEFL', 'TOEFL'],
      ['yuz-yuze', 'ielts', 'IELTS', 'IELTS'],
      ['yuz-yuze', 'pre-toefl', 'Pre-TOEFL', 'Pre-TOEFL'],
      ['yuz-yuze', 'pre-ielts', 'Pre-IELTS', 'Pre-IELTS'],
      ['yuz-yuze', 'genel-ingilizce-aksam', 'General English (evening)', 'Genel İngilizce (akşam)'],
      ['yuz-yuze', 'genel-ingilizce-hafta-sonu', 'General English (weekend)', 'Genel İngilizce (hafta sonu)'],
      ['yuz-yuze', 'sertifika-programi', 'Intensive Academic English (certificate)', 'Yoğun Akademik İngilizce (sertifika)'],
      ['yuz-yuze', 'sertifika-programi-yogun-genel-ingilizce', 'Intensive General English', 'Yoğun Genel İngilizce'],
      ['cevrim-ici', 'toefl', 'TOEFL', 'TOEFL'],
      ['cevrim-ici', 'yogun-toefl', 'Intensive TOEFL', 'Yoğun TOEFL'],
      ['cevrim-ici', 'ielts', 'IELTS', 'IELTS'],
      ['cevrim-ici', 'yogun-ielts', 'Intensive IELTS', 'Yoğun IELTS'],
      ['cevrim-ici', 'pre-toefl', 'Pre-TOEFL', 'Pre-TOEFL'],
      ['cevrim-ici', 'pre-ielts', 'Pre-IELTS', 'Pre-IELTS'],
      ['cevrim-ici', 'genel-ingilizce-aksam', 'General English (evening)', 'Genel İngilizce (akşam)'],
      ['cevrim-ici', 'genel-ingilizce-hafta-sonu', 'General English (weekend)', 'Genel İngilizce (hafta sonu)'],
      ['cevrim-ici', 'sertifika-programi', 'Intensive Academic English (certificate)', 'Yoğun Akademik İngilizce (sertifika)'],
      ['cevrim-ici', 'sertifika-programi-yogun-genel-ingilizce', 'Intensive General English', 'Yoğun Genel İngilizce'],
      ['cevrim-ici', 'kisa-donem-yds', 'Short YDS preparation', 'Kısa dönem YDS'],
      ['cevrim-ici', 'iys-hazirlik-atlama', 'METU English Proficiency Exam (prep exemption) preparation', 'İYS hazırlık atlama'],
      ['cevrim-ici', 'akademik-konusma-sunum-becerileri', 'Academic speaking and presentation skills', 'Akademik konuşma ve sunum becerileri'],
      ['cevrim-ici', 'konusma-kulubu', 'Speaking club', 'Konuşma kulübü'],
    ] as const
  ).map(([format, slug, en, tr]): PageSource => ({
    id: `dil-${format === 'yuz-yuze' ? 'campus' : 'online'}-${slug}`,
    title: format === 'yuz-yuze' ? { en: `${en} course on campus: schedule`, tr: `Yüz yüze ${tr} kursu: takvim` } : { en: `Online ${en} course: schedule`, tr: `Çevrim içi ${tr} kursu: takvim` },
    url: `https://dil.metu.edu.tr/kurslar/${format}/${slug}/`,
    topic: 'language',
    // "Kurs detayları" PDF with the syllabus and procedures.
    file_links: '/kursdetaylari/',
  })),
];

export const CALENDAR_INDEX_URLS: Record<Lang, string> = {
  tr: 'https://oidb.metu.edu.tr/tr/akademik-takvim',
  en: 'https://oidb.metu.edu.tr/en/academic-calendar',
};
export const DINING_BASE_URL = 'https://kafeterya.metu.edu.tr/';
export const DINING_DAYS_AHEAD = 7;
export const MAP_MARKER_URL = 'https://map.metu.edu.tr/getmarker.php';
/** Which building each classroom code is in (links to map.metu.edu.tr places). */
export const CLASSROOMS_URL = 'https://www.metu.edu.tr/location-classrooms-metu-campus';
export const RING_LIVE_URL = 'https://ring.metu.edu.tr/ring.json';
export const RING_LIVE_CACHE_MS = 30_000;
/** Student club events (Culture Office, KİM) and the 70th-anniversary university events calendar. */
export const KIM_EVENTS_URL = 'https://kim.metu.edu.tr/tr/etkinlikler';
export const EVENTS_70YIL_LIST_URL = 'https://70yil.metu.edu.tr/tr/events/all-events';
export const EVENTS_70YIL_MAX_PAGES = 6;
/**
 * Culture and Convention Center (KKM) venue calendar (crawl-delay 10 s). Its webcal export is broken, so the year view
 * (`…/year/YYYY`, one row per event with an ISO start, title link and hall) is parsed for this year and the next.
 */
export const KKM_EVENTS_URL = 'https://kkm.metu.edu.tr/etkinlikler';
export const KKM_YEAR_URL = 'https://kkm.metu.edu.tr/calendar-node-field-etkinlik-tarihi/year/';
/** Event detail pages per run (the host asks for a 10 s crawl delay): every unseen event up to a cap, plus re-checks. */
export const EVENTS_70YIL_MAX_NEW = 80;
export const EVENTS_70YIL_RECHECKS = 10;
/** BİDB IT help FAQ (crawl-delay 10 s): answer pages fetched per night, so ~445 answers refresh every few days. */
export const FAQ_BASE_URL = 'https://faq.cc.metu.edu.tr/';
export const FAQ_DETAILS_PER_RUN = 120;
/** Health center (SRM / Medico) doctors and today's duty status. */
export const DOCTORS_URL = 'https://srm.metu.edu.tr/tr/doktorlarimiz';

/** Course catalog (catalog.metu.edu.tr, English only; no robots.txt). */
export const CATALOG_BASE_URL = 'https://catalog.metu.edu.tr/';
/** `fac_inst.php?fac_inst=<id>` pages of the Ankara campus (the [NCC] ids 995–998 belong to Northern Cyprus). */
export const CATALOG_FACULTY_IDS = [650, 100, 200, 300, 400, 500, 975, 900, 955, 850, 849, 600];
/** Course detail pages fetched per run, oldest first — the full catalog is refreshed over a few weeks. */
export const CATALOG_DETAILS_PER_RUN = 1000;
/** Courses whose syllabus (objectives + outcomes, two requests each) is fetched per night. */
export const SYLLABUS_PER_RUN = 300;

/**
 * METULearn (learn.metu.edu.tr, no robots.txt): catalog of continuing-education trainings (ODTÜ-SEM, Bilgeİş, METU OCW,
 * METU Learn). The list is server-rendered HTML, 24 per page (`?sayfa=N`; out-of-range pages repeat the last page).
 * Each card's detail is an HTML fragment at `/api/course/<id>/` (start date, registration window, enrolment link).
 */
export const TRAININGS_LIST_URL = 'https://learn.metu.edu.tr/egitimler/';
export const TRAININGS_DETAIL_URL = 'https://learn.metu.edu.tr/api/course/';
export const TRAININGS_MAX_PAGES = 40;
/** Detail fragments per daily run, least recently fetched first (~576 trainings → full refresh in about ten days). */
export const TRAININGS_DETAILS_PER_RUN = 60;

/**
 * OpenMETU (DSpace, open.metu.edu.tr) theses over OAI-PMH. robots.txt disallows the /discover search UI, so records are
 * harvested through the OAI endpoint (built for harvesting) and searched locally. Sets are the graduate-school
 * communities; only items typed as theses are kept.
 */
export const OPENMETU_OAI_URL = 'https://open.metu.edu.tr/oai/request';
export const OPENMETU_HANDLE_URL = 'https://open.metu.edu.tr/handle/11511/';
export const THESIS_SETS: { set: string; name: Localized }[] = [
  { set: 'com_11511_16', name: { en: 'Graduate School of Natural and Applied Sciences', tr: 'Fen Bilimleri Enstitüsü' } },
  { set: 'com_11511_17', name: { en: 'Graduate School of Social Sciences', tr: 'Sosyal Bilimler Enstitüsü' } },
  { set: 'com_11511_14', name: { en: 'Graduate School of Informatics', tr: 'Enformatik Enstitüsü' } },
  { set: 'com_11511_13', name: { en: 'Graduate School of Applied Mathematics', tr: 'Uygulamalı Matematik Enstitüsü' } },
  { set: 'com_11511_15', name: { en: 'Graduate School of Marine Sciences', tr: 'Deniz Bilimleri Enstitüsü' } },
];
/** OAI list pages (100 records each) per run: the first full harvest (~45 000 records) spreads over a few nights. */
export const OAI_PAGES_PER_RUN = 150;

/**
 * OpenStreetMap enrichment of the campus map: named buildings and amenities with their outlines and Turkish / short
 * names (map.metu.edu.tr names are English only). Data © OpenStreetMap contributors, ODbL — answers that use it say so.
 */
export const OSM_OVERPASS_URL = 'https://overpass.kumi.systems/api/interpreter';
/** Ankara campus (south, west, north, east), from the extent of the map.metu.edu.tr places plus a margin. */
export const OSM_CAMPUS_BBOX = [39.881, 32.762, 39.911, 32.798] as const;
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors (ODbL)';

/** map.metu.edu.tr category ids (getmarker.php `type=`). */
export const MAP_CATEGORIES: Record<number, Localized> = {
  3: { en: 'Academic building', tr: 'Akademik bina' },
  5: { en: 'ATM', tr: 'ATM' },
  6: { en: 'Sports facility', tr: 'Spor tesisi' },
  7: { en: 'Parking lot', tr: 'Otopark' },
  8: { en: 'Food & drink', tr: 'Yeme-içme' },
  9: { en: 'Building / dormitory', tr: 'Bina / yurt' },
  10: { en: 'Conference hall', tr: 'Konferans salonu' },
  11: { en: 'Health unit', tr: 'Sağlık birimi' },
  12: { en: 'Campus gate', tr: 'Kampüs kapısı' },
  13: { en: 'Bank', tr: 'Banka' },
  14: { en: 'Post office', tr: 'Postane' },
  16: { en: 'Library', tr: 'Kütüphane' },
  17: { en: 'Shopping', tr: 'Alışveriş' },
  23: { en: 'Transport point', tr: 'Ulaşım noktası' },
  25: { en: 'Computer lab', tr: 'Bilgisayar laboratuvarı' },
  29: { en: 'Classroom', tr: 'Derslik' },
  32: { en: 'Administrative building', tr: 'İdari bina' },
  35: { en: 'Student society', tr: 'Öğrenci topluluğu' },
};

/** Collector schedules (croner expressions, Europe/Istanbul). */
export const SCHEDULES: Record<string, string> = {
  announcements: '*/20 * * * *',
  'announcements-hourly': '40 * * * *',
  calendar: '15 6 * * *',
  dining: '30 5,11 * * *',
  pages: '0 7 * * *',
  places: '0 4 * * 1',
  links: '0 3 * * 0',
  catalog: '0 2 * * 3',
  'catalog-details': '30 0 * * *',
  doctors: '5 8-16 * * 1-5',
  events: '45 6 * * *',
  faq: '15 3 * * 2',
  'faq-answers': '30 1 * * *',
  curriculum: '30 2 * * 3',
  classrooms: '20 4 * * 1',
  maintenance: '50 4 * * *',
  syllabus: '30 3 * * *',
  trainings: '0 5 * * 6',
  'trainings-details': '50 4 * * *',
  theses: '10 1 * * *',
  osm: '30 4 * * 1',
};
