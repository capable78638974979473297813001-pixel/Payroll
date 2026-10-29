import type { Cents } from '../src/money.ts';
import type { Earning } from '../src/types.ts';

/**
 * Turns raw clock punches into the classified regular/overtime/double-time
 * hours payroll/engine.ts prices into a paycheck — the layer between "an
 * employee clocked in and out" and the flat regularHours/overtimeHours a
 * TimeEntry expects.
 *
 * SCOPE: this models the overtime shapes this project could verify against a
 * primary source — the plain federal weekly-40-hour test (FLSA, every state
 * with no daily rule of its own), California's daily 8/12-hour and
 * 7th-consecutive-day rules (Cal. Labor Code § 510), Alaska's 8-hour day
 * (AS 23.10.060), and Colorado's 12-hour day (COMPS Order). Each state rule
 * is UNCONDITIONAL here, but two of them carry a real-world condition this
 * stateless lookup cannot see, left to the caller:
 *   - Alaska's daily rule EXEMPTS employers with fewer than four employees in
 *     the week; a caller running a three-person shop should pass the federal
 *     rule instead.
 *   - Colorado's rule is actually "the greatest of 12 hours worked, 12
 *     CONSECUTIVE hours, or 40/week" — the consecutive-hours span (which can
 *     cross an unpaid break) needs punch times this hours-only model doesn't
 *     carry, so only the 12-hours-worked and weekly tests are applied.
 * NEVADA is deliberately left on the federal rule: its daily-8 rule reaches
 * only employees earning under 1.5x the state minimum wage, which no
 * prevailing-wage tradesworker does, so the weekly test is the correct one
 * for this project's callers. Other states' variants remain unmodelled — the
 * same "disclosed, not force-fit" choice this project makes everywhere it
 * hasn't done the legal research yet (see README.md's own Known gaps).
 * `overtimeRuleForState()` falls back to the federal rule for every state it
 * doesn't have an explicit rule for, which is the correct floor (no state's
 * overtime law is EVER less protective than FLSA) even where it understates a
 * state's own stricter daily rule.
 */

export interface TimePunch {
  employeeId: string;
  /** ISO datetime, e.g. '2026-01-05T09:03:00'. Local to the workplace — this module does no timezone conversion, the same "the caller resolves it" convention payroll/schedule.ts uses for check dates. */
  timestamp: string;
  type: 'clock_in' | 'clock_out';
}

export interface DailyHours {
  /** The work date these hours are attributed to — the calendar date of the CLOCK-IN punch, even if a shift runs past midnight. */
  date: string;
  hoursWorked: number;
}

/**
 * Pairs one employee's punches (already filtered to one employee, any
 * order) into daily worked hours. Punches must alternate starting with
 * clock_in for a given day — an odd count (a missing clock-out) throws
 * rather than guessing when the shift ended, the same "an ambiguous
 * input is an error, not a silent default" discipline the tax engine
 * itself uses for a missing eligibility fact.
 *
 * Unpaid breaks need no separate punch type: clocking out for lunch and
 * back in again already excludes that interval, since only time BETWEEN
 * a clock_in and its matching clock_out is counted.
 */
export function pairPunchesIntoDailyHours(punches: readonly TimePunch[]): DailyHours[] {
  const byDate = new Map<string, TimePunch[]>();
  for (const p of [...punches].sort((a, b) => a.timestamp.localeCompare(b.timestamp))) {
    const date = p.timestamp.slice(0, 10);
    const list = byDate.get(date) ?? [];
    list.push(p);
    byDate.set(date, list);
  }

  const result: DailyHours[] = [];
  for (const [date, dayPunches] of byDate) {
    if (dayPunches.length % 2 !== 0) {
      throw new Error(`Unpaired punch on ${date}: an odd number of clock_in/clock_out events (a missing clock-out, most likely)`);
    }
    let hoursWorked = 0;
    for (let i = 0; i < dayPunches.length; i += 2) {
      const inPunch = dayPunches[i];
      const outPunch = dayPunches[i + 1];
      if (inPunch.type !== 'clock_in' || outPunch.type !== 'clock_out') {
        throw new Error(`Punches on ${date} are not a clean clock_in/clock_out alternation`);
      }
      const ms = Date.parse(outPunch.timestamp) - Date.parse(inPunch.timestamp);
      if (ms < 0) throw new Error(`clock_out before its clock_in on ${date}`);
      hoursWorked += ms / 3_600_000;
    }
    result.push({ date, hoursWorked });
  }
  return result.sort((a, b) => a.date.localeCompare(b.date));
}

export interface OvertimeRule {
  weeklyThresholdHours: number;
  /** Hours per DAY beyond which pay steps up to 1.5x — absent means this jurisdiction has no daily rule at all (the federal/most-states case). */
  dailyOvertimeThresholdHours?: number;
  /** Hours per DAY beyond which pay steps up again to 2x. Only meaningful alongside dailyOvertimeThresholdHours. */
  dailyDoubleTimeThresholdHours?: number;
  /** California's own rule: the 7th consecutive day worked in one workweek is paid at 1.5x for its first 8 hours and 2x beyond that, regardless of the ordinary daily split that would otherwise apply to that day. */
  seventhConsecutiveDayRule?: boolean;
}

/** FLSA's own floor: overtime only after 40 hours in a workweek, at 1.5x, no daily concept at all. Every state's overtime law is at least this protective. */
export const FEDERAL_OVERTIME_RULE: OvertimeRule = { weeklyThresholdHours: 40 };

/** Cal. Labor Code § 510: overtime after 8 hours/day OR 40 hours/week (whichever is more, per day resolved below), double time after 12 hours/day, and the 7th-consecutive-day premium. */
export const CALIFORNIA_OVERTIME_RULE: OvertimeRule = {
  weeklyThresholdHours: 40,
  dailyOvertimeThresholdHours: 8,
  dailyDoubleTimeThresholdHours: 12,
  seventhConsecutiveDayRule: true,
};

/** AS 23.10.060: overtime after 8 hours/day or 40 hours/week, at 1.5x, no double time. EXEMPTS employers with fewer than four employees in the week — a condition this stateless rule can't see (see the header). */
export const ALASKA_OVERTIME_RULE: OvertimeRule = {
  weeklyThresholdHours: 40,
  dailyOvertimeThresholdHours: 8,
};

/** Colorado COMPS Order: overtime after 12 hours/day (or 40/week), at 1.5x, no double time. The order's third prong — 12 CONSECUTIVE hours — needs punch spans this hours-only model lacks, so only the 12-worked and weekly tests apply (see the header). */
export const COLORADO_OVERTIME_RULE: OvertimeRule = {
  weeklyThresholdHours: 40,
  dailyOvertimeThresholdHours: 12,
};

const STATE_OVERTIME_RULES: Readonly<Record<string, OvertimeRule>> = {
  CA: CALIFORNIA_OVERTIME_RULE,
  AK: ALASKA_OVERTIME_RULE,
  CO: COLORADO_OVERTIME_RULE,
};

export function overtimeRuleForState(stateCode: string): OvertimeRule {
  return STATE_OVERTIME_RULES[stateCode] ?? FEDERAL_OVERTIME_RULE;
}

export interface WeeklyHoursClassification {
  regularHours: number;
  overtimeHours: number;
  doubleTimeHours: number;
}

/** One day's hours split by the DAILY thresholds alone, ignoring the weekly test entirely — the weekly test is layered on afterward in classifyWeeklyHours(), which is why this stays a private helper. */
function splitByDailyThresholds(hoursWorked: number, rule: OvertimeRule): WeeklyHoursClassification {
  if (rule.dailyOvertimeThresholdHours === undefined) {
    return { regularHours: hoursWorked, overtimeHours: 0, doubleTimeHours: 0 };
  }
  const regular = Math.min(hoursWorked, rule.dailyOvertimeThresholdHours);
  const aboveRegular = Math.max(0, hoursWorked - rule.dailyOvertimeThresholdHours);
  const doubleTimeThreshold = rule.dailyDoubleTimeThresholdHours;
  if (doubleTimeThreshold === undefined || hoursWorked <= doubleTimeThreshold) {
    return { regularHours: regular, overtimeHours: aboveRegular, doubleTimeHours: 0 };
  }
  const overtime = doubleTimeThreshold - rule.dailyOvertimeThresholdHours;
  const doubleTime = hoursWorked - doubleTimeThreshold;
  return { regularHours: regular, overtimeHours: overtime, doubleTimeHours: doubleTime };
}

/**
 * Classifies one employee's ONE-WORKWEEK worth of daily hours (7 days,
 * however many were actually worked) into regular/overtime/double-time,
 * applying whichever thresholds `rule` defines.
 *
 * The interaction between a DAILY rule and the WEEKLY 40-hour test is the
 * part naive implementations get wrong: hours already paid at a daily
 * premium are not also recounted toward the weekly-40 test (that would tax
 * the same hour twice into overtime) — only each day's own "regular"
 * portion feeds the weekly total, and it's THAT total which gets capped at
 * 40, with the excess reclassified up to overtime. Under the federal rule
 * (no daily thresholds at all), every hour is "regular" until the weekly
 * total itself crosses 40, which collapses to the plain FLSA test exactly.
 */
export function classifyWeeklyHours(days: readonly DailyHours[], rule: OvertimeRule): WeeklyHoursClassification {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const isSeventhConsecutiveDay = rule.seventhConsecutiveDayRule === true && sorted.length === 7;

  let regularPool = 0;
  let overtime = 0;
  let doubleTime = 0;

  sorted.forEach((day, index) => {
    if (isSeventhConsecutiveDay && index === sorted.length - 1) {
      // The 7th consecutive day itself: first 8 hours at 1.5x, the rest at
      // 2x — overrides the ordinary daily split for this one day only.
      overtime += Math.min(day.hoursWorked, 8);
      doubleTime += Math.max(0, day.hoursWorked - 8);
      return;
    }
    const split = splitByDailyThresholds(day.hoursWorked, rule);
    regularPool += split.regularHours;
    overtime += split.overtimeHours;
    doubleTime += split.doubleTimeHours;
  });

  const regularHours = Math.min(regularPool, rule.weeklyThresholdHours);
  const weeklyOverflow = Math.max(0, regularPool - rule.weeklyThresholdHours);

  return { regularHours, overtimeHours: overtime + weeklyOverflow, doubleTimeHours: doubleTime };
}

/** Turns a classified week into the Earning lines a paycheck needs — the same 1x/1.5x/2x pricing payroll/engine.ts applies to a caller-supplied TimeEntry, exposed here so a caller driving pay directly off punches never has to duplicate the multipliers. */
export function earningsFromWeeklyHours(hourlyRate: Cents, hours: WeeklyHoursClassification): Earning[] {
  const earnings: Earning[] = [{ code: 'REG', category: 'regular', amount: Math.round(hourlyRate * hours.regularHours) }];
  if (hours.overtimeHours > 0) {
    earnings.push({ code: 'OT', category: 'regular', amount: Math.round(hourlyRate * 1.5 * hours.overtimeHours) });
  }
  if (hours.doubleTimeHours > 0) {
    earnings.push({ code: 'DT', category: 'regular', amount: Math.round(hourlyRate * 2 * hours.doubleTimeHours) });
  }
  return earnings;
}
