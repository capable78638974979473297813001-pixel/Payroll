import type { PtoPolicy } from './pto.ts';

/**
 * California paid sick leave (Healthy Workplaces, Healthy Families Act of
 * 2014, Labor Code §245 et seq., as amended by SB 616 effective January 1,
 * 2024) — LIVE-VERIFIED against the California Division of Labor Standards
 * Enforcement's own pages, not assumed from trained memory:
 *   - https://www.dir.ca.gov/dlse/ab1522.html
 *   - https://www.dir.ca.gov/dlse/Paid_Sick_Leave.htm
 * (both fetched 2026-09-13).
 *
 * ONE STATE ONLY. payroll/pto.ts's own header comment already discloses
 * that its accrual engine is a generic EMPLOYER-POLICY tool, not a model
 * of the roughly two dozen states' (and many more cities') own mandatory
 * paid-sick-leave laws — "a legal-research project of the same shape and
 * size as this project's minimum-wage database." This module fills in
 * exactly one of those jurisdictions, California, as a first pass; every
 * other state/city with its own paid-sick-leave mandate remains that same
 * disclosed gap, the same "one jurisdiction modeled, the rest named as
 * missing" boundary payroll/newHireReporting.ts and payroll/workersComp.ts
 * already draw.
 *
 * SCOPE: pure calculation functions — accrual, the annual usage cap, the
 * 90-day use-eligibility waiting period, and rehire reinstatement — plus a
 * policy-level compliance check comparing an employer's configured
 * PtoPolicy against CA's floor (DIR: "a paid time off (PTO) plan that
 * employees may use for the same purposes of paid sick leave, and that
 * complies with all applicable minimum requirements... may continue to be
 * used"). Deliberately does NOT track a running per-employee balance,
 * hours worked, or usage history end to end — that's payroll/pto.ts's own
 * PtoBalance, which this module treats as the store of record; wiring the
 * two together (e.g. computing "hours worked since hire" automatically)
 * would require a cumulative hours-worked figure this project doesn't
 * currently track per employee, the same kind of gap payroll/fmla.ts
 * discloses for its own "does not track an actual leave request end to
 * end."
 */

/** DIR: "at least one hour of paid leave for every 30 hours worked." */
export const CA_SICK_LEAVE_ACCRUAL_HOURS_PER_HOURS_WORKED = 1 / 30;

/** DIR: an employer may cap total ACCRUAL (the running balance) at 80 hours or 10 days — the figure a balance carries over into a new year, distinct from the annual USAGE cap below. */
export const CA_SICK_LEAVE_ACCRUAL_CAP_HOURS = 80;

/** DIR: an employer may limit how much of an employee's balance can actually be USED in one year to 40 hours or 5 days, even if the accrued balance itself is higher (up to the 80-hour accrual cap). */
export const CA_SICK_LEAVE_ANNUAL_USAGE_CAP_HOURS = 40;

/** DIR: the "up-front"/lump-sum alternative to accrual — the full 40 hours (5 days) made available at the start of each year, with no carryover required under this method (unlike the accrual method, which must carry over up to the 80-hour cap). */
export const CA_SICK_LEAVE_FRONT_LOAD_HOURS = 40;

/** DIR: an employee who works in California 30 or more days within a year of the start of employment is eligible at all. */
export const CA_SICK_LEAVE_ELIGIBILITY_MIN_DAYS_WORKED = 30;

/** DIR: "You may use accrued paid sick days beginning on the 90th day of employment" — a waiting period on USE, not on accrual, which starts on day one. */
export const CA_SICK_LEAVE_USE_WAITING_PERIOD_DAYS = 90;

/** DIR: accrued-and-unused sick leave must be restored if the employee returns to the same employer within this many months of separating — unless it was already paid out at termination under a PTO policy. */
export const CA_SICK_LEAVE_REINSTATEMENT_WINDOW_MONTHS = 12;

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1 + months, d));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

/**
 * The hire date itself is day 1 of employment, so the 90th day is 89 days
 * after it (verified: a 2026-01-01 hire's 90th day of employment is
 * 2026-03-31).
 */
export function caSickLeaveUseEligibleDate(hireDate: string): string {
  return addDays(hireDate, CA_SICK_LEAVE_USE_WAITING_PERIOD_DAYS - 1);
}

export function isEligibleToUseCaSickLeave(hireDate: string, asOfDate: string): boolean {
  return asOfDate >= caSickLeaveUseEligibleDate(hireDate);
}

/** Accrues sick leave at CA's minimum rate and applies the 80-hour accrual cap — a policy may be MORE generous than this floor, never less. */
export function accrueCaSickLeaveHours(currentBalanceHours: number, hoursWorked: number): number {
  const accrued = hoursWorked * CA_SICK_LEAVE_ACCRUAL_HOURS_PER_HOURS_WORKED;
  return Math.min(currentBalanceHours + accrued, CA_SICK_LEAVE_ACCRUAL_CAP_HOURS);
}

/** How many hours of an employee's balance may still be used this year, applying the 40-hour annual usage cap on top of whatever balance is actually available — never more than either figure allows. */
export function maxUsableCaSickLeaveHours(balanceHours: number, hoursUsedThisYear: number): number {
  const remainingUnderUsageCap = Math.max(0, CA_SICK_LEAVE_ANNUAL_USAGE_CAP_HOURS - hoursUsedThisYear);
  return Math.max(0, Math.min(balanceHours, remainingUnderUsageCap));
}

export function caSickLeaveReinstatementDeadline(separationDate: string): string {
  return addMonths(separationDate, CA_SICK_LEAVE_REINSTATEMENT_WINDOW_MONTHS);
}

export function isCaSickLeaveReinstatementRequired(separationDate: string, rehireDate: string): boolean {
  return rehireDate <= caSickLeaveReinstatementDeadline(separationDate);
}

/**
 * DIR: unused sick leave isn't paid out at termination like vacation
 * unless the employer's own policy provides for it — but if it WAS paid
 * out, a rehire within the 12-month window restores nothing (there's
 * nothing left to restore); if it wasn't, the full prior balance must be
 * reinstated.
 */
export function caSickLeaveBalanceToReinstate(balanceAtSeparationHours: number, wasPaidOutAtSeparation: boolean): number {
  return wasPaidOutAtSeparation ? 0 : balanceAtSeparationHours;
}

/**
 * Compares an employer's configured PTO policy against CA's own floor, for
 * a company that intends that policy to double as CA sick leave
 * compliance (DIR permits this as long as the policy "complies with all
 * applicable minimum requirements"). Only checks what a PtoPolicy can
 * actually express: the 'perHourWorked' accrual rate and the accrual/
 * carryover caps. A 'perPayPeriod' policy's effective hourly rate depends
 * on how many hours an employee actually works that period, which this
 * project doesn't track at the policy level — such a policy is not
 * flagged on accrual rate at all (a real limitation, disclosed here
 * rather than guessed at), only on its caps.
 */
export function caPaidSickLeavePolicyComplianceIssues(policy: PtoPolicy): string[] {
  const issues: string[] = [];

  if (policy.accrual.kind === 'perHourWorked' && policy.accrual.hoursAccruedPerHourWorked < CA_SICK_LEAVE_ACCRUAL_HOURS_PER_HOURS_WORKED) {
    issues.push(
      `Accrual rate of ${policy.accrual.hoursAccruedPerHourWorked} hour(s) per hour worked is below California's required ${CA_SICK_LEAVE_ACCRUAL_HOURS_PER_HOURS_WORKED.toFixed(4)} (1 hour per 30 hours worked).`,
    );
  }

  if (policy.maxBalanceHours !== undefined && policy.maxBalanceHours < CA_SICK_LEAVE_ACCRUAL_CAP_HOURS) {
    issues.push(`Accrual cap of ${policy.maxBalanceHours} hour(s) is below California's minimum accrual cap of ${CA_SICK_LEAVE_ACCRUAL_CAP_HOURS} hours (10 days).`);
  }

  if (policy.annualCarryoverCapHours !== undefined && policy.annualCarryoverCapHours < CA_SICK_LEAVE_ACCRUAL_CAP_HOURS) {
    issues.push(`Carryover cap of ${policy.annualCarryoverCapHours} hour(s) is below California's minimum of ${CA_SICK_LEAVE_ACCRUAL_CAP_HOURS} hours (10 days) that must carry into the new year.`);
  }

  return issues;
}
