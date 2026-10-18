import { TZDate } from '@date-fns/tz';
import { TIMEZONE } from '../config.js';

/** Single clock source (tests use fake timers). */
export function now(): Date {
  return new Date();
}

export interface IstanbulClock {
  /** YYYY-MM-DD */
  date: string;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
  hour: number;
  minute: number;
  /** minutes since midnight */
  minutes: number;
}

export function istanbulClock(at: Date = now()): IstanbulClock {
  const t = new TZDate(at.getTime(), TIMEZONE);
  const y = t.getFullYear();
  const m = String(t.getMonth() + 1).padStart(2, '0');
  const d = String(t.getDate()).padStart(2, '0');
  return {
    date: `${y}-${m}-${d}`,
    weekday: t.getDay(),
    hour: t.getHours(),
    minute: t.getMinutes(),
    minutes: t.getHours() * 60 + t.getMinutes(),
  };
}

export function todayIstanbul(at: Date = now()): string {
  return istanbulClock(at).date;
}

/** Adds days to an ISO date (YYYY-MM-DD). */
export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** Formats a timestamp as "2026-09-30 14:05" in Istanbul time. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return 'unknown';
  const t = new TZDate(new Date(iso).getTime(), TIMEZONE);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
}

export function formatDateOnly(iso: string | null | undefined): string {
  return iso ? formatDateTime(iso).slice(0, 10) : 'unknown';
}

/** "HH:MM" or "HH.MM" → minutes since midnight. */
export function parseHm(s: string): number | undefined {
  const m = /^(\d{1,2})[.:](\d{2})$/.exec(s.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 24 || mi > 59) return undefined;
  return h * 60 + mi;
}

export function formatHm(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
