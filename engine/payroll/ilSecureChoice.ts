import type { Cents } from '../src/money.ts';
import { dollars } from '../src/money.ts';

/**
 * Illinois Secure Choice, the state-run auto-IRA program (820 ILCS 80/)
 * — LIVE-VERIFIED against the Illinois Department of Revenue's own
 * enforcement bulletin (FY 2023-09) and the Illinois State Treasurer's
 * own program page, not assumed from trained memory (both fetched
 * 2026-09-14). This is the natural companion to `payroll/calSavers.ts`
 * for THIS project's own demo company, whose home state is Illinois.
 *
 * A GENUINELY DIFFERENT COVERAGE TEST than CalSavers: Illinois requires
 * 5+ employees AND 2+ years in business (CalSavers has no years-in-
 * business test at all, and its own phase-in schedule has fully run its
 * course down to 1 employee). And a GENUINELY DIFFERENT PENALTY
 * STRUCTURE: Illinois assesses a flat $250/employee for the employer's
 * first calendar year of noncompliance and $500/employee for EACH
 * subsequent noncompliant calendar year (which need not be consecutive)
 * — a per-YEAR structure, not CalSavers' own per-employee flat-plus-
 * additional model. This module deliberately does NOT reuse any of
 * `payroll/calSavers.ts`'s constants or functions even where the
 * concepts rhyme, since conflating two different states' own thresholds
 * or penalty math is exactly the kind of error this project's own
 * discipline (see payroll/cobra.ts's own header on not reusing another
 * statute's headcount definition) exists to prevent.
 *
 * DISCLOSED GAP: unlike CalSavers, this project could not confirm an
 * automatic annual contribution-rate escalation for Illinois Secure
 * Choice from either primary source consulted — only the flat 5%
 * default is confirmed, so no escalation function is offered here rather
 * than guessing one exists (or guessing its size) by analogy to
 * CalSavers.
 */

/** IDOR bulletin: covers employers with at least this many employees. */
export const IL_SECURE_CHOICE_EMPLOYER_THRESHOLD = 5;

/** IDOR bulletin: covers employers in business at least this many years. */
export const IL_SECURE_CHOICE_MIN_YEARS_IN_BUSINESS = 2;

/** Illinois State Treasurer: the default automatic-enrollment contribution rate (a Roth IRA, after-tax). No confirmed automatic escalation — see this module's own header. */
export const IL_SECURE_CHOICE_DEFAULT_CONTRIBUTION_RATE = 0.05;

/** 820 ILCS 80/85, via IDOR bulletin FY 2023-09: Tier I penalty, per employee, for the employer's FIRST calendar year of noncompliance. */
export const IL_SECURE_CHOICE_TIER1_PENALTY_PER_EMPLOYEE: Cents = dollars(250);

/** 820 ILCS 80/85: Tier II penalty, per employee, for EACH subsequent calendar year of noncompliance — need not be consecutive with the first. */
export const IL_SECURE_CHOICE_TIER2_PENALTY_PER_EMPLOYEE: Cents = dollars(500);

/** IDOR bulletin: an employer that comes into compliance within this many days of its IDOR-2P-NT (Notice of Proposed Assessment) avoids the proposed penalty assessment entirely. */
export const IL_SECURE_CHOICE_CURE_PERIOD_DAYS = 120;

/** True once an employer meets ALL THREE of Illinois's own coverage conditions: 5+ employees, 2+ years in business, and no qualified retirement plan of its own. */
export function isIlSecureChoiceMandatory(employeeCount: number, yearsInBusiness: number, hasQualifiedRetirementPlan: boolean): boolean {
  return employeeCount >= IL_SECURE_CHOICE_EMPLOYER_THRESHOLD && yearsInBusiness >= IL_SECURE_CHOICE_MIN_YEARS_IN_BUSINESS && !hasQualifiedRetirementPlan;
}

/**
 * Total penalty exposure across every eligible employee, for a given
 * number of noncompliant calendar years (need not be consecutive, per
 * the statute) — the first year at the Tier I rate, every year after
 * that at the (higher) Tier II rate. Zero noncompliant years means zero
 * exposure.
 */
export function ilSecureChoicePenaltyExposure(eligibleEmployeeCount: number, noncompliantCalendarYears: number): Cents {
  if (noncompliantCalendarYears <= 0) return 0;
  const subsequentYears = noncompliantCalendarYears - 1;
  const perEmployee = IL_SECURE_CHOICE_TIER1_PENALTY_PER_EMPLOYEE + subsequentYears * IL_SECURE_CHOICE_TIER2_PENALTY_PER_EMPLOYEE;
  return eligibleEmployeeCount * perEmployee;
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function ilSecureChoiceCureDeadline(noticeIssueDate: string): string {
  return addDays(noticeIssueDate, IL_SECURE_CHOICE_CURE_PERIOD_DAYS);
}

export function isWithinIlSecureChoiceCurePeriod(noticeIssueDate: string, asOfDate: string): boolean {
  return asOfDate <= ilSecureChoiceCureDeadline(noticeIssueDate);
}
