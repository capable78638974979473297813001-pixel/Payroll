import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import {
  ProviderNotConnectedError,
  checkProvider,
  resolveProvider,
  sandboxProvider,
  zealProvider,
  type EmbeddedPayrollProvider,
  type ProviderPayrollInput,
} from '../payroll/index.ts';

const input: ProviderPayrollInput = {
  companyId: 'shop-1',
  checkDate: '2026-01-14',
  items: [
    { employeeId: 'joe', name: 'Joe Crew', grossCents: dollars(2000), netCents: dollars(1500), taxWithheldCents: dollars(500) },
    { employeeId: 'amy', name: 'Amy Crew', grossCents: dollars(1600), netCents: dollars(1250), taxWithheldCents: dollars(350) },
  ],
};

describe('embedded payroll provider (payroll/embeddedProvider.ts)', () => {
  test('the sandbox accepts the payroll but never claims money moved or taxes filed', async () => {
    const r = await sandboxProvider.runPayroll(input);
    assert.equal(r.submitted, true);
    assert.equal(r.moneyMoved, false);
    assert.equal(r.taxesFiled, false);
    assert.match(r.note, /SANDBOX|no money moved/i);
    assert.equal(r.totalNetCents, dollars(2750));
    assert.equal(r.totalTaxCents, dollars(850));
    assert.equal(r.perEmployee.length, 2);
    assert.equal(r.perEmployee[0].status, 'simulated');
  });

  test('real adapters report configured() from their key but refuse to run until implemented', async () => {
    delete process.env.CHECK_API_KEY;
    assert.equal(checkProvider.configured(), false);
    process.env.CHECK_API_KEY = 'test_key';
    assert.equal(checkProvider.configured(), true);
    await assert.rejects(checkProvider.runPayroll(input), ProviderNotConnectedError);
    await assert.rejects(zealProvider.runPayroll(input), ProviderNotConnectedError);
    delete process.env.CHECK_API_KEY;
  });

  test('resolveProvider stays on the sandbox until a real adapter is connected', () => {
    assert.equal(resolveProvider().name, 'sandbox');
  });

  test('a real provider (when implemented) is honored and only IT can report money moved', async () => {
    const liveCheck: EmbeddedPayrollProvider = {
      name: 'check',
      configured: () => true,
      async runPayroll(i) {
        return {
          provider: 'check',
          submitted: true,
          moneyMoved: true,
          taxesFiled: true,
          providerRef: 'py_abc123',
          note: 'accepted',
          totalNetCents: i.items.reduce((s, x) => s + x.netCents, 0),
          totalTaxCents: i.items.reduce((s, x) => s + x.taxWithheldCents, 0),
          perEmployee: i.items.map((x) => ({ employeeId: x.employeeId, netCents: x.netCents, status: 'paid' })),
        };
      },
    };
    const r = await liveCheck.runPayroll(input);
    assert.equal(r.moneyMoved, true);
    assert.equal(r.taxesFiled, true);
    assert.equal(r.providerRef, 'py_abc123');
    assert.equal(r.totalNetCents, dollars(2750));
  });
});
