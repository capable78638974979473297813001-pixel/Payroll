import type { Cents } from '../src/money.ts';

/**
 * California meal and rest period requirements (Labor Code §§ 226.7,
 * 512; IWC Wage Orders) — LIVE-VERIFIED against the California Division
 * of Labor Standards Enforcement's own FAQ pages, not assumed from
 * trained memory:
 *  - https://www.dir.ca.gov/dlse/faq_mealperiods.htm
 *  - https://www.dir.ca.gov/dlse/FAQ_RestPeriods.htm
 * (both fetched 2026-09-13).
 *
 * ONE STATE ONLY. California is the one jurisdiction this module models
 * explicitly; other states with their own meal/rest requirements (a
 * genuinely different, smaller set of rules each) remain a disclosed
 * gap, the same "one jurisdiction modeled, the rest named as missing"
 * boundary payroll/paidSickLeave.ts and payroll/workersComp.ts already
 * draw.
 *
 * THE DAILY CAP: the "one additional hour of pay... for each workday"
 * premium is, per the DLSE's own long-standing enforcement position
 * (Enforcement Policies & Interpretations Manual § 45.2.7, applied
 * consistently since before this project's other CA-specific research),
 * owed AT MOST ONCE for ANY number of meal-period violations in a
 * workday and AT MOST ONCE SEPARATELY for ANY number of rest-period
 * violations that same day — never once per individual missed break.
 * This module's own functions take a single boolean per category (did
 * a violation happen at all that day) rather than a violation COUNT,
 * which structurally enforces that cap rather than requiring a caller
 * to separately remember it.
 *
 * SCOPE: pure eligibility/premium math over hours worked and a caller-
 * supplied violation flag — this project's timekeeping
 * (payroll/timeAndAttendance.ts) has no notion of when a break was
 * actually taken during a shift, so whether a compliant break actually
 * occurred is a fact this module takes as an input, not one it derives
 * from punch data.
 */

/** DIR: the first meal period must begin no later than the end of this many hours of work. */
export const CA_FIRST_MEAL_PERIOD_DEADLINE_HOURS = 5;

/** DIR: a first meal period may be waived by mutual consent only if the total workday is at or under this many hours. */
export const CA_FIRST_MEAL_WAIVER_MAX_HOURS = 6;

/** DIR: a second meal period is required once the workday exceeds this many hours. */
export const CA_SECOND_MEAL_PERIOD_THRESHOLD_HOURS = 10;

/** DIR: a second meal period may be waived by mutual consent only if the total workday is at or under this many hours AND the first meal period was not itself waived. */
export const CA_SECOND_MEAL_WAIVER_MAX_HOURS = 12;

export const CA_MEAL_PERIOD_MINIMUM_MINUTES = 30;

/** DIR: no rest break is required at all below this many hours of daily work time. */
export const CA_REST_BREAK_EXEMPTION_THRESHOLD_HOURS = 3.5;

export const CA_REST_BREAK_MINUTES = 10;

/** § 226.7: the premium for a violation — one additional hour of pay at the employee's regular rate, per category (meal or rest), per workday. */
export const CA_BREAK_PREMIUM_HOURS = 1;

/** True once a workday is long enough to require a first meal period at all (waivable up to 6 hours — see isFirstMealPeriodWaivable). */
export function isFirstMealPeriodRequired(hoursWorked: number): boolean {
  return hoursWorked > CA_FIRST_MEAL_PERIOD_DEADLINE_HOURS;
}

export function isFirstMealPeriodWaivable(hoursWorked: number): boolean {
  return hoursWorked <= CA_FIRST_MEAL_WAIVER_MAX_HOURS;
}

export function isSecondMealPeriodRequired(hoursWorked: number): boolean {
  return hoursWorked > CA_SECOND_MEAL_PERIOD_THRESHOLD_HOURS;
}

/** The second meal period may only be waived if the workday is at or under 12 hours AND the first meal period was actually taken (not itself waived). */
export function isSecondMealPeriodWaivable(hoursWorked: number, firstMealPeriodWaived: boolean): boolean {
  return hoursWorked <= CA_SECOND_MEAL_WAIVER_MAX_HOURS && !firstMealPeriodWaived;
}

export function isRestBreakRequired(hoursWorked: number): boolean {
  return hoursWorked >= CA_REST_BREAK_EXEMPTION_THRESHOLD_HOURS;
}

/**
 * DIR: "net ten consecutive minutes for each four hour work period, or
 * major fraction thereof" (over half of a 4-hour block triggers another
 * break) — the standard DLSE-endorsed schedule: 0 below 3.5 hours, 1
 * from 3.5 up to and including 6, 2 from just over 6 up to and including
 * 10, 3 from just over 10 up to and including 14, and so on.
 */
export function restBreaksRequired(hoursWorked: number): number {
  if (hoursWorked < CA_REST_BREAK_EXEMPTION_THRESHOLD_HOURS) return 0;
  const fullBlocks = Math.floor(hoursWorked / 4);
  const remainder = hoursWorked % 4;
  return fullBlocks + (remainder > 2 ? 1 : 0);
}

/** One hour of pay at the regular rate if ANY meal-period violation occurred that workday — never more than one, however many meal periods were actually missed/short/late/interrupted that day. */
export function mealPeriodPremium(mealPeriodViolationOccurred: boolean, regularRateCents: Cents): Cents {
  return mealPeriodViolationOccurred ? CA_BREAK_PREMIUM_HOURS * regularRateCents : 0;
}

/** One hour of pay at the regular rate if ANY rest-period violation occurred that workday — never more than one, however many rest breaks were actually missed/short that day. */
export function restPeriodPremium(restPeriodViolationOccurred: boolean, regularRateCents: Cents): Cents {
  return restPeriodViolationOccurred ? CA_BREAK_PREMIUM_HOURS * regularRateCents : 0;
}

/** The two premiums are independent and additive (a workday can owe both), but each is itself capped at one hour regardless of how many violations of that TYPE occurred — so this never exceeds 2 hours of premium pay for one workday. */
export function dailyMealAndRestPremium(mealPeriodViolationOccurred: boolean, restPeriodViolationOccurred: boolean, regularRateCents: Cents): Cents {
  return mealPeriodPremium(mealPeriodViolationOccurred, regularRateCents) + restPeriodPremium(restPeriodViolationOccurred, regularRateCents);
}
