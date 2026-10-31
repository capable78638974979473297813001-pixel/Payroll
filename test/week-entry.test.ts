import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.ts';
import { saveWeek, weekSummary } from '../src/domain/weekEntry.ts';
import { recordShift } from '../src/domain/timekeeping.ts';
import { draftPayRun, approvePayRun } from '../src/payroll/payRuns.ts';
import { ApiError } from '../src/lib/errors.ts';
import { hire, newCompany } from './helpers.ts';

const FROM = '2026-10-19';
const TO = '2026-10-25';
const setup = () => {
  const store = new Store();
  const { company } = newCompany(store);
  const server = hire(store, company.id, { firstName: 'Elena', lastName: 'Ruiz' });
  const cook = hire(store, company.id, { firstName: 'Priya', lastName: 'Raman', roleKey: 'line_cook' });
  return { store, company, server, cook };
};
const refused = (fn: () => unknown, code: string) => assert.throws(fn, (e: unknown) => e instanceof ApiError && e.code === code, code);
const rowOf = (store: Store, company: ReturnType<typeof setup>['company'], id: string) => weekSummary(store, company, FROM, TO).people.find((p) => p.employeeId === id)!;

test('a weekly entry becomes shifts, and overtime comes from the hours, not from the box it was typed in', () => {
  const { store, company, server } = setup();
  saveWeek(store, company, { periodStart: FROM, periodEnd: TO, entries: [{ employeeId: server.id, regularMinutes: 40 * 60, overtimeMinutes: 6 * 60, tipsCents: 41230 }] });
  let row = rowOf(store, company, server.id);
  assert.equal(row.regularMinutes, 2400);
  assert.equal(row.overtimeMinutes, 360);
  assert.equal(row.tipsCents, 41230);
  // typed all in the regular box, same answer
  saveWeek(store, company, { periodStart: FROM, periodEnd: TO, entries: [{ employeeId: server.id, regularMinutes: 46 * 60, overtimeMinutes: 0, tipsCents: 41230 }] });
  row = rowOf(store, company, server.id);
  assert.equal(row.regularMinutes, 2400);
  assert.equal(row.overtimeMinutes, 360);
  const run = draftPayRun(store, company.id, { periodStart: FROM, periodEnd: TO, checkDate: '2026-10-30' });
  const pc = run.paychecks.find((p) => p.employeeId === server.id)!;
  assert.equal(pc.hours, 46);
  assert.ok(pc.weeks[0]!.overtimeMinutes === 360);
});

test('saving again replaces the earlier entry instead of paying it twice', () => {
  const { store, company, cook } = setup();
  const entry = (h: number) => ({ periodStart: FROM, periodEnd: TO, entries: [{ employeeId: cook.id, regularMinutes: h * 60 }] });
  saveWeek(store, company, entry(40));
  saveWeek(store, company, entry(32));
  assert.equal(rowOf(store, company, cook.id).regularMinutes, 32 * 60);
  saveWeek(store, company, entry(0));
  assert.equal(store.shifts.where((s) => s.employeeId === cook.id).length, 0);
});

test('shift-by-shift time is never overwritten by a different weekly box', () => {
  const { store, company, cook } = setup();
  recordShift(store, company.id, { employeeId: cook.id, workDate: '2026-10-20', minutes: 480 });
  assert.equal(rowOf(store, company, cook.id).shiftByShift, true);
  refused(() => saveWeek(store, company, { periodStart: FROM, periodEnd: TO, entries: [{ employeeId: cook.id, regularMinutes: 40 * 60 }] }), 'detailed_time_exists');
  // the same numbers are fine: nothing changes
  saveWeek(store, company, { periodStart: FROM, periodEnd: TO, entries: [{ employeeId: cook.id, regularMinutes: 480 }] });
  assert.equal(store.shifts.where((s) => s.employeeId === cook.id).length, 1);
});

test('an approved period cannot change, tips need a tipped role, and an impossible week is refused', () => {
  const { store, company, server, cook } = setup();
  assert.throws(() => saveWeek(store, company, { periodStart: FROM, periodEnd: TO, entries: [{ employeeId: server.id, regularMinutes: 90 * 60 }] }), /more than a person can work/);
  const role = company.settings.roles.find((r) => r.key === 'line_cook')!;
  if (role.tipped === 'never') assert.throws(() => saveWeek(store, company, { periodStart: FROM, periodEnd: TO, entries: [{ employeeId: cook.id, regularMinutes: 600, tipsCents: 500 }] }), /not a tipped role/);
  saveWeek(store, company, { periodStart: FROM, periodEnd: TO, entries: [{ employeeId: server.id, regularMinutes: 20 * 60 }] });
  const run = draftPayRun(store, company.id, { periodStart: FROM, periodEnd: TO, checkDate: '2026-10-30' });
  approvePayRun(store, company.id, run.id, { acknowledgeReviewIssues: true });
  refused(() => saveWeek(store, company, { periodStart: FROM, periodEnd: TO, entries: [{ employeeId: server.id, regularMinutes: 25 * 60 }] }), 'period_closed');
});

test('a two-week period keeps each week under its own overtime line, and a new hire is only given days they were employed', () => {
  const { store, company, server } = setup();
  saveWeek(store, company, { periodStart: '2026-10-12', periodEnd: '2026-10-25', entries: [{ employeeId: server.id, regularMinutes: 80 * 60 }] });
  const row = weekSummary(store, company, '2026-10-12', '2026-10-25').people.find((p) => p.employeeId === server.id)!;
  assert.equal(row.regularMinutes, 4800);
  assert.equal(row.overtimeMinutes, 0);
  const late = hire(store, company.id, { firstName: 'New', lastName: 'Hire', hireDate: '2026-10-22' });
  saveWeek(store, company, { periodStart: FROM, periodEnd: TO, entries: [{ employeeId: late.id, regularMinutes: 12 * 60 }] });
  const days = store.shifts.where((s) => s.employeeId === late.id).map((s) => s.workDate);
  assert.ok(days.length > 0 && days.every((d) => d >= '2026-10-22'), days.join());
});

test('hours by day: set a day, change it, clear it, and see the tip pool for that week', async () => {
  const { daySummary, saveDay } = await import('../src/domain/weekEntry.ts');
  const { store, company, server, cook } = setup();
  saveDay(store, company, { employeeId: cook.id, date: '2026-10-20', minutes: 480 });
  saveDay(store, company, { employeeId: cook.id, date: '2026-10-21', minutes: 360 });
  saveDay(store, company, { employeeId: cook.id, date: '2026-10-20', minutes: 420 });
  let sum = daySummary(store, company, FROM, TO);
  const row = sum.people.find((p) => p.employeeId === cook.id)!;
  assert.equal(row.perDay[1]!.minutes, 420);
  assert.equal(row.totalMinutes, 780);
  assert.equal(store.shifts.where((s) => s.employeeId === cook.id).length, 2, 'a changed day is not a second shift');
  saveDay(store, company, { employeeId: cook.id, date: '2026-10-21', minutes: 0 });
  assert.equal(daySummary(store, company, FROM, TO).people.find((p) => p.employeeId === cook.id)!.totalMinutes, 420);

  recordShift(store, company.id, { employeeId: server.id, workDate: '2026-10-22', minutes: 360, chargedTipsCents: 20000 });
  recordShift(store, company.id, { employeeId: server.id, workDate: '2026-10-23', minutes: 360 });
  refused(() => saveDay(store, company, { employeeId: server.id, date: '2026-10-22', minutes: 0 }), 'has_tips');
  recordShift(store, company.id, { employeeId: server.id, workDate: '2026-10-23', minutes: 60 });
  refused(() => saveDay(store, company, { employeeId: server.id, date: '2026-10-23', minutes: 100 }), 'detailed_time_exists');
  sum = daySummary(store, company, FROM, TO);
  assert.equal(sum.tips.chargedCents, 20000);
  assert.equal(sum.tips.totalCents, 20000);
  assert.throws(() => saveDay(store, company, { employeeId: cook.id, date: '2025-01-01', minutes: 60 }), /wasn’t employed/);
});

test('weekly payroll keeps paycheck tips and already-received cash tips separate, including when resaved', () => {
  const { store, company, server } = setup();
  const entries = [{ employeeId: server.id, regularMinutes: 2400, tipsCents: 20000, cashTipsCents: 5000 }];
  saveWeek(store, company, { periodStart: FROM, periodEnd: TO, entries });
  saveWeek(store, company, { periodStart: FROM, periodEnd: TO, entries });
  const row = rowOf(store, company, server.id);
  assert.equal(row.chargedTipsCents, 20000);
  assert.equal(row.cashTipsCents, 5000);
  assert.equal(row.tipsCents, 25000);
  const shifts = store.shifts.where(s => s.employeeId === server.id);
  assert.equal(shifts.reduce((n, s) => n + s.cashTipsCents, 0), 5000);
  assert.equal(shifts.reduce((n, s) => n + s.chargedTipsCents, 0), 20000);
  const run = draftPayRun(store, company.id, { periodStart: FROM, periodEnd: TO, checkDate: '2026-10-30' });
  assert.equal(run.totals.cashTipsCents, 5000);
  assert.equal(run.paychecks[0]!.tips.cashCents, 5000);
  assert.equal(run.paychecks[0]!.payableCents, run.paychecks[0]!.netPayCents - 5000, 'cash already received is not paid twice');
});

test('invalid cash-tip input rolls back the whole weekly update', () => {
  const { store, company, server } = setup();
  saveWeek(store, company, { periodStart: FROM, periodEnd: TO, entries: [{ employeeId: server.id, regularMinutes: 2400, tipsCents: 20000, cashTipsCents: 5000 }] });
  assert.throws(() => saveWeek(store, company, { periodStart: FROM, periodEnd: TO, entries: [{ employeeId: server.id, regularMinutes: 1200, cashTipsCents: -1 }] }));
  const row = rowOf(store, company, server.id);
  assert.equal(row.regularMinutes, 2400);
  assert.equal(row.cashTipsCents, 5000);
});
