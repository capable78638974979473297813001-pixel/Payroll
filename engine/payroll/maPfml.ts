import type { Cents } from '../src/money.ts';
import { dollars } from '../src/money.ts';

/**
 * Massachusetts Paid Family and Medical Leave (PFML, M.G.L. c. 175M) —
 * LIVE-VERIFIED against Massachusetts DFML's own 2026 figures
 * (corroborated across multiple independent employment-law/benefits-
 * broker sources describing the same tiered formula and figures, since
 * mass.gov itself returned 403 to direct fetches), not assumed from
 * trained memory. Fetched/cross-checked 2026-09-14.
 *
 * SAME SCOPE BOUNDARY AS payroll/nyPfl.ts and payroll/njFli.ts, for the
 * same reason: this project's own core tax engine already correctly
 * computes the PFML payroll WITHHOLDING — `data/states/MA-2026.json`'s
 * own extensively statute-confirmed config (M.G.L. c. 175M § 6: employers
 * may deduct at most 40% of the medical-leave contribution and up to
 * 100% of the family-leave contribution, family leave funded ENTIRELY by
 * the employee at every employer size — genuinely different from
 * Washington's PFML, where employer and employee split BOTH portions).
 * Reimplementing that withholding math here would risk the "two
 * different, possibly divergent, calculations of the same figure"
 * failure mode payroll/cobra.ts's own header warns against. This module
 * adds only the wage-replacement BENEFIT calculation, which the
 * withholding side has no reason to compute.
 *
 * A GENUINELY DIFFERENT BENEFIT FORMULA than NY's or NJ's flat-
 * percentage models: Massachusetts uses a TWO-TIER formula — the portion
 * of an employee's average weekly wage at or below 50% of the state
 * average weekly wage (MAAWW) is replaced at 80%; the portion ABOVE that
 * threshold is replaced at only 50% — both tiers computed and rounded
 * independently, then summed and capped at the maximum weekly benefit.
 * This is NOT a flat rate applied to the whole wage the way
 * `payroll/nyPfl.ts` (67% flat) and `payroll/njFli.ts` (85% flat) work.
 *
 * SCOPE: does not evaluate the "30 times the weekly benefit amount"
 * secondary earnings test as a single combined eligibility function —
 * `mgMeetsMinimumEarningsTest()` and `maMeetsThirtyTimesBenefitTest()`
 * are exposed separately since a caller needs the computed benefit
 * amount to evaluate the second test at all (a genuine sequencing
 * dependency, not an oversight). Does not track an actual leave request
 * end to end, the same category of gap payroll/fmla.ts's own header
 * discloses for FMLA leave requests.
 */

/** DFML 2026: the Massachusetts state average weekly wage (MAAWW), the figure the tiered benefit formula is built from. */
export const MA_PFML_STATE_AVERAGE_WEEKLY_WAGE_2026: Cents = dollars(1_922.48);

/** The wage-replacement rate for the portion of average weekly wage AT OR BELOW 50% of the MAAWW. */
export const MA_PFML_LOWER_TIER_REPLACEMENT_RATE = 0.8;

/** The wage-replacement rate for the portion of average weekly wage ABOVE 50% of the MAAWW. */
export const MA_PFML_UPPER_TIER_REPLACEMENT_RATE = 0.5;

/** DFML 2026: the maximum weekly benefit, whatever the two-tier formula alone would otherwise produce. */
export const MA_PFML_MAX_WEEKLY_BENEFIT_2026: Cents = dollars(1_230.39);

/** DFML 2026: the minimum total wages required across the four-quarter base period — the first of two independent eligibility tests. */
export const MA_PFML_MIN_BASE_PERIOD_EARNINGS_2026: Cents = dollars(6_300);

/** DFML: the second eligibility test — total base-period wages must exceed this many times the employee's own computed weekly benefit amount. */
export const MA_PFML_MIN_EARNINGS_BENEFIT_MULTIPLE = 30;

export const MA_PFML_FAMILY_LEAVE_MAX_WEEKS = 12;
export const MA_PFML_MEDICAL_LEAVE_MAX_WEEKS = 20;
export const MA_PFML_MILITARY_CAREGIVER_LEAVE_MAX_WEEKS = 26;

/** DFML: however many leave TYPES an employee draws on, combined leave in one benefit year never exceeds this many weeks. */
export const MA_PFML_COMBINED_MAX_WEEKS_PER_BENEFIT_YEAR = 26;

/** 50% of the MAAWW — the dividing line between the two wage-replacement tiers. */
export function maPfmlTierThreshold(): Cents {
  return Math.round(MA_PFML_STATE_AVERAGE_WEEKLY_WAGE_2026 * 0.5);
}

/**
 * The two-tier weekly benefit: 80% of whatever average weekly wage falls
 * at or below the tier threshold, plus 50% of whatever falls above it —
 * each tier rounded independently before summing, then the total capped
 * at the maximum weekly benefit.
 */
export function maPfmlWeeklyBenefit(averageWeeklyWageCents: Cents): Cents {
  const threshold = maPfmlTierThreshold();
  const lowerPortion = Math.min(averageWeeklyWageCents, threshold);
  const upperPortion = Math.max(0, averageWeeklyWageCents - threshold);
  const raw = Math.round(lowerPortion * MA_PFML_LOWER_TIER_REPLACEMENT_RATE) + Math.round(upperPortion * MA_PFML_UPPER_TIER_REPLACEMENT_RATE);
  return Math.min(raw, MA_PFML_MAX_WEEKLY_BENEFIT_2026);
}

export function maMeetsMinimumEarningsTest(basePeriodEarningsCents: Cents): boolean {
  return basePeriodEarningsCents >= MA_PFML_MIN_BASE_PERIOD_EARNINGS_2026;
}

/** The second, independent eligibility test — requires the employee's OWN computed weekly benefit amount, since the threshold scales with it. */
export function maMeetsThirtyTimesBenefitTest(basePeriodEarningsCents: Cents, weeklyBenefitCents: Cents): boolean {
  return basePeriodEarningsCents > MA_PFML_MIN_EARNINGS_BENEFIT_MULTIPLE * weeklyBenefitCents;
}

export function isMaPfmlEligible(basePeriodEarningsCents: Cents, weeklyBenefitCents: Cents): boolean {
  return maMeetsMinimumEarningsTest(basePeriodEarningsCents) && maMeetsThirtyTimesBenefitTest(basePeriodEarningsCents, weeklyBenefitCents);
}
