import { randomUUID } from 'node:crypto';
import { checkMinimumWageComplianceForCompany } from './compliance.ts';
import { computeEmployeePaycheck } from './engine.ts';
import type { Company, Employee, ExtendedYearToDate, PayRun, PayRunLine, TimeEntry } from './types.ts';
import { accumulateYtd, freshYearToDate } from './ytd.ts';

/**
 * Orchestrates a pay run across every active employee of a company for one
 * check date — the actual "run payroll" button. payroll/engine.ts computes
 * one employee at a time; this module is what makes it a RUN: who's
 * included, the draft/approve/void lifecycle, and rolling approved results
 * into each employee's running YTD so the NEXT run sees them.
 *
 * A run is DRAFT until approved. Calculating a draft (or recalculating it
 * after fixing a time entry) never touches an employee's stored YTD —
 * only approvePayRun() does, exactly once, which is what makes "run it,
 * notice an hours error, fix it, run it again" safe: nothing is committed
 * until a human signs off on the numbers.
 */

/** Employees this company actually owes pay to on `checkDate`: hired on or before it, and not yet terminated (or terminated ON this date, since a final check is still owed the day of termination). */
export function activeEmployeesFor(company: Company, employees: readonly Employee[], checkDate: string): Employee[] {
  return employees.filter(
    (e) => e.companyId === company.id && e.hireDate <= checkDate && (!e.terminationDate || e.terminationDate >= checkDate),
  );
}

/** The YTD an employee's paycheck should start from for `checkDate` — their own stored YTD if it already reflects this calendar year, or a fresh zeroed one if this check crosses into a new year (see ExtendedYearToDate's own doc comment — the same "one calendar year, then start over" rule the tax engine's jurisdiction files assume). */
export function ytdForCheckDate(employee: Employee, checkDate: string): ExtendedYearToDate {
  const year = Number(checkDate.slice(0, 4));
  return employee.ytdYear === year ? employee.ytd : freshYearToDate();
}

export function draftPayRun(
  company: Company,
  employees: readonly Employee[],
  periodStart: string,
  periodEnd: string,
  checkDate: string,
  timeEntries: readonly TimeEntry[] = [],
): PayRun {
  const timeEntryByEmployee = new Map(timeEntries.map((t) => [t.employeeId, t]));
  const active = activeEmployeesFor(company, employees, checkDate);
  const lines: PayRunLine[] = active.map((employee) => {
    const effectiveEmployee: Employee = { ...employee, ytd: ytdForCheckDate(employee, checkDate) };
    return computeEmployeePaycheck(company, effectiveEmployee, checkDate, timeEntryByEmployee.get(employee.id)).line;
  });

  return {
    id: randomUUID(),
    companyId: company.id,
    periodStart,
    periodEnd,
    checkDate,
    status: 'draft',
    lines,
    createdAt: new Date().toISOString(),
    minimumWageIssues: checkMinimumWageComplianceForCompany(company, active, checkDate),
  };
}

/**
 * Recomputes a DRAFT run's lines in place (new time entries came in, a
 * deduction plan changed) without disturbing its id or status. Throws on
 * anything already approved or voided — a run's numbers are exactly what
 * got approved from that point on, never silently recalculated under it.
 */
export function recalculatePayRun(
  run: PayRun,
  company: Company,
  employees: readonly Employee[],
  timeEntries: readonly TimeEntry[] = [],
): PayRun {
  if (run.status !== 'draft') {
    throw new Error(`Cannot recalculate a ${run.status} pay run — only a draft run's numbers may change.`);
  }
  const fresh = draftPayRun(company, employees, run.periodStart, run.periodEnd, run.checkDate, timeEntries);
  return { ...fresh, id: run.id, createdAt: run.createdAt };
}

export interface ApprovedPayRun {
  run: PayRun;
  /** Every employee this run paid, with YTD rolled forward — the caller persists these back to its own employee store. Employees NOT in this run (inactive, or excluded) are absent; the caller keeps their existing records unchanged. */
  updatedEmployees: Employee[];
}

/**
 * Locks a draft run and rolls its results into each paid employee's YTD.
 * This is the one moment a payroll run has a durable side effect on an
 * employee record — everything before this point (drafting, recalculating)
 * is disposable.
 */
export function approvePayRun(run: PayRun, employees: readonly Employee[]): ApprovedPayRun {
  if (run.status !== 'draft') {
    throw new Error(`Cannot approve a ${run.status} pay run — it must be a draft.`);
  }

  const byId = new Map(employees.map((e) => [e.id, e]));
  const updatedEmployees: Employee[] = [];

  for (const line of run.lines) {
    const employee = byId.get(line.employeeId);
    if (!employee) throw new Error(`Pay run references unknown employee ${line.employeeId}`);

    const startingYtd = ytdForCheckDate(employee, run.checkDate);
    const nextYtd = accumulateYtd(startingYtd, {
      checkDate: run.checkDate,
      employmentCategory: employee.employmentCategory,
      grossPay: line.grossPay,
      taxLines: line.taxLines,
      electiveDeferrals: line.electiveDeferrals,
    });

    updatedEmployees.push({ ...employee, ytd: nextYtd, ytdYear: Number(run.checkDate.slice(0, 4)) });
  }

  const approved: PayRun = { ...run, status: 'approved', approvedAt: new Date().toISOString() };
  return { run: approved, updatedEmployees };
}

/** Discards a draft run without ever touching YTD — the always-safe undo, since draft numbers were never committed anywhere. Voiding an already-approved run is deliberately NOT offered here: reversing committed YTD correctly (and re-filing whatever quarter it landed in) is a real payroll-correction workflow, not a status flip, and this module doesn't pretend otherwise — see this module's own header note on scope. */
export function voidPayRun(run: PayRun): PayRun {
  if (run.status !== 'draft') {
    throw new Error(`Cannot void a ${run.status} pay run — only a draft run has never been committed anywhere.`);
  }
  return { ...run, status: 'voided' };
}
