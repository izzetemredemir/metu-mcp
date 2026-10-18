import * as XLSX from 'xlsx';
import { cleanText } from '../lib/sanitize.js';

/** Cells that only mark a feature in a yes/no matrix ("•", "."): dropped, the file link carries the matrix. */
const MARK = /^[•·.\-x✓✔]$/i;

/**
 * Renders a spreadsheet (.xls/.xlsx) as plain text for page records: title rows first, then one line per data row with
 * each value labelled by its column header ("Aylık Ücret ( ₺ ): 3615"). A row with a single value is a section heading
 * and starts a new paragraph, so `matchingParagraphs` returns a whole section for a query.
 */
export function spreadsheetText(bytes: Uint8Array, maxChars = 30000): string {
  const wb = XLSX.read(bytes, { type: 'array' });
  const blocks: string[] = [];
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils
      .sheet_to_json<unknown[]>(wb.Sheets[name]!, { header: 1, raw: true, defval: '', blankrows: false })
      .map((r) => r.map((c) => cleanText(String(c ?? ''), 300)));
    // The header is the first row (of the first five) with at least three labels.
    const h = rows.slice(0, 5).findIndex((r) => r.filter((c) => c && !MARK.test(c)).length >= 3);
    const header = h >= 0 ? rows[h]! : [];
    const lines: string[] = [];
    rows.forEach((row, i) => {
      if (i === h) return;
      const cells = row.map((c, col) => ({ c, col })).filter(({ c }) => c && !MARK.test(c));
      if (cells.length === 0) return;
      if (i < h || cells.length === 1) {
        lines.push('', cells.map(({ c }) => c).join(' '));
        return;
      }
      const [first, ...rest] = cells;
      lines.push([first!.c, ...rest.map(({ c, col }) => (header[col] ? `${header[col]}: ${c}` : c))].join(' | '));
    });
    blocks.push(lines.join('\n').trim());
  }
  return blocks.filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n').slice(0, maxChars);
}
