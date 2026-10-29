import type { Cents } from '../src/money.ts';
import { dollars } from '../src/money.ts';

/**
 * OregonSaves, the state-run auto-IRA program (ORS 178.200 et seq.) —
 * LIVE-VERIFIED against the program's own published rules, corroborated
 * across multiple independent state-retirement-mandate compliance
 * sources for the coverage test, escalation figures, and penalty
 * structure, not assumed from trained memory. Fetched/cross-checked
 * 2026-09-14.
 *
 * A THIRD state auto-IRA module alongside `payroll/calSavers.ts`
 * (California) and `payroll/ilSecureChoice.ts` (Illinois) — deliberately
 * its own module with its own constants, never reusing a sibling's, for
 * the same reason `payroll/ilSecureChoice.ts`'s own header gives:
 * conflating two states' own thresholds or penalty math is exactly the
 * kind of error this project's discipline (see `payroll/cobra.ts`'s own
 * header) exists to prevent.
 *
 * THE SIMPLEST COVERAGE TEST OF THE THREE: OregonSaves has NO employee-
 * count threshold and NO years-in-business test at all — every Oregon
 * employer with at least one employee and no qualified retirement plan
 * of its own is covered (Illinois requires 5+ employees AND 2+ years in
 * business; CalSavers' own phase-in has settled at 1+ employees but
 * still applies no years-in-business test). The escalation SHAPE matches
 * CalSavers' own +1 percentage point per year, but the CAP is different:
 * OregonSaves escalates from a 5% default up to 10% (five years to reach
 * the cap), not CalSavers' own 8% ceiling — and Illinois Secure Choice
 * offers no confirmed escalation at all, per that module's own disclosed
 * gap. THE PENALTY STRUCTURE IS ALSO GENUINELY DIFFERENT: $100 per
 * affected employee, but CAPPED AT $5,000 PER CALENDAR YEAR per employer
 * — neither CalSavers' nor Illinois Secure Choice's own per-employee
 * penalties are capped this way, so a large noncompliant employer's
 * exposure here can be lower, not higher, than a small one's per-
 * employee rate alone would suggest.
 *
 * SCOPE: does not model the "qualified retirement plan" exemption test
 * itself (whether a specific employer-sponsored plan counts) — this
 * module takes `hasQualifiedRetirementPlan` as a caller-supplied fact,
 * the same boundary `payroll/ilSecureChoice.ts`'s own coverage function
 * draws.
 */

/** OregonSaves's own program rules: covers every employer with at least this many employees — no years-in-business test at all. */
export const OREGON_SAVES_EMPLOYER_THRESHOLD = 1;

/** OregonSaves: the default automatic-enrollment contribution rate (a Roth IRA, after-tax). */
export const OREGON_SAVES_DEFAULT_CONTRIBUTION_RATE = 0.05;

/** OregonSaves: the contribution rate escalates by this many percentage points for each full year enrolled. */
export const OREGON_SAVES_ANNUAL_ESCALATION_RATE = 0.01;

/** OregonSaves: the contribution rate never escalates past this ceiling (reached after five full years enrolled, starting from the 5% default). */
export const OREGON_SAVES_MAX_CONTRIBUTION_RATE = 0.1;

/** OregonSaves's own penalty structure: this many dollars per affected employee for noncompliance. */
export const OREGON_SAVES_PENALTY_PER_EMPLOYEE: Cents = dollars(100);

/** Unlike CalSavers' or Illinois Secure Choice's own uncapped per-employee penalties, OregonSaves caps total exposure at this amount PER EMPLOYER, per calendar year. */
export const OREGON_SAVES_MAX_PENALTY_PER_CALENDAR_YEAR: Cents = dollars(5_000);

/** True once an employer meets BOTH of OregonSaves's own coverage conditions: at least one employee, and no qualified retirement plan of its own. */
export function isOregonSavesMandatory(employeeCount: number, hasQualifiedRetirementPlan: boolean): boolean {
  return employeeCount >= OREGON_SAVES_EMPLOYER_THRESHOLD && !hasQualifiedRetirementPlan;
}

/**
 * The escalated contribution rate for a saver who has completed the
 * given number of full years enrolled, capped at the program's own 10%
 * ceiling — computed in basis points to avoid floating-point drift
 * across repeated additions, the same technique `payroll/calSavers.ts`
 * uses for its own escalation.
 */
export function oregonSavesContributionRate(fullYearsEnrolled: number): number {
  const basisPoints = Math.round(OREGON_SAVES_DEFAULT_CONTRIBUTION_RATE * 10_000) + fullYearsEnrolled * Math.round(OREGON_SAVES_ANNUAL_ESCALATION_RATE * 10_000);
  const capBasisPoints = Math.round(OREGON_SAVES_MAX_CONTRIBUTION_RATE * 10_000);
  return Math.min(basisPoints, capBasisPoints) / 10_000;
}

/**
 * Total penalty exposure for a noncompliant employer: $100 per affected
 * employee, capped at $5,000 for the calendar year regardless of how
 * many employees that would otherwise multiply out to.
 */
export function oregonSavesPenaltyExposure(affectedEmployeeCount: number): Cents {
  if (affectedEmployeeCount <= 0) return 0;
  const uncapped = affectedEmployeeCount * OREGON_SAVES_PENALTY_PER_EMPLOYEE;
  return Math.min(uncapped, OREGON_SAVES_MAX_PENALTY_PER_CALENDAR_YEAR);
}
