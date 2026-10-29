import type { Cents } from '../src/money.ts';
import { dollars } from '../src/money.ts';

/**
 * CalSavers, California's state-run auto-IRA retirement program (Cal.
 * Gov. Code §§ 100000 et seq.) — LIVE-VERIFIED against the program's own
 * site and the statute's own penalty text, not assumed from trained
 * memory:
 *  - https://www.treasurer.ca.gov/calsavers/ ("Effective January 1, 2026,
 *    all California employers with one or more employees are required by
 *    law to provide access to a qualified retirement program or certify
 *    a valid exemption" — the size-tiered phase-in schedule that
 *    preceded this project's own current date has fully run its course)
 *  - Cal. Gov. Code § 100033(b)(2), fetched via leginfo.legislature.ca.gov
 *    (the exact penalty figures)
 * (both fetched 2026-09-13).
 *
 * ONE STATE ONLY. Several other states run their own auto-IRA/mandatory
 * retirement programs (OregonSaves, Illinois Secure Choice, and others,
 * each with its own rate/escalation/penalty figures) — those remain a
 * disclosed gap, the same "one jurisdiction modeled, the rest named as
 * missing" boundary payroll/paidSickLeave.ts and payroll/workersComp.ts
 * already draw.
 *
 * DISCLOSED GAP: the statute's $500 additional penalty applies "if
 * noncompliance continues," but this project could not independently
 * verify the exact number of days after the first FTB notice that
 * triggers it — rather than guess at a compliance deadline, this module
 * takes "does noncompliance continue" as a caller-supplied fact, the
 * same "count/fact supplied, not derived" choice payroll/cobra.ts and
 * payroll/warnAct.ts already make for their own caller-supplied
 * headcounts.
 */

export const CALSAVERS_EFFECTIVE_DATE = '2026-01-01';

/** CalSavers auto-enrolls a participating employee at this default contribution rate (after-tax, Roth-style) absent an opt-out or a different elected rate. */
export const CALSAVERS_DEFAULT_CONTRIBUTION_RATE = 0.05;

/** The default rate escalates by this many percentage points each year the employee remains enrolled at the default (absent an opt-out or an employee-elected override). */
export const CALSAVERS_ANNUAL_ESCALATION_RATE = 0.01;

/** The escalating default rate never exceeds this cap. */
export const CALSAVERS_MAX_CONTRIBUTION_RATE = 0.08;

/** Gov. Code § 100033(b)(2): the first penalty the Franchise Tax Board assesses per eligible employee for noncompliance. */
export const CALSAVERS_FIRST_PENALTY_PER_EMPLOYEE: Cents = dollars(250);

/** Gov. Code § 100033(b)(2): an ADDITIONAL per-employee penalty (on top of, not instead of, the first) once noncompliance continues — bringing total exposure to $750/employee. */
export const CALSAVERS_ADDITIONAL_PENALTY_PER_EMPLOYEE: Cents = dollars(500);

/** True once an employer with at least one employee, no qualified retirement plan of its own, is required to register with CalSavers (or certify an exemption) as of the given date — every California employer, regardless of size, once the given date is on or after the program's now-fully-phased-in effective date. */
export function isCalSaversMandatory(employeeCount: number, hasQualifiedRetirementPlan: boolean, asOfDate: string): boolean {
  return employeeCount >= 1 && !hasQualifiedRetirementPlan && asOfDate >= CALSAVERS_EFFECTIVE_DATE;
}

/**
 * The default contribution rate at a given number of full years enrolled
 * — 5% at enrollment, escalating 1 point per year, capped at 8% (reached
 * at year 3 and thereafter). Doesn't apply to an employee who opted out
 * or elected a different rate. Computed in integer basis points rather
 * than adding floating-point percentages directly (0.05 + 0.01 is
 * 0.060000000000000005 in IEEE 754, not the exact 0.06 a percentage
 * comparison needs) — the same "never let floating point drift into a
 * figure that must compare exactly" discipline this project's own
 * src/money.ts applies to dollar amounts via integer cents.
 */
export function calSaversDefaultContributionRate(fullYearsEnrolled: number): number {
  const basisPoints = Math.round(CALSAVERS_DEFAULT_CONTRIBUTION_RATE * 10_000) + fullYearsEnrolled * Math.round(CALSAVERS_ANNUAL_ESCALATION_RATE * 10_000);
  const capBasisPoints = Math.round(CALSAVERS_MAX_CONTRIBUTION_RATE * 10_000);
  return Math.min(basisPoints, capBasisPoints) / 10_000;
}

/** Total penalty exposure across every eligible employee — the $250 first penalty alone, or $750 total ($250 + the $500 additional penalty) once noncompliance continues. */
export function calSaversPenaltyExposure(eligibleEmployeeCount: number, noncomplianceContinues: boolean): Cents {
  const perEmployee = noncomplianceContinues
    ? CALSAVERS_FIRST_PENALTY_PER_EMPLOYEE + CALSAVERS_ADDITIONAL_PENALTY_PER_EMPLOYEE
    : CALSAVERS_FIRST_PENALTY_PER_EMPLOYEE;
  return eligibleEmployeeCount * perEmployee;
}
