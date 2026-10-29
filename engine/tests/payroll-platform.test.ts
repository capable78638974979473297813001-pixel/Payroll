import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import { runEmbeddedPayroll, sandboxProvider, type PlatformEmployeeInput } from '../payroll/index.ts';
import type { EmbeddedPayrollProvider } from '../payroll/index.ts';

const w4 = { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 } as const;

const employees: PlatformEmployeeInput[] = [
  { employeeId: 'joe', name: 'Joe Crew', grossCents: dollars(2000), workStateCode: 'TX', federalW4: { ...w4 } },
  { employeeId: 'amy', name: 'Amy Crew', grossCents: dollars(1600), workStateCode: 'TX', federalW4: { ...w4 } },
];

describe('embedded-payroll platform (payroll/platform.ts)', () => {
  test('runs a full payroll: engine computes each net, totals add up, provider settles', async () => {
    const run = await runEmbeddedPayroll({ companyId: 'shop-1', checkDate: '2026-01-14', payFrequency: 'weekly', employees });
    assert.equal(run.paychecks.length, 2);
    // each employee's net is real gross-to-net from the engine (TX: no state tax, so net < gross by fed+FICA)
    for (const p of run.paychecks) {
      assert.ok(p.netCents > 0 && p.netCents < p.grossCents, `net should be below gross for ${p.employeeId}`);
      assert.equal(p.taxWithheldCents, p.grossCents - p.netCents);
    }
    assert.equal(run.totalGrossCents, dollars(3600));
    assert.equal(run.totalNetCents, run.paychecks.reduce((s, p) => s + p.netCents, 0));
    assert.equal(run.totalTaxCents, run.totalGrossCents - run.totalNetCents);
    assert.ok(run.runId.startsWith('run_'));
  });

  test('with the sandbox provider, the run is accepted but no money moved and no taxes filed', async () => {
    const run = await runEmbeddedPayroll({ companyId: 'shop-1', checkDate: '2026-01-14', payFrequency: 'weekly', employees, provider: sandboxProvider });
    assert.equal(run.settlement.submitted, true);
    assert.equal(run.settlement.moneyMoved, false);
    assert.equal(run.settlement.taxesFiled, false);
    assert.match(run.settlement.note, /SANDBOX|no money moved/i);
    // the amount handed to the provider matches the engine's totals
    assert.equal(run.settlement.totalNetCents, run.totalNetCents);
  });

  test('a real provider (when connected) is what turns money-moved true — nothing else', async () => {
    let handedNet = 0;
    const liveZeal: EmbeddedPayrollProvider = {
      name: 'zeal',
      configured: () => true,
      async runPayroll(input) {
        handedNet = input.items.reduce((s, i) => s + i.netCents, 0);
        return {
          provider: 'zeal',
          submitted: true,
          moneyMoved: true,
          taxesFiled: true,
          providerRef: 'zpr_1',
          note: 'accepted',
          totalNetCents: handedNet,
          totalTaxCents: input.items.reduce((s, i) => s + i.taxWithheldCents, 0),
          perEmployee: input.items.map((i) => ({ employeeId: i.employeeId, netCents: i.netCents, status: 'paid' })),
        };
      },
    };
    const run = await runEmbeddedPayroll({ companyId: 'shop-1', checkDate: '2026-01-14', payFrequency: 'weekly', employees, provider: liveZeal });
    assert.equal(run.settlement.moneyMoved, true);
    assert.equal(run.settlement.taxesFiled, true);
    assert.equal(handedNet, run.totalNetCents); // the platform handed the provider exactly what the engine computed
  });
});
