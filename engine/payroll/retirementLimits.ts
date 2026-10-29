import type { Cents } from '../src/money.ts';
import { dollars } from '../src/money.ts';

/**
 * 401(k)/403(b)/governmental 457(b) elective deferral limits (IRC §402(g))
 * and catch-up contributions (IRC §414(v), as expanded by SECURE 2.0
 * §109/§603) — LIVE-VERIFIED against the IRS's own published figures for
 * 2026, not assumed from trained memory:
 *  - https://www.irs.gov/retirement-plans/plan-participant-employee/retirement-topics-catch-up-contributions
 *  - IRS Notice 2023-62 (SECURE 2.0 §603 Roth catch-up transition guidance)
 * (fetched 2026-09-13).
 *
 * YEAR-SPECIFIC, the same convention payroll/aca.ts's own dollar constants
 * use: these limits are annually inflation-adjusted by the IRS, and this
 * project does not maintain a multi-year effective-dated history for them
 * the way src/taxes/federal.ts does for the core tax engine's own
 * brackets — only the CURRENT (2026) figures are modeled, named with the
 * year suffix so a future year's update is an obviously new constant,
 * never a silent overwrite.
 *
 * SCOPE: pure calculation over a plan-year elective-deferral YTD total and
 * an age the caller supplies — this project's Employee type has no birth
 * date field, so age isn't derived here, the same "take the figure as a
 * parameter rather than force a schema change to compute it" choice
 * payroll/workersComp.ts makes for subject wages. Does NOT track that YTD
 * total itself (payroll/ytd.ts would need a new field for it, a real but
 * separate wiring task) and does NOT compute the IRC §415(c) annual-
 * additions limit, which combines employee AND employer contributions and
 * is a different, larger figure this module leaves out entirely.
 */

/** IRC §402(g) elective deferral limit for 2026. */
export const ELECTIVE_DEFERRAL_LIMIT_2026: Cents = dollars(24_500);

/** Standard IRC §414(v) catch-up for participants 50+ who are NOT in the 60-63 enhanced window, for 2026. */
export const CATCH_UP_LIMIT_2026: Cents = dollars(8_000);

/** SECURE 2.0 §109's enhanced catch-up for participants who turn 60, 61, 62, or 63 during the calendar year, for 2026 — larger than the standard 50+ catch-up above, not additive to it. */
export const ENHANCED_CATCH_UP_LIMIT_2026: Cents = dollars(11_250);

/** SECURE 2.0 §603: a participant 50+ whose PRIOR-YEAR FICA wages from THIS employer (IRC §3121(a), generally Form W-2 box 3) exceeded this figure must make all catch-up contributions on a Roth (after-tax) basis, effective for taxable years beginning after December 31, 2025 (i.e. first applies for 2026, measured against 2025 wages). Not prorated or aggregated across employers. */
export const ROTH_CATCH_UP_WAGE_THRESHOLD_2026: Cents = dollars(150_000);

export const CATCH_UP_MINIMUM_AGE = 50;
export const ENHANCED_CATCH_UP_MIN_AGE = 60;
export const ENHANCED_CATCH_UP_MAX_AGE = 63;

/** The catch-up amount that applies at a given age this calendar year — the ENHANCED figure for the 60-63 window specifically, the standard figure for 50+ outside it, and none below 50. */
export function applicableCatchUpLimit(age: number): Cents {
  if (age >= ENHANCED_CATCH_UP_MIN_AGE && age <= ENHANCED_CATCH_UP_MAX_AGE) return ENHANCED_CATCH_UP_LIMIT_2026;
  if (age >= CATCH_UP_MINIMUM_AGE) return CATCH_UP_LIMIT_2026;
  return 0;
}

/** The total elective-deferral ceiling for the year — the base §402(g) limit plus whatever catch-up applies at this age. */
export function annualElectiveDeferralLimit(age: number): Cents {
  return ELECTIVE_DEFERRAL_LIMIT_2026 + applicableCatchUpLimit(age);
}

/** How much MORE this employee may defer this year without exceeding their own limit — never negative, even if YTD deferrals already reached or exceeded it. */
export function remainingElectiveDeferralRoom(ytdElectiveDeferrals: Cents, age: number): Cents {
  return Math.max(0, annualElectiveDeferralLimit(age) - ytdElectiveDeferrals);
}

/** Clamps a requested pay-period deferral to whatever room remains under the annual limit — never grants more than the limit allows, and never less than what was actually requested when room exceeds it. */
export function cappedDeferralForPayPeriod(requestedDeferral: Cents, ytdElectiveDeferrals: Cents, age: number): Cents {
  return Math.min(requestedDeferral, remainingElectiveDeferralRoom(ytdElectiveDeferrals, age));
}

/** SECURE 2.0 §603: true only for a participant 50+ whose prior-year FICA wages from this employer strictly EXCEEDED the threshold — exactly at the threshold does not trigger it. */
export function isRothCatchUpRequired(age: number, priorYearFicaWagesFromThisEmployer: Cents): boolean {
  return age >= CATCH_UP_MINIMUM_AGE && priorYearFicaWagesFromThisEmployer > ROTH_CATCH_UP_WAGE_THRESHOLD_2026;
}
