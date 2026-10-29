import type { PtoBalance } from './pto.ts';
import type { Employee } from './types.ts';

/**
 * Offboarding: when the final paycheck is legally due, and what happens to
 * an unused PTO/vacation balance — two questions state law answers very
 * differently depending on WHY someone left, which federal law does not
 * answer at all (FLSA sets no final-paycheck deadline; it requires only
 * that wages actually due be paid, generally read as no later than the
 * next regular payday).
 *
 * SCOPE, same discipline as payroll/newHireReporting.ts's own per-state
 * deadlines: California is researched and cited (Cal. Labor Code
 * §§ 201-203, 227.3) because it is the single most consequential and
 * most-cited case (immediate pay on involuntary termination, a HARD ban
 * on ever forfeiting earned vacation). Every other state falls back to
 * the federal floor — "next regular payday," "PTO payout follows the
 * employer's own policy" — which is the safe direction to be wrong in:
 * several other states have their own final-pay or no-forfeiture rules
 * this project has not yet researched state by state.
 */

/**
 * 'gross_misconduct' is a genuinely distinct sub-case of an
 * employer-initiated separation, called out on its own rather than
 * folded into 'involuntary': it's still due immediate final pay under
 * the same rule as any other involuntary termination (the employer
 * ended it, same as a layoff), but it's the ONE termination reason that
 * disqualifies someone from COBRA continuation coverage (see
 * payroll/cobra.ts's own header) — a fact this module's own
 * finalPayDueDate() doesn't need, but the termination workflow as a
 * whole does.
 */
export type TerminationReason = 'voluntary_with_notice' | 'voluntary_without_notice' | 'involuntary' | 'layoff' | 'gross_misconduct';

export interface FinalPayResult {
  dueDate: string; // ISO yyyy-mm-dd
  rule: string;
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

/**
 * `nextRegularPayDate` is the caller's own answer to "when would this
 * person have been paid anyway" (typically the company's own next
 * scheduled check date) — the federal-floor branch needs it because
 * "the next regular payday" is only meaningful with the caller's own
 * payroll calendar in hand; this module has no calendar of its own.
 */
export function finalPayDueDate(
  stateCode: string,
  terminationDate: string,
  reason: TerminationReason,
  nextRegularPayDate: string,
): FinalPayResult {
  if (stateCode === 'CA') {
    if (reason === 'involuntary' || reason === 'layoff' || reason === 'gross_misconduct') {
      return { dueDate: terminationDate, rule: 'Cal. Labor Code § 201: wages due IMMEDIATELY upon involuntary termination or layoff.' };
    }
    if (reason === 'voluntary_with_notice') {
      return { dueDate: terminationDate, rule: 'Cal. Labor Code § 202: with 72+ hours notice, wages due on the last day worked.' };
    }
    // voluntary_without_notice: due within 72 HOURS of resignation. This
    // project works in whole calendar days everywhere else (see
    // payroll/schedule.ts) — 72 hours is approximated as 3 calendar days,
    // which is exact when the resignation happens at the start of a day
    // and conservative (a day early, never late) otherwise.
    return {
      dueDate: addDays(terminationDate, 3),
      rule: 'Cal. Labor Code § 202: without notice, wages due within 72 hours of resignation (approximated here as 3 calendar days).',
    };
  }

  return {
    dueDate: nextRegularPayDate,
    rule: 'No state-specific final-pay rule researched for this state — federal floor: no later than the next regular payday.',
  };
}

/**
 * California (Cal. Labor Code § 227.3) is the researched case where an
 * employer's OWN "use it or lose it" forfeiture (payroll/pto.ts's own
 * annualCarryoverCapHours) is not just unenforced but flatly ILLEGAL:
 * earned vacation is treated as WAGES and can never be forfeited, whether
 * the employer's policy says so or not. This is checked separately from
 * pto.ts's own carryover cap precisely because the two modules answer
 * different questions — payroll/pto.ts models what an employer's policy
 * SAYS; this module answers whether the LAW lets that policy stand once
 * someone actually leaves.
 */
export function isVacationPayoutMandatory(stateCode: string): boolean {
  return stateCode === 'CA';
}

/**
 * How many PTO hours must actually be cashed out in the final paycheck.
 * A mandatory-payout state ignores the employer's own election entirely
 * (mandatory means mandatory); everywhere else, this project defers to
 * whatever the employer's own policy says, since ordinary PTO payout upon
 * termination is a matter of employer policy or contract absent a state
 * law like California's.
 */
export function finalPtoPayoutHours(balance: PtoBalance | null, stateCode: string, employerPolicyPaysOutPto: boolean): number {
  if (!balance) return 0;
  if (isVacationPayoutMandatory(stateCode)) return balance.balanceHours;
  return employerPolicyPaysOutPto ? balance.balanceHours : 0;
}

export interface TerminationResult {
  employee: Employee;
  finalPay: FinalPayResult;
  ptoPayoutHours: number;
}

/** Runs the whole offboarding decision at once: sets the employee's own terminationDate, resolves the final-pay deadline, and resolves how much PTO is owed. Does not itself run a paycheck — see payroll/pto.ts's own ptoPayoutEarning() to turn `ptoPayoutHours` into an Earning for the actual final pay run. */
export function terminateEmployee(
  employee: Employee,
  terminationDate: string,
  reason: TerminationReason,
  nextRegularPayDate: string,
  ptoBalance: PtoBalance | null,
  employerPolicyPaysOutPto: boolean,
): TerminationResult {
  const stateCode = employee.workState?.code ?? employee.residenceState.code;
  return {
    employee: { ...employee, terminationDate },
    finalPay: finalPayDueDate(stateCode, terminationDate, reason, nextRegularPayDate),
    ptoPayoutHours: finalPtoPayoutHours(ptoBalance, stateCode, employerPolicyPaysOutPto),
  };
}
