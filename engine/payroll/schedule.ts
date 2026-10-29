import type { PayScheduleConfig } from './types.ts';

/**
 * Turns a company's pay schedule CONFIGURATION into actual calendar dates —
 * the periods a real payroll calendar shows an admin, one calendar year at
 * a time. Pure and deterministic: the same config always produces the same
 * calendar, so a payroll run's period dates never depend on when the code
 * happened to run.
 *
 * Check dates are plain calendar-day offsets from the period end, NOT
 * shifted off weekends or bank holidays — a company whose real calendar
 * always lands on a business day should pick a lag that already does
 * (a Friday period end with a 5-day lag lands on the following Wednesday,
 * for instance, not the following Friday). Modelling the actual Federal
 * Reserve holiday calendar is a real feature a production system needs and
 * this one does not attempt — see this module's own header note.
 */

export interface PayPeriod {
  periodStart: string; // ISO yyyy-mm-dd
  periodEnd: string; // ISO yyyy-mm-dd, inclusive
  checkDate: string; // ISO yyyy-mm-dd
}

function toUtcDays(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

function fromUtcDays(days: number): string {
  const date = new Date(days * 86_400_000);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function lastDayOfMonth(year: number, month1based: number): number {
  // Day 0 of the NEXT month is the last day of this one.
  return new Date(Date.UTC(year, month1based, 0)).getUTCDate();
}

/**
 * Weekly (stepDays 7) or biweekly (stepDays 14) periods, walked forward from
 * the schedule's own anchor rather than derived from a weekday name, so a
 * calendar can never drift out of the fixed cadence the anchor established
 * — see PayScheduleConfig.anchorPeriodStart's own doc comment.
 */
function fixedStepPeriods(anchorPeriodStart: string, stepDays: number, lagDays: number, year: number): PayPeriod[] {
  const anchor = toUtcDays(anchorPeriodStart);
  const jan1 = toUtcDays(`${year}-01-01`);
  const dec31 = toUtcDays(`${year}-12-31`);

  // Jump close to the target year instead of walking one period at a time
  // from a potentially distant anchor; the -2 buffer guarantees we start
  // at or before the first period whose CHECK date (not period start) could
  // fall in range once the lag is added, and the loop below trims any
  // extra periods this coarse jump overshoots on either side.
  const periodsSinceAnchor = Math.floor((jan1 - anchor) / stepDays) - 2;
  let start = anchor + Math.max(0, periodsSinceAnchor) * stepDays;

  const periods: PayPeriod[] = [];
  while (start <= dec31 + lagDays) {
    const end = start + stepDays - 1;
    const checkDate = end + lagDays;
    const checkYear = Number(fromUtcDays(checkDate).slice(0, 4));
    if (checkYear === year) {
      periods.push({ periodStart: fromUtcDays(start), periodEnd: fromUtcDays(end), checkDate: fromUtcDays(checkDate) });
    } else if (checkYear > year) {
      break;
    }
    start += stepDays;
  }
  return periods;
}

function semimonthlyPeriods(splitDays: [number, number], lagDays: number, year: number): PayPeriod[] {
  const [, secondStart] = splitDays;
  const periods: PayPeriod[] = [];
  for (let month = 1; month <= 12; month++) {
    const firstEnd = secondStart - 1;
    const monthLastDay = lastDayOfMonth(year, month);
    const mm = String(month).padStart(2, '0');
    const firstStart = toUtcDays(`${year}-${mm}-01`);
    const firstEndDay = toUtcDays(`${year}-${mm}-${String(firstEnd).padStart(2, '0')}`);
    const secondStartDay = toUtcDays(`${year}-${mm}-${String(secondStart).padStart(2, '0')}`);
    const secondEndDay = toUtcDays(`${year}-${mm}-${String(monthLastDay).padStart(2, '0')}`);
    periods.push({
      periodStart: fromUtcDays(firstStart),
      periodEnd: fromUtcDays(firstEndDay),
      checkDate: fromUtcDays(firstEndDay + lagDays),
    });
    periods.push({
      periodStart: fromUtcDays(secondStartDay),
      periodEnd: fromUtcDays(secondEndDay),
      checkDate: fromUtcDays(secondEndDay + lagDays),
    });
  }
  return periods;
}

function monthlyPeriods(lagDays: number, year: number): PayPeriod[] {
  const periods: PayPeriod[] = [];
  for (let month = 1; month <= 12; month++) {
    const mm = String(month).padStart(2, '0');
    const start = toUtcDays(`${year}-${mm}-01`);
    const end = toUtcDays(`${year}-${mm}-${String(lastDayOfMonth(year, month)).padStart(2, '0')}`);
    periods.push({ periodStart: fromUtcDays(start), periodEnd: fromUtcDays(end), checkDate: fromUtcDays(end + lagDays) });
  }
  return periods;
}

/** Every pay period whose CHECK DATE (not period end) falls within the given calendar year — what an admin picking "2026" from a calendar dropdown expects to see. */
export function generatePayPeriods(config: PayScheduleConfig, year: number): PayPeriod[] {
  switch (config.frequency) {
    case 'weekly':
    case 'biweekly': {
      if (!config.anchorPeriodStart) {
        throw new Error(`${config.frequency} schedule requires anchorPeriodStart`);
      }
      const stepDays = config.frequency === 'weekly' ? 7 : 14;
      return fixedStepPeriods(config.anchorPeriodStart, stepDays, config.checkDateLagDays, year);
    }
    case 'semimonthly':
      return semimonthlyPeriods(config.semimonthlySplitDays ?? [1, 16], config.checkDateLagDays, year);
    case 'monthly':
      return monthlyPeriods(config.checkDateLagDays, year);
  }
}

/** The single period a given check date falls in, or null if this schedule has none matching exactly — used to validate a manually-entered check date against the company's own calendar rather than trusting it blindly. */
export function periodForCheckDate(config: PayScheduleConfig, checkDate: string): PayPeriod | null {
  const year = Number(checkDate.slice(0, 4));
  // A check date near a year boundary can belong to a period generated
  // under the ADJACENT year's calendar (e.g. a January 2nd check date for
  // a period that started in late December) — check both.
  const candidates = [...generatePayPeriods(config, year - 1), ...generatePayPeriods(config, year), ...generatePayPeriods(config, year + 1)];
  return candidates.find((p) => p.checkDate === checkDate) ?? null;
}
