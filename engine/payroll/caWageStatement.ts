import type { Cents } from '../src/money.ts';
import { dollars } from '../src/money.ts';

/**
 * California's itemized wage statement requirements (Labor Code § 226)
 * — LIVE-VERIFIED against California DIR's own FAQ and the statute's own
 * penalty text (§ 226(e)(1)), not assumed from trained memory, both
 * fetched 2026-09-13.
 *
 * THE GAP THIS FILLS: this project's own `payroll/paystub.ts` renders a
 * paystub with gross pay, taxes, deductions, garnishments, and net pay —
 * but does NOT currently include total hours worked, the applicable
 * hourly rate(s) and hours at each, the employee's own truncated SSN, or
 * the employer's ADDRESS (only its legal name). This module doesn't
 * change `renderPaystubText()` itself; it validates whatever data a
 * caller assembles against the statute's own 9 required items, the same
 * "compliance CHECK, not a rewrite of the thing being checked" pattern
 * `payroll/nyWageNotice.ts` uses for its own at-hire notice.
 *
 * SCOPE: the 9 required items, and the statute's own three-tier penalty
 * math ($50 first pay period, $100 each subsequent pay period, capped at
 * $4,000 aggregate per employee). Deliberately does NOT evaluate whether
 * a given failure was "knowing and intentional" — § 226(e)(1)'s own
 * trigger for the penalty, and a fact-specific state-of-mind question,
 * not a formula — so `caWageStatementPenaltyExposure()` computes the
 * MAXIMUM exposure assuming that element is met, the same "compute the
 * ceiling, leave the legal judgment to the caller" choice
 * payroll/warnAct.ts's own exception guidance makes.
 *
 * ONE STATE ONLY — this is a genuinely different, additional set of
 * requirements from `payroll/nyWageNotice.ts`'s own New York wage-
 * statement rules; each state with its own itemization law (several do)
 * remains a disclosed gap, the same "one jurisdiction modeled, the rest
 * named as missing" boundary payroll/paidSickLeave.ts and
 * payroll/workersComp.ts already draw.
 */

export interface CaHourlyRateLine {
  hourlyRateCents: Cents;
  hoursAtThisRate: number;
}

/** Every field Labor Code § 226(a) requires on an itemized wage statement. `totalHoursWorked` and `hourlyRateLines` are not required for a salaried EXEMPT employee (see `isExemptSalaried`); `pieceRateUnitsEarned` only applies to piece-rate work (see `isPieceRateWork`). */
export interface CaWageStatementData {
  grossWagesCents: Cents;
  isExemptSalaried: boolean;
  totalHoursWorked: number | null;
  isPieceRateWork: boolean;
  pieceRateUnitsEarned: number | null;
  deductionsCents: Cents;
  netWagesCents: Cents;
  payPeriodStart: string;
  payPeriodEnd: string;
  employeeName: string;
  lastFourSsn: string;
  employerLegalName: string;
  employerAddress: string;
  hourlyRateLines: CaHourlyRateLine[];
}

/** § 226(e)(1): the penalty for the FIRST pay period with a violation. */
export const CA_WAGE_STATEMENT_FIRST_VIOLATION_PENALTY: Cents = dollars(50);

/** § 226(e)(1): the penalty for EACH subsequent pay period with a violation. */
export const CA_WAGE_STATEMENT_SUBSEQUENT_VIOLATION_PENALTY: Cents = dollars(100);

/** § 226(e)(1): the aggregate cap on total penalty exposure per employee, however many pay periods were affected. */
export const CA_WAGE_STATEMENT_MAX_AGGREGATE_PENALTY: Cents = dollars(4_000);

/** Every missing/invalid required field, reported all at once rather than stopping at the first — the same pattern payroll/nyWageNotice.ts's own validator and payroll/fmla.ts's own eligibility check use. Accepts a Partial so a caller assembling a statement can check it before every field is filled in. */
export function caWageStatementComplianceIssues(statement: Partial<CaWageStatementData>): string[] {
  const issues: string[] = [];

  if (statement.grossWagesCents === undefined || statement.grossWagesCents < 0) issues.push('Missing gross wages earned.');
  if (statement.netWagesCents === undefined || statement.netWagesCents < 0) issues.push('Missing net wages earned.');
  if (statement.deductionsCents === undefined) issues.push('Missing a statement of deductions (enter 0 if none).');
  if (!statement.payPeriodStart || !statement.payPeriodEnd) issues.push('Missing the inclusive pay period dates.');
  if (!statement.employeeName) issues.push('Missing employee name.');
  if (!statement.lastFourSsn || statement.lastFourSsn.length !== 4) issues.push('Missing the last four digits of the employee\'s Social Security number.');
  if (!statement.employerLegalName) issues.push('Missing the employer\'s legal name.');
  if (!statement.employerAddress) issues.push('Missing the employer\'s address.');

  if (!statement.isExemptSalaried) {
    if (statement.totalHoursWorked === null || statement.totalHoursWorked === undefined) {
      issues.push('Missing total hours worked (required for a non-exempt employee).');
    }
    if (!statement.hourlyRateLines || statement.hourlyRateLines.length === 0) {
      issues.push('Missing the applicable hourly rate(s) and hours worked at each rate (required for a non-exempt employee).');
    }
  }

  if (statement.isPieceRateWork && (statement.pieceRateUnitsEarned === null || statement.pieceRateUnitsEarned === undefined)) {
    issues.push('Missing piece-rate units earned and the applicable piece rate.');
  }

  return issues;
}

/** The statute's own capped, tiered penalty math — $50 for the first affected pay period, $100 for each one after that, never exceeding the $4,000 aggregate cap per employee. Assumes the "knowing and intentional" element the statute requires is met; this module doesn't evaluate that fact-specific question itself. */
export function caWageStatementPenaltyExposure(payPeriodsWithViolations: number): Cents {
  if (payPeriodsWithViolations <= 0) return 0;
  const subsequentPeriods = payPeriodsWithViolations - 1;
  const total = CA_WAGE_STATEMENT_FIRST_VIOLATION_PENALTY + subsequentPeriods * CA_WAGE_STATEMENT_SUBSEQUENT_VIOLATION_PENALTY;
  return Math.min(total, CA_WAGE_STATEMENT_MAX_AGGREGATE_PENALTY);
}
