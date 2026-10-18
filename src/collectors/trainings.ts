import * as cheerio from 'cheerio';
import type { DatabaseSync } from 'node:sqlite';
import { TRAININGS_DETAIL_URL, TRAININGS_DETAILS_PER_RUN, TRAININGS_LIST_URL, TRAININGS_MAX_PAGES } from '../config.js';
import { cleanText, htmlToText, safeUrl } from '../lib/sanitize.js';
import { foldTr } from '../lib/text.js';
import { now } from '../lib/time.js';
import { transaction } from '../store/db.js';
import { politeFetch } from './http.js';
import { runUnit, type CollectorContext } from './runner.js';

/**
 * METULearn (learn.metu.edu.tr): the university's catalog of continuing-education trainings from ODTÜ-SEM, Bilgeİş,
 * METU OCW and METU Learn. The list is paginated server-rendered HTML; a card's details (start date, registration
 * window, enrolment link) are an HTML fragment the page loads into a drawer via htmx.
 */

export type TrainingFormat = 'online' | 'in-person' | 'hybrid';

/** What a list card shows. */
export interface TrainingCard {
  /** METULearn id, e.g. `sem-352` (ODTÜ-SEM) or `moodle-722` (Moodle-based sources). */
  id: string;
  provider: string;
  title: string;
  description: string;
  category: string;
  language: string | null;
  format: TrainingFormat | null;
  price: string | null;
  /** E.g. "139 modül" for OCW courses. */
  duration: string | null;
}

/** What a detail fragment adds. */
export interface TrainingDetail {
  description: string;
  format: TrainingFormat | null;
  price: string | null;
  /** As shown: a date, a date range or "İstediğiniz zaman başlayabilirsiniz" (self-paced). */
  start_text: string | null;
  start_date: string | null;
  end_date: string | null;
  registration: string | null;
  registration_status: string | null;
  enroll_url: string | null;
}

const LANGUAGE_WORDS = /^(türkçe|turkish|english|ingilizce|i̇ngilizce|almanca|german|deutsch|fransızca|french|français|ispanyolca|spanish|rusça|russian|arapça|arabic|tr|en)$/i;
const PRICE = /ücretsiz|free|\d[\d.,]*\s*(tl|₺|usd|eur|\$|€)/i;
const DURATION = /^\d+([.,]\d+)?\s*(modül|module|saat|hour|hafta|week|gün|day|ay|month)/i;

export function normalizeFormat(raw: string): TrainingFormat | null {
  const f = foldTr(raw);
  if (/hibrit|hybrid|karma|harmanlanmis|blended/.test(f)) return 'hybrid';
  if (/online|cevrim ?ici|uzaktan/.test(f)) return 'online';
  if (/yuz ?yuze|in.person|face.to.face/.test(f)) return 'in-person';
  return null;
}

/** `DD.MM.YYYY` → `YYYY-MM-DD`. */
function dmy(s: string): string | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/** "29.09.2026 – 30.09.2026" or "17.05.2017"; anything else (self-paced text) has no date. */
export function parseStart(text: string): { start: string | null; end: string | null } {
  const parts = text.split(/\s*[–-]\s*/);
  const start = dmy(parts[0] ?? '');
  const end = parts[1] ? dmy(parts[1]) : start;
  return { start, end: start ? end : null };
}

/** Cards of one list page, plus the highest page number linked from its pagination. */
export function parseTrainingList(html: string): { cards: TrainingCard[]; maxPage: number; total: number | null } {
  const $ = cheerio.load(html);
  const cards: TrainingCard[] = [];
  $('article.course-card-h').each((_, el) => {
    const card = $(el);
    const id = /\/api\/course\/([\w-]+)\/?$/.exec(card.attr('hx-get') ?? '')?.[1];
    const title = cleanText(card.find('.course-card-h-title').text(), 300);
    if (!id || !title) return;
    let category = '';
    let language: string | null = null;
    let format: TrainingFormat | null = null;
    let price: string | null = null;
    let duration: string | null = null;
    card.find('.course-meta-item').each((_, m) => {
      const v = cleanText($(m).text(), 120);
      if (!v) return;
      if (!price && PRICE.test(v)) price = v;
      else if (!format && normalizeFormat(v)) format = normalizeFormat(v);
      else if (!duration && DURATION.test(v)) duration = v;
      else if (!language && LANGUAGE_WORDS.test(v)) language = v;
      else if (!category) category = v;
    });
    cards.push({
      id,
      provider: cleanText(card.find('.course-source-badge').text(), 100),
      title,
      description: cleanText(card.find('.course-card-h-desc').text(), 600),
      category,
      language,
      format,
      price,
      duration,
    });
  });
  let maxPage = 1;
  $('[href*="sayfa="], [hx-get*="sayfa="]').each((_, el) => {
    const n = Number(/sayfa=(\d+)/.exec($(el).attr('href') ?? $(el).attr('hx-get') ?? '')?.[1]);
    if (Number.isInteger(n) && n > maxPage) maxPage = n;
  });
  const total = Number($('#result-count-num').text().trim());
  return { cards, maxPage, total: Number.isInteger(total) && total > 0 ? total : null };
}

/** A detail fragment: label/value pairs ("Başlangıç Tarihi", "Fiyat", …) and the "Eğitime Git" link. */
export function parseTrainingDetail(html: string): TrainingDetail {
  const $ = cheerio.load(html);
  const fields = new Map<string, string>();
  $('span.block').each((_, el) => {
    const label = foldTr(cleanText($(el).text(), 80));
    const value = cleanText($(el).next().text().replace(/\s+/g, ' '), 300);
    if (label && value) fields.set(label, value);
  });
  const get = (...labels: string[]) => labels.map((l) => fields.get(l)).find((v) => v !== undefined) ?? null;
  const startText = get('baslangic tarihi', 'start date');
  const { start, end } = startText ? parseStart(startText) : { start: null, end: null };
  const link = $('a[target="_blank"]')
    .filter((_, a) => /eğitime git|go to|kayıt|enrol/i.test($(a).text()))
    .first()
    .attr('href');
  const formatText = get('format');
  return {
    description: cleanText(htmlToText($('.mb-10').first().html() ?? '', 3000), 3000),
    format: formatText ? normalizeFormat(formatText) : null,
    price: get('fiyat', 'price'),
    start_text: startText,
    start_date: start,
    end_date: end,
    registration: get('kayit tarihleri', 'registration dates'),
    registration_status: get('kayit durumu', 'registration status'),
    enroll_url: safeUrl(link, TRAININGS_DETAIL_URL) ?? null,
  };
}

/** Listing link used until the enrolment link is known: the catalog searched for the title. */
export function catalogSearchUrl(title: string): string {
  return `${TRAININGS_LIST_URL}?q=${encodeURIComponent(title)}`;
}

function searchText(c: Pick<TrainingCard, 'title' | 'provider' | 'category' | 'description'>, extra = ''): string {
  return foldTr(`${c.title} ${c.provider} ${c.category} ${c.description} ${extra}`);
}

/** Upserts list cards; detail columns stay as they are. */
export function saveTrainingCards(db: DatabaseSync, cards: TrainingCard[], ts: string): void {
  transaction(db, () => {
    const ins = db.prepare(
      `INSERT INTO trainings (id, provider, title, description, category, language, format, price, duration, url, search_text, listed_at, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, title = excluded.title, category = excluded.category,
         language = excluded.language, format = COALESCE(excluded.format, trainings.format),
         price = COALESCE(excluded.price, trainings.price), duration = excluded.duration,
         -- The detail description is complete; the card's is cut at ~140 characters.
         description = CASE WHEN trainings.detail_fetched_at IS NULL THEN excluded.description ELSE trainings.description END,
         url = CASE WHEN trainings.enroll_url IS NULL THEN excluded.url ELSE trainings.url END,
         search_text = CASE WHEN trainings.detail_fetched_at IS NULL THEN excluded.search_text ELSE trainings.search_text END,
         listed_at = excluded.listed_at, fetched_at = excluded.fetched_at`,
    );
    for (const c of cards) {
      ins.run(c.id, c.provider, c.title, c.description, c.category, c.language, c.format, c.price, c.duration,
        catalogSearchUrl(c.title), searchText(c), ts, ts);
    }
  });
}

export function saveTrainingDetail(db: DatabaseSync, id: string, d: TrainingDetail, ts: string): void {
  const row = db.prepare('SELECT title, provider, category, description FROM trainings WHERE id = ?').get(id) as
    | { title: string; provider: string; category: string; description: string }
    | undefined;
  if (!row) return;
  const description = d.description || row.description;
  db.prepare(
    `UPDATE trainings SET description = ?, format = COALESCE(?, format), price = COALESCE(?, price), start_text = ?,
       start_date = ?, end_date = ?, registration = ?, registration_status = ?, enroll_url = ?, url = COALESCE(?, url),
       search_text = ?, detail_fetched_at = ?, fetched_at = ? WHERE id = ?`,
  ).run(
    description, d.format, d.price, d.start_text, d.start_date, d.end_date, d.registration, d.registration_status,
    d.enroll_url, d.enroll_url, searchText({ ...row, description }, d.registration_status ?? ''), ts, ts, id,
  );
}

/** Weekly: every list page (~24 requests); trainings no longer listed are removed after a complete walk. */
export async function collectTrainings(ctx: CollectorContext): Promise<void> {
  await runUnit(ctx, 'trainings', async () => {
    const ts = now().toISOString();
    const first = parseTrainingList((await politeFetch(ctx.db, TRAININGS_LIST_URL)).body);
    if (first.cards.length === 0) throw new Error('no trainings parsed from the METULearn list (layout change?)');
    const cards = new Map(first.cards.map((c) => [c.id, c]));
    const last = Math.min(first.maxPage, TRAININGS_MAX_PAGES);
    let complete = first.maxPage <= TRAININGS_MAX_PAGES;
    for (let page = 2; page <= last; page++) {
      try {
        const { cards: more } = parseTrainingList((await politeFetch(ctx.db, `${TRAININGS_LIST_URL}?sayfa=${page}`)).body);
        for (const c of more) cards.set(c.id, c);
      } catch (err) {
        complete = false;
        ctx.log(`[trainings] page ${page} skipped: ${(err as Error).message}`);
      }
    }
    saveTrainingCards(ctx.db, [...cards.values()], ts);
    // Only a complete walk proves a training was withdrawn; a partial one keeps the rest.
    if (complete && (first.total === null || cards.size >= first.total * 0.9)) {
      ctx.db.prepare('DELETE FROM trainings WHERE listed_at < ?').run(ts);
    }
    return cards.size;
  });
}

/** Daily: detail fragments of the least recently checked trainings (never-fetched first). */
export async function collectTrainingDetails(ctx: CollectorContext, max = TRAININGS_DETAILS_PER_RUN): Promise<void> {
  await runUnit(ctx, 'trainings-details', async () => {
    const ids = (
      ctx.db.prepare('SELECT id FROM trainings ORDER BY detail_fetched_at IS NOT NULL, detail_fetched_at LIMIT ?').all(max) as { id: string }[]
    ).map((r) => r.id);
    let ok = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        const res = await politeFetch(ctx.db, `${TRAININGS_DETAIL_URL}${id}/`);
        saveTrainingDetail(ctx.db, id, parseTrainingDetail(res.body), now().toISOString());
        ok++;
      } catch (err) {
        failed++;
        ctx.log(`[trainings-details] ${id}: ${(err as Error).message}`);
      }
    }
    if (ids.length > 0 && ok === 0) throw new Error(`all ${failed} detail requests failed`);
    return ok;
  });
}
