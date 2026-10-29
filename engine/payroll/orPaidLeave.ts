import type { Cents } from '../src/money.ts';
import { dollars } from '../src/money.ts';

/**
 * Paid Leave Oregon (ORS 657B) — LIVE-VERIFIED for benefit years beginning
 * on or after June 28, 2026, corroborated across multiple independent
 * benefits-broker sources reporting the same state average weekly wage
 * and the resulting minimum/maximum benefit figures (cross-checked
 * arithmetically: the reported $1,692.16 maximum is exactly 120% of the
 * reported $1,410.13 SAWW, and the reported $70.51 minimum is exactly 5%
 * of it — internal consistency across independently-reported figures,
 * not assumed from trained memory). Fetched/cross-checked 2026-09-14.
 *
 * SAME SCOPE BOUNDARY AS `payroll/nyPfl.ts`, `payroll/njFli.ts`,
 * `payroll/maPfml.ts`, `payroll/waPfml.ts`, and `payroll/coFamli.ts`, for
 * the same reason: this project's own core tax engine already correctly
 * computes Paid Leave Oregon's payroll WITHHOLDING via
 * `data/states/OR-2026.json`'s own `statePaidLeaveEmployee` config.
 * Reimplementing that withholding math here would risk the "two
 * different, possibly divergent, calculations of the same figure"
 * failure mode `payroll/cobra.ts`'s own header warns against. This module
 * adds only the wage-replacement BENEFIT calculation and the base-year
 * earnings eligibility test.
 *
 * A GENUINELY DIFFERENT SHAPE than any sibling PFL benefit formula in
 * this project: Oregon replaces 100% (not a fraction) of average weekly
 * wage up to 65% of the state average weekly wage (SAWW) — the highest
 * threshold and the only 100%-replacement tier among this project's five
 * state PFL modules — then 50% of whatever falls above that threshold.
 * Oregon is also the only one of the five with BOTH a floor AND a cap
 * defined as percentages of the SAWW itself (5% and 120%, respectively)
 * rather than a separately-published flat minimum/maximum dollar figure —
 * confirmed by the arithmetic cross-check in the header above.
 *
 * SCOPE: does not model the base-year wage lookup itself (which
 * completed quarters count) — this module takes a caller-supplied
 * average weekly wage and base-year earnings total as given, the same
 * caller-supplies-the-wage-history boundary every sibling PFML module in
 * this project draws. Does not track an actual leave request end to end,
 * the same category of gap `payroll/fmla.ts`'s own header discloses.
 */

/** Paid Leave Oregon, benefit years beginning on or after 2026-06-28: the Oregon state average weekly wage (SAWW) the formula is built from. */
export const OR_PAID_LEAVE_STATE_AVERAGE_WEEKLY_WAGE_2026: Cents = dollars(1_410.13);

/** The dividing line between the two wage-replacement tiers, as a fraction of the SAWW. */
export const OR_PAID_LEAVE_TIER_THRESHOLD_FRACTION = 0.65;

/** The wage-replacement rate for the portion of average weekly wage ABOVE the tier threshold. Below the threshold, wages are replaced at a flat 100%. */
export const OR_PAID_LEAVE_UPPER_TIER_REPLACEMENT_RATE = 0.5;

/** The minimum weekly benefit, as a fraction of the SAWW. */
export const OR_PAID_LEAVE_MIN_BENEFIT_FRACTION = 0.05;

/** The maximum weekly benefit, as a fraction of the SAWW. */
export const OR_PAID_LEAVE_MAX_BENEFIT_FRACTION = 1.2;

/** Oregon Employment Department: the minimum wages required in the base year, from Oregon employment. */
export const OR_PAID_LEAVE_MIN_BASE_YEAR_EARNINGS: Cents = dollars(1_000);

export const OR_PAID_LEAVE_STANDARD_MAX_WEEKS = 12;

/** Additional weeks available only to the parent who gave birth, for limitations related to pregnancy, childbirth, or a related medical condition (including lactation) — medical certification required. */
export const OR_PAID_LEAVE_PREGNANCY_CHILDBIRTH_ADDITIONAL_WEEKS = 2;

export const OR_PAID_LEAVE_COMBINED_MAX_WEEKS =
  OR_PAID_LEAVE_STANDARD_MAX_WEEKS + OR_PAID_LEAVE_PREGNANCY_CHILDBIRTH_ADDITIONAL_WEEKS;

/** 65% of the SAWW — the dividing line between 100% replacement and the 50% upper tier. */
export function orPaidLeaveTierThreshold(): Cents {
  return Math.round(OR_PAID_LEAVE_STATE_AVERAGE_WEEKLY_WAGE_2026 * OR_PAID_LEAVE_TIER_THRESHOLD_FRACTION);
}

/** 5% of the SAWW — the minimum weekly benefit, whatever the formula alone would otherwise produce below it. */
export function orPaidLeaveMinWeeklyBenefit(): Cents {
  return Math.round(OR_PAID_LEAVE_STATE_AVERAGE_WEEKLY_WAGE_2026 * OR_PAID_LEAVE_MIN_BENEFIT_FRACTION);
}

/** 120% of the SAWW — the maximum weekly benefit, whatever the formula alone would otherwise produce above it. */
export function orPaidLeaveMaxWeeklyBenefit(): Cents {
  return Math.round(OR_PAID_LEAVE_STATE_AVERAGE_WEEKLY_WAGE_2026 * OR_PAID_LEAVE_MAX_BENEFIT_FRACTION);
}

/**
 * The weekly benefit: 100% of average weekly wage at or below the tier
 * threshold; above it, the threshold itself plus 50% of the excess —
 * then floored at the minimum and capped at the maximum weekly benefit.
 */
export function orPaidLeaveWeeklyBenefit(averageWeeklyWageCents: Cents): Cents {
  const threshold = orPaidLeaveTierThreshold();
  const raw =
    averageWeeklyWageCents <= threshold
      ? averageWeeklyWageCents
      : threshold + Math.round((averageWeeklyWageCents - threshold) * OR_PAID_LEAVE_UPPER_TIER_REPLACEMENT_RATE);
  return Math.max(orPaidLeaveMinWeeklyBenefit(), Math.min(raw, orPaidLeaveMaxWeeklyBenefit()));
}

/** Paid Leave Oregon's single eligibility test: at least $1,000 in base-year wages from Oregon employment. */
export function isOrPaidLeaveEligible(baseYearEarningsCents: Cents): boolean {
  return baseYearEarningsCents >= OR_PAID_LEAVE_MIN_BASE_YEAR_EARNINGS;
}

/** The total leave weeks available, including the pregnancy/childbirth-related addition when it applies (available only to the parent who gave birth). */
export function orPaidLeaveMaxWeeksAvailable(hasPregnancyOrChildbirthRelatedCondition: boolean): number {
  return hasPregnancyOrChildbirthRelatedCondition ? OR_PAID_LEAVE_COMBINED_MAX_WEEKS : OR_PAID_LEAVE_STANDARD_MAX_WEEKS;
}
