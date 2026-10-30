import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.ts';
import { updateSetup } from '../src/builder/edit.ts';
import { DashboardService } from '../src/dashboard/service.ts';
import { createCompanyFromSetup } from '../src/builder/finish.ts';
import { addEmployee } from '../src/domain/employees.ts';
import { ApiError } from '../src/lib/errors.ts';
import type { User } from '../src/accounts/types.ts';
import type { Answers } from '../src/builder/catalog.ts';

const D = '2026-10-30';
const NOW = new Date(`${D}T15:00:00Z`);
const FULL: Answers = { state: 'MI', locations: [{ name: 'Detroit', city: 'Detroit', state: 'MI' }, { name: 'Ferndale', city: 'Ferndale', state: 'MI' }], team: '11-25', tips: { on: true, pool: 'hours' }, frequency: { value: 'weekly', weekday: 'friday' }, contractors: { on: true, count: 2 } };
function made() {
  const store = new Store();
  const company = createCompanyFromSetup(store, { id: 'u1', businessName: 'Harbor' } as User, 'restaurant', FULL, D, NOW);
  const dash = new DashboardService(store, () => NOW);
  dash.get(company.id);
  return { store, company, dash };
}
const moduleIds = (dash: DashboardService, id: string) => dash.get(id).config.tabs.find((t) => t.id === 'overview')!.widgets.filter((w) => w.type === 'module').map((w) => w.settings.module);
const refused = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: unknown) => e instanceof ApiError && re.test(`${e.code} ${e.message}`), String(re));

test('switching contractors off removes its card and keeps every other card where the owner put it', () => {
  const { store, company, dash } = made();
  const before = moduleIds(dash, company.id);
  assert.ok(before.includes('contractors'));
  updateSetup(store, company.id, { contractors: { on: false } }, D, NOW);
  dash.reconcile(company.id);
  assert.deepEqual(moduleIds(dash, company.id), before.filter((m) => m !== 'contractors'));
  updateSetup(store, company.id, { contractors: { on: true, count: 3 } }, D, NOW);
  dash.reconcile(company.id);
  assert.equal(moduleIds(dash, company.id).at(-1), 'contractors', 'a returning section goes at the end');
});

test('pay frequency, locations and tips follow the new answers', () => {
  const { store, company } = made();
  const c = updateSetup(store, company.id, { frequency: { value: 'biweekly', weekday: 'thursday' }, tips: { on: true, pool: 'points' }, locations: [...FULL.locations!, { name: 'Royal Oak', city: 'Royal Oak', state: 'MI' }] }, D, NOW);
  assert.equal(c.paySchedule.frequency, 'biweekly');
  assert.equal(c.paySchedule.payWeekday, 'thursday');
  assert.equal(c.settings.policy.pool.basis, 'points');
  assert.equal(c.locations!.length, 3);
  const off = updateSetup(store, company.id, { tips: { on: false, pool: 'none' } }, D, NOW);
  assert.equal(off.settings.policy.pool.enabled, false);
});

test('the state cannot change, and a location people work at cannot be removed', () => {
  const { store, company } = made();
  refused(() => updateSetup(store, company.id, { state: 'OH' }, D, NOW), /can’t change here/);
  updateSetup(store, company.id, { state: 'MI' }, D, NOW); // the same state is fine
  addEmployee(store, company.id, { firstName: 'A', lastName: 'B', roleKey: 'server', hireDate: '2026-01-05', payType: { kind: 'hourly', rateCents: 1500 }, location: 'Ferndale', tipCreditNoticeDate: '2026-01-05' });
  refused(() => updateSetup(store, company.id, { locations: [FULL.locations![0]!] }, D, NOW), /location_in_use/);
  refused(() => updateSetup(store, company.id, { team: 'nonsense' }, D, NOW), /team|size/i);
  assert.equal(store.companies.get(company.id)!.locations!.length, 2, 'a refused change changes nothing');
});
