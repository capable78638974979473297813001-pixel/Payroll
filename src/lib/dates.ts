/** Calendar-date helpers over ISO `YYYY-MM-DD` strings. All arithmetic is UTC, so no daylight-saving day is ever 23 or 25 hours long. */

export function isIsoDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

/** The first day of the workweek containing `iso`, for a workweek that starts on `startDay` (0 = Sunday). */
export function workweekStart(iso: string, startDay: number): string {
  const back = (dayOfWeek(iso) - startDay + 7) % 7;
  return addDays(iso, -back);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function quarterOf(iso: string): { year: number; quarter: 1 | 2 | 3 | 4 } {
  return { year: Number(iso.slice(0, 4)), quarter: (Math.floor((Number(iso.slice(5, 7)) - 1) / 3) + 1) as 1 | 2 | 3 | 4 };
}
