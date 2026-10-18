import * as cheerio from 'cheerio';
import { XMLParser } from 'fast-xml-parser';
import { ANNOUNCEMENT_SOURCES, LANGS, type AnnouncementSource, type Lang } from '../config.js';
import { cleanText, htmlToText, safeUrl } from '../lib/sanitize.js';
import { foldTr } from '../lib/text.js';
import { getRecord, hasRecords, upsertRecord } from '../store/records.js';
import { extractPage } from './extract.js';
import { politeFetch } from './http.js';
import { runUnit, type CollectorContext } from './runner.js';

export interface AnnouncementItem {
  title: string;
  url: string;
  summary: string;
  published_at: string | null;
  /** Record id when several items share one URL (bulletin issues); defaults to `announcement:<url>`. */
  id?: string;
  /** The summary already is the full text: no detail page to fetch. */
  full_text?: boolean;
}

/** Newest items kept per list page (some Drupal 7 tables list the whole archive). */
const MAX_ITEMS_PER_PAGE = 40;

/** Max detail pages fetched per source per run (only for announcements we have not seen yet). */
const MAX_DETAIL_FETCHES = 8;

/** Boilerplate lines some METU RSS feeds put into descriptions (slider image labels). */
const RSS_JUNK = /^(slider cover image|slider image|cover image)$/i;

/** Drops utm_* tracking parameters (WordPress feeds such as kpm.metu.edu.tr add them), so URLs stay stable ids. */
function stripTracking(url: string | undefined): string | undefined {
  if (!url) return url;
  const u = new URL(url);
  for (const key of [...u.searchParams.keys()]) if (key.startsWith('utm_')) u.searchParams.delete(key);
  return u.href;
}

export function parseRss(xml: string, baseUrl: string): AnnouncementItem[] {
  const parser = new XMLParser({ ignoreAttributes: true, processEntities: true, htmlEntities: true });
  const doc = parser.parse(xml) as { rss?: { channel?: { item?: unknown } } };
  const raw = doc.rss?.channel?.item;
  const items = (Array.isArray(raw) ? raw : raw ? [raw] : []) as Record<string, unknown>[];
  const out: AnnouncementItem[] = [];
  for (const it of items) {
    const url = stripTracking(safeUrl(String(it.link ?? ''), baseUrl));
    const title = cleanText(String(it.title ?? ''), 300);
    if (!url || !title) continue;
    const summary = htmlToText(String(it.description ?? ''), 1500)
      .split('\n')
      .filter((l) => !RSS_JUNK.test(l.trim()))
      .join('\n')
      .trim();
    const pub = it.pubDate ? new Date(String(it.pubDate)) : undefined;
    out.push({
      title,
      url,
      summary,
      published_at: pub && !Number.isNaN(pub.getTime()) ? pub.toISOString() : null,
    });
  }
  return out;
}

/**
 * Parses an announcement list of METU's shared Drupal theme. Each item is a `.views-row` with
 * `a.list-group-item__title`, `.list-group-item__body` and `time[datetime]`. Falls back to the
 * first link / time element for older variants.
 */
export function parseDrupalList(html: string, baseUrl: string): AnnouncementItem[] {
  const $ = cheerio.load(html);
  const out: AnnouncementItem[] = [];
  const seen = new Set<string>();
  $('.view-content .views-row').each((_, row) => {
    const r = $(row);
    const titleEl = r.find('a.list-group-item__title').first().length
      ? r.find('a.list-group-item__title').first()
      : r.find('h2 a, h3 a, h4 a, a').first();
    const url = safeUrl(titleEl.attr('href'), baseUrl);
    const title = cleanText(titleEl.text(), 300);
    if (!url || !title || seen.has(url)) return;
    seen.add(url);
    const summary = cleanText(r.find('.list-group-item__body, .views-field-body, .field-content p').first().text(), 1500);
    const dt = r.find('time[datetime]').first().attr('datetime');
    const pub = dt ? new Date(dt) : undefined;
    out.push({
      title,
      url,
      summary: summary === title ? '' : summary,
      published_at: pub && !Number.isNaN(pub.getTime()) ? pub.toISOString() : null,
    });
  });
  if (out.length > 0) return out;
  // Card list of kafeterya.metu.edu.tr: `.announcement > a.announcement-link` with title, teaser and a dd/mm/yyyy date.
  $('.announcement a.announcement-link').each((_, el) => {
    const a = $(el);
    const url = safeUrl(a.attr('href'), baseUrl);
    const title = cleanText(a.find('.announcement-title').text(), 300);
    if (!url || !title || seen.has(url)) return;
    seen.add(url);
    const d = /(\d{2})\/(\d{2})\/(\d{4})/.exec(a.find('.announcement-date').text());
    out.push({
      title,
      url,
      summary: cleanText(a.find('.announcement-text').text(), 1500),
      published_at: d ? new Date(`${d[3]}-${d[2]}-${d[1]}T00:00:00+03:00`).toISOString() : null,
    });
  });
  if (out.length > 0) return out;
  // Drupal 7 table views (e.g. ii.metu.edu.tr/tr/all-announcements): one row per item, title link in the first cell.
  $('.view-content table tr').each((_, tr) => {
    const a = $(tr).find('td a[href]').first();
    const url = safeUrl(a.attr('href'), baseUrl);
    const title = cleanText(a.text(), 300);
    if (!url || !title || seen.has(url)) return;
    seen.add(url);
    const dt = $(tr).find('time[datetime]').first().attr('datetime') ?? $(tr).find('.date-display-single').attr('content');
    const pub = dt ? new Date(dt) : undefined;
    out.push({ title, url, summary: '', published_at: pub && !Number.isNaN(pub.getTime()) ? pub.toISOString() : null });
  });
  return out;
}

/** Bulletin sections that list births and deaths of staff members: personal data, never stored. */
const BULLETIN_SKIP_SECTIONS = /^(diger|other|dogum ve vefat|acı kayıplarımız|aci kayiplarimiz|hos geldin bebek)$/;

/**
 * "Bu Hafta" (buhafta.metu.edu.tr) issues from the WordPress REST API (`/wp-json/wp/v2/pages`): each issue is a page
 * titled "Sayı: N" with `<h2>` sections (Haberler, Etkinlikler, Duyurular) and one `<h4>` per item. Every item becomes
 * one announcement linked to its issue. The "Diğer" section (births and deaths) is skipped.
 */
export function parseBulletinIssues(json: string, siteUrl: string): AnnouncementItem[] {
  const pages = JSON.parse(json) as {
    id: number;
    date_gmt?: string;
    title?: { rendered?: string };
    content?: { rendered?: string };
  }[];
  const out: AnnouncementItem[] = [];
  for (const page of pages) {
    const issue = /Say[ıi]\s*:?\s*(\d+)/i.exec(cleanText(htmlToText(page.title?.rendered ?? '', 200)))?.[1];
    if (!issue) continue;
    const pub = page.date_gmt ? new Date(`${page.date_gmt}Z`) : undefined;
    const published_at = pub && !Number.isNaN(pub.getTime()) ? pub.toISOString() : null;
    const url = new URL(`?page_id=${page.id}`, siteUrl).href;
    const $ = cheerio.load(page.content?.rendered ?? '');
    let section = '';
    let skip = false;
    let current: { title: string; parts: string[] } | undefined;
    let n = 0;
    const flush = () => {
      if (current && !skip) {
        n++;
        const text = cleanText(current.parts.join('\n\n'), 6000);
        out.push({
          id: `announcement:bulletin:${issue}:${n}`,
          title: current.title,
          url,
          summary: `Bu Hafta ${issue}${section ? ` · ${section}` : ''}\n\n${text}`,
          published_at,
          full_text: true,
        });
      }
      current = undefined;
    };
    $('h2, h3, h4, p, li:not(:has(p))').each((_, el) => {
      const tag = el.tagName.toLowerCase();
      const text = cleanText($(el).text(), 2000);
      if (!text) return;
      if (tag === 'h2' || tag === 'h3') {
        flush();
        const folded = foldTr(text);
        if (tag === 'h2') {
          section = text.charAt(0) + text.slice(1).toLocaleLowerCase('tr-TR');
          skip = BULLETIN_SKIP_SECTIONS.test(folded);
        } else if (BULLETIN_SKIP_SECTIONS.test(folded)) {
          skip = true;
        }
        return;
      }
      if (tag === 'h4') {
        flush();
        current = { title: text, parts: [] };
        return;
      }
      current?.parts.push(text);
    });
    flush();
  }
  return out;
}

/**
 * Parses a fragment of `<a href="file">title</a> (dd/mm/yyyy)` lines (dbe.metu.edu.tr `_announcements.php`). The link is
 * a file (mostly PDF), so the title is all the text there is.
 */
export function parseDatedLinks(html: string, baseUrl: string): AnnouncementItem[] {
  const $ = cheerio.load(html);
  const out: AnnouncementItem[] = [];
  const seen = new Set<string>();
  $('a[href]').each((_, el) => {
    const a = $(el);
    const url = safeUrl(a.attr('href'), baseUrl);
    const title = cleanText(a.text(), 300);
    if (!url || !title || seen.has(url)) return;
    seen.add(url);
    const d = /\((\d{2})\/(\d{2})\/(\d{4})\)/.exec(a.parent().text());
    out.push({
      title,
      url,
      summary: '',
      published_at: d ? new Date(`${d[3]}-${d[2]}-${d[1]}T00:00:00+03:00`).toISOString() : null,
      full_text: true,
    });
  });
  return out;
}

/**
 * Drupal serves every page under `/index.php/…` too (some lists link that form, sometimes encoded as `index%2ephp`);
 * dropping it keeps one record per announcement.
 */
export function canonicalUrl(url: string): string {
  return url.replace(/\/index(?:\.|%2e)php(?=\/)/i, '');
}

/** Language from a `/tr/…` or `/en/…` path prefix, if the URL has one. */
export function itemLang(url: string): Lang | undefined {
  const seg = new URL(url).pathname.split('/').filter(Boolean)[0];
  return seg === 'tr' || seg === 'en' ? seg : undefined;
}

async function collectSource(ctx: CollectorContext, src: AnnouncementSource, lang: Lang, listUrl: string): Promise<number> {
  let items: AnnouncementItem[] = [];
  let lastBody = '';
  const pages = src.type === 'drupal' ? (src.pages ?? 1) : 1;
  for (let p = 0; p < pages; p++) {
    const url = p === 0 ? listUrl : `${listUrl}?page=${p}`;
    let res;
    try {
      res = await politeFetch(ctx.db, url);
    } catch (err) {
      // Only the first page is required; later pages are a bonus.
      if (p === 0) throw err;
      ctx.log(`[announcements:${src.id}:${lang}] ${url} skipped: ${(err as Error).message}`);
      break;
    }
    if (p === 0) lastBody = res.body;
    const parsed =
      src.type === 'rss'
        ? parseRss(res.body, listUrl)
        : src.type === 'wp-bulletin'
          ? parseBulletinIssues(res.body, src.site_url ?? listUrl)
          : src.type === 'dated-links'
            ? parseDatedLinks(res.body, listUrl)
            : parseDrupalList(res.body, listUrl);
    items = items.concat(parsed.slice(0, MAX_ITEMS_PER_PAGE));
    if (parsed.length === 0) break;
  }
  if (items.length === 0) {
    // An empty Drupal view ("There is no content in this category") is a valid, empty list — not a layout change.
    if (lastBody && cheerio.load(lastBody)('.view-empty').length > 0) return 0;
    throw new Error(`no announcements parsed from ${listUrl} (page layout may have changed)`);
  }

  const known = hasRecords(ctx.db, 'announcement', src.id, lang);
  let detailFetches = 0;
  for (const item of items) {
    item.url = canonicalUrl(item.url);
    const id = item.id ?? `announcement:${item.url}`;
    const existing = getRecord(ctx.db, id);
    let body = item.summary;
    let sourceUpdatedAt: string | null = null;
    if (existing) {
      // Keep the full text fetched earlier; only the list-level fields are re-checked.
      body = existing.body;
    } else if (!item.full_text && detailFetches < MAX_DETAIL_FETCHES) {
      detailFetches++;
      try {
        const detail = await politeFetch(ctx.db, item.url, { conditional: false });
        const page = extractPage(detail.body, 12000);
        if (page.text.length > body.length) body = page.text;
        sourceUpdatedAt = page.updatedAt;
        // Lists without dates (Drupal 7 tables): fall back to the page's own stamp.
        item.published_at ??= page.updatedAt;
      } catch (err) {
        ctx.log(`[announcements:${src.id}:${lang}] detail fetch failed for ${item.url}: ${(err as Error).message}`);
      }
    }
    upsertRecord(ctx.db, {
      id,
      kind: 'announcement',
      source: src.id,
      // The item's own URL prefix wins: some Turkish lists link English-only posts (/en/...) and vice versa.
      lang: itemLang(item.url) ?? lang,
      title: item.title,
      body,
      url: item.url,
      data: { category: src.category, department: src.department ?? null },
      published_at: item.published_at,
      source_updated_at: sourceUpdatedAt,
      search_extra: `${src.name.en} ${src.name.tr} ${src.department ?? ''}`,
    }, undefined, { trackNew: known });
  }
  return items.length;
}

/**
 * Collects announcement sources. With `only`, exactly those sources; otherwise the 20-minute tier (`frequent`) or the
 * hourly tier (sources marked `hourly`, mostly department sites).
 */
export async function collectAnnouncements(ctx: CollectorContext, only?: string[], tier: 'frequent' | 'hourly' = 'frequent'): Promise<void> {
  const sources = only?.length
    ? ANNOUNCEMENT_SOURCES.filter((s) => only.includes(s.id))
    : ANNOUNCEMENT_SOURCES.filter((s) => (tier === 'hourly') === Boolean(s.hourly));
  for (const src of sources) {
    for (const lang of LANGS) {
      const listUrl = src.urls[lang];
      if (!listUrl) continue;
      await runUnit(ctx, `announcements:${src.id}:${lang}`, () => collectSource(ctx, src, lang, listUrl));
    }
  }
}
