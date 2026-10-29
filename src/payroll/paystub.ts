import { fmtUsd } from '../lib/money.ts';
import type { Company, Employee, Paycheck, PayRun } from '../domain/types.ts';

/**
 * A pay stub built from an approved paycheck: every earning with its hours,
 * the tip breakdown, each tax withheld by name, deductions, and what was
 * actually paid. The structured form is the source of truth; the text form is
 * a plain rendering of it. It states what was paid and what was not (cash tips
 * the employee already holds are taxed but not paid by payroll).
 */
export function paystub(company: Company, employee: Employee, run: PayRun, pc: Paycheck) {
  const employeeTaxes = pc.taxLines.filter((t) => t.payer === 'employee' && t.amount > 0).map((t) => ({ code: t.id, name: t.name, amountCents: t.amount }));
  const structured = {
    employer: { name: company.legalName, ein: company.ein },
    employee: { name: pc.name, id: employee.id, ssnLast4: employee.ssnLast4 ?? null },
    period: { start: run.periodStart, end: run.periodEnd },
    checkDate: run.checkDate,
    status: run.status,
    hours: pc.hours,
    earnings: pc.earnings.map((e) => ({ code: e.code, description: e.detail, hours: e.minutes ? Math.round((e.minutes / 60) * 100) / 100 : undefined, amountCents: e.amountCents, paidByPayroll: e.paidByPayroll })),
    tips: pc.tips,
    grossWagesCents: pc.taxableWagesCents,
    reimbursementsCents: pc.reimbursementCents,
    employeeTaxes,
    employeeTaxTotalCents: pc.employeeTaxCents,
    deductions: pc.deductionLines.filter((d) => d.amountCents > 0),
    uncollectedTaxOnTipsCents: pc.uncollectedCents,
    netPayCents: pc.netPayCents,
    cashTipsHeldByEmployeeCents: pc.cashTipsCents,
    paidThroughPayrollCents: pc.payableCents,
    workweeks: pc.weeks,
  };
  const rows: string[] = [];
  const line = (label: string, cents: number, note = '') => rows.push(`  ${label.padEnd(46)} ${fmtUsd(cents).padStart(12)}${note ? `  ${note}` : ''}`);
  const title = `${company.legalName} - pay stub`;
  rows.push(title, '='.repeat(title.length));
  rows.push(`Employee: ${pc.name}${employee.ssnLast4 ? ` (SSN xxx-xx-${employee.ssnLast4})` : ''}`);
  rows.push(`Pay period: ${run.periodStart} to ${run.periodEnd}    Check date: ${run.checkDate}`, '');
  rows.push('Earnings');
  for (const e of pc.earnings) line(`${e.code}${e.minutes ? ` (${(e.minutes / 60).toFixed(2)} h)` : ''}`, e.amountCents, e.paidByPayroll ? '' : '(cash tips you received; taxed, not paid here)');
  rows.push('', 'Taxes withheld');
  for (const t of employeeTaxes) line(t.name, t.amountCents);
  line('Total taxes withheld', pc.employeeTaxCents);
  if (pc.deductionLines.some((d) => d.amountCents > 0)) {
    rows.push('', 'Deductions');
    for (const d of pc.deductionLines.filter((x) => x.amountCents > 0)) line(d.code, d.amountCents);
  }
  rows.push('');
  line('Net pay (after taxes and deductions)', pc.netPayCents);
  if (pc.cashTipsCents > 0) line('Less cash tips you already hold', -pc.cashTipsCents);
  line('Paid to your bank account', pc.payableCents);
  if (pc.uncollectedCents > 0) rows.push(`  Note: ${fmtUsd(pc.uncollectedCents)} of tax on your cash tips could not be collected from this check. It appears on your W-2.`);
  return { structured, text: rows.join('\n') + '\n' };
}
