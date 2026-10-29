import type { Cents } from '../src/money.ts';
import { dollars } from '../src/money.ts';

/**
 * Colorado Family and Medical Leave Insurance (FAMLI, C.R.S. § 8-13.3-501
 * et seq.) — LIVE-VERIFIED for the benefit year running July 1, 2026
 * through June 30, 2027, corroborated across multiple independent
 * benefits-broker and employment-law sources for the state average
 * weekly wage and maximum benefit figures (since famli.colorado.gov
 * itself blocked automated fetches, the same CDLE-site access problem
 * already disclosed in `payroll/coEpewa.ts`'s own header) — a New York
 * Life Group Benefit Solutions calculation guide independently confirmed
 * the underlying two-tier FORMULA STRUCTURE with worked dollar examples,
 * separately from the current year's dollar figures. Fetched/cross-
 * checked 2026-09-14.
 *
 * SAME SCOPE BOUNDARY AS `payroll/nyPfl.ts`, `payroll/njFli.ts`,
 * `payroll/maPfml.ts`, and `payroll/waPfml.ts`, for the same reason: this
 * project's own core tax engine already correctly computes FAMLI payroll
 * WITHHOLDING via `data/states/CO-2026.json`'s own `statePaidLeaveEmployee`
 * config. Reimplementing that withholding math here would risk the "two
 * different, possibly divergent, calculations of the same figure" failure
 * mode `payroll/cobra.ts`'s own header warns against. This module adds
 * only the wage-replacement BENEFIT calculation and the base-period
 * earnings eligibility test, which the withholding side has no reason to
 * compute.
 *
 * THE SAME TWO-TIER SHAPE AS MASSACHUSETTS AND WASHINGTON'S OWN PFML
 * FORMULAS, but with FAMLI's own rates and its own, notably simpler,
 * eligibility test: 90% wage replacement for the portion of average
 * weekly wage at or below 50% of the state average weekly wage (SAWW),
 * 50% replacement for the portion above that threshold, capped at the
 * maximum weekly benefit (itself defined as 90% of the full SAWW, not a
 * separately-published flat dollar figure — confirmed by cross-checking
 * that 90% x SAWW reproduces the independently-reported maximum for two
 * different benefit years). Eligibility is a SINGLE test — at least
 * $2,500 in wages during the base period, from any combination of
 * employers, with NO minimum tenure or hours-worked requirement at all —
 * genuinely simpler than Massachusetts's own two-part earnings test
 * (`payroll/maPfml.ts`'s own `maMeetsThirtyTimesBenefitTest()`).
 *
 * SCOPE: does not model the base-period WAGE lookup itself (which of the
 * last five completed calendar quarters counts, and the /13 conversion
 * to a weekly figure) — this module takes a caller-supplied average
 * weekly wage and base-period earnings total as given, the same
 * caller-supplies-the-wage-history boundary every sibling PFML module in
 * this project draws. Does not track an actual leave request end to end,
 * the same category of gap `payroll/fmla.ts`'s own header discloses.
 */

/** FAMLI benefit year 2026-07-01 through 2027-06-30: the Colorado state average weekly wage (SAWW) the tiered formula is built from. */
export const CO_FAMLI_STATE_AVERAGE_WEEKLY_WAGE_2026: Cents = dollars(1_608.91);

/** The wage-replacement rate for the portion of average weekly wage AT OR BELOW 50% of the SAWW. */
export const CO_FAMLI_LOWER_TIER_REPLACEMENT_RATE = 0.9;

/** The wage-replacement rate for the portion of average weekly wage ABOVE 50% of the SAWW. */
export const CO_FAMLI_UPPER_TIER_REPLACEMENT_RATE = 0.5;

/** The minimum total wages required across the base period (or alternate base period), from any combination of employers — the ONLY eligibility test, with no minimum tenure or hours-worked requirement. */
export const CO_FAMLI_MIN_BASE_PERIOD_EARNINGS: Cents = dollars(2_500);

export const CO_FAMLI_STANDARD_LEAVE_MAX_WEEKS = 12;

/** Additional weeks available on top of the standard maximum, for a serious health condition related to pregnancy or childbirth complications. */
export const CO_FAMLI_PREGNANCY_COMPLICATIONS_ADDITIONAL_WEEKS = 4;

export const CO_FAMLI_COMBINED_MAX_WEEKS = CO_FAMLI_STANDARD_LEAVE_MAX_WEEKS + CO_FAMLI_PREGNANCY_COMPLICATIONS_ADDITIONAL_WEEKS;

/** 50% of the SAWW — the dividing line between the two wage-replacement tiers. */
export function coFamliTierThreshold(): Cents {
  return Math.round(CO_FAMLI_STATE_AVERAGE_WEEKLY_WAGE_2026 * 0.5);
}

/** 90% of the full SAWW — FAMLI's maximum weekly benefit is defined directly off the SAWW, not published as an independent flat figure. */
export function coFamliMaxWeeklyBenefit(): Cents {
  return Math.round(CO_FAMLI_STATE_AVERAGE_WEEKLY_WAGE_2026 * 0.9);
}

/**
 * The two-tier weekly benefit: 90% of whatever average weekly wage falls
 * at or below the tier threshold, plus 50% of whatever falls above it —
 * each tier rounded independently before summing, then the total capped
 * at the maximum weekly benefit.
 */
export function coFamliWeeklyBenefit(averageWeeklyWageCents: Cents): Cents {
  const threshold = coFamliTierThreshold();
  const lowerPortion = Math.min(averageWeeklyWageCents, threshold);
  const upperPortion = Math.max(0, averageWeeklyWageCents - threshold);
  const raw = Math.round(lowerPortion * CO_FAMLI_LOWER_TIER_REPLACEMENT_RATE) + Math.round(upperPortion * CO_FAMLI_UPPER_TIER_REPLACEMENT_RATE);
  return Math.min(raw, coFamliMaxWeeklyBenefit());
}

/** FAMLI's single eligibility test: at least $2,500 in base-period wages, from any combination of employers. */
export function isCoFamliEligible(basePeriodEarningsCents: Cents): boolean {
  return basePeriodEarningsCents >= CO_FAMLI_MIN_BASE_PERIOD_EARNINGS;
}

/** The total leave weeks available, including the pregnancy/childbirth-complications addition when it applies. */
export function coFamliMaxWeeksAvailable(hasPregnancyOrChildbirthComplications: boolean): number {
  return hasPregnancyOrChildbirthComplications ? CO_FAMLI_COMBINED_MAX_WEEKS : CO_FAMLI_STANDARD_LEAVE_MAX_WEEKS;
}
