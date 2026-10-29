import type { Company, Employee, StateEmployerRegistration } from './types.ts';

/**
 * A multi-state employer must register with EVERY state it has employees
 * working in — a state unemployment insurance (SUI/SUTA) account at
 * minimum, and usually a separate withholding tax account — before it can
 * legally run payroll there. `src/types.ts`'s own EmployerContext lets a
 * caller SUPPLY a per-state SUI rate to the tax engine, but supplying a
 * rate and actually being registered are two different facts: an employer
 * can (and in practice sometimes does) start paying someone in a new
 * state before its own registration paperwork clears, which is exactly
 * the kind of gap a real payroll product surfaces as a finding rather
 * than silently processing anyway — the same "computes what was asked,
 * flags what looks wrong" discipline payroll/compliance.ts's own
 * minimum-wage check applies.
 *
 * SCOPE: this module does not know how to actually FILE a state
 * registration (each state's own SUI/withholding agency has its own
 * separate online application — real, separate infrastructure, not a
 * payroll calculation) and does not track a state's own registration
 * PROCESSING time; it only compares "where are our active employees" against
 * "which states has this employer told us it's registered in," which is
 * exactly the fact this project's own store already has both halves of.
 */

export type StateRegistrationIssueKind = 'not_registered' | 'rate_mismatch';

export interface StateRegistrationIssue {
  kind: StateRegistrationIssueKind;
  stateCode: string;
  /** Every active employee whose work state is the one this finding is about. */
  employeeIds: string[];
  /** 'rate_mismatch' only: the rate the tax engine is actually configured to use for this state (EmployerContext.stateUnemploymentRate), vs. the rate this employer's own registration record says the state assigned. */
  configuredRate?: number;
  registeredRate?: number;
}

function workStateOf(company: Company, employee: Employee): string {
  return employee.workState?.code ?? company.homeState;
}

/**
 * Every state an active employee (no terminationDate, or one on/after
 * asOfDate) actually works in, with no registration on file for it at
 * all, plus every state where a registration IS on file but its own
 * last-reported rate no longer matches what EmployerContext tells the
 * tax engine to use — a real, useful catch, since a stale rate here means
 * every paycheck in that state is computing SUI wrong even though nothing
 * about the calculation itself is broken.
 */
export function checkStateRegistrationCompliance(
  company: Company,
  employees: readonly Employee[],
  asOfDate: string,
): StateRegistrationIssue[] {
  const active = employees.filter((e) => !e.terminationDate || e.terminationDate >= asOfDate);
  const employeeIdsByState = new Map<string, string[]>();
  for (const employee of active) {
    const state = workStateOf(company, employee);
    const list = employeeIdsByState.get(state) ?? [];
    list.push(employee.id);
    employeeIdsByState.set(state, list);
  }

  const registrationsByState = new Map<string, StateEmployerRegistration>();
  for (const reg of company.stateRegistrations ?? []) registrationsByState.set(reg.stateCode, reg);

  const issues: StateRegistrationIssue[] = [];
  for (const [stateCode, employeeIds] of employeeIdsByState) {
    const registration = registrationsByState.get(stateCode);
    if (!registration) {
      issues.push({ kind: 'not_registered', stateCode, employeeIds });
      continue;
    }
    const configuredRate = company.employerContext?.stateUnemploymentRate?.[stateCode];
    if (configuredRate !== undefined && configuredRate !== registration.suiRate) {
      issues.push({
        kind: 'rate_mismatch',
        stateCode,
        employeeIds,
        configuredRate,
        registeredRate: registration.suiRate,
      });
    }
  }

  return issues.sort((a, b) => a.stateCode.localeCompare(b.stateCode));
}
