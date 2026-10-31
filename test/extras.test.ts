import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.ts';
import { createCompanyFromSetup } from '../src/builder/finish.ts';
import { updateSetup } from '../src/builder/edit.ts';
import { addEmployee, updateEmployee, importYtd } from '../src/domain/employees.ts';
import { saveWeek } from '../src/domain/weekEntry.ts';
import { draftPayRun, recalculatePayRun } from '../src/payroll/payRuns.ts';
import { ApiError } from '../src/lib/errors.ts';
import type { User } from '../src/accounts/types.ts';
import type { Answers } from '../src/builder/catalog.ts';
import './helpers.ts';

const D = '2026-10-30'; const NOW = new Date(`${D}T15:00:00Z`);
const BASE: Answers = { state: 'TX', locations: [{ name: 'Main', city: 'Austin', state: 'TX' }], team: '1-10', tips: { on: true, pool: 'hours' }, frequency: { value: 'weekly', weekday: 'friday' }, contractors: { on: false } };
const make = (extra: Partial<Answers> = {}) => {
  const store = new Store();
  const company = createCompanyFromSetup(store, { id: 'u1', businessName: 'Harbor' } as User, 'restaurant', { ...BASE, ...extra }, D, NOW);
  const emp = addEmployee(store, company.id, { firstName: 'Ana', lastName: 'Cruz', roleKey: 'line_cook', hireDate: '2026-01-05', payType: { kind: 'hourly', rateCents: 2000 }, ssn: '512-34-9001' });
  saveWeek(store, company, { periodStart: '2026-10-19', periodEnd: '2026-10-25', entries: [{ employeeId: emp.id, regularMinutes: 2400 }] });
  return { store, company, emp };
};
const pc = (store: Store, id: string, empId: string) => store.payRuns.get(id)!.paychecks.find((p) => p.employeeId === empId)!;
const PERIOD = { periodStart: '2026-10-19', periodEnd: '2026-10-25', checkDate: '2026-10-30' };

test('the tip credit answer sets whether tipped staff are paid the lower cash wage', () => {
  assert.equal(make({ tipcredit: { on: true } }).store.companies.all()[0]!.settings.policy.takesTipCredit, true);
  assert.equal(make({ tipcredit: { on: false } }).store.companies.all()[0]!.settings.policy.takesTipCredit, false);
  const { store, company } = make({ tipcredit: { on: true } });
  const c = updateSetup(store, company.id, { tipcredit: { on: false } }, D, NOW);
  assert.equal(c.settings.policy.takesTipCredit, false);
  assert.equal(updateSetup(store, company.id, { tips: { on: false, pool: 'none' } }, D, NOW).settings.policy.takesTipCredit, false, 'no tips, no tip credit');
});

test('a bonus is taxed as pay, a reimbursement is not, and both can be changed on the draft', () => {
  const { store, company, emp } = make({ bonuses: { on: true } });
  const run = draftPayRun(store, company.id, PERIOD);
  const plain = pc(store, run.id, emp.id);
  const r1 = recalculatePayRun(store, company.id, run.id, { adjustments: [{ employeeId: emp.id, code: 'BONUS', label: 'Holiday bonus', category: 'supplemental', amountCents: 50_000 }, { employeeId: emp.id, code: 'MILEAGE', label: 'Mileage', category: 'reimbursement', amountCents: 12_000 }] });
  const withExtras = r1.paychecks.find((p) => p.employeeId === emp.id)!;
  assert.equal(withExtras.taxableWagesCents, plain.taxableWagesCents + 50_000, 'the reimbursement is not wages');
  assert.equal(withExtras.reimbursementCents, 12_000);
  assert.ok(withExtras.netPayCents > plain.netPayCents + 12_000, 'the reimbursement is paid on top, after tax on the bonus');
  assert.ok(withExtras.employeeTaxCents > plain.employeeTaxCents);
  assert.equal(recalculatePayRun(store, company.id, run.id).adjustments.length, 2, 'recalculating without a list keeps them');
  assert.equal(recalculatePayRun(store, company.id, run.id, { adjustments: [] }).paychecks[0]!.taxableWagesCents, plain.taxableWagesCents, 'an empty list clears them');
  assert.throws(() => recalculatePayRun(store, company.id, run.id, { adjustments: [{ employeeId: 'emp_nobody', code: 'X', label: 'x', category: 'supplemental', amountCents: 100 }] }), ApiError);
});

test('a deduction comes out of net pay, and a 401(k) deferral also lowers taxable income tax', () => {
  const { store, company, emp } = make({ deductions: { on: true } });
  const base = pc(store, draftPayRun(store, company.id, PERIOD).id, emp.id);
  updateEmployee(store, company.id, emp.id, { deductionPlans: [{ code: 'DENTAL', category: null, amount: { kind: 'flat', cents: 2500 }, active: true }, { code: '401K', category: 'deferral_401k', amount: { kind: 'percentOfGross', percent: 5 }, active: true }] });
  const store2 = store; const run2 = recalculatePayRun(store2, company.id, store2.payRuns.all()[0]!.id);
  const after = run2.paychecks[0]!;
  assert.equal(after.deductionLines.length, 2);
  assert.equal(after.deductionsCents, 2500 + Math.round(base.taxableWagesCents * 0.05));
  assert.ok(after.netPayCents < base.netPayCents - 2500);
  updateEmployee(store, company.id, emp.id, { deductionPlans: [] });
  assert.equal(recalculatePayRun(store, company.id, run2.id).paychecks[0]!.deductionsCents, 0);
});

test('opening balances from another service set the Social Security base the next run starts from', () => {
  const { store, company, emp } = make({ prior: { on: true } });
  importYtd(store, company.id, emp.id, { asOf: D, socialSecurityWagesCents: 18_400_000, medicareWagesCents: 18_400_000, futaWagesCents: 700_000 });
  const run = draftPayRun(store, company.id, PERIOD);
  const base = make().store; void base;
  const ss = run.paychecks[0]!.taxLines.find((t) => t.id === 'US_SS_EE')!.amount;
  const fresh = (() => { const m = make(); return pc(m.store, draftPayRun(m.store, m.company.id, PERIOD).id, m.emp.id).taxLines.find((t) => t.id === 'US_SS_EE')!.amount; })();
  assert.ok(ss < fresh, `Social Security stops at the yearly cap: ${ss} < ${fresh}`);
});
