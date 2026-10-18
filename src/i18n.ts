import type { Lang } from './config.js';

/**
 * Server-generated text in both languages METU works in. Scraped content is never translated;
 * only labels, notes and warnings produced by this server go through `t()`.
 */
const MESSAGES = {
  source: { en: 'Source', tr: 'Kaynak' },
  last_checked: { en: 'last checked {at} (Istanbul time)', tr: 'son kontrol {at} (İstanbul saati)' },
  page_updated: { en: 'page last updated {at}', tr: 'sayfanın güncellenme tarihi {at}' },
  valid_for: { en: 'valid for: {v}', tr: 'geçerlilik: {v}' },
  never_fetched: {
    en: 'This source has not been fetched yet; check the official page directly: {url}',
    tr: 'Bu kaynak henüz taranmadı; bilgiyi doğrudan resmi sayfadan kontrol et: {url}',
  },
  unreachable: {
    en: 'The source has been unreachable since {at} ({n} failed attempts). This may be outdated; verify on the official page: {url}',
    tr: 'Kaynağa {at} tarihinden beri ulaşılamıyor ({n} başarısız deneme). Bilgi güncel olmayabilir; resmi sayfadan teyit et: {url}',
  },
  stale: {
    en: 'This information has not been re-verified for {age}; confirm on the official page: {url}',
    tr: 'Bu bilgi {age} doğrulanamadı; resmi sayfadan teyit et: {url}',
  },
  age_days: { en: '{n} day(s)', tr: '{n} gündür' },
  age_hours: { en: '{n} hour(s)', tr: '{n} saattir' },
  fallback_lang: {
    en: '(No English version is published for this; showing the Turkish original.)',
    tr: '(Bunun Türkçe sürümü yayımlanmıyor; İngilizce orijinali gösteriliyor.)',
  },
  see_also: { en: 'Official pages', tr: 'Resmi sayfalar' },
  login_required: { en: 'login required: {system}', tr: 'giriş gerekir: {system}' },
  no_results: { en: 'No matching results.', tr: 'Eşleşen sonuç yok.' },
  more_results: {
    en: '{n} more result(s); narrow the query or use offset={offset}.',
    tr: '{n} sonuç daha var; sorguyu daralt ya da offset={offset} kullan.',
  },
  published: { en: 'published', tr: 'yayın' },
  breakfast: { en: 'Breakfast', tr: 'Kahvaltı' },
  lunch: { en: 'Lunch', tr: 'Öğle yemeği' },
  dinner: { en: 'Dinner', tr: 'Akşam yemeği' },
  vegetarian: { en: 'Vegetarian option', tr: 'Vejetaryen seçenek' },
  vegan: { en: 'Vegan option', tr: 'Vegan seçenek' },
  faculty_club: { en: 'Faculty Club (à la carte, kcal)', tr: 'Faculty Club (alakart, kcal)' },
  no_menu: {
    en: 'No cafeteria menu is published for {date}.',
    tr: '{date} için yayımlanmış yemek listesi yok.',
  },
  menu_not_collected: {
    en: 'The menu for {date} has not been collected (menus are fetched up to 7 days ahead). Check {url}',
    tr: '{date} tarihli menü toplanmadı (menüler 7 gün öncesine kadar çekilir). Buradan bak: {url}',
  },
  dish_names_turkish: {
    en: 'Dish names are published in Turkish only.',
    tr: '',
  },
  yes: { en: 'Yes', tr: 'Evet' },
  no: { en: 'No', tr: 'Hayır' },
  signs_prevail: {
    en: 'On-site signs and parking attendants always take precedence over this summary.',
    tr: 'Yerindeki tabelalar ve görevli uyarıları her zaman bu özetten önce gelir.',
  },
} as const satisfies Record<string, Record<Lang, string>>;

export type MessageKey = keyof typeof MESSAGES;

export function t(lang: Lang, key: MessageKey, vars: Record<string, string | number> = {}): string {
  const template: string = MESSAGES[key][lang] ?? MESSAGES[key].en;
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
}
