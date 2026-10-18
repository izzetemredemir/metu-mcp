import { describe, expect, it } from 'vitest';
import { formatRange, parseDrupalTimestamp, parseTrDateRange } from '../../src/lib/trdate.js';

describe('parseTrDateRange', () => {
  it.each([
    ['28 TEMMUZ 2026', '2026-07-28', '2026-07-28', 'day'],
    ['18 - 31 AĞUSTOS 2026', '2026-08-18', '2026-08-31', 'day'],
    ['24 AĞUSTOS - 25 EYLÜL 2026', '2026-08-24', '2026-09-25', 'day'],
    ['30 KASIM - 06 ARALIK 2026', '2026-11-30', '2026-12-06', 'day'],
    ['09-10-11 EYLÜL 2026', '2026-09-09', '2026-09-11', 'day'],
    ['24 ve 25 EYLÜL 2026', '2026-09-24', '2026-09-25', 'day'],
    ['1 HAZİRAN- 12 TEMMUZ 2026', '2026-06-01', '2026-07-12', 'day'],
    ['28 Aralık - 3 Ocak 2027', '2026-12-28', '2027-01-03', 'day'],
    ['05 - 09 OCTOBER 2026', '2026-10-05', '2026-10-09', 'day'],
    ['+++ EYLÜL 2026', '2026-09-01', '2026-09-30', 'month'],
    ['* - * EKİM 2026', '2026-10-01', '2026-10-31', 'month'],
    ['% TEMMUZ 2027', '2027-07-01', '2027-07-31', 'month'],
  ])('%s', (raw, start, end, precision) => {
    expect(parseTrDateRange(raw)).toEqual({ start, end, precision });
  });

  it('rejects text without a month', () => {
    expect(parseTrDateRange('GÜZ DÖNEMİ')).toBeUndefined();
  });

  it('uses the fallback year when none is printed', () => {
    expect(parseTrDateRange('5 Ekim', 2026)).toEqual({ start: '2026-10-05', end: '2026-10-05', precision: 'day' });
  });
});

describe('formatting', () => {
  it('formats ranges in English', () => {
    expect(formatRange('2026-10-05', '2026-10-09')).toBe('Mon 5 October 2026 – Fri 9 October 2026');
    expect(formatRange('2026-10-01', '2026-10-31', 'month')).toBe('October 2026 (exact day not announced yet)');
    expect(formatRange('2026-10-05', '2026-10-09', 'day', 'tr')).toBe('5 Ekim 2026 Pazartesi – 9 Ekim 2026 Cuma');
  });

  it('parses Drupal "last updated" stamps as Istanbul time', () => {
    expect(parseDrupalTimestamp('11/07/2026 - 14:31')).toBe('2026-07-11T11:31:00.000Z');
    expect(parseDrupalTimestamp('31/02/2026')).toBeUndefined();
  });
});
