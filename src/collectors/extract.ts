import * as cheerio from 'cheerio';
import type { Lang } from '../config.js';
import { cleanText, htmlToText, safeUrl } from '../lib/sanitize.js';
import { parseDrupalTimestamp } from '../lib/trdate.js';

export interface ExtractedPage {
  title: string;
  text: string;
  /** The page's own "Son güncelleme" / "Last updated" stamp, ISO 8601. */
  updatedAt: string | null;
  /** Translations advertised by the page (Drupal hreflang links); untranslated placeholders are skipped. */
  alternates: Partial<Record<Lang, string>>;
  /** Language declared on <html lang>, if any. */
  pageLang: string | null;
}

/** Main-content selectors, most specific first (Drupal 8+ "miys" theme, then Drupal 7). */
const CONTENT_SELECTORS = [
  '.node__content .field--name-body',
  'main .field--name-body',
  '.region-content .field-name-body',
  '.region-content article',
  'main article',
  'main',
  '#block-system-main',
  // Bootstrap course template of dil.metu.edu.tr (no <main>; the breadcrumb banner is a section without .section).
  'section.section',
];

/**
 * Extracts title, main text and the "last updated" stamp from a METU Drupal page.
 * METU sites print the stamp as "Son güncelleme 11/07/2026 - 14:31" (D8+) or "Son Güncelleme: 19/11/2024 - 15:14" (D7).
 */
export function extractPage(html: string, maxLength = 20000, baseUrl?: string): ExtractedPage {
  const $ = cheerio.load(html);
  // Pages without an <h1> (dil.metu.edu.tr) name the page in the active breadcrumb; <title> is only the site name there.
  const title = cleanText($('h1').first().text() || $('.bread-list li.active').first().text() || $('title').text().split('|')[0] || '', 300);

  let text = '';
  for (const sel of CONTENT_SELECTORS) {
    const el = $(sel).first();
    if (el.length) {
      text = htmlToText($.html(el) ?? '', maxLength);
      if (text.length > 40) break;
    }
  }

  let updatedAt: string | null = null;
  const timeAfterLabel = $('.field__label')
    .filter((_, el) => /son\s+g[üu]ncelleme|last\s+updated?/i.test($(el).text()))
    .first()
    .parent()
    .find('time[datetime]')
    .attr('datetime');
  if (timeAfterLabel) {
    const d = new Date(timeAfterLabel);
    if (!Number.isNaN(d.getTime())) updatedAt = d.toISOString();
  }
  if (!updatedAt) {
    const bodyText = $('body').text().replace(/\s+/g, ' ');
    const m = /(?:Son\s+G[üu]ncelleme|Last\s+Updated?)\s*:?\s*(\d{2}\/\d{2}\/\d{4}(?:\s*-\s*\d{2}:\d{2})?)/i.exec(bodyText);
    if (m) updatedAt = parseDrupalTimestamp(m[1]!) ?? null;
  }
  const alternates: Partial<Record<Lang, string>> = {};
  if (baseUrl) {
    $('link[rel="alternate"][hreflang], a.language-link[hreflang]').each((_, el) => {
      const node = $(el);
      if (node.hasClass('locale-untranslated') || node.hasClass('is-untranslated')) return;
      const lang = node.attr('hreflang');
      const href = safeUrl(node.attr('href'), baseUrl);
      if ((lang === 'en' || lang === 'tr') && href && !alternates[lang]) alternates[lang] = href;
    });
  }
  const pageLang = ($('html').attr('lang') ?? '').slice(0, 2).toLowerCase() || null;
  return { title, text, updatedAt, alternates, pageLang };
}
