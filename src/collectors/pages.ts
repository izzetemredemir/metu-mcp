import * as cheerio from 'cheerio';
import { PAGE_SOURCES, type Lang, type PageSource } from '../config.js';
import { cleanText, safeUrl } from '../lib/sanitize.js';
import { upsertRecord } from '../store/records.js';
import { extractPage } from './extract.js';
import { politeFetch } from './http.js';
import { spreadsheetText } from './spreadsheet.js';
import { runUnit, type CollectorContext } from './runner.js';

/**
 * Fetches info pages (parking rules, permit rules, meal hours, ring timetables, registrar pages).
 * The Turkish page is the primary source; its English translation is stored too when METU publishes one.
 */
export async function collectPages(ctx: CollectorContext, only?: string[]): Promise<void> {
  const sources = only?.length
    ? PAGE_SOURCES.filter((p) => only.includes(p.id) || only.includes(p.topic))
    : PAGE_SOURCES;
  for (const src of sources) {
    await runUnit(ctx, `page:${src.id}`, () => collectPage(ctx, src));
  }
}

async function collectPage(ctx: CollectorContext, src: PageSource): Promise<number> {
  const tr = await storePage(ctx, src, 'tr', src.url);
  const enUrl = src.url_en ?? tr.alternates.en;
  if (!enUrl) return 1;
  try {
    // A configured url_en is trusted; a discovered alternate must really be an English page.
    await storePage(ctx, src, 'en', enUrl, !src.url_en, tr.text);
    return 2;
  } catch (err) {
    ctx.log(`[page:${src.id}] English version failed (${(err as Error).message}); Turkish stored`);
    return 1;
  }
}

async function storePage(ctx: CollectorContext, src: PageSource, lang: Lang, url: string, checkLang = false, originalText?: string) {
  const res = await politeFetch(ctx.db, url);
  const page = extractPage(res.body, src.max_chars ?? 30000, url);
  if (page.text.length < 40) throw new Error(`page ${url} has no readable content (layout change?)`);
  if (checkLang && page.pageLang && page.pageLang !== lang) {
    throw new Error(`${url} is not an English page (html lang="${page.pageLang}")`);
  }
  // Some Drupal sites (spormd, kim) serve the untranslated Turkish node under /en/node/N with lang="en".
  if (checkLang && originalText && page.text.slice(0, 500) === originalText.slice(0, 500)) {
    throw new Error(`${url} is the untranslated Turkish page`);
  }
  const files = src.file_links ? fileLinks(res.body, url, new RegExp(src.file_links, 'i')) : [];
  let tableText = '';
  if (src.spreadsheet) {
    const sheet = fileLinks(res.body, url, new RegExp(src.spreadsheet, 'i')).find((f) => /\.xlsx?$/i.test(new URL(f.url).pathname));
    // The table is the point of the page: a missing link or unreadable file fails the unit instead of storing less.
    if (!sheet) throw new Error(`no spreadsheet link matching /${src.spreadsheet}/ on ${url}`);
    const file = await politeFetch(ctx.db, sheet.url, { binary: true, timeoutMs: 60_000 });
    tableText = `\n\n${spreadsheetText(file.bytes!)}`;
    if (!files.some((f) => f.url === sheet.url)) files.push(sheet);
  }
  const filesText = files.length ? `\n\n${lang === 'tr' ? 'Dosyalar' : 'Files'}:\n${files.map((f) => `• ${f.title}: ${f.url}`).join('\n')}` : '';
  upsertRecord(ctx.db, {
    id: `page:${src.id}:${lang}`,
    kind: 'page',
    source: src.id,
    lang,
    title: page.title || src.title[lang],
    body: page.text + tableText + filesText,
    url,
    data: files.length ? { topic: src.topic, files } : { topic: src.topic },
    source_updated_at: page.updatedAt,
    search_extra: `${src.title.en} ${src.title.tr} ${src.topic}`,
  });
  return page;
}

/** Links to files whose URL matches `pattern`, titled by the link text or else the file name. */
export function fileLinks(html: string, pageUrl: string, pattern: RegExp): { title: string; url: string }[] {
  const $ = cheerio.load(html);
  const out: { title: string; url: string }[] = [];
  $('a[href]').each((_, a) => {
    const url = safeUrl($(a).attr('href'), pageUrl);
    if (!url || !/\.(pdf|jpe?g|png|xlsx?|docx?)$/i.test(new URL(url).pathname) || !pattern.test(url)) return;
    if (out.some((f) => f.url === url)) return;
    const file = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? url);
    out.push({ title: cleanText($(a).text(), 150) || file, url });
  });
  return out;
}
