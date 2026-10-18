/** Folds Turkish text for accent-insensitive search: "Işık Şükrü" → "isik sukru". */
export function foldTr(input: string): string {
  return input
    .replace(/İ/g, 'i')
    .replace(/I/g, 'ı')
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
    .replace(/ş/g, 's')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .replace(/â/g, 'a')
    .replace(/î/g, 'i')
    .replace(/û/g, 'u')
    .normalize('NFD')
    .replace(/[\u0300-\u036F]/g, '');
}

/** Turns a user query into a safe FTS5 MATCH expression (prefix match per token, AND). */
export function toFtsQuery(query: string): string | undefined {
  const tokens = foldTr(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2)
    .slice(0, 12);
  if (tokens.length === 0) return undefined;
  return tokens.map((t) => `"${t}"*`).join(' ');
}

/** Simple token-overlap score in [0,1] for short in-memory lists. */
export function matchScore(haystack: string, query: string): number {
  const h = foldTr(haystack);
  const tokens = foldTr(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return 0;
  let score = 0;
  for (const t of tokens) {
    if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(t)}`, 'u').test(h)) score += 2;
    else if (h.includes(t)) score += 1;
  }
  return score / (tokens.length * 2);
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}
