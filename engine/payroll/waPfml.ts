import type { Cents } from '../src/money.ts';
import { dollars } from '../src/money.ts';

/**
 * Washington Paid Family and Medical Leave (PFML, RCW Title 50A) —
 * LIVE-VERIFIED against the statute's own text (RCW 50A.15.020, fetched
 * directly via app.leg.wa.gov) and paidleave.wa.gov's own current pages
 * for the 2026 dollar figures, not assumed from trained memory. Fetched
 * 2026-09-14.
 *
 * SAME WITHHOLDING/BENEFIT SCOPE SPLIT as payroll/nyPfl.ts,
 * payroll/njFli.ts, and payroll/maPfml.ts: this project's own core tax
 * engine already correctly computes the PFML payroll withholding
 * (`data/states/WA-2026.json`'s own config, employer and employee
 * SPLITTING BOTH portions proportionally — genuinely different from
 * Massachusetts, where family leave is funded entirely by the employee
 * at every employer size, per that module's own header). This module
 * adds only the wage-replacement BENEFIT, which the withholding side has
 * no reason to compute.
 *
 * A THIRD DISTINCT BENEFIT FORMULA in this project's growing set of
 * state PFL modules: like Massachusetts, Washington uses a two-tier
 * formula (90% up to half the state average weekly wage, 50% above),
 * but at DIFFERENT percentages (90%/50%, not MA's 80%/50%) — and unlike
 * NY (flat 67%), NJ (flat 85%), or MA (no floor), Washington's own
 * statute sets an explicit $100/week MINIMUM benefit, with its own
 * carve-out: an employee whose average weekly wage is itself under
 * $100/week receives their full wage instead of the $100 floor (RCW
 * 50A.15.020, verbatim: "the minimum weekly benefit shall not be less
 * than $100 per week except that if the employee's average weekly wage
 * ... is less than $100 per week, the weekly benefit shall be the
 * employee's full wage").
 *
 * SCOPE: eligibility (the 820-hours test) and the weekly benefit only.
 * Washington's own duration rules are genuinely more varied than every
 * other state module in this project — medical leave duration is openly
 * "as medically necessary" rather than a fixed week count, family
 * bonding is 12 weeks, multiple qualifying events combine up to 16
 * weeks, and pregnancy/birth complications extend to 18 weeks — modeled
 * here as constants for a caller to reference, not as a single "max
 * weeks" figure the way payroll/maPfml.ts's own three simpler duration
 * constants work. Does not track an actual leave request end to end, the
 * same category of gap payroll/fmla.ts's own header discloses.
 */

/** paidleave.wa.gov 2026: the Washington state average weekly wage (SAWW). */
export const WA_PFML_STATE_AVERAGE_WEEKLY_WAGE_2026: Cents = dollars(1_830);

export const WA_PFML_LOWER_TIER_REPLACEMENT_RATE = 0.9;
export const WA_PFML_UPPER_TIER_REPLACEMENT_RATE = 0.5;

/** paidleave.wa.gov 2026: the maximum weekly benefit. */
export const WA_PFML_MAX_WEEKLY_BENEFIT_2026: Cents = dollars(1_647);

/** RCW 50A.15.020: the minimum weekly benefit for an eligible claim whose average weekly wage is at least this much — see `waPfmlWeeklyBenefit()`'s own doc comment for the below-minimum-wage exception. */
export const WA_PFML_MIN_WEEKLY_BENEFIT_2026: Cents = dollars(100);

/** paidleave.wa.gov: the hours-worked eligibility threshold within the qualifying period. */
export const WA_PFML_MIN_HOURS_WORKED = 820;

/** paidleave.wa.gov: the qualifying period is a rolling lookback of this many months. */
export const WA_PFML_QUALIFYING_PERIOD_MONTHS = 12;

export const WA_PFML_FAMILY_BONDING_MAX_WEEKS = 12;
export const WA_PFML_MULTIPLE_QUALIFYING_EVENTS_MAX_WEEKS = 16;
export const WA_PFML_PREGNANCY_COMPLICATIONS_MAX_WEEKS = 18;

export function isWaPfmlEligible(hoursWorkedInQualifyingPeriod: number): boolean {
  return hoursWorkedInQualifyingPeriod >= WA_PFML_MIN_HOURS_WORKED;
}

/** Half the state average weekly wage — the dividing line between the two wage-replacement tiers. */
export function waPfmlTierThreshold(): Cents {
  return Math.round(WA_PFML_STATE_AVERAGE_WEEKLY_WAGE_2026 * 0.5);
}

/**
 * RCW 50A.15.020's own formula: below $100/week average wage, the
 * benefit is simply the employee's full wage (paying the $100 floor
 * would otherwise pay MORE than they actually earned). At or above
 * $100/week, the two-tier 90%/50% formula applies, each tier rounded
 * independently, capped at the maximum and floored at the minimum.
 */
export function waPfmlWeeklyBenefit(averageWeeklyWageCents: Cents): Cents {
  if (averageWeeklyWageCents < WA_PFML_MIN_WEEKLY_BENEFIT_2026) {
    return averageWeeklyWageCents;
  }
  const threshold = waPfmlTierThreshold();
  const lowerPortion = Math.min(averageWeeklyWageCents, threshold);
  const upperPortion = Math.max(0, averageWeeklyWageCents - threshold);
  const raw = Math.round(lowerPortion * WA_PFML_LOWER_TIER_REPLACEMENT_RATE) + Math.round(upperPortion * WA_PFML_UPPER_TIER_REPLACEMENT_RATE);
  const capped = Math.min(raw, WA_PFML_MAX_WEEKLY_BENEFIT_2026);
  return Math.max(capped, WA_PFML_MIN_WEEKLY_BENEFIT_2026);
}
