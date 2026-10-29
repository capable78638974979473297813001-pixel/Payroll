import { addDays } from '../lib/dates.ts';

/**
 * Overtime classification for one FLSA workweek, in whole minutes.
 *
 * Rules (each read from its statute or regulation on 2026-10-29):
 *
 *   federal   Time and a half after 40 hours in the workweek (29 U.S.C. § 207).
 *
 *   california  Labor Code § 510 (DIR "Overtime" FAQ). Over 8 hours in a day is
 *     time and a half; over 12 is double time. On the seventh consecutive day of
 *     the workweek the first 8 hours are time and a half and the rest double
 *     time. Hours already paid as daily overtime or double time do not count
 *     toward the 40-hour weekly threshold (CalChamber's reading of the DLSE
 *     manual; the DIR FAQ itself is silent on this point).
 *
 *   alaska  AS 23.10.060: time and a half over 8 hours in a day and over 40 in a
 *     week. Hours paid as daily overtime are not counted again toward the 40.
 *     Employers with fewer than four employees are exempt (not checked here).
 *
 *   nevada  NRS 608.018: for an employee paid less than 1.5 times the minimum
 *     wage, time and a half over 8 hours in a workday as well as over 40 in the
 *     week; at or above 1.5 times the minimum, over 40 in the week only. A
 *     workday is 24 hours from when the employee starts work; this uses the
 *     calendar day the shift began. A mutually agreed four-ten schedule removes
 *     the daily rule; that agreement is not modelled.
 *
 *   colorado  COMPS Order Rule 4.1: time and a half over 40 in the workweek, over
 *     12 in the workday, or over 12 consecutive hours, whichever calculation
 *     pays more. The consecutive-hours test across split shifts is not modelled;
 *     the weekly and daily tests are.
 */

export type OvertimeRule = 'federal' | 'california' | 'alaska' | 'nevada' | 'colorado';

export function overtimeRuleFor(state: string): OvertimeRule {
  switch (state) {
    case 'CA':
      return 'california';
    case 'AK':
      return 'alaska';
    case 'NV':
      return 'nevada';
    case 'CO':
      return 'colorado';
    default:
      return 'federal';
  }
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

export interface ClassifyOptions {
  /** Nevada only: the daily rule applies to this employee (paid under 1.5 times the minimum wage). */
  nevadaDailyApplies?: boolean;
}

/** Classify each of the seven days of the workweek starting `weekStart`. `minutesByDate` holds minutes actually worked; absent days are zero. */
export function classifyWorkweek(weekStart: string, minutesByDate: ReadonlyMap<string, number>, rule: OvertimeRule, opts: ClassifyOptions = {}): DayClass[] {
  const dates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const minutes = dates.map((d) => minutesByDate.get(d) ?? 0);

  const federalWeekly = (): DayClass[] => {
    let total = 0;
    return dates.map((date, i) => {
      const m = minutes[i];
      const overtime = Math.max(0, total + m - WEEK) - Math.max(0, total - WEEK);
      total += m;
      return { date, regular: m - overtime, overtime, doubleTime: 0 };
    });
  };

  /** Daily threshold(s) first, then regular minutes past 40 hours in the week become overtime. */
  const dailyThenWeekly = (opts2: { dailyOt: number; dailyDt?: number; seventhDay?: boolean }): DayClass[] => {
    const workedEveryDay = minutes.every((m) => m > 0);
    let regularSoFar = 0;
    return dates.map((date, i) => {
      const m = minutes[i];
      let regular: number;
      let overtime: number;
      let doubleTime = 0;
      if (opts2.seventhDay && workedEveryDay && i === 6) {
        regular = 0;
        overtime = Math.min(m, DAY);
        doubleTime = Math.max(0, m - DAY);
      } else {
        regular = Math.min(m, opts2.dailyOt);
        const otCeiling = opts2.dailyDt ?? Infinity;
        overtime = Math.max(0, Math.min(m, otCeiling) - opts2.dailyOt);
        doubleTime = opts2.dailyDt === undefined ? 0 : Math.max(0, m - opts2.dailyDt);
      }
      const converted = Math.min(regular, Math.max(0, regularSoFar + regular - WEEK));
      regular -= converted;
      overtime += converted;
      regularSoFar += regular;
      return { date, regular, overtime, doubleTime };
    });
  };

  switch (rule) {
    case 'federal':
      return federalWeekly();
    case 'california':
      return dailyThenWeekly({ dailyOt: DAY, dailyDt: DOUBLE, seventhDay: true });
    case 'alaska':
      return dailyThenWeekly({ dailyOt: DAY });
    case 'nevada':
      return opts.nevadaDailyApplies ? dailyThenWeekly({ dailyOt: DAY }) : federalWeekly();
    case 'colorado': {
      const weekly = federalWeekly();
      const daily = minutes.map((m, i) => ({ date: dates[i], regular: Math.min(m, DOUBLE), overtime: Math.max(0, m - DOUBLE), doubleTime: 0 }));
      const sumOt = (d: DayClass[]) => d.reduce((a, x) => a + x.overtime, 0);
      return sumOt(daily) > sumOt(weekly) ? daily : weekly;
    }
  }
}
