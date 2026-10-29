import type { Cents } from '../src/money.ts';
import { dollars } from '../src/money.ts';

/**
 * Oregon's Fair Work Week Act (S.B. 828 (2017), codified at ORS
 * 653.412-653.485; predictability-pay formula at ORS 653.455) — LIVE-
 * VERIFIED against a law-review article that quotes the statute's own
 * section numbers directly, corroborated against an independent
 * secondary source's own paraphrase of ORS 653.455's two pay formulas
 * and its full exception list, not assumed from trained memory.
 * Fetched/cross-checked 2026-09-14. Oregon remains the only STATEWIDE
 * predictive-scheduling law in the country — Chicago, New York City,
 * Philadelphia, San Francisco, and Seattle each run their own separate
 * municipal ordinances, which remain a disclosed gap, the same "one
 * jurisdiction modeled, the rest named as missing" boundary
 * `payroll/fairChanceAct.ts` and `payroll/paidSickLeave.ts` already draw.
 *
 * COVERAGE IS NARROW ON PURPOSE: 500+ employees WORLDWIDE (not just in
 * Oregon), in "retail trade" (which itself includes hotels, motels, and
 * food service), and only for non-exempt HOURLY employees — salaried
 * exempt employees at the same covered employer are outside the Act
 * entirely, a distinction `isOrFairWorkWeekCoveredEmployer()` requires
 * as an explicit input rather than assuming every employee at a covered
 * employer is covered.
 *
 * TWO GENUINELY DIFFERENT PAY FORMULAS, not one flat "predictability
 * pay" rate: an ADDITIVE change (adding more than 30 minutes to a
 * shift, moving a shift's start/end time with no loss of hours, or
 * adding a shift/on-call assignment) owes a flat ONE HOUR of pay at the
 * regular rate, regardless of how much time was actually added — a
 * cancelled 8-hour shift added back the next day still owes only one
 * hour extra, not eight. A SUBTRACTIVE change (cutting hours before or
 * after the employee reports, or a time change that reduces hours) owes
 * HALF the regular rate for EACH scheduled hour the employee does not
 * work — this one DOES scale with the size of the cut, the opposite
 * shape from the additive formula. Conflating the two formulas would be
 * exactly the kind of error `payroll/cobra.ts`'s own header warns
 * against.
 *
 * SCOPE: exposes the statute's own exception list as a named enum with
 * guidance text (the same `warnExceptionGuidance()`-style pattern
 * `payroll/warnAct.ts` already uses) rather than attempting to compute
 * whether a specific real-world change actually qualifies — "legitimate
 * disciplinary reasons for just cause," a genuine "threat to safety,"
 * and an "unanticipated customer need" are fact-specific judgment calls
 * with no formula, the same kind of scope boundary
 * `payroll/warnAct.ts`'s own exception guidance draws. This module
 * takes the exemption determination as a caller-supplied boolean rather
 * than deriving it.
 */

/** ORS 653.412: covers employers with this many employees WORLDWIDE, not just in Oregon. */
export const OR_FAIR_WORK_WEEK_EMPLOYER_THRESHOLD = 500;

/** ORS 653.436: the required advance written notice period for a current employee's work schedule. */
export const OR_FAIR_WORK_WEEK_ADVANCE_NOTICE_DAYS = 14;

/** ORS 653.455: a schedule change of this many minutes or less owes no additional compensation at all. */
export const OR_FAIR_WORK_WEEK_DE_MINIMIS_MINUTES = 30;

/** ORS 653.455: the flat additive-change pay is exactly one hour at the regular rate, regardless of how much time was actually added. */
export const OR_FAIR_WORK_WEEK_ADDITIVE_CHANGE_HOURS = 1;

/** ORS 653.455: the subtractive-change pay rate, applied per scheduled hour the employee does not work. */
export const OR_FAIR_WORK_WEEK_SUBTRACTIVE_CHANGE_RATE = 0.5;

/** ORS 653.436 / S.B. 828 § 6: the minimum required rest period between shifts. */
export const OR_FAIR_WORK_WEEK_REST_PERIOD_HOURS = 10;

/** The premium rate owed for any hours actually worked during the 10-hour rest period, even with the employee's consent. */
export const OR_FAIR_WORK_WEEK_REST_PERIOD_PREMIUM_RATE = 1.5;

/** BOLI's own civil penalty range, per violation per day. */
export const OR_FAIR_WORK_WEEK_PENALTY_MIN: Cents = dollars(500);
export const OR_FAIR_WORK_WEEK_PENALTY_MAX: Cents = dollars(2_000);

export type OrFairWorkWeekExceptionReason =
  | 'employee_initiated_swap'
  | 'employee_written_request'
  | 'disciplinary_with_documentation'
  | 'threat_to_safety_or_property'
  | 'public_utility_failure'
  | 'natural_disaster'
  | 'ticketed_event_cancellation'
  | 'voluntary_standby_consent'
  | 'unanticipated_need_with_consent';

/** ORS 653.455's own exception list — every listed reason exempts the change from predictability pay, the same fact-specific-judgment scope boundary payroll/warnAct.ts's own exception guidance draws. */
export function orFairWorkWeekExceptionGuidance(reason: OrFairWorkWeekExceptionReason): string {
  switch (reason) {
    case 'employee_initiated_swap':
      return 'A shift swap or trade mutually agreed to by two employees, initiated by an employee rather than the employer.';
    case 'employee_written_request':
      return 'The employee requested the specific change in writing, and the employer granted it.';
    case 'disciplinary_with_documentation':
      return 'Hours were reduced for legitimate disciplinary reasons for just cause, documented in writing at the time.';
    case 'threat_to_safety_or_property':
      return 'A threat to employees or property made the work not able to be performed as scheduled.';
    case 'public_utility_failure':
      return 'Operations were affected by a failure of public utilities (power, water, gas, etc.).';
    case 'natural_disaster':
      return 'Operations were affected by a natural disaster.';
    case 'ticketed_event_cancellation':
      return 'A ticketed event the shift supported was cancelled or rescheduled for reasons outside the employer\'s control.';
    case 'voluntary_standby_consent':
      return 'The employee is on a voluntary standby list and consented to the additional hours.';
    case 'unanticipated_need_with_consent':
      return 'An unanticipated customer need or unexpected employee absence required additional hours, with the employee\'s written consent (and, if not currently working, a group communication to eligible employees).';
  }
}

/** True once BOTH of the Act's own coverage conditions hold: 500+ employees worldwide, and this specific employee is a non-exempt hourly worker (salaried exempt employees are outside the Act entirely). */
export function isOrFairWorkWeekCoveredEmployer(employeeCountWorldwide: number, isNonExemptHourlyEmployee: boolean): boolean {
  return employeeCountWorldwide >= OR_FAIR_WORK_WEEK_EMPLOYER_THRESHOLD && isNonExemptHourlyEmployee;
}

/** ORS 653.455: a change of 30 minutes or less owes no additional compensation, regardless of which category it would otherwise fall into. */
export function isOrFairWorkWeekChangeDeMinimis(changeMinutes: number): boolean {
  return changeMinutes <= OR_FAIR_WORK_WEEK_DE_MINIMIS_MINUTES;
}

/** The flat additive-change pay: one hour at the regular rate, whether the addition was 31 minutes or 8 hours. */
export function orFairWorkWeekAdditiveChangePay(regularRateCentsPerHour: Cents): Cents {
  return Math.round(regularRateCentsPerHour * OR_FAIR_WORK_WEEK_ADDITIVE_CHANGE_HOURS);
}

/** The subtractive-change pay: half the regular rate for EACH scheduled hour the employee does not work — this formula scales with the size of the cut, unlike the flat additive formula. */
export function orFairWorkWeekSubtractiveChangePay(regularRateCentsPerHour: Cents, scheduledHoursNotWorked: number): Cents {
  if (scheduledHoursNotWorked <= 0) return 0;
  return Math.round(regularRateCentsPerHour * OR_FAIR_WORK_WEEK_SUBTRACTIVE_CHANGE_RATE * scheduledHoursNotWorked);
}

/** True when the gap between two shifts falls below the Act's own 10-hour rest-period floor. */
export function isOrFairWorkWeekRestPeriodViolation(hoursBetweenShifts: number): boolean {
  return hoursBetweenShifts < OR_FAIR_WORK_WEEK_REST_PERIOD_HOURS;
}

/** The 1.5x premium owed for any hours actually worked during the 10-hour rest period, even where the employee consented to work them. */
export function orFairWorkWeekRestPeriodPremiumPay(regularRateCentsPerHour: Cents, hoursWorkedDuringRestPeriod: number): Cents {
  if (hoursWorkedDuringRestPeriod <= 0) return 0;
  return Math.round(regularRateCentsPerHour * OR_FAIR_WORK_WEEK_REST_PERIOD_PREMIUM_RATE * hoursWorkedDuringRestPeriod);
}

/** Clamps a considered per-violation, per-day civil penalty into BOLI's own $500-$2,000 range. */
export function clampOrFairWorkWeekPenalty(consideredPenaltyCents: Cents): Cents {
  return Math.min(Math.max(consideredPenaltyCents, OR_FAIR_WORK_WEEK_PENALTY_MIN), OR_FAIR_WORK_WEEK_PENALTY_MAX);
}
