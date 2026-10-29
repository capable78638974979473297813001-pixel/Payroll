import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeHourlyWages, type WageParams, type WageShift } from '../src/restaurant/wages.ts';
import { tipCreditShortfall } from '../engine/payroll/tipCredit.ts';
import { wageFloors } from '../src/restaurant/floors.ts';

const shift = (date: string, hours: number, over: Partial<WageShift> = {}): WageShift => ({
  shiftId: `s_${date}_${over.roleKey ?? 'server'}_${over.sortKey ?? ''}`,
  workDate: date,
  sortKey: over.sortKey ?? '0',
  roleKey: 'server',
  minutes: hours * 60,
  rateCentsPerHour: 213,
  tipCreditRole: true,
  mealBreakViolation: false,
  restBreakViolation: false,
  ...over,
});

const week = (hoursPerDay: number[], over: Partial<WageShift> = {}): WageShift[] =>
  hoursPerDay.map((h, i) => shift(`2026-06-0${i + 1}`, h, over)).filter((s) => s.minutes > 0);

const params = (shifts: WageShift[], over: Partial<WageParams> = {}): WageParams => ({
  employeeId: 'emp_1',
  state: 'TX',
  weekStartDay: 1,
  takesTipCredit: true,
  periodStart: '2026-06-01',
  periodEnd: '2026-06-07',
  shifts,
  tipsReceivedByDate: new Map(),
  ...over,
});

const line = (r: ReturnType<typeof computeHourlyWages>, code: string) => r.lines.find((l) => l.code === code);
const codes = (r: ReturnType<typeof computeHourlyWages>, severity: string) => r.issues.filter((i) => i.severity === severity).map((i) => i.code);

test('engine floors for the states these tests lean on', () => {
  assert.deepEqual(wageFloors('2026-06-01', 'TX'), { tipCreditAllowed: true, cashFloorCentsPerHour: 213, standardFloorCentsPerHour: 725, maxCreditCentsPerHour: 512 });
  assert.equal(wageFloors('2026-06-01', 'CA').tipCreditAllowed, false);
  assert.equal(wageFloors('2026-06-01', 'NY', undefined, 'downstate').cashFloorCentsPerHour > wageFloors('2026-06-01', 'NY').cashFloorCentsPerHour, true);
});

test('tipped server in TX: cash wage plus a make-up when tips fall short of the credit', () => {
  const tips = new Map([['2026-06-02', 10_000]]);
  const r = computeHourlyWages(params(week([6, 6, 6, 6, 6]), { tipsReceivedByDate: tips }));
  assert.equal(line(r, 'REG')!.amountCents, 213 * 30); // 6,390
  // credit claimed = (725 − 213) × 30h = 15,360; tips 10,000; make-up 5,360
  assert.equal(line(r, 'TIP_MAKEUP')!.amountCents, 5_360);
  // the engine's own function agrees for a week without overtime
  assert.equal(
    tipCreditShortfall({ hoursWorked: 30, cashWageCentsPerHour: 213, tipsReceivedCents: 10_000, requiredMinimumWageCentsPerHour: 725 }),
    5_360,
  );
  assert.deepEqual(codes(r, 'blocking'), []);
});

test('no make-up when tips cover the credit', () => {
  const tips = new Map([['2026-06-03', 15_360]]);
  const r = computeHourlyWages(params(week([6, 6, 6, 6, 6]), { tipsReceivedByDate: tips }));
  assert.equal(line(r, 'TIP_MAKEUP'), undefined);
});

test('tipped overtime is 1.5 × full minimum wage less the credit', () => {
  const tips = new Map([['2026-06-05', 50_000]]);
  const r = computeHourlyWages(params(week([10, 10, 10, 10, 10]), { tipsReceivedByDate: tips }));
  assert.equal(line(r, 'REG')!.amountCents, 213 * 40); // 8,520
  // 10 OT hours at (1.5 × 725 − 512) = 575.5 → 5,755
  assert.equal(line(r, 'OT')!.amountCents, 5_755);
  assert.equal(line(r, 'OT')!.minutes, 600);
  assert.equal(r.weeks[0].regularRateCentsPerHour, 725);
  assert.equal(line(r, 'TIP_MAKEUP'), undefined);
});

test('california: no tip credit, full minimum wage in cash, daily overtime and double time', () => {
  const r = computeHourlyWages(params([shift('2026-06-01', 13, { rateCentsPerHour: 2000 })], { state: 'CA' }));
  assert.equal(line(r, 'REG')!.amountCents, 2000 * 8);
  assert.equal(line(r, 'OT')!.amountCents, 4 * 2000 + 0.5 * 2000 * 4); // 12,000
  assert.equal(line(r, 'DT')!.amountCents, 2000 + 2000); // 4,000
  assert.equal(line(r, 'TIP_MAKEUP'), undefined);
});

test('california: a tipped role below the state minimum is blocked, because no tip credit exists there', () => {
  const r = computeHourlyWages(params(week([8]), { state: 'CA', shifts: [shift('2026-06-01', 8, { rateCentsPerHour: 213 })] }));
  assert.deepEqual(codes(r, 'blocking'), ['below_minimum_wage']);
});

test('california: one meal premium and one rest premium per day, however many shifts', () => {
  const shifts = [
    shift('2026-06-01', 5, { rateCentsPerHour: 2000, mealBreakViolation: true, sortKey: 'a' }),
    shift('2026-06-01', 4, { rateCentsPerHour: 2000, mealBreakViolation: true, restBreakViolation: true, sortKey: 'b' }),
  ];
  const r = computeHourlyWages(params(shifts, { state: 'CA' }));
  assert.equal(line(r, 'BREAK_PREMIUM')!.amountCents, 2 * 2000);
});

test('break premium marked outside california is flagged, not paid', () => {
  const r = computeHourlyWages(params([shift('2026-06-01', 8, { rateCentsPerHour: 1500, tipCreditRole: false, mealBreakViolation: true })]));
  assert.equal(line(r, 'BREAK_PREMIUM'), undefined);
  assert.deepEqual(codes(r, 'review'), ['break_premium_not_modelled']);
});

test('a cash wage below the tipped floor is blocked', () => {
  const r = computeHourlyWages(params([shift('2026-06-01', 8, { rateCentsPerHour: 100 })]));
  assert.deepEqual(codes(r, 'blocking'), ['below_tipped_cash_floor']);
});

test('without a tip credit the full minimum wage applies, even to a tipped role', () => {
  const r = computeHourlyWages(params([shift('2026-06-01', 8, { rateCentsPerHour: 500 })], { takesTipCredit: false }));
  assert.deepEqual(codes(r, 'blocking'), ['below_minimum_wage']);
  const ok = computeHourlyWages(params([shift('2026-06-01', 8, { rateCentsPerHour: 1200 })], { takesTipCredit: false }));
  assert.equal(line(ok, 'TIP_MAKEUP'), undefined);
  assert.equal(line(ok, 'REG')!.amountCents, 1200 * 8);
});

test('a dual-rate week (server + cook) uses the weighted regular rate for overtime', () => {
  const shifts = [
    ...week([8, 8, 8, 8], { rateCentsPerHour: 213, roleKey: 'server', sortKey: 'a' }),
    ...week([0, 0, 0, 0, 10], { rateCentsPerHour: 1800, roleKey: 'line_cook', tipCreditRole: false, sortKey: 'b' }).map((s) => ({ ...s, workDate: '2026-06-05', shiftId: 'cook5' })),
  ];
  const tips = new Map([['2026-06-02', 100_000]]);
  const r = computeHourlyWages(params(shifts, { tipsReceivedByDate: tips }));
  // 32h tipped (value 725) + 10h cook (value 1800) = 42h, 2h overtime.
  // straight value = 32×725 + 10×1800 = 23,200 + 18,000 = 41,200 ; regular rate = 41,200 / 42h = 980.95/h
  // OT premium = 0.5 × 41,200 × 120/2520 = 981 (rounded)
  const ot = line(r, 'OT')!;
  assert.equal(ot.minutes, 120);
  // the OT minutes fall on Friday's cook shift: cash 1800 × 2h = 3,600, plus the premium 980.95
  assert.equal(ot.amountCents, Math.round(3600 + 0.5 * 41_200 * 120 / 2520));
  assert.equal(r.weeks[0].regularRateCentsPerHour, 981);
});

test('a workweek that runs past the period defers its make-up', () => {
  const shifts = week([6, 6, 6, 6, 6, 6, 6]);
  const r = computeHourlyWages(params(shifts, { periodStart: '2026-06-01', periodEnd: '2026-06-03' }));
  assert.equal(line(r, 'TIP_MAKEUP'), undefined);
  assert.equal(r.weeks[0].makeupDeferred, true);
  assert.ok(r.issues.some((i) => i.code === 'tip_makeup_deferred'));
  // and only days inside the period are paid
  assert.equal(r.paidMinutes, 3 * 360);
});

test('the make-up runs in the period that contains the workweek end, using the whole week', () => {
  const shifts = week([6, 6, 6, 6, 6, 6, 6]);
  const r = computeHourlyWages(params(shifts, { periodStart: '2026-06-04', periodEnd: '2026-06-07', tipsReceivedByDate: new Map([['2026-06-01', 5_000]]) }));
  // credit = 512 × 42h = 21,504; tips for the week 5,000
  assert.equal(line(r, 'TIP_MAKEUP')!.amountCents, 21_504 - 5_000);
});

test('rounding: fractional cents are carried and rounded once per code', () => {
  // 7 shifts of 1h07m at 1,000.5¢/h would drift if each were rounded alone.
  const shifts = Array.from({ length: 7 }, (_, i) => shift(`2026-06-0${i + 1}`, 0, { minutes: 67, rateCentsPerHour: 1_333, tipCreditRole: false }));
  const r = computeHourlyWages(params(shifts, { takesTipCredit: false }));
  assert.equal(line(r, 'REG')!.amountCents, Math.round((1_333 * 67 * 7) / 60));
});
