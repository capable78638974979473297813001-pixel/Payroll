import { addDays } from '../lib/dates.ts';

/**
 * Overtime classification for one FLSA workweek, in whole minutes.
 *
 *   federal: time and a half after 40 hours in the workweek (29 U.S.C. § 207).
 *   california: Labor Code § 510. Over 8 hours in a day is overtime, over 12 is
 *     double time, and on the seventh consecutive day of the workweek the first
 *     8 hours are overtime and the rest double time. Hours already paid as daily
 *     overtime or double time do not count toward the 40-hour weekly threshold.
 *
 * Alaska, Nevada and Colorado add daily overtime rules Totali does not model
 * yet; they are named in DAILY_OVERTIME_NOT_MODELLED so the pay run can say so.
 */

export type OvertimeRule = 'federal' | 'california';

export const DAILY_OVERTIME_NOT_MODELLED: readonly string[] = ['AK', 'NV', 'CO'];

export function overtimeRuleFor(state: string): OvertimeRule {
  return state === 'CA' ? 'california' : 'federal';
}

export interface DayClass {
  date: string;
  regular: number;
  overtime: number;
  doubleTime: number;
}

const WEEK = 40 * 60;
const DAY = 8 * 60;
const DOUBLE = 12 * 60;

/** Classify each of the seven days of the workweek starting `weekStart`. `minutesByDate` holds minutes actually worked; absent days are zero. */
export function classifyWorkweek(weekStart: string, minutesByDate: ReadonlyMap<string, number>, rule: OvertimeRule): DayClass[] {
  const dates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const minutes = dates.map((d) => minutesByDate.get(d) ?? 0);
  const workedEveryDay = minutes.every((m) => m > 0);

  const out: DayClass[] = [];
  let regularSoFar = 0;
  let totalSoFar = 0;

  dates.forEach((date, i) => {
    const m = minutes[i];
    let regular: number;
    let overtime: number;
    let doubleTime: number;

    if (rule === 'california') {
      if (workedEveryDay && i === 6) {
        regular = 0;
        overtime = Math.min(m, DAY);
        doubleTime = Math.max(0, m - DAY);
      } else {
        regular = Math.min(m, DAY);
        overtime = Math.max(0, Math.min(m, DOUBLE) - DAY);
        doubleTime = Math.max(0, m - DOUBLE);
      }
      // Weekly: regular minutes past 40 hours become overtime.
      const converted = Math.min(regular, Math.max(0, regularSoFar + regular - WEEK));
      regular -= converted;
      overtime += converted;
      regularSoFar += regular;
    } else {
      const overBefore = Math.max(0, totalSoFar - WEEK);
      const overAfter = Math.max(0, totalSoFar + m - WEEK);
      overtime = overAfter - overBefore;
      regular = m - overtime;
      doubleTime = 0;
      totalSoFar += m;
    }
    out.push({ date, regular, overtime, doubleTime });
  });
  return out;
}
