import type { Cents } from '../src/money.ts';
import { dollars } from '../src/money.ts';

/**
 * New Jersey Family Leave Insurance (FLI) — LIVE-VERIFIED against the
 * NJ Department of Labor's own 2026 rate announcement and
 * myleavebenefits.nj.gov's own FAQ, not assumed from trained memory:
 *  - https://www.nj.gov/labor/lwdhome/press/2025/20251229_newbenefitrates2026.shtml
 *  - https://www.nj.gov/labor/myleavebenefits/help/faq/fli.shtml
 * (both fetched 2026-09-14).
 *
 * SAME SCOPE BOUNDARY AS payroll/nyPfl.ts, for the exact same reason:
 * this project's own core tax engine already correctly computes the FLI
 * (and TDI) payroll WITHHOLDING — `data/states/NJ-2026.json`'s own
 * `statePaidLeaveEmployee` config shares NJ's $171,100 TDI/FLI wage base,
 * tracked via the ordinary annual-wage-base-cap branch of
 * `stateDisabilityEmployeeTax()`/`statePaidLeaveEmployeeTax()` in
 * `src/taxes/state.ts`. Reimplementing that withholding calculation here
 * would risk exactly the "two different, possibly divergent,
 * calculations of the same figure" failure mode payroll/cobra.ts's own
 * header warns against. This module adds only what the withholding
 * calculation has no reason to compute: eligibility and the wage-
 * replacement BENEFIT an employee actually receives while on leave.
 *
 * YEAR-SPECIFIC dollar constants, the same convention payroll/aca.ts and
 * payroll/nyPfl.ts already use — only the CURRENT (2026) figures are
 * modeled.
 */

/** NJ 2026 rate announcement: the maximum weekly FLI benefit. */
export const NJ_FLI_MAX_WEEKLY_BENEFIT_2026: Cents = dollars(1_119);

/** myleavebenefits.nj.gov: the fraction of an employee's own average weekly wage FLI replaces. */
export const NJ_FLI_WAGE_REPLACEMENT_RATE = 0.85;

/** myleavebenefits.nj.gov: the maximum weeks of benefits for ONE CONTINUOUS period of leave within a 12-month period. */
export const NJ_FLI_MAX_CONTINUOUS_LEAVE_WEEKS = 12;

/** myleavebenefits.nj.gov: the maximum individual days of benefits (8 weeks' worth) for INTERMITTENT leave within a 12-month period — a separate cap from the continuous-leave one, not additional to it. */
export const NJ_FLI_MAX_INTERMITTENT_LEAVE_DAYS = 56;

/** NJ 2026 rate announcement: one eligibility path — this many "base weeks" earning at least the per-week threshold below. */
export const NJ_FLI_MIN_BASE_WEEKS = 20;

/** NJ 2026 rate announcement: the minimum weekly earnings for a week to count as a qualifying "base week." */
export const NJ_FLI_MIN_WEEKLY_EARNINGS_2026: Cents = dollars(310);

/** NJ 2026 rate announcement: the OTHER eligibility path — total earnings during the base year, regardless of how many individual weeks met the per-week threshold above. */
export const NJ_FLI_MIN_BASE_YEAR_EARNINGS_2026: Cents = dollars(15_500);

/** The "base weeks" eligibility path: enough qualifying weeks, each earning at least the per-week minimum. */
export function isNjFliEligibleByBaseWeeks(baseWeeksWorked: number, weeklyEarningsCents: Cents): boolean {
  return baseWeeksWorked >= NJ_FLI_MIN_BASE_WEEKS && weeklyEarningsCents >= NJ_FLI_MIN_WEEKLY_EARNINGS_2026;
}

/** The alternate "total base-year earnings" eligibility path — independent of how earnings were distributed across weeks. */
export function isNjFliEligibleByAnnualEarnings(baseYearEarningsCents: Cents): boolean {
  return baseYearEarningsCents >= NJ_FLI_MIN_BASE_YEAR_EARNINGS_2026;
}

export function isNjFliEligible(baseWeeksWorked: number, weeklyEarningsCents: Cents, baseYearEarningsCents: Cents): boolean {
  return isNjFliEligibleByBaseWeeks(baseWeeksWorked, weeklyEarningsCents) || isNjFliEligibleByAnnualEarnings(baseYearEarningsCents);
}

/** 85% of the employee's own average weekly wage, capped at the 2026 maximum weekly benefit regardless of how much higher their own wage is. */
export function njFliWeeklyBenefit(averageWeeklyWageCents: Cents): Cents {
  return Math.min(Math.round(averageWeeklyWageCents * NJ_FLI_WAGE_REPLACEMENT_RATE), NJ_FLI_MAX_WEEKLY_BENEFIT_2026);
}

export function njFliRemainingContinuousWeeks(weeksAlreadyUsed: number): number {
  return Math.max(0, NJ_FLI_MAX_CONTINUOUS_LEAVE_WEEKS - weeksAlreadyUsed);
}

export function njFliRemainingIntermittentDays(daysAlreadyUsed: number): number {
  return Math.max(0, NJ_FLI_MAX_INTERMITTENT_LEAVE_DAYS - daysAlreadyUsed);
}
