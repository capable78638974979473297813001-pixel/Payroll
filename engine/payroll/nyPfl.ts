import type { Cents } from '../src/money.ts';
import { dollars } from '../src/money.ts';

/**
 * New York Paid Family Leave (PFL, N.Y. Workers' Compensation Law
 * Article 9) — LIVE-VERIFIED against the New York Workers' Compensation
 * Board's own 2026 press release and paidfamilyleave.ny.gov's own
 * eligibility page, not assumed from trained memory:
 *  - https://www.wcb.ny.gov/content/main/PressRe/paid-family-leave-2026.jsp
 *  - https://paidfamilyleave.ny.gov/eligibility
 * (both fetched 2026-09-14).
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO: compute the employee
 * PAYROLL WITHHOLDING that funds PFL. That's ALREADY correctly modeled
 * in this project's own core tax engine — `data/states/NY-2026.json`'s
 * `statePaidLeaveEmployee` config (rate 0.00432, annual cap $411.91),
 * dispatched through `src/taxes/state.ts`'s own generic
 * `statePaidLeaveEmployeeTax()` (the same mechanism Minnesota's Paid
 * Leave program already uses) — live-sourced and already covered by
 * this project's own engine test suite. Reimplementing that calculation
 * here would risk exactly the "two different, possibly divergent,
 * calculations of the same figure" failure mode this project's own
 * discipline exists to prevent (see payroll/cobra.ts's own header on
 * not reusing another statute's headcount definition inconsistently).
 *
 * WHAT THIS MODULE ACTUALLY ADDS: the two things the core tax engine's
 * own withholding calculation has no reason to compute — (1) basic
 * eligibility (the tenure test an employee must clear before PFL applies
 * at all) and (2) the BENEFIT an eligible employee actually receives
 * while on leave, which is a wage-replacement PAYMENT from the state's
 * PFL insurance carrier, not a payroll withholding, and genuinely not
 * modeled anywhere else in this project.
 *
 * YEAR-SPECIFIC dollar constants, the same convention payroll/aca.ts and
 * payroll/retirementLimits.ts already use — only the CURRENT (2026)
 * benefit figures are modeled.
 *
 * SCOPE: does not track an actual leave request end to end (dates,
 * carrier claim, return-to-work) — a real, separate persistence workflow
 * not built here, the same category of gap payroll/fmla.ts's own header
 * discloses for FMLA leave requests.
 */

/** paidfamilyleave.ny.gov: a full-time schedule is 20+ hours/week, eligible after this many CONSECUTIVE weeks of employment. */
export const NY_PFL_FULL_TIME_HOURS_PER_WEEK_THRESHOLD = 20;

export const NY_PFL_FULL_TIME_ELIGIBILITY_WEEKS = 26;

/** A part-time schedule (under 20 hours/week) is eligible after this many days worked — need NOT be consecutive, and may accumulate across more than one year. */
export const NY_PFL_PART_TIME_ELIGIBILITY_DAYS = 175;

/** WCB 2026: the New York State Average Weekly Wage (NYSAWW) — the figure the maximum weekly benefit is calculated from. */
export const NY_PFL_STATEWIDE_AVERAGE_WEEKLY_WAGE_2026: Cents = dollars(1_833.63);

/** WCB: the fraction of an employee's own average weekly wage paid during PFL leave. */
export const NY_PFL_WAGE_REPLACEMENT_RATE = 0.67;

/** WCB 2026: the maximum weekly benefit — 67% of the statewide average weekly wage, not 67% of the employee's own wage once that exceeds the statewide average. */
export const NY_PFL_MAX_WEEKLY_BENEFIT_2026: Cents = dollars(1_228.53);

/** WCB: the maximum duration of job-protected, paid leave available under the program. */
export const NY_PFL_MAX_LEAVE_WEEKS = 12;

/** True once a full-time (20+ hours/week) employee has cleared the 26-consecutive-week tenure test. */
export function isFullTimePflEligible(hoursPerWeek: number, consecutiveWeeksEmployed: number): boolean {
  return hoursPerWeek >= NY_PFL_FULL_TIME_HOURS_PER_WEEK_THRESHOLD && consecutiveWeeksEmployed >= NY_PFL_FULL_TIME_ELIGIBILITY_WEEKS;
}

/** True once a part-time (under 20 hours/week) employee has accumulated 175 days worked — need not be consecutive or within a single year. */
export function isPartTimePflEligible(hoursPerWeek: number, totalDaysWorked: number): boolean {
  return hoursPerWeek < NY_PFL_FULL_TIME_HOURS_PER_WEEK_THRESHOLD && totalDaysWorked >= NY_PFL_PART_TIME_ELIGIBILITY_DAYS;
}

export function isPflEligible(hoursPerWeek: number, consecutiveWeeksEmployed: number, totalDaysWorked: number): boolean {
  return isFullTimePflEligible(hoursPerWeek, consecutiveWeeksEmployed) || isPartTimePflEligible(hoursPerWeek, totalDaysWorked);
}

/** The weekly benefit for an employee's own average weekly wage — 67% of it, capped at 67% of the statewide average weekly wage regardless of how much higher the employee's own wage is. */
export function nyPflWeeklyBenefit(averageWeeklyWageCents: Cents): Cents {
  return Math.min(Math.round(averageWeeklyWageCents * NY_PFL_WAGE_REPLACEMENT_RATE), NY_PFL_MAX_WEEKLY_BENEFIT_2026);
}
