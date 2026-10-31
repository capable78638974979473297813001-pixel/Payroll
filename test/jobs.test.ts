import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.ts';
import { JobService, hoursByTag, wcReport } from '../src/jobs/service.ts';
import { recordShift } from '../src/domain/timekeeping.ts';
import { saveWeek } from '../src/domain/weekEntry.ts';
import { draftPayRun } from '../src/payroll/payRuns.ts';
import { ApiError } from '../src/lib/errors.ts';
import { hire, newCompany } from './helpers.ts';

const NOW = new Date('2026-10-30T15:00:00Z');
const FROM = '2026-10-26'; const TO = '2026-11-01';
const make = () => {
  const store = new Store(); const { company } = newCompany(store);
  const a = hire(store, company.id, { firstName: 'Ana', lastName: 'Cruz', roleKey: 'line_cook', payType: { kind: 'hourly', rateCents: 2000 }, tags: { crew: 'Red', wcClass: '5190' } });
  const b = hire(store, company.id, { firstName: 'Ben', lastName: 'Ode', roleKey: 'line_cook', payType: { kind: 'hourly', rateCents: 3000 }, tags: { crew: 'Blue', wcClass: '5190' } });
  return { store, company, a, b, svc: new JobService(store, () => NOW) };
};
const refused = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: unknown) => e instanceof ApiError && re.test(`${e.code} ${e.message}`), String(re));

test('jobs keep labor against a budget, by cost code, at each person\'s own rate', () => {
  const { svc, company, a, b } = make();
  const job = svc.add(company.id, { name: 'Mercer St. panel upgrade', budgetCents: 100_000, prevailingWage: true, costCodes: [{ code: '01', label: 'Rough-in', budgetCents: 40_000 }, { code: '02', label: 'Trim', budgetCents: 60_000 }] });
  refused(() => svc.add(company.id, { name: 'mercer st. panel upgrade' }), /job_exists/);
  svc.logHours(company.id, { employeeId: a.id, date: '2026-10-27', minutes: 480, jobId: job.id, costCode: '01' }); // $160
  svc.logHours(company.id, { employeeId: b.id, date: '2026-10-27', minutes: 480, jobId: job.id, costCode: '02' }); // $240
  let r = svc.report(company.id, FROM, TO);
  let j = r.jobs[0]!;
  assert.equal(j.spentCents, 40_000);
  assert.equal(j.pct, 40);
  assert.equal(j.over, false);
  assert.deepEqual(j.costCodes.map((c) => [c.code, c.costCents]), [['01', 16_000], ['02', 24_000]]);
  assert.equal(r.stats.prevailingWage, 1);
  // saying the same day again replaces it, it does not add
  svc.logHours(company.id, { employeeId: a.id, date: '2026-10-27', minutes: 600, jobId: job.id, costCode: '01' });
  assert.equal(svc.report(company.id, FROM, TO).jobs[0]!.spentCents, 20_000 + 24_000);
  svc.logHours(company.id, { employeeId: a.id, date: '2026-10-27', minutes: 0, jobId: job.id, costCode: '01' });
  assert.equal(svc.report(company.id, FROM, TO).jobs[0]!.spentCents, 24_000);
  // over budget on a code, then on the job
  svc.logHours(company.id, { employeeId: b.id, date: '2026-10-28', minutes: 600, jobId: job.id, costCode: '02' }); // +$300 => code 02 is $540 of $600... 
  svc.logHours(company.id, { employeeId: b.id, date: '2026-10-29', minutes: 600, jobId: job.id, costCode: '02' });
  assert.equal(svc.report(company.id, FROM, TO).jobs[0]!.over, false, '$840 of $1,000');
  svc.logHours(company.id, { employeeId: b.id, date: '2026-10-30', minutes: 600, jobId: job.id, costCode: '02' });
  r = svc.report(company.id, FROM, TO); j = r.jobs[0]!;
  assert.equal(j.over, true);
  assert.equal(r.stats.overBudget, 1);
  assert.equal(j.costCodes.find((c) => c.code === '02')!.over, true);
  assert.ok(r.note.includes('straight time'));
  // hours without a code are shown, not hidden
  svc.logHours(company.id, { employeeId: a.id, date: '2026-10-30', minutes: 60, jobId: job.id });
  assert.ok(svc.report(company.id, FROM, TO).jobs[0]!.costCodes.some((c) => c.label === 'No cost code'));
});

test('a shift can only be charged to an open job and a code that job has, and a used code cannot be dropped', () => {
  const { svc, company, a, store } = make();
  const job = svc.add(company.id, { name: 'Ridge Ave', costCodes: [{ code: '01', label: 'Rough-in' }] });
  assert.throws(() => recordShift(store, company.id, { employeeId: a.id, workDate: '2026-10-27', minutes: 60, jobId: 'job_nope' }), /open jobs/);
  assert.throws(() => recordShift(store, company.id, { employeeId: a.id, workDate: '2026-10-27', minutes: 60, jobId: job.id, costCode: '99' }), /no cost code/);
  svc.logHours(company.id, { employeeId: a.id, date: '2026-10-27', minutes: 60, jobId: job.id, costCode: '01' });
  refused(() => svc.update(company.id, job.id, { costCodes: [{ code: '02', label: 'Other' }] }), /code_in_use/);
  refused(() => svc.update(company.id, job.id, { costCodes: [{ code: '01', label: 'A' }, { code: '01', label: 'B' }] }), /twice/);
  svc.archive(company.id, job.id);
  assert.equal(svc.list(company.id).length, 0);
  assert.throws(() => recordShift(store, company.id, { employeeId: a.id, workDate: '2026-10-28', minutes: 60, jobId: job.id }), /open jobs/);
});

test('hours by crew, and payroll by workers\' comp class from approved runs', () => {
  const { store, company, a, b } = make();
  saveWeek(store, company, { periodStart: FROM, periodEnd: TO, entries: [{ employeeId: a.id, regularMinutes: 2400 }, { employeeId: b.id, regularMinutes: 1200 }] });
  const crews = hoursByTag(store, company, FROM, TO, 'crew');
  assert.deepEqual(crews.map((c) => [c.label, c.minutes, c.count]), [['Red', 2400, 1], ['Blue', 1200, 1]]);
  const draft = draftPayRun(store, company.id, { periodStart: FROM, periodEnd: TO, checkDate: '2026-11-06' });
  assert.equal(wcReport(store, company, 2026).rows.length, 0, 'a draft is not payroll yet');
  store.tx(() => store.payRuns.put({ ...draft, status: 'approved' }));
  const r = wcReport(store, company, 2026);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0]!.wcClass, '5190');
  assert.equal(r.rows[0]!.people, 2);
  assert.equal(r.rows[0]!.grossCents, draft.paychecks.reduce((n, p) => n + p.taxableWagesCents, 0));
  assert.ok(r.csv.startsWith('"Class"'));
});
