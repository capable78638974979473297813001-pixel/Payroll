import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import { buildPaymentBatch, submitPaymentBatch, unbankedSubmitter, type Payee } from '../payroll/index.ts';
import type { AchFileConfig, DirectDepositAccount, PaymentSubmitter } from '../payroll/index.ts';

const config: AchFileConfig = {
  originRoutingNumber: '021000021',
  originName: 'Rooter Bros Payroll',
  immediateOriginId: '1741234567',
  companyName: 'Rooter Bros LLC',
  companyIdentification: '1741234567',
  effectiveEntryDate: '2026-01-14',
};

const checking = (id: string, routing: string): DirectDepositAccount => ({
  id, routingNumber: routing, accountNumber: '000123456789', accountType: 'checking', allocation: { kind: 'remainder' },
});

describe('payment run (payroll/paymentRun.ts)', () => {
  test('assembles one live ACH credit per funded account and totals them', () => {
    const payees: Payee[] = [
      { employeeId: 'joe', name: 'Joe Crew', netPayCents: dollars(1500), accounts: [checking('a1', '021000021')] },
      { employeeId: 'amy', name: 'Amy Crew', netPayCents: dollars(1200), accounts: [checking('a2', '011401533')] },
    ];
    const batch = buildPaymentBatch(payees, config);
    assert.equal(batch.entryCount, 2);
    assert.equal(batch.payeeCount, 2);
    assert.equal(batch.totalCents, dollars(2700));
    assert.equal(batch.credits[0].entryType, 'live');
    assert.ok(batch.nachaFile.length > 0);
    assert.equal(batch.unbanked.length, 0);
  });

  test('an employee with no bank account is flagged unbanked, not silently dropped', () => {
    const payees: Payee[] = [
      { employeeId: 'joe', name: 'Joe Crew', netPayCents: dollars(1000), accounts: [checking('a1', '021000021')] },
      { employeeId: 'sam', name: 'Sam Summers', netPayCents: dollars(800), accounts: [] },
    ];
    const batch = buildPaymentBatch(payees, config);
    assert.equal(batch.entryCount, 1);
    assert.deepEqual(batch.unbanked, [{ employeeId: 'sam', name: 'Sam Summers', netPayCents: dollars(800) }]);
  });

  test('a split deposit (flat + remainder) produces two credits summing to net pay', () => {
    const accounts: DirectDepositAccount[] = [
      { id: 'save', routingNumber: '021000021', accountNumber: '111', accountType: 'savings', allocation: { kind: 'flatAmount', amount: dollars(200) }, priority: 1 },
      { id: 'check', routingNumber: '021000021', accountNumber: '222', accountType: 'checking', allocation: { kind: 'remainder' } },
    ];
    const batch = buildPaymentBatch([{ employeeId: 'joe', name: 'Joe', netPayCents: dollars(1500), accounts }], config);
    assert.equal(batch.entryCount, 2);
    assert.equal(batch.totalCents, dollars(1500));
    assert.equal(batch.credits.find((c) => c.accountType === 'savings')!.amount, dollars(200));
    assert.equal(batch.credits.find((c) => c.accountType === 'checking')!.amount, dollars(1300));
  });

  test('the default submitter moves NO money and says so — never claims a deposit happened', () => {
    const batch = buildPaymentBatch([{ employeeId: 'joe', name: 'Joe', netPayCents: dollars(1000), accounts: [checking('a1', '021000021')] }], config);
    const out = submitPaymentBatch(batch); // default = unbankedSubmitter
    assert.equal(Symbol.asyncIterator in Object(out), false);
    const result = out as ReturnType<typeof unbankedSubmitter.submit> & { submitted: boolean };
    assert.equal((result as { submitted: boolean }).submitted, false);
    assert.match((result as { note: string }).note, /NOT transmitted|no money has moved/i);
  });

  test('a real submitter is honored, and only it can report money moved', async () => {
    const batch = buildPaymentBatch([{ employeeId: 'joe', name: 'Joe', netPayCents: dollars(1000), accounts: [checking('a1', '021000021')] }], config);
    let received = 0;
    const fakeBank: PaymentSubmitter = {
      submit(b) {
        received = b.totalCents;
        return { submitted: true, via: 'test-bank', note: 'accepted', providerRef: 'ach_123', totalCents: b.totalCents, entryCount: b.entryCount };
      },
    };
    const out = await submitPaymentBatch(batch, fakeBank);
    assert.equal(out.submitted, true);
    assert.equal(out.providerRef, 'ach_123');
    assert.equal(received, dollars(1000));
  });
});
