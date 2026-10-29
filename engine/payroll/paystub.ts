import { fmt } from '../src/money.ts';
import type { Company, Employee, PayRun, PayRunLine } from './types.ts';

/**
 * A plain-text paystub from an approved (or draft, for a preview) pay run
 * line. Deliberately text, not a PDF: the numbers and their provenance —
 * which tax line, which garnishment order, which account — are the actual
 * deliverable here, and a rendering format (PDF, HTML, whatever an
 * employee portal wants) is a presentation choice layered on top of this
 * data, not a second source of truth for it.
 */
export function renderPaystubText(company: Company, employee: Employee, run: PayRun, line: PayRunLine): string {
  const rows: string[] = [];
  const title = `${company.legalName} — Paystub`;
  rows.push(title);
  rows.push('='.repeat(title.length));
  rows.push(`Employee: ${employee.firstName} ${employee.lastName} (${employee.id})`);
  rows.push(`Pay period: ${run.periodStart} to ${run.periodEnd}`);
  rows.push(`Check date: ${run.checkDate}`);
  rows.push('');
  rows.push(`Gross pay: ${fmt(line.grossPay)}`);
  rows.push('');

  const employeeTaxes = line.taxLines.filter((t) => t.payer === 'employee');
  if (employeeTaxes.length > 0) {
    rows.push('Taxes withheld:');
    for (const t of employeeTaxes) rows.push(`  ${t.name.padEnd(45)} ${fmt(t.amount).padStart(12)}`);
    rows.push(`  ${'Total taxes withheld'.padEnd(45)} ${fmt(line.employeeTaxTotal).padStart(12)}`);
    rows.push('');
  }

  if (line.pretaxDeductions > 0 || line.posttaxDeductions > 0) {
    rows.push('Deductions:');
    if (line.pretaxDeductions > 0) rows.push(`  ${'Pre-tax'.padEnd(45)} ${fmt(line.pretaxDeductions).padStart(12)}`);
    if (line.posttaxDeductions > 0) rows.push(`  ${'Post-tax'.padEnd(45)} ${fmt(line.posttaxDeductions).padStart(12)}`);
    rows.push('');
  }

  if (line.garnishmentLines.length > 0) {
    rows.push('Garnishments:');
    for (const g of line.garnishmentLines) rows.push(`  ${g.orderId.padEnd(45)} ${fmt(g.withheld).padStart(12)}`);
    rows.push(`  ${'Total garnished'.padEnd(45)} ${fmt(line.garnishmentTotal).padStart(12)}`);
    rows.push('');
  }

  rows.push(`Net pay: ${fmt(line.netPayAfterGarnishment)}`);

  if (line.depositAllocations.length > 0) {
    rows.push('');
    rows.push('Direct deposit:');
    for (const d of line.depositAllocations) {
      const account = employee.directDepositAccounts.find((a) => a.id === d.accountId);
      const label = account ? `${account.accountType} ...${account.accountNumber.slice(-4)}` : d.accountId;
      rows.push(`  ${label.padEnd(45)} ${fmt(d.amount).padStart(12)}`);
    }
  }

  rows.push('');
  const employerTaxes = line.taxLines.filter((t) => t.payer === 'employer');
  if (employerTaxes.length > 0) {
    rows.push('Employer-paid taxes (not withheld from employee):');
    for (const t of employerTaxes) rows.push(`  ${t.name.padEnd(45)} ${fmt(t.amount).padStart(12)}`);
    rows.push(`  ${'Total employer taxes'.padEnd(45)} ${fmt(line.employerTaxTotal).padStart(12)}`);
  }

  return rows.join('\n') + '\n';
}
