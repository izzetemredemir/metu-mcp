import type { DatabaseSync } from 'node:sqlite';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { PAGE_SOURCES, type Lang, type PageTopic } from '../config.js';
import { t } from '../i18n.js';
import type { LinkCategory } from '../links.js';
import { foldTr } from '../lib/text.js';
import { computeFreshness, type Freshness } from '../store/freshness.js';
import { getRecord, type StoredRecord } from '../store/records.js';
import { answer, COMMON_OUTPUT, LangSchema, READ_ONLY, recordFreshness, seeAlso } from './common.js';

const SERVICE_TOPICS = ['sports', 'health', 'library', 'clubs', 'safety', 'accessibility', 'regulations', 'language', 'dormitory', 'registrar', 'scholarships', 'international'] as const satisfies readonly PageTopic[];
type ServiceTopic = (typeof SERVICE_TOPICS)[number];

/** Official-link lookup and related announcement sources per topic. */
const TOPIC_META: Record<ServiceTopic, { links: { query: string; category?: LinkCategory }; announcements: string[] }> = {
  sports: { links: { query: 'spor sports rezervasyon reservation havuz' }, announcements: ['sports', 'pools'] },
  health: { links: { query: 'sağlık health mediko randevu appointment' }, announcements: ['health'] },
  library: { links: { query: 'kütüphane library katalog', category: 'library' }, announcements: ['library'] },
  clubs: { links: { query: 'topluluk club etkinlik event' }, announcements: [] },
  safety: { links: { query: 'güvenlik security iç hizmetler' }, announcements: ['ihm'] },
  accessibility: { links: { query: 'engelsiz accessibility disability' }, announcements: [] },
  regulations: { links: { query: 'yönetmelik regulation senato', category: 'regulations' }, announcements: ['oidb'] },
  language: { links: { query: 'dil kursu language course toefl ielts ingilizce' }, announcements: [] },
  dormitory: { links: { query: 'yurt dorm dormitory konaklama', category: 'dormitory' }, announcements: ['yurtlar'] },
  registrar: { links: { query: 'öğrenci işleri registrar kayıt form', category: 'registration' }, announcements: ['oidb'] },
  scholarships: { links: { query: 'burs scholarship yardım' }, announcements: ['oidb'] },
  international: { links: { query: 'uluslararası international öğrenci oturum residence', category: 'international' }, announcements: ['ico'] },
};

/** Characters of page text returned per answer (pages are cut, not dropped, when over budget). */
const TEXT_BUDGET = 9000;

const PageOut = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  lang: z.enum(['tr', 'en']),
  text: z.string(),
  truncated: z.boolean(),
});

/**
 * Paragraphs of `body` that contain every query word (accent-insensitive), plus up to three short paragraphs after each
 * match — enough for "heading → name → status" lists such as the doctors-on-duty page.
 */
export function matchingParagraphs(body: string, query: string): string {
  const words = foldTr(query)
    .split(/\s+/)
    .filter((w) => w.length >= 2);
  if (words.length === 0) return body;
  const paras = body.split(/\n{2,}/);
  const keep = new Set<number>();
  paras.forEach((p, i) => {
    const folded = foldTr(p);
    if (words.every((w) => folded.includes(w))) {
      keep.add(i);
      for (let j = i + 1; j <= i + 3 && j < paras.length && paras[j]!.length < 300; j++) keep.add(j);
    }
  });
  return [...keep].sort((a, b) => a - b).map((i) => paras[i]).join('\n\n');
}

/** Whether every query word (accent-insensitive, 2+ letters) occurs in `title`. */
export function titleMatches(title: string, query: string): boolean {
  const words = foldTr(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2);
  const folded = foldTr(title);
  return words.length > 0 && words.every((w) => folded.includes(w));
}

export function registerServiceTools(server: McpServer, db: DatabaseSync): void {
  server.registerTool(
    'metu_campus_services',
    {
      title: 'METU campus services',
      description:
        'Current text of official METU service pages by topic: ' +
        'sports (facilities and opening hours, sports teams, swimming pools: student fees and status), ' +
        'health (health center/Medico: units and hours, phone numbers, free psychological counselling PDRM; for who is on ' +
        'duty today use metu_doctors_on_duty), library (opening hours, borrowing limits and fines, off-campus e-resource access), ' +
        'clubs (list of student societies with advisors/rooms, upcoming club events), safety (campus security 24 h duty desk ' +
        'and internal services contacts), accessibility (Disability Support Office), regulations (undergraduate and ' +
        'graduate regulations: probation, repeats, double major/minor, leave of absence, maximum study period, resit exams ' +
        'and summer school), language (paid English courses of the School of Foreign Languages: TOEFL, IELTS, General ' +
        'English, YDS, online or on campus, with fees, hours and term schedules; placement exam; METU TOEFL iBT test centre), ' +
        'dormitory (monthly fee of every dormitory and guesthouse room type from the official fee spreadsheet, bank ' +
        'accounts for payment, general features, placement point table, dormitories regulation, contacts), registrar ' +
        '(Registrar FAQ: registration, prep school, add-drop, leave of absence, graduation; forms with file links; ' +
        'tuition payments and amounts, student certificate, course withdrawal), scholarships (Registrar scholarship and ' +
        'aid applications, required documents, YÖK undergraduate and 100/2000 PhD scholarships, YUDAP, scholarships for ' +
        'international students) and international (International Students Office: residence permit, foreign ID ' +
        'number, health insurance, tuition fee, cost of living, application dates and documents). ' +
        'Optional `query` keeps only matching paragraphs, e.g. topic="sports", query="tenis" or topic="language", ' +
        'query="TOEFL". For news of these units use metu_announcements; for locations use metu_campus_place; for other ' +
        'continuing-education trainings use metu_trainings.',
      inputSchema: z.object({
        topic: z.enum(SERVICE_TOPICS).describe('Service area'),
        query: z.string().max(100).optional().describe('Words to look for inside the pages (Turkish or English)'),
        lang: LangSchema,
      }),
      outputSchema: z.object({
        topic: z.enum(SERVICE_TOPICS),
        pages: z.array(PageOut),
        related_announcement_sources: z.array(z.string()).describe('Pass one as `source` to metu_announcements for news'),
        ...COMMON_OUTPUT,
      }),
      annotations: { ...READ_ONLY, title: 'METU campus services' },
    },
    async ({ topic, query, lang }) => {
      const sources = PAGE_SOURCES.filter((p) => p.topic === topic);
      const freshness: Freshness[] = [];
      const pages: z.infer<typeof PageOut>[] = [];
      let budget = TEXT_BUDGET;
      for (const src of sources) {
        // Requested language first; the other one when it is missing or (with a query) has no match, since students
        // often search in Turkish while asking in English and vice versa.
        const candidates = [lang, lang === 'tr' ? 'en' : 'tr']
          .map((l) => getRecord(db, `page:${src.id}:${l}`))
          .filter((r): r is StoredRecord => r !== undefined);
        if (candidates.length === 0) {
          freshness.push(computeFreshness(db, { kind: 'page', collector: `page:${src.id}`, source_url: src.url }, lang));
          continue;
        }
        // A page whose own title matches the query (e.g. "TOEFL" → the TOEFL course schedule) is returned whole.
        const whole = !query || titleMatches(`${src.title.en} ${src.title.tr}`, query);
        const hit = candidates
          .map((rec) => ({ rec, text: whole ? rec.body : matchingParagraphs(rec.body, query) }))
          .find((c) => c.text);
        const rec = hit?.rec ?? candidates[0]!;
        freshness.push(recordFreshness(db, rec, `page:${src.id}`, lang));
        const text = hit?.text;
        if (!text) continue;
        const cut = text.length > budget;
        const shown = cut ? `${text.slice(0, Math.max(budget, 300))}…` : text;
        budget = Math.max(0, budget - shown.length);
        pages.push({ id: src.id, title: src.title[lang], url: rec.url, lang: rec.lang, text: shown, truncated: cut });
      }

      const related = TOPIC_META[topic].announcements;
      const blocks = pages.map((p) => {
        const fallback = p.lang !== lang ? `${t(lang, 'fallback_lang')}\n` : '';
        return `## ${p.title}\n${p.url}\n${fallback}${p.text}`;
      });
      if (blocks.length === 0) {
        blocks.push(
          query
            ? `${t(lang, 'no_results')} ${lang === 'tr' ? 'Sorgu olmadan tekrar dene.' : 'Try again without a query.'}`
            : lang === 'tr'
              ? 'Bu konudaki sayfalar henüz toplanmadı; resmi sayfalara bak.'
              : 'These pages have not been collected yet; see the official pages.',
        );
      }
      if (related.length) {
        blocks.push(
          lang === 'tr'
            ? `Güncel duyurular için: metu_announcements (source: ${related.join(', ')}).`
            : `For current notices: metu_announcements (source: ${related.join(', ')}).`,
        );
      }
      return answer({
        lang,
        text: blocks.join('\n\n'),
        data: { topic, pages, related_announcement_sources: related },
        freshness,
        see_also: seeAlso(db, { ...TOPIC_META[topic].links, limit: 3 }, lang),
      });
    },
  );
}
