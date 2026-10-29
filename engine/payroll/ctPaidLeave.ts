import type { Cents } from '../src/money.ts';
import { dollars } from '../src/money.ts';

/**
 * Connecticut Paid Leave (CTPL, Conn. Gen. Stat. § 31-49e et seq.) —
 * LIVE-VERIFIED for benefits payable in 2026, corroborated across
 * multiple independent sources both for the benefit formula itself and,
 * separately, for the $16.94/hour Connecticut minimum wage effective
 * January 1, 2026 that the formula's own threshold and cap are pegged
 * to (Gov. Lamont's own announcement, cross-checked against employment-
 * law coverage of the same increase), not assumed from trained memory.
 * Fetched/cross-checked 2026-09-14.
 *
 * SAME SCOPE BOUNDARY AS `payroll/nyPfl.ts`, `payroll/njFli.ts`,
 * `payroll/maPfml.ts`, `payroll/waPfml.ts`, `payroll/coFamli.ts`, and
 * `payroll/orPaidLeave.ts`, for the same reason: this project's own core
 * tax engine already correctly computes CTPL's payroll WITHHOLDING via
 * `data/states/CT-2026.json`'s own `statePaidLeaveEmployee` config.
 * Reimplementing that withholding math here would risk the "two
 * different, possibly divergent, calculations of the same figure"
 * failure mode `payroll/cobra.ts`'s own header warns against. This module
 * adds only the wage-replacement BENEFIT calculation and the eligibility
 * tests.
 *
 * THE ONLY SIBLING FORMULA PEGGED TO THE STATE MINIMUM WAGE RATHER THAN A
 * STATE AVERAGE WEEKLY WAGE: the tier threshold is 40x the Connecticut
 * minimum wage ($677.60 in 2026) and the maximum weekly benefit is 60x
 * the same minimum wage ($1,016.40) — both figures rise automatically
 * whenever the minimum wage itself rises, unlike every other sibling
 * module's own SAWW-derived figures, which are separately republished
 * each benefit year. Below the threshold, wages are replaced at 95% (not
 * 90%, 80%, 100%, or a flat rate — a fifth distinct lower-tier rate among
 * this project's six state PFL modules); above it, 60% of the excess.
 *
 * ELIGIBILITY IS TWO INDEPENDENT TESTS, not one: (1) at least $2,325 in
 * the SINGLE highest-earning quarter of the base period (not total
 * base-period earnings, the test every sibling module in this project
 * uses instead — CTPL is the only one pegged to one quarter alone), and
 * (2) currently employed, or separated from employment within the past
 * 12 weeks. Both are exposed separately since a caller may know one fact
 * without the other.
 *
 * SCOPE: does not model the average-weekly-wage calculation itself
 * (highest two quarters of the base period, summed and divided by 26,
 * then rounded down to the next whole dollar) — this module takes a
 * caller-supplied average weekly wage as given, the same caller-
 * supplies-the-wage-history boundary every sibling PFML module in this
 * project draws. Does not track an actual leave request end to end, the
 * same category of gap `payroll/fmla.ts`'s own header discloses.
 */

/** Connecticut minimum wage effective January 1, 2026, the figure CTPL's own threshold and cap are pegged to. */
export const CT_PAID_LEAVE_MINIMUM_WAGE_2026: Cents = dollars(16.94);

/** The tier threshold is this many multiples of the Connecticut minimum wage. */
export const CT_PAID_LEAVE_THRESHOLD_MINIMUM_WAGE_MULTIPLE = 40;

/** The maximum weekly benefit is this many multiples of the Connecticut minimum wage. */
export const CT_PAID_LEAVE_MAX_BENEFIT_MINIMUM_WAGE_MULTIPLE = 60;

/** The wage-replacement rate for the portion of average weekly wage AT OR BELOW the tier threshold. */
export const CT_PAID_LEAVE_LOWER_TIER_REPLACEMENT_RATE = 0.95;

/** The wage-replacement rate for the portion of average weekly wage ABOVE the tier threshold. */
export const CT_PAID_LEAVE_UPPER_TIER_REPLACEMENT_RATE = 0.6;

/** The minimum earnings required in the SINGLE highest-earning quarter of the base period — the first of two independent eligibility tests. */
export const CT_PAID_LEAVE_MIN_HIGHEST_QUARTER_EARNINGS: Cents = dollars(2_325);

/** The second, independent eligibility test: how recently employment must have ended, if it has, for someone no longer currently employed. */
export const CT_PAID_LEAVE_MAX_WEEKS_SINCE_SEPARATION = 12;

/** 40x the Connecticut minimum wage — the dividing line between the two wage-replacement tiers. */
export function ctPaidLeaveTierThreshold(): Cents {
  return CT_PAID_LEAVE_THRESHOLD_MINIMUM_WAGE_MULTIPLE * CT_PAID_LEAVE_MINIMUM_WAGE_2026;
}

/** 60x the Connecticut minimum wage — the maximum weekly benefit, whatever the formula alone would otherwise produce. */
export function ctPaidLeaveMaxWeeklyBenefit(): Cents {
  return CT_PAID_LEAVE_MAX_BENEFIT_MINIMUM_WAGE_MULTIPLE * CT_PAID_LEAVE_MINIMUM_WAGE_2026;
}

/**
 * The weekly benefit: 95% of average weekly wage at or below the tier
 * threshold; above it, 95% of the threshold itself plus 60% of the
 * excess — capped at the maximum weekly benefit.
 */
export function ctPaidLeaveWeeklyBenefit(averageWeeklyWageCents: Cents): Cents {
  const threshold = ctPaidLeaveTierThreshold();
  const raw =
    averageWeeklyWageCents <= threshold
      ? Math.round(averageWeeklyWageCents * CT_PAID_LEAVE_LOWER_TIER_REPLACEMENT_RATE)
      : Math.round(threshold * CT_PAID_LEAVE_LOWER_TIER_REPLACEMENT_RATE) +
        Math.round((averageWeeklyWageCents - threshold) * CT_PAID_LEAVE_UPPER_TIER_REPLACEMENT_RATE);
  return Math.min(raw, ctPaidLeaveMaxWeeklyBenefit());
}

/** The first eligibility test: at least $2,325 earned in the single highest-earning quarter of the base period. */
export function ctMeetsHighestQuarterEarningsTest(highestQuarterEarningsCents: Cents): boolean {
  return highestQuarterEarningsCents >= CT_PAID_LEAVE_MIN_HIGHEST_QUARTER_EARNINGS;
}

/** The second eligibility test: currently employed, or separated within the past 12 weeks. */
export function ctMeetsRecentEmploymentTest(isCurrentlyEmployed: boolean, weeksSinceSeparation: number): boolean {
  return isCurrentlyEmployed || weeksSinceSeparation <= CT_PAID_LEAVE_MAX_WEEKS_SINCE_SEPARATION;
}

export function isCtPaidLeaveEligible(
  highestQuarterEarningsCents: Cents,
  isCurrentlyEmployed: boolean,
  weeksSinceSeparation: number,
): boolean {
  return (
    ctMeetsHighestQuarterEarningsTest(highestQuarterEarningsCents) &&
    ctMeetsRecentEmploymentTest(isCurrentlyEmployed, weeksSinceSeparation)
  );
}
