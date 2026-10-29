import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import { buildGlJournalEntries, renderGlJournalCsv } from '../payroll/glExport.ts';
import type { GlAccountMapping } from '../payroll/glExport.ts';
import type { PayRun, PayRunLine } from '../payroll/types.ts';

function mapping(): GlAccountMapping {
  return {
    wagesExpense: '6000',
    employerTaxExpense: '6100',
    federalTaxPayable: '2100',
    stateTaxPayable: '2110',
    localTaxPayable: '2120',
    netPayPayable: '2200',
    garnishmentPayable: '2300',
    benefitDeductionPayable: '2400',
  };
}

function line(overrides: Partial<PayRunLine> = {}): PayRunLine {
  return {
    employeeId: 'e1',
    grossPay: dollars(3_000),
    netPay: dollars(1_960.5),
    employeeTaxTotal: dollars(809.5),
    employerTaxTotal: dollars(279.5),
    pretaxDeductions: dollars(100),
    posttaxDeductions: dollars(50),
    garnishmentTotal: dollars(80),
    netPayAfterGarnishment: dollars(1_960.5),
    taxLines: [
      { id: 'us_fit', name: 'Federal Income Tax', payer: 'employee', jurisdiction: 'federal', taxableWages: dollars(3_000), amount: dollars(400) },
      { id: 'us_ss_ee', name: 'Social Security (employee)', payer: 'employee', jurisdiction: 'federal', taxableWages: dollars(3_000), amount: dollars(186) },
      { id: 'us_ss_er', name: 'Social Security (employer)', payer: 'employer', jurisdiction: 'federal', taxableWages: dollars(3_000), amount: dollars(186) },
      { id: 'us_medicare_ee', name: 'Medicare (employee)', payer: 'employee', jurisdiction: 'federal', taxableWages: dollars(3_000), amount: dollars(43.5) },
      { id: 'us_medicare_er', name: 'Medicare (employer)', payer: 'employer', jurisdiction: 'federal', taxableWages: dollars(3_000), amount: dollars(43.5) },
      { id: 'state_it', name: 'State Income Tax', payer: 'employee', jurisdiction: 'state', taxableWages: dollars(3_000), amount: dollars(150) },
      { id: 'suta', name: 'SUTA', payer: 'employer', jurisdiction: 'state', taxableWages: dollars(3_000), amount: dollars(50) },
      { id: 'local', name: 'Local Tax', payer: 'employee', jurisdiction: 'local', taxableWages: dollars(3_000), amount: dollars(30) },
    ],
    garnishmentLines: [],
    depositAllocations: [],
    ...overrides,
  };
}

function payRun(overrides: Partial<PayRun> = {}): PayRun {
  return {
    id: 'run-1',
    companyId: 'co-1',
    periodStart: '2026-01-01',
    periodEnd: '2026-01-14',
    checkDate: '2026-01-16',
    status: 'approved',
    lines: [line()],
    createdAt: '2026-01-15',
    minimumWageIssues: [],
    ...overrides,
  };
}

describe('GL journal entry export (payroll/glExport.ts)', () => {
  test('total debits equal total credits exactly', () => {
    const lines = buildGlJournalEntries(payRun(), mapping());
    const totalDebits = lines.reduce((sum, l) => sum + l.debit, 0);
    const totalCredits = lines.reduce((sum, l) => sum + l.credit, 0);
    assert.equal(totalDebits, totalCredits);
  });

  test('wages expense debit equals total gross pay across all lines', () => {
    const lines = buildGlJournalEntries(payRun({ lines: [line(), line({ employeeId: 'e2' })] }), mapping());
    const wagesLine = lines.find((l) => l.account === '6000')!;
    assert.equal(wagesLine.debit, dollars(6_000)); // two employees at $3,000 gross each
  });

  test('tax payable lines are split correctly by jurisdiction, summing employee + employer shares together', () => {
    const lines = buildGlJournalEntries(payRun(), mapping());
    const federal = lines.find((l) => l.account === '2100')!;
    // 400 + 186 + 186 + 43.5 + 43.5 = 859
    assert.equal(federal.credit, dollars(859));
    const state = lines.find((l) => l.account === '2110')!;
    assert.equal(state.credit, dollars(200)); // 150 + 50
    const local = lines.find((l) => l.account === '2120')!;
    assert.equal(local.credit, dollars(30));
  });

  test('benefit deductions combine pretax and posttax; garnishment and net pay are their own lines', () => {
    const lines = buildGlJournalEntries(payRun(), mapping());
    assert.equal(lines.find((l) => l.account === '2400')!.credit, dollars(150)); // 100 pretax + 50 posttax
    assert.equal(lines.find((l) => l.account === '2300')!.credit, dollars(80));
    assert.equal(lines.find((l) => l.account === '2200')!.credit, dollars(1_960.5));
  });

  test('a category with zero activity produces no journal line at all, rather than a zero-dollar one', () => {
    // Removing the $30 local tax line means the employee keeps that $30 as
    // net pay instead -- both employeeTaxTotal and netPayAfterGarnishment
    // must shift together to preserve the accounting identity, or this
    // fixture itself would trip the "does not balance" guard.
    const noLocalTax = line({
      taxLines: line().taxLines.filter((t) => t.jurisdiction !== 'local'),
      employeeTaxTotal: dollars(779.5),
      netPayAfterGarnishment: dollars(1_990.5),
    });
    const lines = buildGlJournalEntries(payRun({ lines: [noLocalTax] }), mapping());
    assert.equal(lines.find((l) => l.account === '2120'), undefined);
  });

  test('throws rather than returning a silently unbalanced entry', () => {
    const brokenLine = line({ grossPay: dollars(999_999) }); // grossPay no longer matches the accounting identity
    assert.throws(() => buildGlJournalEntries(payRun({ lines: [brokenLine] }), mapping()), /does not balance/);
  });

  test('the rendered CSV has a self-checking TOTAL row where debits equal credits', () => {
    const csv = renderGlJournalCsv(payRun(), mapping());
    const rows = csv.trim().split('\n');
    const totalRow = rows[rows.length - 1];
    assert.match(totalRow, /^TOTAL,,\d+\.\d{2},\d+\.\d{2}$/);
    const [, , debitStr, creditStr] = totalRow.split(',');
    assert.equal(debitStr, creditStr);
  });
});
