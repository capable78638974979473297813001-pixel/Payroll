import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeHourlyWages, type WageParams, type WageShift } from '../src/restaurant/wages.ts';
import { classifyWorkweek, overtimeRuleFor } from '../src/restaurant/overtime.ts';

const D = (n: number) => `2026-06-0${n + 1}`; // D(0) is Monday 2026-06-01
const shift = (n: number, minutes: number, over: Partial<WageShift> = {}): WageShift => ({
  shiftId: `s${n}_${over.sortKey ?? 'a'}`,
  workDate: D(n),
  sortKey: over.sortKey ?? 'a',
  roleKey: 'line_cook',
  minutes,
  rateCentsPerHour: 2000,
  tipCreditRole: false,
  mealBreakViolation: false,
  restBreakViolation: false,
  ...over,
});
const params = (state: string, shifts: WageShift[], over: Partial<WageParams> = {}): WageParams => ({ employeeId: 'e1', state, weekStartDay: 1, takesTipCredit: false, periodStart: D(0), periodEnd: D(6), shifts, tipsReceivedByDate: new Map(), ...over });
const line = (r: ReturnType<typeof computeHourlyWages>, code: string) => r.lines.find((l) => l.code === code);
const hours = (h: number) => h * 60;
const ot = (rule: Parameters<typeof classifyWorkweek>[2], mins: number[], opts = {}) => {
  const c = classifyWorkweek('2026-06-01', new Map(mins.map((m, i) => [D(i), m] as [string, number]).filter(([, m]) => m > 0)), rule, opts);
  return { reg: c.reduce((a, d) => a + d.regular, 0) / 60, ot: c.reduce((a, d) => a + d.overtime, 0) / 60, dt: c.reduce((a, d) => a + d.doubleTime, 0) / 60 };
};

test('each state maps to its own overtime rule', () => {
  assert.deepEqual(['TX', 'CA', 'AK', 'NV', 'CO', 'NY'].map(overtimeRuleFor), ['federal', 'california', 'alaska', 'nevada', 'colorado', 'federal']);
});

// ---------------------------------------------------------------- Alaska

test('alaska: over 8 hours in a day is overtime even when the week is under 40', () => {
  assert.deepEqual(ot('alaska', [hours(10), hours(10), hours(10), hours(10)]), { reg: 32, ot: 8, dt: 0 });
  assert.deepEqual(ot('federal', [hours(10), hours(10), hours(10), hours(10)]), { reg: 40, ot: 0, dt: 0 }, 'the federal rule alone would pay none');
});

test('alaska wages: five 9-hour days is 40 regular hours and 5 overtime hours', () => {
  const r = computeHourlyWages(params('AK', [0, 1, 2, 3, 4].map((n) => shift(n, hours(9)))));
  assert.equal(line(r, 'REG')!.amountCents, 40 * 2000);
  assert.equal(line(r, 'OT')!.amountCents, 5 * 3000);
  assert.equal(line(r, 'OT')!.minutes, hours(5));
});

test('alaska: daily overtime hours are not counted again toward the weekly 40; the weekly rule still applies to the rest', () => {
  assert.deepEqual(ot('alaska', [hours(8), hours(8), hours(8), hours(8), hours(8), hours(8)]), { reg: 40, ot: 8, dt: 0 });
  assert.deepEqual(ot('alaska', [hours(9), hours(9), hours(9), hours(9), hours(9), hours(9)]), { reg: 40, ot: 14, dt: 0 }, '6 days: 6h daily overtime, then the regular 48 hours less 40 is 8 more');
});

// ---------------------------------------------------------------- Nevada

test('nevada: the daily rule applies only below 1.5 times the minimum wage ($12.00 → $18.00)', () => {
  const tenHours = [0, 1, 2, 3].map((n) => shift(n, hours(10)));
  const low = computeHourlyWages(params('NV', tenHours.map((s) => ({ ...s, rateCentsPerHour: 1500 }))));
  assert.equal(line(low, 'REG')!.amountCents, 32 * 1500);
  assert.equal(line(low, 'OT')!.amountCents, 8 * 2250);
  const high = computeHourlyWages(params('NV', tenHours.map((s) => ({ ...s, rateCentsPerHour: 2000 }))));
  assert.equal(line(high, 'REG')!.amountCents, 40 * 2000);
  assert.equal(line(high, 'OT'), undefined, 'a 40-hour week at or above 1.5 times the minimum has no overtime');
  const exactly = computeHourlyWages(params('NV', tenHours.map((s) => ({ ...s, rateCentsPerHour: 1800 }))));
  assert.equal(line(exactly, 'OT'), undefined, 'exactly 1.5 times the minimum is not "less than"');
});

test('nevada: the weekly 40-hour rule applies to everyone', () => {
  const r = computeHourlyWages(params('NV', [0, 1, 2, 3, 4].map((n) => shift(n, hours(9))).map((s) => ({ ...s, rateCentsPerHour: 2500 }))));
  assert.equal(line(r, 'OT')!.minutes, hours(5));
});

// ---------------------------------------------------------------- Colorado

test('colorado: over 12 hours in a day, or over 40 in the week, whichever pays more', () => {
  assert.deepEqual(ot('colorado', [hours(13)]), { reg: 12, ot: 1, dt: 0 }, 'daily');
  assert.deepEqual(ot('colorado', [hours(8), hours(8), hours(8), hours(8), hours(8), hours(8)]), { reg: 40, ot: 8, dt: 0 }, 'weekly');
  assert.deepEqual(ot('colorado', [hours(13), hours(13), hours(13), hours(13), hours(13)]), { reg: 40, ot: 25, dt: 0 }, 'weekly pays more than the 5 daily hours');
  assert.deepEqual(ot('colorado', [hours(10), hours(10), hours(10), hours(10)]), { reg: 40, ot: 0, dt: 0 }, 'no daily overtime until 12 hours');
});

test('colorado wages: a 13-hour day pays one overtime hour', () => {
  const r = computeHourlyWages(params('CO', [shift(0, hours(13))]));
  assert.equal(line(r, 'REG')!.amountCents, 12 * 2000);
  assert.equal(line(r, 'OT')!.amountCents, 3000);
});

// ---------------------------------------------------------------- New York

const T = (d: number, hhmm: string) => `${D(d)}T${hhmm}:00Z`;

test('new york spread of hours: more than 10 hours from first start to last finish earns one extra hour at the basic minimum wage', () => {
  // 11:30-15:00 and 16:00-22:00: 9.5 hours worked, a 10.5 hour spread
  const split = [shift(0, 210, { sortKey: 'a', clockIn: T(0, '11:30'), clockOut: T(0, '15:00') }), shift(0, 360, { sortKey: 'b', clockIn: T(0, '16:00'), clockOut: T(0, '22:00') })];
  const r = computeHourlyWages(params('NY', split, { region: 'downstate' }));
  assert.equal(line(r, 'SPREAD_HOURS')!.amountCents, 1700, 'one hour at the downstate basic minimum, $17.00');
  assert.equal(line(r, 'REG')!.amountCents, Math.round((570 * 2000) / 60));

  const upstate = computeHourlyWages(params('NY', split));
  assert.equal(line(upstate, 'SPREAD_HOURS')!.amountCents, 1600, 'the statewide figure when no region is set');

  const exactlyTen = [shift(0, 480, { clockIn: T(0, '10:00'), clockOut: T(0, '20:00') })];
  assert.equal(line(computeHourlyWages(params('NY', exactlyTen)), 'SPREAD_HOURS'), undefined, 'exactly 10 hours is not more than 10');
  assert.equal(line(computeHourlyWages(params('TX', split)), 'SPREAD_HOURS'), undefined, 'a New York rule only');
});

test('new york spread of hours: it applies at any rate of pay, and without clock times 11 worked hours still proves it', () => {
  const r = computeHourlyWages(params('NY', [shift(0, hours(11), { rateCentsPerHour: 6000 })]));
  assert.equal(line(r, 'SPREAD_HOURS')!.amountCents, 1600);
  const unknown = computeHourlyWages(params('NY', [shift(0, 180, { sortKey: 'a' }), shift(0, 180, { sortKey: 'b' })]));
  assert.ok(unknown.issues.some((i) => i.code === 'spread_of_hours_unknown' && i.severity === 'review'));
  assert.equal(line(unknown, 'SPREAD_HOURS'), undefined);
});

test('new york call-in pay: the minimum is 3 hours for one shift, 6 for two short shifts, 8 for three', () => {
  const one = computeHourlyWages(params('NY', [shift(0, 120)]));
  assert.equal(line(one, 'CALL_IN_PAY')!.amountCents, 1600, 'one hour short of 3, at the $16.00 basic minimum');
  const two = computeHourlyWages(params('NY', [shift(0, 120, { sortKey: 'a' }), shift(0, 120, { sortKey: 'b' })]));
  assert.equal(line(two, 'CALL_IN_PAY')!.amountCents, 3200, 'two hours short of 6');
  const three = computeHourlyWages(params('NY', [shift(0, 120, { sortKey: 'a' }), shift(0, 120, { sortKey: 'b' }), shift(0, 180, { sortKey: 'c' })]));
  assert.equal(line(three, 'CALL_IN_PAY')!.amountCents, 1600, 'one hour short of 8');
  const twoLong = computeHourlyWages(params('NY', [shift(0, 240, { sortKey: 'a' }), shift(0, 180, { sortKey: 'b' })]));
  assert.equal(line(twoLong, 'CALL_IN_PAY'), undefined, 'two shifts totalling more than 6 hours owe nothing');
  assert.equal(line(computeHourlyWages(params('NY', [shift(0, 180)])), 'CALL_IN_PAY'), undefined, 'a full 3 hours owes nothing');
});

test('new york call-in pay is capped by the regularly scheduled shift when there is one', () => {
  assert.equal(line(computeHourlyWages(params('NY', [shift(0, 120, { scheduledMinutes: 120 })])), 'CALL_IN_PAY'), undefined);
  assert.equal(line(computeHourlyWages(params('NY', [shift(0, 120, { scheduledMinutes: 150 })])), 'CALL_IN_PAY')!.amountCents, 800, '30 minutes short of the 150 scheduled, at $16.00');
});

test('new york call-in pay uses the basic minimum rate with no tip credit', () => {
  const r = computeHourlyWages(params('NY', [shift(0, 120, { rateCentsPerHour: 1070, tipCreditRole: true })], { takesTipCredit: true }));
  assert.equal(line(r, 'CALL_IN_PAY')!.amountCents, 1600, 'the balance is paid at the full $16.00, not the tipped cash wage');
});
