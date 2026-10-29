import type { MinimumWageComplianceIssue } from './compliance.ts';
import { checkMinimumWageComplianceForCompany } from './compliance.ts';
import type { EverifyCase } from './everify.ts';
import { everifyComplianceIssues } from './everify.ts';
import type { I9Record } from './i9.ts';
import { i9ComplianceIssues } from './i9.ts';
import type { NewHireReportingIssue } from './newHireReporting.ts';
import { newHireReportingIssuesForCompany } from './newHireReporting.ts';
import type { StateRegistrationIssue } from './stateRegistration.ts';
import { checkStateRegistrationCompliance } from './stateRegistration.ts';
import type { Company, Employee } from './types.ts';

/**
 * One screen for every compliance check this project already runs
 * separately — minimum wage, Form I-9, E-Verify, PRWORA new-hire
 * reporting, and state SUI/withholding registration. Pure aggregation,
 * the same "no new business logic, just call what already exists and
 * collect the results" discipline payroll/reports.ts applies to its own
 * headcount and payroll-cost rollups: every individual finding here is
 * produced by a function this project already ships and independently
 * tests — a wrong dashboard entry would be a wrong CALL SITE, never a
 * new wrong calculation.
 *
 * Before this, an admin had to know to click into several separate
 * panels to find out whether anything needed attention at all — a
 * genuinely dangerous gap for a compliance-shaped product, where the
 * whole point is that someone forgets to go looking.
 */

export interface I9DashboardEntry {
  employeeId: string;
  issues: string[];
}

export interface EverifyDashboardEntry {
  employeeId: string;
  issues: string[];
}

export interface ComplianceDashboard {
  asOfDate: string;
  minimumWageIssues: MinimumWageComplianceIssue[];
  i9Issues: I9DashboardEntry[];
  everifyIssues: EverifyDashboardEntry[];
  newHireReportingIssues: NewHireReportingIssue[];
  stateRegistrationIssues: StateRegistrationIssue[];
  /** Sum of every finding across all five categories — a single number for a "N items need attention" banner, never a substitute for looking at the categories themselves. */
  totalIssueCount: number;
}

export function computeComplianceDashboard(
  company: Company,
  employees: readonly Employee[],
  i9Records: ReadonlyMap<string, I9Record>,
  everifyCases: ReadonlyMap<string, EverifyCase>,
  newHireReportsFiledEmployeeIds: ReadonlySet<string>,
  asOfDate: string,
): ComplianceDashboard {
  const minimumWageIssues = checkMinimumWageComplianceForCompany(company, employees, asOfDate);

  const i9Issues = employees
    .map((employee) => ({ employeeId: employee.id, issues: i9ComplianceIssues(employee, i9Records.get(employee.id), asOfDate) }))
    .filter((entry) => entry.issues.length > 0);

  const everifyIssues = employees
    .map((employee) => ({ employeeId: employee.id, issues: everifyComplianceIssues(employee, everifyCases.get(employee.id), asOfDate) }))
    .filter((entry) => entry.issues.length > 0);

  const newHireReportingIssues = newHireReportingIssuesForCompany(company, employees, newHireReportsFiledEmployeeIds, asOfDate);

  const stateRegistrationIssues = checkStateRegistrationCompliance(company, employees, asOfDate);

  const totalIssueCount =
    minimumWageIssues.length +
    i9Issues.reduce((sum, entry) => sum + entry.issues.length, 0) +
    everifyIssues.reduce((sum, entry) => sum + entry.issues.length, 0) +
    newHireReportingIssues.length +
    stateRegistrationIssues.length;

  return { asOfDate, minimumWageIssues, i9Issues, everifyIssues, newHireReportingIssues, stateRegistrationIssues, totalIssueCount };
}
