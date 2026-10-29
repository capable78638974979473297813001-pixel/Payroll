import type { Cents } from '../src/money.ts';
import { dollars } from '../src/money.ts';

/**
 * HSA (IRC §223), health FSA, and dependent-care FSA (§129 DCAP) annual
 * contribution limits — LIVE-VERIFIED against the IRS's own 2026 figures,
 * not assumed from trained memory:
 *  - IRS Publication 969 (2026 HSA/HDHP limits, fetched 2026-09-13)
 *  - IRS Revenue Procedure 2025-32 (2026 health FSA limit and carryover)
 *  - One Big Beautiful Bill Act §70404 (the dependent-care FSA increase —
 *    its first permanent increase since 1986)
 *
 * YEAR-SPECIFIC, the same convention payroll/aca.ts and
 * payroll/retirementLimits.ts use for their own annually-adjusted dollar
 * constants: only the CURRENT (2026) figures are modeled, named with the
 * year suffix so a future year's COLA update is an obviously new
 * constant, never a silent overwrite.
 *
 * SCOPE: pure contribution-limit math over a coverage tier, an age, and a
 * YTD contribution total the caller supplies — the same "take the figure
 * as a parameter" choice payroll/retirementLimits.ts makes for age.
 * Deliberately does NOT determine HSA ELIGIBILITY itself (actually being
 * enrolled in a qualifying HDHP, not also enrolled in Medicare or other
 * disqualifying coverage — a genuinely separate eligibility question this
 * project doesn't verify, the same "count supplied, not derived" boundary
 * payroll/cobra.ts draws around its own headcount input) and does NOT
 * prorate the annual limit for a partial year of HDHP coverage (the
 * "last-month rule" and its 13-month testing period — a real, separate
 * piece of HSA law this module leaves out entirely rather than getting
 * partially right).
 */

/** IRS Pub 969: 2026 annual HSA contribution limit for self-only HDHP coverage. */
export const HSA_SELF_ONLY_LIMIT_2026: Cents = dollars(4_400);

/** IRS Pub 969: 2026 annual HSA contribution limit for family HDHP coverage. */
export const HSA_FAMILY_LIMIT_2026: Cents = dollars(8_750);

/** IRS Pub 969: additional HSA catch-up for participants 55+ — unlike the 401(k) catch-up, this has no upper age cutoff and applies per-account (a married couple each 55+ with their own HSA each gets this separately). */
export const HSA_CATCH_UP_LIMIT_2026: Cents = dollars(1_000);

export const HSA_CATCH_UP_MINIMUM_AGE = 55;

/** IRS Rev. Proc. 2025-32: 2026 health care FSA salary-reduction limit. */
export const HEALTH_FSA_LIMIT_2026: Cents = dollars(3_400);

/** IRS Rev. Proc. 2025-32: the most a health FSA plan may allow to carry over into the following plan year (a plan may offer this OR a grace period, never both — this module only computes the carryover figure itself, not which option a given plan chose). */
export const HEALTH_FSA_CARRYOVER_LIMIT_2026: Cents = dollars(680);

/** OBBBA §70404: 2026 dependent-care FSA limit for single filers and married filing jointly — the first permanent increase to this figure since 1986. */
export const DEPENDENT_CARE_FSA_LIMIT_2026: Cents = dollars(7_500);

/** OBBBA §70404: 2026 dependent-care FSA limit for a married employee filing separately — always half the joint figure. */
export const DEPENDENT_CARE_FSA_LIMIT_MFS_2026: Cents = dollars(3_750);

export type HdhpCoverageTier = 'self_only' | 'family';

/** The annual HSA contribution ceiling for a coverage tier and age — the base tier limit plus the 55+ catch-up when it applies. */
export function hsaContributionLimit(coverageTier: HdhpCoverageTier, age: number): Cents {
  const base = coverageTier === 'family' ? HSA_FAMILY_LIMIT_2026 : HSA_SELF_ONLY_LIMIT_2026;
  const catchUp = age >= HSA_CATCH_UP_MINIMUM_AGE ? HSA_CATCH_UP_LIMIT_2026 : 0;
  return base + catchUp;
}

/** How much MORE may be contributed to an HSA this year without exceeding the limit — never negative. */
export function remainingHsaContributionRoom(ytdContributions: Cents, coverageTier: HdhpCoverageTier, age: number): Cents {
  return Math.max(0, hsaContributionLimit(coverageTier, age) - ytdContributions);
}

/** Clamps a requested HSA contribution to whatever room remains this year. */
export function cappedHsaContributionForPayPeriod(requestedContribution: Cents, ytdContributions: Cents, coverageTier: HdhpCoverageTier, age: number): Cents {
  return Math.min(requestedContribution, remainingHsaContributionRoom(ytdContributions, coverageTier, age));
}

/** How much MORE may be contributed to a health FSA this plan year — the limit doesn't vary by age or coverage tier, unlike an HSA. */
export function remainingHealthFsaRoom(ytdContributions: Cents): Cents {
  return Math.max(0, HEALTH_FSA_LIMIT_2026 - ytdContributions);
}

/** Clamps a requested health FSA contribution to whatever room remains this plan year. */
export function cappedHealthFsaContributionForPayPeriod(requestedContribution: Cents, ytdContributions: Cents): Cents {
  return Math.min(requestedContribution, remainingHealthFsaRoom(ytdContributions));
}

/** The annual dependent-care FSA limit for a given filing status — half the joint figure for married-filing-separately, the full figure for everyone else (single or married filing jointly). */
export function dependentCareFsaLimit(isMarriedFilingSeparately: boolean): Cents {
  return isMarriedFilingSeparately ? DEPENDENT_CARE_FSA_LIMIT_MFS_2026 : DEPENDENT_CARE_FSA_LIMIT_2026;
}

/** How much MORE may be contributed to a dependent-care FSA this plan year, for the given filing status — never negative. */
export function remainingDependentCareFsaRoom(ytdContributions: Cents, isMarriedFilingSeparately: boolean): Cents {
  return Math.max(0, dependentCareFsaLimit(isMarriedFilingSeparately) - ytdContributions);
}

/** Clamps a requested dependent-care FSA contribution to whatever room remains this plan year. */
export function cappedDependentCareFsaContributionForPayPeriod(requestedContribution: Cents, ytdContributions: Cents, isMarriedFilingSeparately: boolean): Cents {
  return Math.min(requestedContribution, remainingDependentCareFsaRoom(ytdContributions, isMarriedFilingSeparately));
}
