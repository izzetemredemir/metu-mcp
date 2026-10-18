import * as cheerio from 'cheerio';
import { DINING_BASE_URL, DINING_DAYS_AHEAD } from '../config.js';
import { cleanText } from '../lib/sanitize.js';
import { foldTr } from '../lib/text.js';
import { addDaysIso, now, todayIstanbul } from '../lib/time.js';
import { upsertRecord } from '../store/records.js';
import { politeFetch } from './http.js';
import { runUnit, type CollectorContext } from './runner.js';

export const DINING_SOURCE = 'cafeteria';

export interface DayMenu {
  date: string;
  breakfast: string[];
  lunch: string[];
  dinner: string[];
  vegetarian: string[];
  vegan: string[];
  /** Faculty Club à la carte list with calories (kcal), when published. */
  faculty_club: { name: string; kcal: number | null }[];
  notes: string[];
}

export function diningUrl(isoDate: string): string {
  const [y, m, d] = isoDate.split('-');
  const u = new URL(DINING_BASE_URL);
  u.searchParams.set('date_filter[value][date]', `${d}/${m}/${y}`);
  return u.toString();
}

const dedupe = (list: string[]) => [...new Set(list.filter((s) => s.length > 0))];

/**
 * Parses kafeterya.metu.edu.tr for one day. The page lists breakfast in a `field-kahvalti` block,
 * then "Öğle Yemeği" (lunch) and "Akşam Yemeği" (dinner) headings each followed by dish articles,
 * then "Vejetaryen:" / "Vegan:" alternatives and a Faculty Club table.
 * Returns `undefined` when the page shows a different date than requested.
 */
export function parseDiningPage(html: string, isoDate: string): DayMenu | undefined {
  const $ = cheerio.load(html);
  const [y, m, d] = isoDate.split('-');
  const shown = $('input[name="date_filter[value][date]"]').attr('value');
  if (shown && shown !== `${d}/${m}/${y}`) return undefined;

  const menu: DayMenu = { date: isoDate, breakfast: [], lunch: [], dinner: [], vegetarian: [], vegan: [], faculty_club: [], notes: [] };

  $('.views-field-field-kahvalti .field-content').each((_, el) => {
    const items = $(el).find('.kahvalti');
    if (items.length) items.each((__, it) => void menu.breakfast.push(cleanText($(it).text(), 120)));
    else menu.breakfast.push(...cleanText($(el).text(), 400).split('\n'));
  });

  let current: 'lunch' | 'dinner' | undefined;
  $('h3.title, article.node-yemek-listesi h2 a, .views-field-field-vejeteryan .field-content, .views-field-field-vegan .field-content').each(
    (_, el) => {
      const node = $(el);
      const text = cleanText(node.text(), 200);
      if (!text) return;
      if (node.is('h3')) {
        const f = foldTr(text);
        current = f.includes('ogle') ? 'lunch' : f.includes('aksam') ? 'dinner' : undefined;
        return;
      }
      if (node.closest('.views-field-field-vejeteryan').length) {
        menu.vegetarian.push(text.replace(/^vejetaryen\s*:\s*/i, ''));
        return;
      }
      if (node.closest('.views-field-field-vegan').length) {
        menu.vegan.push(text.replace(/^vegan\s*:\s*/i, ''));
        return;
      }
      if (current) menu[current].push(text);
    },
  );

  $('.sosyal-bina table tr').each((_, tr) => {
    const cells = $(tr).find('td');
    if (cells.length < 2) return;
    const name = cleanText(cells.eq(0).text(), 120);
    const kcal = Number(cleanText(cells.eq(1).text(), 10));
    if (name) menu.faculty_club.push({ name, kcal: Number.isFinite(kcal) && kcal > 0 ? kcal : null });
  });

  const notice = cleanText($('.alert').first().text(), 300).replace(/^NOT:\s*/i, '').replace(/×$/, '').trim();
  if (notice) menu.notes.push(notice);

  menu.breakfast = dedupe(menu.breakfast);
  menu.lunch = dedupe(menu.lunch);
  menu.dinner = dedupe(menu.dinner);
  menu.vegetarian = dedupe(menu.vegetarian);
  menu.vegan = dedupe(menu.vegan);
  return menu;
}

export function menuToText(menu: DayMenu): string {
  const lines: string[] = [];
  if (menu.breakfast.length) lines.push(`Breakfast: ${menu.breakfast.join(', ')}`);
  if (menu.lunch.length) lines.push(`Lunch: ${menu.lunch.join(', ')}`);
  if (menu.dinner.length) lines.push(`Dinner: ${menu.dinner.join(', ')}`);
  if (menu.vegetarian.length) lines.push(`Vegetarian: ${menu.vegetarian.join(', ')}`);
  if (menu.vegan.length) lines.push(`Vegan: ${menu.vegan.join(', ')}`);
  return lines.join('\n');
}

export async function collectDining(ctx: CollectorContext): Promise<void> {
  await runUnit(ctx, 'dining', async () => {
    const today = todayIstanbul(now());
    let stored = 0;
    for (let i = 0; i < DINING_DAYS_AHEAD; i++) {
      const date = addDaysIso(today, i);
      const url = diningUrl(date);
      const res = await politeFetch(ctx.db, url);
      const menu = parseDiningPage(res.body, date);
      if (!menu) {
        ctx.log(`[dining] page for ${date} showed another date; skipped`);
        continue;
      }
      upsertRecord(ctx.db, {
        id: `menu:${date}`,
        kind: 'menu',
        source: DINING_SOURCE,
        lang: 'tr',
        title: `Cafeteria menu ${date}`,
        body: menuToText(menu),
        url,
        data: menu,
        valid_for: date,
      });
      stored++;
    }
    if (stored === 0) throw new Error('no cafeteria menu page could be parsed');
    return stored;
  });
}
