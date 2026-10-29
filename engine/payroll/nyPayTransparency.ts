import type { Cents } from '../src/money.ts';
import { dollars } from '../src/money.ts';

/**
 * New York's pay transparency law (Labor Law § 194-b, effective
 * September 17, 2023) — LIVE-VERIFIED against NY DOL's own pages,
 * corroborated across multiple independent employment-law sources for
 * the exact tiered penalty figures, not assumed from trained memory.
 * Fetched 2026-09-14.
 *
 * The natural companion to `payroll/salaryHistoryBan.ts` (California's
 * own pay-scale-transparency requirement) — deliberately its OWN module
 * rather than a shared abstraction, since the two statutes differ in
 * every particular that matters: NY's employer threshold is 4 employees
 * (not California's 15-for-job-postings), NY's obligation attaches
 * unconditionally to every covered employer's job/promotion/transfer
 * postings (California's own posting duty is the ONE rule among four
 * that carries a size threshold at all — see that module's own header),
 * and NY's penalty is a flat per-violation TIER ($1,000 / $2,000 /
 * $3,000 for the first/second/third-or-later violation) rather than
 * California's $100-$10,000 discretionary RANGE. Conflating the two
 * statutes' own thresholds or penalty shapes would be exactly the
 * mistake payroll/cobra.ts's own header warns against.
 *
 * SCOPE: coverage and the penalty tier only. Does not evaluate whether a
 * posted range reflects a genuine "good faith" belief about expected pay
 * (the 2026 amendments specifically outlawed placeholder ranges like "$1
 * to $1 million," but judging whether any SPECIFIC range is a good-faith
 * estimate is a fact-specific determination, not a formula) — the same
 * kind of scope boundary payroll/warnAct.ts's own exception guidance
 * draws.
 */

export const NY_PAY_TRANSPARENCY_EMPLOYER_THRESHOLD = 4;

export const NY_PAY_TRANSPARENCY_FIRST_VIOLATION_PENALTY: Cents = dollars(1_000);
export const NY_PAY_TRANSPARENCY_SECOND_VIOLATION_PENALTY: Cents = dollars(2_000);
export const NY_PAY_TRANSPARENCY_THIRD_OR_SUBSEQUENT_VIOLATION_PENALTY: Cents = dollars(3_000);

export function isNyPayTransparencyRequired(employeeCount: number): boolean {
  return employeeCount >= NY_PAY_TRANSPARENCY_EMPLOYER_THRESHOLD;
}

/**
 * The mandatory civil penalty for an employer's Nth violation — flat
 * tiers, not a per-day or per-posting accrual: $1,000 for the first,
 * $2,000 for the second, and $3,000 for the third AND every one after
 * that (the statute doesn't keep escalating past the third tier). A
 * violation number below 1 has no penalty at all.
 */
export function nyPayTransparencyPenaltyForViolationNumber(violationNumber: number): Cents {
  if (violationNumber < 1) return 0;
  if (violationNumber === 1) return NY_PAY_TRANSPARENCY_FIRST_VIOLATION_PENALTY;
  if (violationNumber === 2) return NY_PAY_TRANSPARENCY_SECOND_VIOLATION_PENALTY;
  return NY_PAY_TRANSPARENCY_THIRD_OR_SUBSEQUENT_VIOLATION_PENALTY;
}
