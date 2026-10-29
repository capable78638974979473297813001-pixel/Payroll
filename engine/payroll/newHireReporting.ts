import type { Company, Employee } from './types.ts';

/**
 * The federal new-hire reporting requirement (PRWORA, the Personal
 * Responsibility and Work Opportunity Reconciliation Act of 1996, 42
 * U.S.C. § 653a) — every employer must report each new hire to the state
 * workforce agency for the state where the employee works, primarily so
 * child-support income-withholding orders can find them. Required data
 * elements and the 20-day federal default deadline are fixed by the
 * federal statute itself; a state MAY require faster reporting (several
 * do), which this module does not attempt to enumerate — see
 * `deadlineDaysForState()`'s own doc comment for why that's disclosed
 * rather than guessed, the same choice this project makes everywhere it
 * hasn't done the per-state legal research (README.md's own Known gaps).
 */

export interface NewHireReport {
  employer: { legalName: string; ein: string; address: string | null };
  employee: { firstName: string; lastName: string; ssn: string | null; address: string | null; hireDate: string };
  /** The state this report is owed to — the employee's own WORK state, since that's who PRWORA's own reporting obligation runs to, not necessarily where the employer is based. */
  reportToState: string;
  dueBy: string; // ISO yyyy-mm-dd = hireDate + deadlineDays
}

/** PRWORA's own default: 20 days from the hire date. A state may set a SHORTER deadline (several do); none may set a longer one. */
export const FEDERAL_DEFAULT_DEADLINE_DAYS = 20;

/**
 * Deliberately returns the federal default for EVERY state rather than a
 * researched per-state table. Several states genuinely require faster
 * reporting than 20 days — that is real, sourceable state law this
 * project has not yet researched state by state, the same category of gap
 * as payroll/timeAndAttendance.ts's un-modelled Alaska/Nevada/Colorado
 * overtime rules. Returning the federal default is the SAFE direction to
 * be wrong in: a caller who reports by day 20 everywhere will occasionally
 * report a few days later than a stricter state technically allows, never
 * later than federal law's own outer bound. Closing this properly means
 * building a `data/new-hire-reporting/` file per state with a cited
 * source and verifiedOn date, exactly like every other jurisdiction fact
 * in this project — not a table invented here without one.
 */
export function deadlineDaysForState(_stateCode: string): number {
  return FEDERAL_DEFAULT_DEADLINE_DAYS;
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Builds the report for one new hire. Throws rather than silently omitting
 * `employee.ssn` or `.address` as null when EITHER is genuinely missing
 * would be wrong — those are two of the federal statute's own required
 * elements, not optional detail, so a report built without them isn't a
 * lesser report, it's not a report a state agency can accept. Employer
 * address is looked up the same way; absent, it's left `null` rather than
 * blocking the report, since several states' own intake forms tolerate an
 * employer address on file already and only strictly require the EIN to
 * match one.
 */
export function buildNewHireReport(company: Company, employee: Employee): NewHireReport {
  if (!employee.ssn) throw new Error(`Cannot build a new-hire report for ${employee.id}: no SSN on file`);
  if (!employee.mailingAddress) throw new Error(`Cannot build a new-hire report for ${employee.id}: no mailing address on file`);

  const reportToState = employee.workState?.code ?? company.homeState;
  const deadlineDays = deadlineDaysForState(reportToState);

  return {
    employer: { legalName: company.legalName, ein: company.ein, address: company.address ?? null },
    employee: {
      firstName: employee.firstName,
      lastName: employee.lastName,
      ssn: employee.ssn,
      address: employee.mailingAddress,
      hireDate: employee.hireDate,
    },
    reportToState,
    dueBy: addDays(employee.hireDate, deadlineDays),
  };
}

export type NewHireReportingIssueKind = 'missing_data' | 'overdue' | 'due_soon';

export interface NewHireReportingIssue {
  employeeId: string;
  kind: NewHireReportingIssueKind;
  /** 'missing_data' only: which of buildNewHireReport()'s own required fields aren't on file yet. */
  missingFields?: ('ssn' | 'mailingAddress')[];
  /** Present once ssn/mailingAddress are both on file, i.e. for 'overdue' and 'due_soon'. */
  reportToState?: string;
  dueBy?: string;
}

/**
 * Every ACTIVE new-hire reporting obligation this company hasn't
 * discharged yet — an employee already recorded in `filedEmployeeIds` is
 * skipped entirely, since PRWORA's own obligation is "report once per
 * hire," not a recurring check. Three findings, in the order a real
 * payroll admin would want to act on them: 'missing_data' (can't even
 * build the report — the same two fields buildNewHireReport() itself
 * refuses to guess), 'overdue' (the deadline has already passed), and
 * 'due_soon' (within `dueSoonWithinDays` of the deadline, not yet late).
 * An employee whose deadline is neither passed nor approaching produces
 * no finding at all — this is a worklist, not a status report on every
 * hire ever made.
 */
export function newHireReportingIssuesForCompany(
  company: Company,
  employees: readonly Employee[],
  filedEmployeeIds: ReadonlySet<string>,
  asOfDate: string,
  dueSoonWithinDays = 5,
): NewHireReportingIssue[] {
  const issues: NewHireReportingIssue[] = [];

  for (const employee of employees) {
    if (filedEmployeeIds.has(employee.id)) continue;

    const missingFields: ('ssn' | 'mailingAddress')[] = [];
    if (!employee.ssn) missingFields.push('ssn');
    if (!employee.mailingAddress) missingFields.push('mailingAddress');
    if (missingFields.length > 0) {
      issues.push({ employeeId: employee.id, kind: 'missing_data', missingFields });
      continue;
    }

    const report = buildNewHireReport(company, employee);
    if (report.dueBy < asOfDate) {
      issues.push({ employeeId: employee.id, kind: 'overdue', reportToState: report.reportToState, dueBy: report.dueBy });
    } else if (report.dueBy <= addDays(asOfDate, dueSoonWithinDays)) {
      issues.push({ employeeId: employee.id, kind: 'due_soon', reportToState: report.reportToState, dueBy: report.dueBy });
    }
  }

  return issues;
}
