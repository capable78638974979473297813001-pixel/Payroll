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
