import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.ts';
import { dashboardData } from '../src/dashboard/data.ts';
import { createCompanyFromSetup } from '../src/builder/finish.ts';
import { addEmployee } from '../src/domain/employees.ts';
import { saveWeek } from '../src/domain/weekEntry.ts';
import { recordShift } from '../src/domain/timekeeping.ts';
import { draftPayRun } from '../src/payroll/payRuns.ts';
import { payrollRegister, hoursReport, roster } from '../src/reports/service.ts';
import { ApiError } from '../src/lib/errors.ts';
import type { User } from '../src/accounts/types.ts';
import { posReady } from './helpers.ts';

const D = '2026-10-30';
function make() {
  const store = new Store();
  const company = createCompanyFromSetup(store, { id: 'u1', businessName: 'Harbor Street Kitchen' } as User, 'restaurant', { state: 'MI', locations: [{ name: 'Detroit', city: 'Detroit', state: 'MI' }], team: '1-10', tips: { on: true, pool: 'hours' }, frequency: { value: 'weekly', weekday: 'friday' }, contractors: { on: false } }, D, new Date(`${D}T15:00:00Z`));
  const mk = (first: string, over: Record<string, unknown> = {}) => addEmployee(store, company.id, { firstName: first, lastName: 'Test', email: `${first.toLowerCase()}@harbor.test`, roleKey: 'line_cook', hireDate: '2026-01-05', payType: { kind: 'hourly', rateCents: 2000 }, ssn: `512-34-${1000 + Math.floor(Math.random() * 8000)}`, ...over });
  return { store, company, mk, data: () => dashboardData(store, store.companies.get(company.id)!, D) };
}

test('a brand-new company gets a guided setup in the order a restaurant does it, and it fills in as things are done', () => {
  const { data, store, company, mk } = make();
  const d = data();
  assert.deepEqual(d.guide.steps.map((x) => x.id).filter((x) => x !== 'state'), ['company', 'bank', 'team', 'hours', 'first']);
  assert.equal(d.guide.done, 0);
  assert.ok(d.guide.minutes > 0);
  assert.ok(d.guide.steps.every((x) => x.to.startsWith('/app')));
  assert.deepEqual(d.todos.map((t) => t.id).filter((id) => ['ein', 'bank', 'first', 'uia', 'pos'].includes(id)), [], 'the to-do list leaves out what the guide already says');
  assert.equal(d.nextPayroll.stage, 'not_started');
  assert.equal(d.nextPayroll.runByPassed, false);
  mk('Ana');
  assert.equal(data().guide.steps.find((x) => x.id === 'team')!.done, true);
  store.tx(() => store.companies.put({ ...store.companies.get(company.id)!, payment: { ...store.companies.get(company.id)!.payment, employerBank: { bankAccountId: 'bank_x' } } as never }));
  assert.equal(data().guide.steps.find((x) => x.id === 'bank')!.done, true);
});

test('the run-by date is the last banking day your bank can still pay on time', () => {
  const { data } = make();
  const n = data().nextPayroll;
  assert.equal(n.period.checkDate, '2026-11-06');
  assert.equal(n.runBy, '2026-11-05', 'one banking day before Friday Nov 6');
  assert.equal(n.daysToRunBy, 6);
});

test('the list follows the work: a missing W-4, a draft run, an approved run waiting to be paid', () => {
  const { store, company, mk, data } = make();
  const a = mk('Ana'); const b = mk('Ben', { })
  store.tx(() => store.employees.put({ ...store.employees.get(b.id)!, onboarding: { invitedAt: '2026-10-01T00:00:00Z', requested: ['w4', 'i9', 'deposit'] } }));
  let d = data();
  assert.ok(d.todos.some((t) => t.id === 'w4' && /Ben Test has no W-4/.test(t.title)));
  assert.equal(d.nextPayroll.people.missingW4, 1);
  assert.equal(d.nextPayroll.people.hourlyWithHours, 0);
  saveWeek(store, company, { periodStart: '2026-10-26', periodEnd: '2026-11-01', entries: [{ employeeId: a.id, regularMinutes: 2400 }] });
  assert.equal(data().nextPayroll.people.hourlyWithHours, 1);
  posReady(store, company.id, '2026-10-26', '2026-11-01');
  const run = draftPayRun(store, company.id, { periodStart: '2026-10-26', periodEnd: '2026-11-01', checkDate: '2026-11-06' });
  d = data();
  assert.equal(d.nextPayroll.stage, 'draft');
  assert.ok(d.todos.some((t) => t.id === 'draft' && t.to === `/app/payroll/runs/${run.id}`));
  store.tx(() => store.payRuns.put({ ...run, status: 'approved' }));
  d = data();
  assert.equal(d.nextPayroll.stage, 'approved');
  assert.ok(d.todos.some((t) => t.id.startsWith('pay_')), 'pay your team');
  assert.equal(d.todos.find((t) => t.id.startsWith('pay_'))!.severity, 'soon', 'pay day is still ahead');
});

test('reports are plain CSV: the register by pay date, hours and tips, and a roster that masks SSNs', () => {
  const { store, company, mk } = make();
  const a = mk('Ana');
  saveWeek(store, company, { periodStart: '2026-10-19', periodEnd: '2026-10-25', entries: [{ employeeId: a.id, regularMinutes: 1950 }] });
  posReady(store, company.id, '2026-10-19', '2026-10-25');
  const run = draftPayRun(store, company.id, { periodStart: '2026-10-19', periodEnd: '2026-10-25', checkDate: '2026-10-30' });
  assert.equal(payrollRegister(store, company.id, '2026-01-01', '2026-12-31').rows, 0, 'a draft is not in the register');
  store.tx(() => store.payRuns.put({ ...run, status: 'approved' }));
  const reg = payrollRegister(store, company.id, '2026-10-01', '2026-10-31');
  assert.equal(reg.rows, 1);
  assert.ok(reg.content.split('\n')[1]!.startsWith('"2026-10-30","2026-10-19","2026-10-25","Ana Test","32.50"'));
  assert.equal(payrollRegister(store, company.id, '2026-11-01', '2026-11-30').rows, 0);
  assert.equal(hoursReport(store, company.id, '2026-10-19', '2026-10-25').rows, 1);
  const r = roster(store, company.id);
  assert.ok(r.content.includes('***-**-') && !r.content.includes('512-34'));
  assert.throws(() => payrollRegister(store, company.id, '2026-12-01', '2026-01-01'), ApiError);
});

test('the week at the restaurant: wages with overtime at time and a half, overtime as a share of hours, by position and by place', () => {
  const { store, company, mk, data } = make();
  const a = mk('Ana'); const b = mk('Ben');
  const d0 = data().hours.weekStart;
  const day = (n: number) => new Date(Date.parse(`${d0}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const rate = (id: string) => (store.employees.get(id)!.payType as { rateCents: number }).rateCents;
  const hourly = rate(a.id);
  recordShift(store, company.id, { employeeId: a.id, workDate: day(0), minutes: 1440 });
  recordShift(store, company.id, { employeeId: a.id, workDate: day(1), minutes: 1260 }); // 45 hours
  recordShift(store, company.id, { employeeId: b.id, workDate: day(0), minutes: 1200 }); // 20 hours
  const w = data().week;
  assert.equal(w.workers, 2);
  assert.equal(w.overtimeShare, 7.7, '5 of 65 hours');
  assert.equal(w.wagesCents, Math.round(hourly * 40 + hourly * 1.5 * 5 + hourly * 20), 'forty hours plain, five at time and a half, twenty plain');
  assert.equal(w.byRole.length, 1);
  assert.deepEqual([w.byRole[0]!.role, w.byRole[0]!.people, w.byRole[0]!.minutes], ['line_cook', 2, 3900]);
  assert.equal(w.byPlace.reduce((n, p) => n + p.minutes, 0), 3900);
  assert.equal(typeof data().company.nicheLabel, 'string');
});
