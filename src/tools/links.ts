import type { DatabaseSync } from 'node:sqlite';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { t } from '../i18n.js';
import { findLinks, getLinkChecks, LinkSchema, loadLinks } from '../links.js';
import type { Lang } from '../config.js';
import { computeFreshness, type Freshness } from '../store/freshness.js';
import { answer, COMMON_OUTPUT, formatLinkLine, LangSchema, linkOut, LinkOutSchema, READ_ONLY, toolError } from './common.js';

export function registerLinkTools(server: McpServer, db: DatabaseSync): void {
  server.registerTool(
    'metu_find_link',
    {
      title: 'Find official METU page',
      description:
        'Finds the official METU web page for a topic from a curated catalog (registrar, academic calendar, OİBS, ODTÜClass, ' +
        'fees, regulations, amnesty (Law 7592), graduate schools, departments, cafeteria, vehicle permits, campus map, ring buses, ' +
        'dormitories, health center, sports, library, IT help). Use it whenever the student needs personal data that requires a ' +
        'login (grades, transcript, fee balance, personal exam schedule, enrolled programme) or when another tool has no data: ' +
        'tell them which page to open and whether they must log in. Accepts Turkish or English queries.',
      inputSchema: z.object({
        query: z.string().min(2).max(200).describe('What the student is looking for, e.g. "transkript", "harç ödeme", "add-drop dates"'),
        category: LinkSchema.shape.category.optional().describe('Optional category filter'),
        audience: z
          .string()
          .optional()
          .describe('Optional audience filter: "undergraduate", "graduate" or a department code such as "ceit"'),
        limit: z.number().int().min(1).max(10).default(5),
        lang: LangSchema,
      }),
      outputSchema: z.object({ links: z.array(LinkOutSchema), ...COMMON_OUTPUT }),
      annotations: { ...READ_ONLY, title: 'Find official METU page' },
    },
    async ({ query, category, audience, limit, lang }) => {
      const links = findLinks(loadLinks(), { query, category, audience, limit }, getLinkChecks(db)).map((l) => linkOut(l, lang));
      if (links.length === 0) {
        return toolError(
          `${t(lang, 'no_results')} ${lang === 'tr' ? 'Başka kelimelerle dene (ör. "kayıt", "harç", "takvim").' : 'Try other words (e.g. "registration", "fees", "calendar").'}`,
          lang,
        );
      }
      return answer({
        lang,
        text: links.map((l) => formatLinkLine(l, lang)).join('\n'),
        data: { links },
        freshness: [linkFreshness(db, links[0]!.id, lang)],
      });
    },
  );
}

/**
 * Freshness of a catalog link: when the weekly checker (or a human, per links.yaml) last confirmed the URL works.
 */
export function linkFreshness(db: DatabaseSync, linkId: string, lang: Lang): Freshness {
  const link = loadLinks().find((l) => l.id === linkId);
  const check = getLinkChecks(db).get(linkId);
  const verifiedAt = check?.checked_at ?? (link ? new Date(`${link.last_verified}T12:00:00+03:00`).toISOString() : null);
  const f = computeFreshness(db, { kind: 'link', collector: 'links', source_url: link?.url ?? '', fetched_at: verifiedAt }, lang);
  // The checker never running is not a problem for a curated link; only report real staleness.
  return f.status === 'source_unreachable' ? { ...f, status: 'stale' } : f;
}
