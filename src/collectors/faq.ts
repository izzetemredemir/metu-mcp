import * as cheerio from 'cheerio';
import { FAQ_BASE_URL, FAQ_DETAILS_PER_RUN } from '../config.js';
import { cleanText, htmlToText, safeUrl } from '../lib/sanitize.js';
import { now } from '../lib/time.js';
import { transaction } from '../store/db.js';
import { hasRecords, upsertRecord } from '../store/records.js';
import { politeFetch } from './http.js';
import { runUnit, type CollectorContext } from './runner.js';

/**
 * BİDB FAQ (faq.cc.metu.edu.tr, Drupal 7, crawl-delay 10 s): ~40 group pages (`/tr/groups/<slug>`) list question
 * links (`/tr/sss/<slug>`). Group lists are crawled weekly into `faq_queue`; answer pages are fetched in nightly
 * batches into `records` (kind `faq`), so they are also found by metu_search.
 */

export const FAQ_SOURCE = 'bidb-faq';

export function parseFaqGroups(html: string): { slug: string; name: string }[] {
  const $ = cheerio.load(html);
  const out = new Map<string, string>();
  $('a[href^="/tr/groups/"]').each((_, a) => {
    const slug = /^\/tr\/groups\/([a-z0-9-]+)$/.exec($(a).attr('href') ?? '')?.[1];
    const name = cleanText($(a).text(), 100);
    if (slug && name && !out.has(slug)) out.set(slug, name);
  });
  return [...out].map(([slug, name]) => ({ slug, name }));
}

export function parseFaqGroupList(html: string): { url: string; question: string }[] {
  const $ = cheerio.load(html);
  const out: { url: string; question: string }[] = [];
  $('.view-content a[href^="/tr/sss/"]').each((_, a) => {
    const url = safeUrl($(a).attr('href'), FAQ_BASE_URL);
    const question = cleanText($(a).text(), 300);
    if (url && question && !out.some((o) => o.url === url)) out.push({ url, question });
  });
  return out;
}

export interface FaqAnswer {
  question: string;
  answer: string;
  groups: string[];
  updated_at: string | null;
}

export function parseFaqAnswer(html: string): FaqAnswer | null {
  const $ = cheerio.load(html);
  const question = cleanText($('h1#page-title').first().text(), 300);
  const answer = cleanText(htmlToText($('.field-name-body').first().html() ?? '', 8000), 8000);
  if (!question || !answer) return null;
  const d = /(\d{4})-(\d{2})-(\d{2})/.exec($('.page-update time').attr('datetime') ?? '');
  return {
    question,
    answer,
    groups: [...new Set($('.field-name-field-groups a').map((_, a) => cleanText($(a).text(), 80)).get().filter(Boolean))],
    updated_at: d ? new Date(`${d[1]}-${d[2]}-${d[3]}T12:00:00+03:00`).toISOString() : null,
  };
}

/** Weekly: group pages → question URLs. */
export async function collectFaqIndex(ctx: CollectorContext): Promise<void> {
  await runUnit(ctx, 'faq', async () => {
    const startedAt = now().toISOString();
    const groups = parseFaqGroups((await politeFetch(ctx.db, new URL('tr', FAQ_BASE_URL).href)).body);
    if (groups.length < 10) throw new Error(`only ${groups.length} FAQ groups parsed (layout change?)`);
    let total = 0;
    for (const g of groups) {
      const items = parseFaqGroupList((await politeFetch(ctx.db, new URL(`tr/groups/${g.slug}`, FAQ_BASE_URL).href)).body);
      transaction(ctx.db, () => {
        const up = ctx.db.prepare(
          `INSERT INTO faq_queue (url, question, grp, listed_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(url) DO UPDATE SET question = excluded.question, listed_at = excluded.listed_at`,
        );
        for (const it of items) up.run(it.url, it.question, g.name, startedAt);
      });
      total += items.length;
    }
    if (total < 50) throw new Error(`only ${total} FAQ entries listed (layout change?)`);
    // Questions no longer listed anywhere are dropped from the queue and the answers.
    const gone = ctx.db.prepare('SELECT url FROM faq_queue WHERE listed_at < ?').all(startedAt) as { url: string }[];
    transaction(ctx.db, () => {
      for (const { url } of gone) ctx.db.prepare('DELETE FROM records WHERE id = ?').run(`faq:${url}`);
      ctx.db.prepare('DELETE FROM faq_queue WHERE listed_at < ?').run(startedAt);
    });
    return total;
  });
}

/** Nightly: fetch a batch of answer pages, never-fetched first. */
export async function collectFaqAnswers(ctx: CollectorContext, limit = FAQ_DETAILS_PER_RUN): Promise<void> {
  await runUnit(ctx, 'faq-answers', async () => {
    const batch = ctx.db
      .prepare('SELECT url, question, grp FROM faq_queue ORDER BY fetched_at IS NOT NULL, fetched_at LIMIT ?')
      .all(limit) as { url: string; question: string; grp: string }[];
    if (batch.length === 0) return 0;
    const known = hasRecords(ctx.db, 'faq', FAQ_SOURCE, 'tr');
    let ok = 0;
    for (const item of batch) {
      try {
        const a = parseFaqAnswer((await politeFetch(ctx.db, item.url)).body);
        if (!a) throw new Error('no question/answer on the page');
        upsertRecord(
          ctx.db,
          {
            id: `faq:${item.url}`,
            kind: 'faq',
            source: FAQ_SOURCE,
            lang: 'tr',
            title: a.question,
            body: a.answer,
            url: item.url,
            data: { groups: a.groups.length ? a.groups : [item.grp] },
            source_updated_at: a.updated_at,
            search_extra: `${a.groups.join(' ')} ${item.grp} BİDB bilgi işlem IT`,
          },
          undefined,
          { trackNew: known },
        );
        ok++;
      } catch (err) {
        ctx.log(`[faq-answers] ${item.url}: ${(err as Error).message}`);
      }
      ctx.db.prepare('UPDATE faq_queue SET fetched_at = ? WHERE url = ?').run(now().toISOString(), item.url);
    }
    if (ok === 0) throw new Error(`all ${batch.length} FAQ pages failed`);
    return ok;
  });
}
