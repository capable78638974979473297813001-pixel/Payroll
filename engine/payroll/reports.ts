import type { Cents } from '../src/money.ts';
import type { Company, Employee, PayRun } from './types.ts';
import { activeEmployeesFor } from './run.ts';

/**
 * Company-level analytics: headcount, payroll cost, and a department
 * breakdown — pure aggregations over records this project already
 * maintains, the same "no new business logic, just a rollup" discipline
 * payroll/filings.ts uses for Form 941/940/W-2. Nothing here is a new
 * source of truth; a wrong figure would be a wrong SUM, not a wrong
 * calculation.
 */

export interface DepartmentHeadcount {
  department: string;
  headcount: number;
}

export interface CompanyReport {
  companyId: string;
  /** Headcount as of `asOfDate` — active employees, same definition payroll/run.ts's own activeEmployeesFor() uses for who gets paid. */
  headcount: number;
  /** Employees with no department on file are grouped under this literal label rather than silently dropped from the count. */
  byDepartment: DepartmentHeadcount[];
  year: number;
  /** Sum of every APPROVED run's grossPay this year. */
  ytdGrossPay: Cents;
  /** Sum of every APPROVED run's employeeTaxTotal this year. */
  ytdEmployeeTaxes: Cents;
  /** Sum of every APPROVED run's employerTaxTotal this year — the employer's own cost beyond gross pay. */
  ytdEmployerTaxes: Cents;
  /** Gross pay + employer taxes — the employer's own true cost of payroll, not just what employees were paid. */
  ytdTotalPayrollCost: Cents;
  payRunCount: number;
}

const UNASSIGNED_DEPARTMENT = '(unassigned)';

export function computeCompanyReport(
  company: Company,
  employees: readonly Employee[],
  payRuns: readonly PayRun[],
  asOfDate: string,
): CompanyReport {
  const active = activeEmployeesFor(company, employees, asOfDate);

  const byDepartmentMap = new Map<string, number>();
  for (const employee of active) {
    const department = employee.department ?? UNASSIGNED_DEPARTMENT;
    byDepartmentMap.set(department, (byDepartmentMap.get(department) ?? 0) + 1);
  }
  const byDepartment = [...byDepartmentMap.entries()]
    .map(([department, headcount]) => ({ department, headcount }))
    .sort((a, b) => b.headcount - a.headcount);

  const year = Number(asOfDate.slice(0, 4));
  const runsThisYear = payRuns.filter((r) => r.companyId === company.id && r.status === 'approved' && r.checkDate.startsWith(String(year)));

  let ytdGrossPay = 0;
  let ytdEmployeeTaxes = 0;
  let ytdEmployerTaxes = 0;
  for (const run of runsThisYear) {
    for (const line of run.lines) {
      ytdGrossPay += line.grossPay;
      ytdEmployeeTaxes += line.employeeTaxTotal;
      ytdEmployerTaxes += line.employerTaxTotal;
    }
  }

  return {
    companyId: company.id,
    headcount: active.length,
    byDepartment,
    year,
    ytdGrossPay,
    ytdEmployeeTaxes,
    ytdEmployerTaxes,
    ytdTotalPayrollCost: ytdGrossPay + ytdEmployerTaxes,
    payRunCount: runsThisYear.length,
  };
}

/** Wraps a field in quotes (doubling any internal quotes) only when it actually needs it — a plain number or word stays bare, matching how a spreadsheet itself would round-trip this file. Exported for other CSV exports in this project (payroll/benefits.ts's own carrier eligibility roster) rather than reimplemented per module. */
export function csvField(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * A payroll register — one row per employee per pay run, in the shape an
 * accountant actually wants for a general-ledger import: CSV, dollars
 * (not cents — fmt() already strips the $ sign the GL doesn't want),
 * every major total broken out into its own column, plus a TOTALS row so
 * the file is self-checking against whatever the payroll run's own
 * numbers say.
 */
export function renderPayrollRegister(employees: readonly Employee[], run: PayRun): string {
  const byId = new Map(employees.map((e) => [e.id, e]));
  const header = ['Employee', 'Gross Pay', 'Employee Taxes', 'Employer Taxes', 'Pretax Deductions', 'Posttax Deductions', 'Garnishments', 'Net Pay'];
  const rows = run.lines.map((line) => {
    const employee = byId.get(line.employeeId);
    const name = employee ? `${employee.firstName} ${employee.lastName}` : line.employeeId;
    return [
      name,
      unfmt(line.grossPay),
      unfmt(line.employeeTaxTotal),
      unfmt(line.employerTaxTotal),
      unfmt(line.pretaxDeductions),
      unfmt(line.posttaxDeductions),
      unfmt(line.garnishmentTotal),
      unfmt(line.netPayAfterGarnishment),
    ];
  });

  const sumOf = (pick: (line: PayRun['lines'][number]) => Cents): Cents => run.lines.reduce((sum, line) => sum + pick(line), 0);
  const totals = [
    'TOTAL',
    unfmt(sumOf((l) => l.grossPay)),
    unfmt(sumOf((l) => l.employeeTaxTotal)),
    unfmt(sumOf((l) => l.employerTaxTotal)),
    unfmt(sumOf((l) => l.pretaxDeductions)),
    unfmt(sumOf((l) => l.posttaxDeductions)),
    unfmt(sumOf((l) => l.garnishmentTotal)),
    unfmt(sumOf((l) => l.netPayAfterGarnishment)),
  ];

  const lines = [header, ...rows, totals];
  return lines.map((row) => row.map(csvField).join(',')).join('\n') + '\n';
}

/** Cents -> a plain decimal dollar STRING (no thousands separators, no $) — the numeric form a spreadsheet/GL import expects, distinct from fmt()'s own human-display format. */
function unfmt(cents: Cents): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  return `${neg ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
