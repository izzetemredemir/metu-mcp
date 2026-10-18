import * as cheerio from 'cheerio';

/**
 * Every scraped string is untrusted data: HTML, script/style, hidden elements and
 * zero-width / bidi control characters are stripped and the length is capped.
 */

// Zero-width chars, bidi marks and BOM: can hide invisible text for prompt injection.
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u00AD]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function cleanText(input: string | null | undefined, maxLength = 4000): string {
  if (!input) return '';
  let s = input.normalize('NFC').replace(INVISIBLE, '').replace(CONTROL, '');
  s = s.replace(/\u00A0/g, ' ');
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n');
  s = s.trim();
  if (s.length > maxLength) s = s.slice(0, maxLength - 1).trimEnd() + '…';
  return s;
}

const BLOCK_TAGS = 'p, div, li, tr, h1, h2, h3, h4, h5, h6, br, section, article, table, ul, ol';

/** Converts an HTML fragment to plain text, keeping line structure. */
export function htmlToText(html: string, maxLength = 20000): string {
  const $ = cheerio.load(`<div id="__root">${html}</div>`);
  const root = $('#__root');
  root.find('script, style, noscript, iframe, template, svg, form, button').remove();
  root.find('[hidden], [aria-hidden="true"], .element-hidden, .visually-hidden, .sr-only').remove();
  root.find('[style]').each((_, el) => {
    const style = ($(el).attr('style') ?? '').replace(/\s/g, '').toLowerCase();
    if (style.includes('display:none') || style.includes('visibility:hidden')) $(el).remove();
  });
  root.find('br').replaceWith('\n');
  root.find(BLOCK_TAGS).each((_, el) => {
    $(el).append('\n');
  });
  root.find('td, th').each((_, el) => {
    $(el).append(' | ');
  });
  const text = root
    .text()
    .split('\n')
    .map((l) => l.replace(/\s*\|\s*$/, '').replace(/\s+/g, ' ').trim())
    .filter((l, i, arr) => l.length > 0 || (i > 0 && arr[i - 1] !== ''))
    .join('\n');
  return cleanText(text, maxLength);
}

/** Resolves `href` against `base`; returns `undefined` for non-http(s) or invalid URLs. */
export function safeUrl(href: string | undefined, base: string): string | undefined {
  if (!href) return undefined;
  try {
    const u = new URL(href, base);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}
