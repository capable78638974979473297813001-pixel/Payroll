import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyWorkweek } from '../src/restaurant/overtime.ts';

const WEEK = '2026-06-01'; // a Monday
const days = (mins: number[]) => new Map(mins.map((m, i) => [`2026-06-0${i + 1}`, m] as [string, number]).filter(([, m]) => m > 0));
const totals = (c: ReturnType<typeof classifyWorkweek>) => ({
  regular: c.reduce((a, d) => a + d.regular, 0),
  overtime: c.reduce((a, d) => a + d.overtime, 0),
  doubleTime: c.reduce((a, d) => a + d.doubleTime, 0),
});

test('federal: overtime starts after 40 hours in the workweek, not after 8 in a day', () => {
  const c = classifyWorkweek(WEEK, days([600, 600, 600, 600, 600, 0, 0]), 'federal');
  assert.deepEqual(totals(c), { regular: 2400, overtime: 600, doubleTime: 0 });
  assert.equal(c[3].overtime, 0, 'Thursday is the 40th hour, still regular');
  assert.equal(c[4].overtime, 600, 'all of Friday is overtime');
});

test('federal: a day that crosses 40 hours splits within the day', () => {
  const c = classifyWorkweek(WEEK, days([480, 480, 480, 480, 360 + 120, 0, 0]), 'federal');
  assert.equal(c[4].regular, 480);
  assert.equal(c[4].overtime, 0);
  const d = classifyWorkweek(WEEK, days([480, 480, 480, 480, 600, 0, 0]), 'federal');
  assert.equal(d[4].regular, 480);
  assert.equal(d[4].overtime, 120);
});

test('california: over 8 hours is overtime and over 12 is double time', () => {
  const c = classifyWorkweek(WEEK, days([13 * 60, 0, 0, 0, 0, 0, 0]), 'california');
  assert.deepEqual({ r: c[0].regular, o: c[0].overtime, d: c[0].doubleTime }, { r: 480, o: 240, d: 60 });
});

test('california: seventh consecutive day is overtime for 8 hours and double time after', () => {
  const six = classifyWorkweek(WEEK, days([360, 360, 360, 360, 360, 360, 360]), 'california');
  assert.deepEqual({ r: six[6].regular, o: six[6].overtime, d: six[6].doubleTime }, { r: 0, o: 360, d: 0 });
  const long = classifyWorkweek(WEEK, days([300, 300, 300, 300, 300, 300, 600]), 'california');
  assert.deepEqual({ r: long[6].regular, o: long[6].overtime, d: long[6].doubleTime }, { r: 0, o: 480, d: 120 });
});

test('california: no seventh-day rule when a day was missed', () => {
  const c = classifyWorkweek(WEEK, days([360, 360, 360, 360, 360, 360, 0]), 'california');
  assert.equal(totals(c).overtime, 0);
});

test('california: regular minutes past 40 hours in the week become overtime; daily overtime does not count toward the 40', () => {
  const six8 = classifyWorkweek(WEEK, days([480, 480, 480, 480, 480, 480, 0]), 'california');
  assert.deepEqual(totals(six8), { regular: 2400, overtime: 480, doubleTime: 0 });
  assert.equal(six8[5].overtime, 480, 'Saturday, the 6th 8-hour day, is all overtime');
  // Four 10-hour days: 8 regular + 2 daily OT each = 32 regular hours, 8 OT hours; weekly rule never triggers.
  const four10 = classifyWorkweek(WEEK, days([600, 600, 600, 600, 0, 0, 0]), 'california');
  assert.deepEqual(totals(four10), { regular: 1920, overtime: 480, doubleTime: 0 });
});

test('classification conserves minutes', () => {
  for (const rule of ['federal', 'california'] as const) {
    const m = days([750, 481, 0, 905, 60, 480, 720]);
    const c = classifyWorkweek(WEEK, m, rule);
    const t = totals(c);
    assert.equal(t.regular + t.overtime + t.doubleTime, [...m.values()].reduce((a, b) => a + b, 0));
  }
});
