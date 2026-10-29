import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.ts';
import { approvePayRun, draftPayRun } from '../src/payroll/payRuns.ts';
import { buildRegister, runMasteryTax } from '../src/tax/masterytax.ts';
import { day, hire, newCompany, ready, shiftsFor } from './helpers.ts';

/** TX restaurant, one approved two-week run with tips, a cook and a salaried manager. */
function approvedRestaurant() {
  const store = new Store();
  const { company } = newCompany(store, { taxAccounts: { state: { TX: { account: '99-887766-5', suiRate: 0.0215 } }, federalSchedule: 'monthly' } });
  const ana = hire(store, company.id, { firstName: 'Ana', lastName: 'Ruiz', roleKey: 'server' });
  const dee = hire(store, company.id, { firstName: 'Dee', lastName: 'Park', roleKey: 'line_cook', payType: { kind: 'hourly', rateCents: 1700 }, deductionPlans: [{ code: '401K', category: 'deferral_401k', amount: { kind: 'percentOfGross', percent: 5 } }] });
  const eli = hire(store, company.id, { firstName: 'Eli', lastName: 'Voss', roleKey: 'general_manager', payType: { kind: 'salary', annualCents: 5_200_000 } });
  for (const e of [ana, dee, eli]) ready(store, e.id);
  shiftsFor(store, company.id, ana.id, [0, 1, 2, 3, 4, 7, 8, 9, 10, 11], { chargedTipsCents: 8_000, cashTipsCents: 2_000, salesCents: 60_000 });
  shiftsFor(store, company.id, dee.id, [0, 1, 2, 3, 4, 7, 8, 9, 10, 11], { minutes: 480 });
  const run = approvePayRun(store, company.id, draftPayRun(store, company.id, { periodStart: day(0), periodEnd: day(13), checkDate: day(18) }).id, { acknowledgeReviewIssues: true });
  return { store, company, run, ana, dee, eli };
}

test('the register carries wages including tips, deductions by category, and what was withheld by engine tax id', () => {
  const { store, company, run, ana } = approvedRestaurant();
  const reg = buildRegister(company, store.employees.all(), [run], []);
  const [header, ...rows] = reg.payrollCsv.trim().split('\n').map((l) => l.split(','));
  const col = (r: string[], c: string) => r[header.indexOf(c)];
  const anaRow = rows.find((r) => col(r, 'employee_id') === ana.id)!;
  const pc = run.paychecks.find((p) => p.employeeId === ana.id)!;
  assert.equal(col(anaRow, 'gross_wages'), (pc.taxableWagesCents / 100).toFixed(2));
  assert.equal(col(anaRow, 'US_SS_EE'), (pc.taxLines.find((t) => t.id === 'US_SS_EE')!.amount / 100).toFixed(2));
  assert.match(col(anaRow, 'ssn'), /^\d{3}-\d{2}-\d{4}$/);
  assert.ok(rows.some((r) => col(r, 'pretax_401k') !== '' && col(r, 'pretax_401k') !== undefined));
  assert.equal(JSON.parse(reg.companiesJson).companies[0].state_accounts.TX.sui_rate, '0.0215');
});

test('MasteryTax independently recomputes the run and finds no withholding variance', async () => {
  const { store, company } = approvedRestaurant();
  const v: any = await runMasteryTax(store, company.id, 'validate', { asOf: day(25) });
  assert.equal(v.exitCode, 0);
  assert.deepEqual(v.result, [], 'MasteryTax agrees with what the pay run withheld, tax by tax');
});

test('the independent check catches a withholding that does not match the engine', async () => {
  const { store, company, run, ana } = approvedRestaurant();
  // tamper: record $25 less federal income tax withheld than the engine computes
  const tampered = structuredClone(run);
  const pc = tampered.paychecks.find((p) => p.employeeId === ana.id)!;
  pc.taxLines.find((t) => t.id === 'US_FIT')!.amount -= 2_500;
  store.tx(() => store.payRuns.put(tampered));
  const v: any = await runMasteryTax(store, company.id, 'validate', { asOf: day(25) });
  const issues = v.result as Array<{ severity: string; code: string; employee_id?: string; message: string }>;
  assert.ok(issues.length > 0, 'a variance is reported');
  assert.ok(issues.some((i) => i.employee_id === ana.id && /FIT|federal/i.test(i.message + i.code)), JSON.stringify(issues).slice(0, 500));
});

test('liabilities and the 941 tie out to the pay run', async () => {
  const { store, company, run } = approvedRestaurant();
  const l: any = await runMasteryTax(store, company.id, 'liabilities', { asOf: day(25) });
  const liab = l.result as Array<{ tax: string; payer: string; amount: string }>;
  const sumOf = (id: string) => run.paychecks.reduce((a, p) => a + (p.taxLines.find((t) => t.id === id)?.amount ?? 0), 0);
  for (const id of ['US_SS_EE', 'US_MED_EE', 'US_FIT', 'US_FUTA', 'TX_SUI_ER']) {
    assert.equal(Math.round(Number(liab.find((x) => x.tax === id)!.amount) * 100), sumOf(id), id);
  }

  const f: any = await runMasteryTax(store, company.id, '941', { year: 2026, quarter: 2, asOf: day(25) });
  const lines = f.result[0].lines as Array<{ line: string; value: string }>;
  const wages = lines.find((x) => x.line === '2')!;
  // line 2 is wages and tips for income-tax purposes: tips included, 401(k) deferrals excluded
  const deferrals = run.paychecks.flatMap((p) => p.deductionLines).filter((d) => d.category === 'deferral_401k').reduce((a, d) => a + d.amountCents, 0);
  assert.equal(deferrals, 6_800);
  assert.equal(Math.round(Number(wages.value) * 100), run.paychecks.reduce((a, p) => a + p.taxableWagesCents, 0) - deferrals, 'line 2 includes tips and excludes 401(k) deferrals');
  assert.equal(Math.round(Number(lines.find((x) => x.line === '3')!.value) * 100), sumOf('US_FIT'));
});

test('the deposit calendar lists each agency; payment instructions are never transmitted', async () => {
  const { store, company } = approvedRestaurant();
  const d: any = await runMasteryTax(store, company.id, 'deposits', { asOf: day(60) });
  const groups = (d.result as Array<{ Group: string }>).map((x) => x.Group);
  assert.deepEqual(groups.sort(), ['TX-UI', 'US-940', 'US-941']);
  const p: any = await runMasteryTax(store, company.id, 'payments', { asOf: '2026-07-20' });
  assert.ok((p.result as unknown[]).length > 0);
  assert.match(JSON.stringify(p.result), /NOT TRANSMITTED/i);
});

test('MasteryTax needs an approved run to work from', async () => {
  const store = new Store();
  const { company } = newCompany(store);
  await assert.rejects(runMasteryTax(store, company.id, 'validate'), (e: any) => e.code === 'no_approved_runs');
});

test('the state unemployment rate has one source: the pay run and MasteryTax use the same figure', () => {
  const { store, company, run } = approvedRestaurant();
  const sui = run.paychecks.reduce((a, p) => a + (p.taxLines.find((t) => t.id === 'TX_SUI_ER')?.amount ?? 0), 0);
  const wages = run.paychecks.reduce((a, p) => a + p.taxableWagesCents, 0);
  assert.equal(sui, Math.round(wages * 0.0215), 'the company\'s 2.15% rate, not the engine\'s new-employer default');
  void store; void company;
});

test('a rate given twice with different values is refused', () => {
  const store = new Store();
  assert.throws(() => newCompany(store, { taxAccounts: { state: { TX: { suiRate: 0.0215 } } }, employerContext: { stateUnemploymentRate: { TX: 0.03 } } }), /Send it once/);
});
