import { foldTr } from './text.js';

/** Turkish (and English) month names → month number, in folded (foldTr) form. */
const MONTHS: Record<string, number> = {
  ocak: 1, subat: 2, mart: 3, nisan: 4, mayis: 5, haziran: 6,
  temmuz: 7, agustos: 8, eylul: 9, ekim: 10, kasim: 11, aralik: 12,
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

const EN_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const EN_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const TR_MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
const TR_WEEKDAYS = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];

type DisplayLang = 'tr' | 'en';

export interface ParsedDateRange {
  /** YYYY-MM-DD */
  start: string;
  /** YYYY-MM-DD (equal to start for a single day) */
  end: string;
  /** `month`: the source gives no day yet ("+++ EYLÜL", "* - * EKİM"), only the month is known. */
  precision: 'day' | 'month';
}

interface Part {
  days: number[];
  month?: number;
  year?: number;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const isoDate = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const lastDayOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * Parses date cells of the METU academic calendar. Supported shapes:
 * "28 TEMMUZ 2026", "18 - 31 AĞUSTOS 2026", "24 AĞUSTOS - 25 EYLÜL 2026",
 * "30 KASIM - 06 ARALIK 2026", "09-10-11 EYLÜL 2026", "24 ve 25 EYLÜL 2026",
 * "+++ EYLÜL 2026" / "* - * EKİM 2026" / "% TEMMUZ 2027" (day not yet announced),
 * "28 Aralık 2026 - 3 Ocak 2027".
 */
export function parseTrDateRange(raw: string, fallbackYear?: number): ParsedDateRange | undefined {
  const text = foldTr(raw)
    .replace(/[–—]/g, '-')
    .replace(/\s+ve\s+/g, ' - ')
    .replace(/,/g, ' - ');
  const segments = text.split('-').map((s) => s.trim()).filter((s) => s.length > 0);
  const parts: Part[] = [];
  for (const seg of segments) {
    const part: Part = { days: [] };
    for (const tok of seg.split(/[\s./]+/)) {
      if (/^\d{4}$/.test(tok)) part.year = Number(tok);
      else if (/^\d{1,2}$/.test(tok)) part.days.push(Number(tok));
      else if (MONTHS[tok] !== undefined) part.month = MONTHS[tok];
    }
    if (part.days.length || part.month || part.year) parts.push(part);
  }
  if (parts.length === 0) return undefined;

  // Inherit month/year from right to left.
  let month: number | undefined;
  let year: number | undefined = fallbackYear;
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]!;
    if (p.year) year = p.year;
    else if (year !== undefined) {
      // "30 ARALIK - 03 OCAK 2027": a start month after the end month belongs to the previous year.
      if (p.month && month && p.month > month && !parts.slice(0, i).some((q) => q.year)) {
        p.year = year - 1;
        year = p.year;
      } else p.year = year;
    }
    if (p.month) month = p.month;
    else p.month = month;
  }

  const withDays = parts.filter((p) => p.days.length > 0 && p.month && p.year);
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  if (withDays.length === 0) {
    if (!last.month || !last.year) return undefined;
    return {
      start: isoDate(last.year, last.month, 1),
      end: isoDate(last.year, last.month, lastDayOfMonth(last.year, last.month)),
      precision: 'month',
    };
  }
  const s = withDays[0]!;
  const e = withDays[withDays.length - 1]!;
  if (first.days.length === 0 && first !== last) {
    // Half-open range like "* - 12 EKİM": fall back to month precision to stay conservative.
    return {
      start: isoDate(e.year!, e.month!, 1),
      end: isoDate(e.year!, e.month!, lastDayOfMonth(e.year!, e.month!)),
      precision: 'month',
    };
  }
  const start = isoDate(s.year!, s.month!, s.days[0]!);
  const end = isoDate(e.year!, e.month!, e.days[e.days.length - 1]!);
  if (!isValidIso(start) || !isValidIso(end)) return undefined;
  return { start, end: end < start ? start : end, precision: 'day' };
}

export function isValidIso(d: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return false;
  const [y, mo, da] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return mo >= 1 && mo <= 12 && da >= 1 && da <= lastDayOfMonth(y, mo);
}

/** "2026-10-05" → "Mon 5 October 2026" (en) / "5 Ekim 2026 Pazartesi" (tr) */
export function formatDate(iso: string, lang: DisplayLang = 'en', withWeekday = true): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (lang === 'tr') return `${d} ${TR_MONTHS[m - 1]} ${y}${withWeekday ? ` ${TR_WEEKDAYS[wd]}` : ''}`;
  return `${withWeekday ? `${EN_WEEKDAYS[wd]!.slice(0, 3)} ` : ''}${d} ${EN_MONTHS[m - 1]} ${y}`;
}

export function formatRange(start: string, end: string, precision: 'day' | 'month' = 'day', lang: DisplayLang = 'en'): string {
  if (precision === 'month') {
    const [y, m] = start.split('-').map(Number) as [number, number];
    return lang === 'tr' ? `${TR_MONTHS[m - 1]} ${y} (günü henüz açıklanmadı)` : `${EN_MONTHS[m - 1]} ${y} (exact day not announced yet)`;
  }
  if (start === end) return formatDate(start, lang);
  return `${formatDate(start, lang)} – ${formatDate(end, lang)}`;
}

export function weekdayName(weekday: number, lang: DisplayLang = 'en'): string {
  return (lang === 'tr' ? TR_WEEKDAYS : EN_WEEKDAYS)[weekday] ?? '';
}

/** Drupal "last updated" stamps like "23/09/2026 - 22:05" → ISO (Europe/Istanbul, +03:00). */
export function parseDrupalTimestamp(raw: string): string | undefined {
  const m = /(\d{2})\/(\d{2})\/(\d{4})(?:\s*-\s*(\d{2}):(\d{2}))?/.exec(raw);
  if (!m) return undefined;
  const [, d, mo, y, h = '00', mi = '00'] = m;
  if (!isValidIso(`${y}-${mo}-${d}`)) return undefined;
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:00+03:00`).toISOString();
}
