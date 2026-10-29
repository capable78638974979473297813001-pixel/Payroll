import { minimumWage } from '../src/minimum-wage.ts';
import type { Cents } from '../src/money.ts';
import type { Company, Employee } from './types.ts';

/**
 * Checks an hourly employee's own contracted rate against the minimum
 * wage floor that actually binds for their work location — wiring
 * src/minimum-wage.ts (already the source of truth this project's own
 * `npm run coverage:minimum-wage` measures every state/locality against)
 * directly into a pay run, so a rate that falls below the floor is a
 * FINDING a real payroll run surfaces, not something silently paid
 * anyway. This is the closest this project comes to isolved's own
 * "AI catches potential errors" claim — the same idea, done as an
 * ordinary, auditable function rather than an opaque model.
 *
 * Deliberately a WARNING, never a thrown error or a blocked pay run: the
 * tax engine itself never refuses to compute a paycheck just because a
 * business fact looks wrong (a $0 rate, an implausible W-4) — it computes
 * what was asked and lets the caller decide what to do with the result.
 * Underpaying an employee is a real, urgent problem, but it is the
 * EMPLOYER'S problem to fix, not this function's to prevent by force.
 */
export interface MinimumWageComplianceIssue {
  employeeId: string;
  /** Which level/name actually binds (e.g. "Seattle" over "Washington" over federal) — straight from minimumWage()'s own bindingJurisdiction. */
  jurisdiction: string;
  /** The binding floor, cents per hour. */
  applicableRateCents: Cents;
  /** The employee's own contracted rate, cents per hour. */
  employeeRateCents: Cents;
  shortfallCents: Cents;
}

/**
 * Salaried employees are skipped outright, not evaluated some other way:
 * minimum wage is inherently a per-HOUR test, and this function has no
 * hours-worked figure to convert an annual salary into an effective
 * hourly rate against (the same reason src/minimum-wage.ts itself only
 * ever answers in dollars per hour, never per year).
 */
export function checkMinimumWageCompliance(company: Company, employee: Employee, checkDate: string): MinimumWageComplianceIssue | null {
  if (employee.payType.kind !== 'hourly') return null;

  const stateCode = employee.workState?.code ?? company.homeState;
  const answer = minimumWage({ checkDate, state: stateCode });
  if (employee.payType.hourlyRate >= answer.cents) return null;

  return {
    employeeId: employee.id,
    jurisdiction: answer.bindingJurisdiction,
    applicableRateCents: answer.cents,
    employeeRateCents: employee.payType.hourlyRate,
    shortfallCents: answer.cents - employee.payType.hourlyRate,
  };
}

/** Every issue found across a company's employees for one check date — only the real findings, never a clean-bill-of-health entry for a compliant employee. */
export function checkMinimumWageComplianceForCompany(
  company: Company,
  employees: readonly Employee[],
  checkDate: string,
): MinimumWageComplianceIssue[] {
  const issues: MinimumWageComplianceIssue[] = [];
  for (const employee of employees) {
    const issue = checkMinimumWageCompliance(company, employee, checkDate);
    if (issue) issues.push(issue);
  }
  return issues;
}
