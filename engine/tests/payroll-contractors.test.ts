import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import { compute1099Nec, FORM_1099_NEC_THRESHOLD_2026, recordContractorPayment } from '../payroll/contractors.ts';
import type { ContractorPayment } from '../payroll/contractors.ts';

describe('1099 contractor payments and reporting (payroll/contractors.ts)', () => {
  test('the 2026 threshold is $2,000 — OBBBA\'s raised figure, not the old $600', () => {
    assert.equal(FORM_1099_NEC_THRESHOLD_2026, dollars(2_000));
  });

  test('recordContractorPayment produces a real, retrievable payment record', () => {
    const payment = recordContractorPayment('c1', dollars(500), '2026-03-01', 'March invoice');
    assert.equal(payment.contractorId, 'c1');
    assert.equal(payment.amount, dollars(500));
    assert.equal(payment.paymentDate, '2026-03-01');
    assert.ok(payment.id);
  });

  test('a contractor paid at or above the 2026 threshold requires reporting', () => {
    const payments: ContractorPayment[] = [
      { id: 'p1', contractorId: 'c1', amount: dollars(1_000), paymentDate: '2026-02-01' },
      { id: 'p2', contractorId: 'c1', amount: dollars(1_000), paymentDate: '2026-06-01' },
    ];
    const summary = compute1099Nec('c1', 2026, payments);
    assert.equal(summary.totalPayments, dollars(2_000));
    assert.equal(summary.reportingRequired, true);
    assert.equal(summary.paymentCount, 2);
  });

  test('a contractor paid just under the threshold does not require reporting, even though the income is still taxable to them', () => {
    const payments: ContractorPayment[] = [{ id: 'p1', contractorId: 'c1', amount: dollars(1_999), paymentDate: '2026-02-01' }];
    const summary = compute1099Nec('c1', 2026, payments);
    assert.equal(summary.reportingRequired, false);
  });

  test('payments to a DIFFERENT contractor, or in a DIFFERENT year, are never counted', () => {
    const payments: ContractorPayment[] = [
      { id: 'p1', contractorId: 'c1', amount: dollars(5_000), paymentDate: '2026-02-01' },
      { id: 'p2', contractorId: 'c2', amount: dollars(5_000), paymentDate: '2026-02-01' },
      { id: 'p3', contractorId: 'c1', amount: dollars(5_000), paymentDate: '2025-02-01' },
    ];
    const summary = compute1099Nec('c1', 2026, payments);
    assert.equal(summary.totalPayments, dollars(5_000));
    assert.equal(summary.paymentCount, 1);
  });

  test('a contractor with no payments on file at all reports clean zeros', () => {
    const summary = compute1099Nec('c1', 2026, []);
    assert.equal(summary.totalPayments, 0);
    assert.equal(summary.reportingRequired, false);
    assert.equal(summary.paymentCount, 0);
  });
});
