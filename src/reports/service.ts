import { badRequest } from '../lib/errors.ts';
import { daysBetween } from '../lib/dates.ts';
import type { Store } from '../store/store.ts';

const q = (s: unknown) => `"${String(s ?? '').replace(/"/g, '""')}"`;
const usd = (c: number) => (c / 100).toFixed(2);
const csv = (head: string[], rows: unknown[][]) => [head.map(q).join(','), ...rows.map((r) => r.map(q).join(','))].join('\n') + '\n';
const PAID = ['approved', 'funding', 'funded', 'disbursing', 'completed'];

function span(from: string, to: string) {
  if (to < from) throw badRequest('The end is before the start.');
  if (daysBetween(from, to) > 800) throw badRequest('Pick a range of two years or less.');
}

/** Spreadsheets for the owner and the owner's accountant. Plain CSV, one row per fact, no formulas. */
export function payrollRegister(store: Store, companyId: string, from: string, to: string) {
  span(from, to);
  const rows: unknown[][] = [];
  for (const run of store.payRuns.where((r) => r.companyId === companyId && PAID.includes(r.status) && r.checkDate >= from && r.checkDate <= to).sort((a, b) => a.checkDate.localeCompare(b.checkDate))) {
    for (const pc of run.paychecks) rows.push([run.checkDate, run.periodStart, run.periodEnd, pc.name, (Math.round(pc.hours * 100) / 100).toFixed(2), usd(pc.taxableWagesCents), usd(pc.employeeTaxCents), usd(pc.deductionsCents), usd(pc.netPayCents), usd(pc.employerTaxCents)]);
  }
  return { fileName: `payroll-register-${from}-to-${to}.csv`, rows: rows.length, content: csv(['Pay date', 'Period start', 'Period end', 'Employee', 'Hours', 'Gross pay', 'Employee taxes', 'Deductions', 'Net pay', 'Employer taxes'], rows) };
}

export function hoursReport(store: Store, companyId: string, from: string, to: string) {
  span(from, to);
  const emps = new Map(store.employees.where((e) => e.companyId === companyId).map((e) => [e.id, e]));
  const by = new Map<string, { minutes: number; tips: number }>();
  for (const s of store.shifts.where((x) => x.companyId === companyId && x.workDate >= from && x.workDate <= to)) { const g = by.get(s.employeeId) ?? { minutes: 0, tips: 0 }; g.minutes += s.minutes; g.tips += s.chargedTipsCents + s.cashTipsCents; by.set(s.employeeId, g); }
  const rows = [...by].map(([id, g]) => { const e = emps.get(id); return [e ? `${e.firstName} ${e.lastName}` : id, e?.location ?? '', (g.minutes / 60).toFixed(2), usd(g.tips)]; }).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return { fileName: `hours-and-tips-${from}-to-${to}.csv`, rows: rows.length, content: csv(['Employee', 'Location', 'Hours', 'Tips'], rows) };
}

export function roster(store: Store, companyId: string) {
  const company = store.companies.require(companyId, 'Company');
  const roles = new Map(company.settings.roles.map((r) => [r.key, r.label]));
  const rows = store.employees.where((e) => e.companyId === companyId).sort((a, b) => a.lastName.localeCompare(b.lastName)).map((e) => [`${e.firstName} ${e.lastName}`, e.email ?? '', roles.get(e.roleKey) ?? e.roleKey, e.location ?? '', e.hireDate, e.terminationDate ?? '', e.payType.kind === 'hourly' ? `${usd(e.payType.rateCents)}/hr` : `${usd(e.payType.annualCents)}/yr`, e.ssnLast4 ? `***-**-${e.ssnLast4}` : '', e.workState.code]);
  return { fileName: 'team-roster.csv', rows: rows.length, content: csv(['Name', 'Email', 'Role', 'Location', 'Start date', 'End date', 'Pay', 'SSN', 'Work state'], rows) };
}
