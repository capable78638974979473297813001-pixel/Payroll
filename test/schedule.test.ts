import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextPayday, periodContaining, previousPeriod, suggestPeriods } from '../src/payroll/schedule.ts';
import type { Company, PayRun } from '../src/domain/types.ts';

const co = (over: Partial<Company['paySchedule']> = {}, start = 1, created = '2026-09-01T00:00:00Z'): Company => ({ createdAt: created, settings: { workweekStartDay: start } as never, paySchedule: { frequency: 'weekly', checkDateLagDays: 5, ...over } } as unknown as Company);
const run = (periodStart: string, periodEnd: string, status: PayRun['status'] = 'completed', id = `run_${periodStart}`) => ({ id, periodStart, periodEnd, status }) as PayRun;

test('weekly, Monday to Sunday, paid the Friday after: the design\'s example (Oct 19 to 25, paid Oct 30)', () => {
  const c = co();
  assert.deepEqual(periodContaining(c, '2026-10-22'), { periodStart: '2026-10-19', periodEnd: '2026-10-25', checkDate: '2026-10-30' });
  assert.deepEqual(periodContaining(c, '2026-10-19'), { periodStart: '2026-10-19', periodEnd: '2026-10-25', checkDate: '2026-10-30' });
  assert.deepEqual(periodContaining(c, '2026-10-25'), { periodStart: '2026-10-19', periodEnd: '2026-10-25', checkDate: '2026-10-30' });
  assert.deepEqual(previousPeriod(c, periodContaining(c, '2026-10-22')), { periodStart: '2026-10-12', periodEnd: '2026-10-18', checkDate: '2026-10-23' });
});

test('a Sunday-to-Saturday week pays six days after it ends', () => {
  assert.equal(periodContaining(co({ checkDateLagDays: 6 }, 0), '2026-10-22').periodStart, '2026-10-18');
  assert.equal(periodContaining(co({ checkDateLagDays: 6 }, 0), '2026-10-22').checkDate, '2026-10-30');
});

test('a check date on a weekend or a bank holiday moves back to the banking day before', () => {
  assert.equal(periodContaining(co({ checkDateLagDays: 6 }), '2026-10-22').checkDate, '2026-10-30', 'Sat Oct 31 would be the date; Friday is used');
  // Monday-Sunday week ending Sun Nov 8, lag 3: Wed Nov 11 is Veterans Day, so the banking day before is Tue Nov 10.
  assert.equal(periodContaining(co({ checkDateLagDays: 3 }), '2026-11-04').checkDate, '2026-11-10');
});

test('every other week counts 14-day blocks from the first run', () => {
  const c = co({ frequency: 'biweekly' });
  const runs = [run('2026-10-05', '2026-10-18')];
  assert.deepEqual(periodContaining(c, '2026-10-22', runs), { periodStart: '2026-10-19', periodEnd: '2026-11-01', checkDate: '2026-11-06' });
  assert.equal(periodContaining(c, '2026-10-10', runs).periodStart, '2026-10-05');
  assert.equal(periodContaining(c, '2026-09-25', runs).periodStart, '2026-09-21', 'blocks run backward too');
});

test('twice a month is the 1st to the 15th and the 16th to the end of the month', () => {
  const c = co({ frequency: 'semimonthly' });
  assert.deepEqual(periodContaining(c, '2026-10-09'), { periodStart: '2026-10-01', periodEnd: '2026-10-15', checkDate: '2026-10-20' });
  assert.deepEqual(periodContaining(c, '2026-10-16'), { periodStart: '2026-10-16', periodEnd: '2026-10-31', checkDate: '2026-11-05' });
  assert.equal(periodContaining(c, '2026-02-20').periodEnd, '2026-02-28');
  assert.equal(periodContaining(c, '2028-02-20').periodEnd, '2028-02-29', 'leap year');
});

test('monthly is the calendar month', () => {
  assert.deepEqual(periodContaining(co({ frequency: 'monthly' }), '2026-10-09'), { periodStart: '2026-10-01', periodEnd: '2026-10-31', checkDate: '2026-11-05' });
});

test('suggested periods show what has been done for each, newest first', () => {
  const c = co();
  const runs = [run('2026-10-12', '2026-10-18', 'completed'), run('2026-10-05', '2026-10-11', 'voided', 'old'), run('2026-10-19', '2026-10-25', 'draft', 'mine')];
  const s = suggestPeriods(c, '2026-10-28', runs, 4);
  assert.deepEqual(s.map((p) => [p.periodStart, p.state, p.current]), [['2026-10-26', 'open', true], ['2026-10-19', 'in_progress', false], ['2026-10-12', 'paid', false], ['2026-10-05', 'open', false]]);
  assert.equal(s[1]!.runId, 'mine');
});

test('the next payday is the most recent finished period nobody has paid, else the current one', () => {
  const c = co();
  const n = nextPayday(c, '2026-10-28', [run('2026-10-12', '2026-10-18')]);
  assert.deepEqual([n.period.periodStart, n.period.checkDate, n.daysUntil, n.ready, n.state], ['2026-10-19', '2026-10-30', 2, true, 'open']);
  const all = nextPayday(co({}, 1, '2026-10-12T00:00:00Z'), '2026-10-28', [run('2026-10-12', '2026-10-18'), run('2026-10-19', '2026-10-25')]);
  assert.deepEqual([all.period.periodStart, all.ready], ['2026-10-26', false], 'everything is paid: the period in progress');
  const behind = nextPayday(c, '2026-10-28', []);
  assert.equal(behind.period.periodStart, '2026-10-19', 'behind: the latest period is the one to run; older ones stay in the picker');
  const drafted = nextPayday(c, '2026-10-28', [run('2026-10-19', '2026-10-25', 'draft', 'mine')]);
  assert.deepEqual([drafted.state, drafted.runId], ['in_progress', 'mine']);
});

test('periods that ended before the company joined are not owed', () => {
  const c = co({}, 1, '2026-10-20T10:00:00Z');
  const n = nextPayday(c, '2026-10-22', []);
  assert.deepEqual([n.period.periodStart, n.ready], ['2026-10-19', false], 'the period it joined in is still in progress');
  const later = nextPayday(c, '2026-10-27', []);
  assert.deepEqual([later.period.periodStart, later.ready], ['2026-10-19', true], 'once it ends it is the one to run');
});
