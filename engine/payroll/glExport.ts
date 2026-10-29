import type { Cents } from '../src/money.ts';
import { csvField } from './reports.ts';
import type { PayRun } from './types.ts';

/**
 * One summarized general-ledger journal entry per PAY RUN — the level a
 * real payroll system actually posts to accounting software at (one
 * entry, company-wide, per run), not one line per employee: the
 * per-employee detail already lives in `payroll/reports.ts`'s own
 * `renderPayrollRegister()`, and duplicating it here as individual GL
 * lines would just be the same numbers imported twice into two
 * different systems of record.
 *
 * The one idea that matters for a payroll GL entry, the same as this
 * project's own tax engine: total debits must equal total credits,
 * always, not approximately. Debits are what payroll COST the company
 * (gross wages + the employer's own tax share); credits are everywhere
 * that cost is now OWED — tax agencies, benefit plans, garnishment
 * recipients, and the employee's own net pay — until each is actually
 * paid out. `buildGlJournalEntries()` asserts this balance itself before
 * returning, the same "prove it balances, don't just compute it and
 * hope" discipline `renderPayrollRegister()`'s own self-checking TOTAL
 * row applies.
 *
 * SCOPE: produces the journal LINES and their dollar amounts; does not
 * post them to any accounting system (QuickBooks, NetSuite, ...) — a
 * real, separate integration this project doesn't build, the same
 * "disclosed, not built" boundary drawn around e-filing and carrier EDI
 * elsewhere. The account CODES themselves are entirely caller-supplied
 * (`GlAccountMapping`): this module has no opinion on a chart of
 * accounts, which is unique to every company that adopts one.
 */

export interface GlAccountMapping {
  wagesExpense: string;
  employerTaxExpense: string;
  federalTaxPayable: string;
  stateTaxPayable: string;
  localTaxPayable: string;
  netPayPayable: string;
  garnishmentPayable: string;
  benefitDeductionPayable: string;
}

export interface GlJournalLine {
  account: string;
  description: string;
  debit: Cents;
  credit: Cents;
}

function sumTaxLinesByJurisdiction(payRun: PayRun, jurisdiction: 'federal' | 'state' | 'local'): Cents {
  return payRun.lines.reduce(
    (sum, line) => sum + line.taxLines.filter((t) => t.jurisdiction === jurisdiction).reduce((s, t) => s + t.amount, 0),
    0,
  );
}

/**
 * Builds the balanced set of journal lines for one pay run. Throws
 * rather than silently returning an unbalanced entry — a real accounting
 * system would reject one anyway, and finding out here is far cheaper
 * than finding out after import.
 */
export function buildGlJournalEntries(payRun: PayRun, mapping: GlAccountMapping): GlJournalLine[] {
  const totalGrossPay = payRun.lines.reduce((sum, l) => sum + l.grossPay, 0);
  const totalEmployerTax = payRun.lines.reduce((sum, l) => sum + l.employerTaxTotal, 0);
  const totalNetPay = payRun.lines.reduce((sum, l) => sum + l.netPayAfterGarnishment, 0);
  const totalGarnishment = payRun.lines.reduce((sum, l) => sum + l.garnishmentTotal, 0);
  const totalBenefitDeductions = payRun.lines.reduce((sum, l) => sum + l.pretaxDeductions + l.posttaxDeductions, 0);
  const totalFederalTax = sumTaxLinesByJurisdiction(payRun, 'federal');
  const totalStateTax = sumTaxLinesByJurisdiction(payRun, 'state');
  const totalLocalTax = sumTaxLinesByJurisdiction(payRun, 'local');

  const lines: GlJournalLine[] = [
    { account: mapping.wagesExpense, description: `Gross wages — pay run ${payRun.checkDate}`, debit: totalGrossPay, credit: 0 },
    { account: mapping.employerTaxExpense, description: `Employer payroll tax expense — pay run ${payRun.checkDate}`, debit: totalEmployerTax, credit: 0 },
    { account: mapping.federalTaxPayable, description: 'Federal tax withheld + employer share, payable', debit: 0, credit: totalFederalTax },
    { account: mapping.stateTaxPayable, description: 'State tax withheld + employer share, payable', debit: 0, credit: totalStateTax },
    { account: mapping.localTaxPayable, description: 'Local tax withheld, payable', debit: 0, credit: totalLocalTax },
    { account: mapping.benefitDeductionPayable, description: 'Benefit/deduction plan withholdings, payable', debit: 0, credit: totalBenefitDeductions },
    { account: mapping.garnishmentPayable, description: 'Garnishment withholdings, payable', debit: 0, credit: totalGarnishment },
    { account: mapping.netPayPayable, description: 'Net pay owed to employees', debit: 0, credit: totalNetPay },
  ].filter((l) => l.debit !== 0 || l.credit !== 0);

  const totalDebits = lines.reduce((sum, l) => sum + l.debit, 0);
  const totalCredits = lines.reduce((sum, l) => sum + l.credit, 0);
  if (totalDebits !== totalCredits) {
    throw new Error(`GL journal entry for pay run ${payRun.id} does not balance: debits ${totalDebits} != credits ${totalCredits}`);
  }

  return lines;
}

/** Cents -> a plain decimal dollar STRING, same convention as payroll/reports.ts's own unfmt(). */
function unfmt(cents: Cents): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  return `${neg ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** A standard debit/credit journal CSV a general-ledger import expects, with a self-checking TOTAL row (same convention as renderPayrollRegister()). */
export function renderGlJournalCsv(payRun: PayRun, mapping: GlAccountMapping): string {
  const lines = buildGlJournalEntries(payRun, mapping);
  const header = ['Account', 'Description', 'Debit', 'Credit'];
  const rows = lines.map((l) => [l.account, l.description, l.debit === 0 ? '' : unfmt(l.debit), l.credit === 0 ? '' : unfmt(l.credit)]);
  const totalDebits = lines.reduce((sum, l) => sum + l.debit, 0);
  const totalCredits = lines.reduce((sum, l) => sum + l.credit, 0);
  const totals = ['TOTAL', '', unfmt(totalDebits), unfmt(totalCredits)];
  return [header, ...rows, totals].map((row) => row.map(csvField).join(',')).join('\n') + '\n';
}
