import { addDays, dayOfWeek } from './dates.ts';

/**
 * Banking days: Monday to Friday, excluding Federal Reserve holidays. ACH
 * settles on banking days, so every date Totali promises a bank or an
 * employee is computed here.
 *
 * Federal Reserve rule (federalreserve.gov, "Holidays Observed" K.8): a
 * holiday on a Sunday is observed the following Monday. A holiday on a
 * Saturday is NOT moved to the Friday: Reserve Banks are open that Friday.
 * (Federal agencies move Saturday holidays to Friday; banks do not.)
 */

function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const day = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function lastWeekday(year: number, month: number, weekday: number): string {
  const last = new Date(Date.UTC(year, month, 0));
  const back = (last.getUTCDay() - weekday + 7) % 7;
  return `${year}-${String(month).padStart(2, '0')}-${String(last.getUTCDate() - back).padStart(2, '0')}`;
}

const fixed = (year: number, month: number, day: number) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

/** A fixed-date holiday as the Fed observes it: Sunday becomes Monday, Saturday stays closed-to-nobody (null). */
function observed(iso: string): string | null {
  const dow = dayOfWeek(iso);
  if (dow === 6) return null;
  return dow === 0 ? addDays(iso, 1) : iso;
}

const cache = new Map<number, Set<string>>();

export function federalReserveHolidays(year: number): Set<string> {
  const hit = cache.get(year);
  if (hit) return hit;
  const out = new Set<string>();
  for (const iso of [
    fixed(year, 1, 1), // New Year's Day
    fixed(year, 6, 19), // Juneteenth
    fixed(year, 7, 4), // Independence Day
    fixed(year, 11, 11), // Veterans Day
    fixed(year, 12, 25), // Christmas Day
  ]) {
    const o = observed(iso);
    if (o) out.add(o);
  }
  out.add(nthWeekday(year, 1, 1, 3)); // Martin Luther King Jr. Day
  out.add(nthWeekday(year, 2, 1, 3)); // Washington's Birthday
  out.add(lastWeekday(year, 5, 1)); // Memorial Day
  out.add(nthWeekday(year, 9, 1, 1)); // Labor Day
  out.add(nthWeekday(year, 10, 1, 2)); // Columbus Day
  out.add(nthWeekday(year, 11, 4, 4)); // Thanksgiving
  cache.set(year, out);
  return out;
}

export function isBankingDay(iso: string): boolean {
  const dow = dayOfWeek(iso);
  if (dow === 0 || dow === 6) return false;
  const year = Number(iso.slice(0, 4));
  // A Sunday-Jan-1 style holiday observed on Jan 2 is in the same year; a Dec 31 Monday observance of a Jan 1 Sunday cannot occur.
  return !federalReserveHolidays(year).has(iso);
}

/** The first banking day on or after `iso`. */
export function onOrAfterBankingDay(iso: string): string {
  let d = iso;
  while (!isBankingDay(d)) d = addDays(d, 1);
  return d;
}

/** The last banking day on or before `iso`. */
export function onOrBeforeBankingDay(iso: string): string {
  let d = iso;
  while (!isBankingDay(d)) d = addDays(d, -1);
  return d;
}

/** `n` banking days after `iso` (n may be 0 or negative). The start date itself need not be a banking day. */
export function addBankingDays(iso: string, n: number): string {
  let d = iso;
  const step = n < 0 ? -1 : 1;
  for (let left = Math.abs(n); left > 0; ) {
    d = addDays(d, step);
    if (isBankingDay(d)) left -= 1;
  }
  return d;
}

/** Banking days strictly after `from` up to and including `to`. */
export function bankingDaysBetween(from: string, to: string): number {
  let n = 0;
  for (let d = addDays(from, 1); d <= to; d = addDays(d, 1)) if (isBankingDay(d)) n += 1;
  return n;
}
