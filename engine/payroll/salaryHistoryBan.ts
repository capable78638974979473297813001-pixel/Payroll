import type { Cents } from '../src/money.ts';
import { dollars } from '../src/money.ts';

/**
 * California's salary history ban and pay scale transparency
 * requirements (Labor Code § 432.3, tightened by SB 642 effective
 * January 1, 2026) — LIVE-VERIFIED against the statute's own text,
 * fetched directly (not assumed from trained memory), 2026-09-14.
 *
 * FOUR DIFFERENT RULES, THREE DIFFERENT SCOPES — a genuine subtlety this
 * module encodes explicitly rather than treating § 432.3 as one uniform
 * rule with one threshold:
 *  1. The salary history INQUIRY ban applies to EVERY employer,
 *     regardless of size — no threshold in the statute's own text.
 *  2. Providing the pay scale to an APPLICANT "upon reasonable request"
 *     likewise applies to every employer, no threshold.
 *  3. Providing the pay scale to a CURRENT EMPLOYEE for their own
 *     position "upon request" likewise applies to every employer, no
 *     threshold.
 *  4. Including the pay scale in a JOB POSTING is the ONE obligation
 *     with an explicit employer-size floor: 15 or more employees.
 * Only #4 has a size test at all — this module deliberately does NOT
 * offer a generic "is this employer covered" function that would imply
 * a single threshold governs the whole statute, since that would
 * misrepresent rules #1-3 as conditional when they aren't.
 *
 * SCOPE: also models the statute's own first-violation penalty waiver
 * (no penalty for a first job-posting violation if the employer
 * demonstrates every posting has since been corrected) and the $100-
 * $10,000 civil penalty range the Labor Commissioner may otherwise
 * assess. Does not evaluate SB 642's own "good faith estimate" standard
 * for what counts as a compliant pay scale range — a fact-specific
 * judgment about whether a posted range is genuinely what the employer
 * expects to pay, not a formula, the same kind of scope boundary
 * payroll/warnAct.ts's own exception guidance draws.
 */

/** Labor Code § 432.3(c): only the job-posting pay-scale requirement carries this employer-size floor — every other obligation in this statute applies regardless of size. */
export const SALARY_HISTORY_JOB_POSTING_EMPLOYER_THRESHOLD = 15;

export const SALARY_HISTORY_BAN_MIN_PENALTY: Cents = dollars(100);
export const SALARY_HISTORY_BAN_MAX_PENALTY: Cents = dollars(10_000);

export function isJobPostingPayScaleRequired(employeeCount: number): boolean {
  return employeeCount >= SALARY_HISTORY_JOB_POSTING_EMPLOYER_THRESHOLD;
}

/** Labor Code § 432.3: no penalty for a FIRST job-posting violation if the employer demonstrates every job posting has since been updated to include the required pay scale. */
export function isFirstViolationPenaltyWaived(isFirstViolation: boolean, allJobPostingsNowUpdated: boolean): boolean {
  return isFirstViolation && allJobPostingsNowUpdated;
}

/** Clamps a considered penalty amount into the statute's own $100-$10,000 range — never below the floor, never above the ceiling, whatever figure the Labor Commissioner was weighing. */
export function clampSalaryHistoryBanPenalty(consideredPenaltyCents: Cents): Cents {
  return Math.min(Math.max(consideredPenaltyCents, SALARY_HISTORY_BAN_MIN_PENALTY), SALARY_HISTORY_BAN_MAX_PENALTY);
}

/** The full penalty determination: zero if the first-violation waiver applies, otherwise the considered penalty clamped into the statutory range. */
export function salaryHistoryBanPenaltyOwed(isFirstViolation: boolean, allJobPostingsNowUpdated: boolean, consideredPenaltyCents: Cents): Cents {
  if (isFirstViolationPenaltyWaived(isFirstViolation, allJobPostingsNowUpdated)) return 0;
  return clampSalaryHistoryBanPenalty(consideredPenaltyCents);
}
