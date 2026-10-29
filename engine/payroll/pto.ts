import type { Cents } from '../src/money.ts';
import type { Earning } from '../src/types.ts';

/**
 * Paid-time-off accrual as an EMPLOYER POLICY engine: accrue hours, track a
 * balance, spend it, cap it, carry it over at year end. Deliberately NOT a
 * model of the roughly 20 states' own MANDATORY paid-sick-leave accrual
 * laws (each with its own minimum accrual rate, usage caps, and carryover
 * rules — a legal-research project of the same shape and size as this
 * project's minimum-wage database, which took a dedicated multi-pass
 * effort to build correctly) — this is disclosed here rather than
 * force-fit, the same choice payroll/timeAndAttendance.ts makes for the
 * states whose overtime law it doesn't model. What this module DOES
 * guarantee is correct: whatever policy numbers an employer configures are
 * applied exactly, capped exactly, and never silently lost.
 */

export type PtoAccrualMethod =
  | { kind: 'perHourWorked'; hoursAccruedPerHourWorked: number }
  | { kind: 'perPayPeriod'; hoursPerPeriod: number };

export interface PtoPolicy {
  id: string;
  name: string;
  accrual: PtoAccrualMethod;
  /** The balance never accrues past this many hours — additional accrual is simply not credited (an "accrual cap", the common employer-side control; not to be confused with annualCarryoverCapHours below, which caps what survives into a NEW year). Absent means uncapped. */
  maxBalanceHours?: number;
  /** At year-end rollover (applyAnnualCarryover below), the balance is clamped to at most this many hours going into the new year — anything above it is forfeited ("use it or lose it"), a policy choice several states restrict or ban outright for SICK leave specifically but generally permit for vacation/PTO. Absent means the full balance carries over uncapped. */
  annualCarryoverCapHours?: number;
}

export interface PtoBalance {
  employeeId: string;
  policyId: string;
  balanceHours: number;
  ytdAccruedHours: number;
  ytdUsedHours: number;
}

export function emptyPtoBalance(employeeId: string, policyId: string): PtoBalance {
  return { employeeId, policyId, balanceHours: 0, ytdAccruedHours: 0, ytdUsedHours: 0 };
}

/**
 * Accrues one pay period's worth of PTO. `hoursWorkedThisPeriod` is
 * required for a 'perHourWorked' policy (a salaried employee under such a
 * policy still needs a figure — typically their own scheduled hours,
 * which the caller supplies, since this module has no notion of a
 * schedule) and ignored for 'perPayPeriod', which accrues the same fixed
 * amount regardless of hours.
 */
export function accruePto(balance: PtoBalance, policy: PtoPolicy, hoursWorkedThisPeriod = 0): PtoBalance {
  const accrued =
    policy.accrual.kind === 'perHourWorked'
      ? hoursWorkedThisPeriod * policy.accrual.hoursAccruedPerHourWorked
      : policy.accrual.hoursPerPeriod;

  const uncappedBalance = balance.balanceHours + accrued;
  const cappedBalance = policy.maxBalanceHours === undefined ? uncappedBalance : Math.min(uncappedBalance, policy.maxBalanceHours);
  // Only credit what actually fit under the cap toward ytdAccruedHours —
  // accrual denied by the cap was never earned, not earned-then-forfeited.
  const actuallyAccrued = cappedBalance - balance.balanceHours;

  return {
    ...balance,
    balanceHours: cappedBalance,
    ytdAccruedHours: balance.ytdAccruedHours + actuallyAccrued,
  };
}

export interface PtoUsageResult {
  balance: PtoBalance;
  /** True only if the FULL request was covered by the balance — this never partially grants a request and calls it approved. */
  approved: boolean;
  /** How many of the requested hours could not be covered, for a caller to decide what happens to them (unpaid leave, a negative balance policy, denying the request outright) — this module doesn't decide that policy question. */
  shortfallHours: number;
}

/** Spends PTO hours against a balance. Never drives the balance negative — a request bigger than the balance is reported as a shortfall, with the balance left untouched, rather than silently going negative or partially deducting. */
export function usePto(balance: PtoBalance, hoursRequested: number): PtoUsageResult {
  if (hoursRequested <= balance.balanceHours) {
    return {
      balance: { ...balance, balanceHours: balance.balanceHours - hoursRequested, ytdUsedHours: balance.ytdUsedHours + hoursRequested },
      approved: true,
      shortfallHours: 0,
    };
  }
  return { balance, approved: false, shortfallHours: hoursRequested - balance.balanceHours };
}

/** Applies a policy's own carryover cap at year-end, and resets the YTD accrual/usage counters for the new year — the balance itself is what survives; YTD is a per-calendar-year measure, same convention as the tax engine's own YearToDate. */
export function applyAnnualCarryover(balance: PtoBalance, policy: PtoPolicy): PtoBalance {
  const carriedBalance =
    policy.annualCarryoverCapHours === undefined ? balance.balanceHours : Math.min(balance.balanceHours, policy.annualCarryoverCapHours);
  return { ...balance, balanceHours: carriedBalance, ytdAccruedHours: 0, ytdUsedHours: 0 };
}

/** A PTO CASH-OUT (an employer policy paying out unused balance, or a final paycheck in a state that requires it) as a payable Earning — taxed as ordinary wages, same as PTO taken during employment. Does not touch the balance itself; the caller applies usePto() (or zeroes the balance directly for a full payout) alongside this. */
export function ptoPayoutEarning(hourlyRate: Cents, hours: number): Earning {
  return { code: 'PTO_PAYOUT', category: 'regular', amount: Math.round(hourlyRate * hours) };
}
