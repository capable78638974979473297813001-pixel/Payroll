import type { Cents } from '../src/money.ts';

/**
 * California's "waiting time" penalty for a late final paycheck (Labor
 * Code § 203) — LIVE-VERIFIED against the California Division of Labor
 * Standards Enforcement's own FAQ, not assumed from trained memory:
 *  - https://www.dir.ca.gov/dlse/FAQ_Paydays.htm
 * (fetched 2026-09-13), corroborated on the daily-rate calculation
 * methodology across multiple independent CA employment-law sources.
 *
 * ONE STATE ONLY. This is the natural companion to
 * payroll/termination.ts's own `finalPayDueDate()`, which computes WHEN
 * final wages are due but stops there — this module computes what's
 * owed when that deadline is missed. Other states have their own late-
 * final-pay penalty regimes (New York's own liquidated-damages
 * provisions under NYLL § 198 are a different statute with different
 * figures) — those remain a disclosed gap, the same "one jurisdiction
 * modeled, the rest named as missing" boundary payroll/paidSickLeave.ts
 * and payroll/workersComp.ts already draw.
 *
 * SCOPE: the penalty formula itself — a full day's wages for every
 * CALENDAR day late (weekends and holidays count), capped at 30 days.
 * Deliberately does NOT evaluate the statute's "good faith dispute"
 * defense (an employer who reasonably and honestly disputes the wages
 * owed, not in bad faith and not on an unsupported basis, may avoid the
 * penalty entirely) — that is a fact-specific determination about the
 * employer's own state of mind and the strength of its position, not a
 * formula, the same kind of legal-judgment boundary payroll/warnAct.ts's
 * own exception-guidance functions already draw.
 */

/** Cal. Labor Code § 203: the penalty accrues for at most this many calendar days, however much longer the wages actually remain unpaid. */
export const WAITING_TIME_PENALTY_MAX_DAYS = 30;

function daysBetween(isoA: string, isoB: string): number {
  const [ya, ma, da] = isoA.split('-').map(Number);
  const [yb, mb, db] = isoB.split('-').map(Number);
  const utcA = Date.UTC(ya, ma - 1, da);
  const utcB = Date.UTC(yb, mb - 1, db);
  return Math.round((utcB - utcA) / (24 * 60 * 60 * 1000));
}

/** How many CALENDAR days late a final payment was — weekends and holidays count, unlike a business-day count elsewhere in this project. Never negative: a payment on or before the due date is 0 days late, not a negative number of days early. */
export function waitingTimePenaltyDaysLate(dueDate: string, actualPaymentDate: string): number {
  return Math.max(0, daysBetween(dueDate, actualPaymentDate));
}

/** The employee's "daily rate of pay" for this purpose — their normal hourly rate times their normal daily hours (commonly 8 for a full-time employee), not a 24-hour calendar day's worth of any other figure. */
export function waitingTimeDailyRate(hourlyRateCents: Cents, normalDailyHours: number): Cents {
  return Math.round(hourlyRateCents * normalDailyHours);
}

/** The total penalty: the daily rate times the days late, capped at the 30-day maximum accrual regardless of how much longer the wages actually stayed unpaid. */
export function waitingTimePenaltyAmount(dailyRateCents: Cents, daysLate: number): Cents {
  const cappedDays = Math.min(daysLate, WAITING_TIME_PENALTY_MAX_DAYS);
  return Math.round(dailyRateCents * cappedDays);
}
