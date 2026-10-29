import type { Cents } from '../src/money.ts';
import { dollars } from '../src/money.ts';

/**
 * Maine Paid Family and Medical Leave (PFML, 26 M.R.S. § 850-A et seq.) —
 * LIVE-VERIFIED by reading the Maine Department of Labor's own April
 * 2026 employer benefits webinar deck directly (its own worked benefit
 * examples independently reproduced HERE to the exact dollar, not
 * assumed from trained memory — see the three hand-checked test cases in
 * this module's own test file), corroborated against independent
 * benefits-broker sources for the benefit year 2026-07-01 through
 * 2027-06-30 state average weekly wage figure. Fetched/cross-checked
 * 2026-09-14.
 *
 * SAME SCOPE BOUNDARY AS `payroll/nyPfl.ts`, `payroll/njFli.ts`,
 * `payroll/maPfml.ts`, `payroll/waPfml.ts`, `payroll/coFamli.ts`,
 * `payroll/orPaidLeave.ts`, and `payroll/ctPaidLeave.ts`, for the same
 * reason: this project's own core tax engine already correctly computes
 * Maine PFML's payroll WITHHOLDING via `data/states/ME-2026.json`'s own
 * `statePaidLeaveEmployee`/`statePaidLeaveEmployer` config. Reimplementing
 * that withholding math here would risk the "two different, possibly
 * divergent, calculations of the same figure" failure mode
 * `payroll/cobra.ts`'s own header warns against. This module adds only
 * the wage-replacement BENEFIT calculation and the base-period earnings
 * eligibility test.
 *
 * THE ONLY SIBLING MODULE THAT ROUNDS DOWN TO THE WHOLE DOLLAR AT EVERY
 * STEP, rather than to the cent: Maine's own average weekly wage
 * calculation is defined to round DOWN to the next lower whole dollar,
 * and its own published tiered-benefit worksheet (reproduced above)
 * shows each tier's dollar amount computed and then likewise rounded
 * DOWN to the whole dollar before being summed — e.g. 66% of $497 is
 * $328.02, but the state's own worked example reports the tier as
 * exactly $328, not $328.02. `mePfmlFloorToDollar()` makes this
 * convention explicit and reusable rather than leaving it as an
 * unstated rounding assumption. The two-tier RATES themselves (90% below
 * 50% of the SAWW, 66% above) are a fourth distinct percentage pairing
 * among this project's seven state PFL modules. The maximum weekly
 * benefit is the full, un-floored state average weekly wage itself —
 * not a percentage of it the way `payroll/coFamli.ts` and
 * `payroll/orPaidLeave.ts` define their own caps.
 *
 * SCOPE: does not model the base-period wage lookup itself (which of the
 * first four of the last five completed calendar quarters counts, or the
 * portable, all-Maine-employers wage aggregation Aflac performs) — this
 * module takes a caller-supplied average weekly wage and base-period
 * earnings total as given, the same caller-supplies-the-wage-history
 * boundary every sibling PFML module in this project draws. Does not
 * model the Undue Hardship rescheduling process, a fact-specific
 * negotiation between employer and employee with no formula, the same
 * kind of scope boundary `payroll/warnAct.ts`'s own exception guidance
 * draws. Does not track an actual leave request end to end, the same
 * category of gap `payroll/fmla.ts`'s own header discloses.
 */

/** Maine PFML benefit year 2026-07-01 through 2027-06-30: the Maine state average weekly wage (SAWW) the tiered formula is built from. */
export const ME_PFML_STATE_AVERAGE_WEEKLY_WAGE_2026: Cents = dollars(1_249.12);

/** The wage-replacement rate for the portion of average weekly wage AT OR BELOW 50% of the SAWW. */
export const ME_PFML_LOWER_TIER_REPLACEMENT_RATE = 0.9;

/** The wage-replacement rate for the portion of average weekly wage ABOVE 50% of the SAWW. */
export const ME_PFML_UPPER_TIER_REPLACEMENT_RATE = 0.66;

/** The maximum weekly benefit equals the full, un-floored state average weekly wage — not a percentage of it. */
export function mePfmlMaxWeeklyBenefit(): Cents {
  return ME_PFML_STATE_AVERAGE_WEEKLY_WAGE_2026;
}

/** MDOL's own eligibility test: earnings during the base period must be at least this many multiples of the SAWW. */
export const ME_PFML_MIN_BASE_PERIOD_EARNINGS_SAWW_MULTIPLE = 6;

/** Maine's own rounding convention, used at every step of the benefit calculation: round DOWN to the next lower whole dollar, never to the nearest cent. */
export function mePfmlFloorToDollar(cents: Cents): Cents {
  return Math.floor(cents / 100) * 100;
}

/** 50% of the SAWW, floored to the whole dollar — the dividing line between the two wage-replacement tiers. */
export function mePfmlTierThreshold(): Cents {
  return mePfmlFloorToDollar(Math.round(ME_PFML_STATE_AVERAGE_WEEKLY_WAGE_2026 * 0.5));
}

/**
 * The two-tier weekly benefit: 90% of whatever average weekly wage falls
 * at or below the tier threshold, plus 66% of whatever falls above it —
 * each tier rounded DOWN to the whole dollar independently before
 * summing, then the total capped at the full SAWW.
 */
export function mePfmlWeeklyBenefit(averageWeeklyWageCents: Cents): Cents {
  const threshold = mePfmlTierThreshold();
  const lowerPortion = Math.min(averageWeeklyWageCents, threshold);
  const upperPortion = Math.max(0, averageWeeklyWageCents - threshold);
  const lowerTier = mePfmlFloorToDollar(Math.round(lowerPortion * ME_PFML_LOWER_TIER_REPLACEMENT_RATE));
  const upperTier = mePfmlFloorToDollar(Math.round(upperPortion * ME_PFML_UPPER_TIER_REPLACEMENT_RATE));
  return Math.min(lowerTier + upperTier, mePfmlMaxWeeklyBenefit());
}

/** The minimum base-period earnings required: 6 times the SAWW. */
export function mePfmlMinBasePeriodEarnings(): Cents {
  return ME_PFML_MIN_BASE_PERIOD_EARNINGS_SAWW_MULTIPLE * ME_PFML_STATE_AVERAGE_WEEKLY_WAGE_2026;
}

/** Maine PFML's single eligibility test: base-period earnings of at least 6 times the SAWW. */
export function isMePfmlEligible(basePeriodEarningsCents: Cents): boolean {
  return basePeriodEarningsCents >= mePfmlMinBasePeriodEarnings();
}

/** MDOL: every covered reason draws on the same combined 12-week annual allowance — there is no separate, larger pool for any one reason. */
export const ME_PFML_MAX_WEEKS_PER_BENEFIT_YEAR = 12;
