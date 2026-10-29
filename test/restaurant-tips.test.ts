import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distributeTips, type DayHouse, type TipShift } from '../src/restaurant/tips.ts';
import { getNiche, settingsFromProfile } from '../src/industries/index.ts';
import { allocate } from '../src/lib/money.ts';
import { ficaTipCredit, form8027Applies, mustReportCashTips } from '../src/restaurant/tipReporting.ts';

const D = '2026-06-05';
const sh = (id: string, roleKey: string, over: Partial<TipShift> = {}): TipShift => ({
  shiftId: id,
  employeeId: `emp_${id}`,
  workDate: D,
  roleKey,
  minutes: 480,
  chargedTipsCents: 0,
  cashTipsCents: 0,
  salesCents: 0,
  ...over,
});
const ctx = (niche: string, tipCreditInEffect: boolean) => ({ settings: settingsFromProfile(getNiche('restaurant', niche)), tipCreditInEffect });
const by = (r: ReturnType<typeof distributeTips>, id: string) => r.shifts.find((s) => s.shiftId === id)!;
const total = (r: ReturnType<typeof distributeTips>) => r.shifts.reduce((a, s) => a + s.keptCents + s.tipOutReceivedCents + s.poolShareCents, 0);

test('allocate: sums exactly, deterministic ties, zero weight gets nothing', () => {
  assert.deepEqual(allocate(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(allocate(10, [0, 1, 1]), [0, 5, 5]);
  assert.deepEqual(allocate(0, [1, 2]), [0, 0]);
  assert.deepEqual(allocate(5, [0, 0]), [0, 0]);
  for (const w of [[3, 7, 11], [1, 1, 1, 1, 1, 1, 1], [0.5, 0.25, 0.25], [1000, 1]]) {
    assert.equal(allocate(99_999, w).reduce((a, b) => a + b, 0), 99_999);
  }
});

test('full service: servers tip out busser, bar and host on sales; money is conserved', () => {
  const shifts = [
    sh('A', 'server', { chargedTipsCents: 20_000, salesCents: 100_000 }),
    sh('B', 'server', { chargedTipsCents: 8_000, salesCents: 50_000 }),
    sh('bus', 'busser'),
    sh('bar', 'bartender'),
  ];
  const r = distributeTips(shifts, [], ctx('full_service', true));
  // busser 1.5% of sales: 1,500 + 750; bar 1%: 1,000 + 500
  assert.equal(by(r, 'A').tipOutPaidCents, 1_500 + 1_000);
  assert.equal(by(r, 'B').tipOutPaidCents, 750 + 500);
  assert.equal(by(r, 'A').keptCents, 17_500);
  assert.equal(by(r, 'B').keptCents, 6_750);
  assert.equal(by(r, 'bus').tipOutReceivedCents, 2_250);
  assert.equal(by(r, 'bar').tipOutReceivedCents, 1_500);
  assert.equal(total(r), 28_000);
  assert.deepEqual(r.issues.filter((i) => i.severity === 'blocking'), []);
});

test('a host (sometimes tipped) can receive a tip-out only when no tip credit is in effect', () => {
  const rule = { id: 'server_host', fromRole: 'server', toRole: 'host', basis: 'percent_of_sales' as const, bps: 50 };
  const shifts = [sh('A', 'server', { chargedTipsCents: 10_000, salesCents: 100_000 }), sh('host', 'host')];
  const withCredit = ctx('full_service', true);
  withCredit.settings.policy.tipOuts = [rule];
  const blocked = distributeTips(shifts, [], withCredit);
  assert.ok(blocked.issues.some((i) => i.code === 'tip_out_recipient_ineligible' && i.severity === 'blocking'));
  assert.equal(by(blocked, 'host').tipOutReceivedCents, 0);
  const noCredit = ctx('full_service', false);
  noCredit.settings.policy.tipOuts = [rule];
  const ok = distributeTips(shifts, [], noCredit);
  assert.equal(by(ok, 'host').tipOutReceivedCents, 500);
});

test('tip-out to several recipients is split by hours', () => {
  const shifts = [sh('A', 'server', { chargedTipsCents: 10_000, salesCents: 100_000 }), sh('b1', 'busser', { minutes: 300 }), sh('b2', 'busser', { minutes: 100 })];
  const r = distributeTips(shifts, [], ctx('full_service', true));
  assert.equal(by(r, 'b1').tipOutReceivedCents + by(r, 'b2').tipOutReceivedCents, 1_500);
  assert.equal(by(r, 'b1').tipOutReceivedCents, 1_125);
  assert.equal(by(r, 'b2').tipOutReceivedCents, 375);
});

test('a tip-out larger than the card tips is capped and flagged', () => {
  const r = distributeTips([sh('A', 'server', { chargedTipsCents: 500, salesCents: 100_000 }), sh('bus', 'busser')], [], ctx('full_service', true));
  assert.equal(by(r, 'A').tipOutPaidCents, 500);
  assert.equal(by(r, 'A').keptCents, 0);
  assert.ok(r.issues.some((i) => i.code === 'tip_out_exceeds_card_tips'));
});

test('no recipient on the clock: the tip-out is not taken', () => {
  const r = distributeTips([sh('A', 'server', { chargedTipsCents: 10_000, salesCents: 100_000 })], [], ctx('full_service', true));
  assert.equal(by(r, 'A').tipOutPaidCents, 0);
  assert.equal(by(r, 'A').keptCents, 10_000);
  assert.ok(r.issues.some((i) => i.code === 'tip_out_no_recipient'));
});

test('a tip-out aimed at a non-tipped role is blocked while a tip credit is in effect', () => {
  const c = ctx('full_service', true);
  c.settings.policy.tipOuts.push({ id: 'server_cook', fromRole: 'server', toRole: 'line_cook', basis: 'percent_of_sales', bps: 100 });
  const r = distributeTips([sh('A', 'server', { chargedTipsCents: 10_000, salesCents: 100_000 }), sh('cook', 'line_cook')], [], c);
  assert.ok(r.issues.some((i) => i.code === 'tip_out_recipient_ineligible' && i.severity === 'blocking'));
  assert.equal(by(r, 'cook').tipOutReceivedCents, 0);
});

test('fine dining: a points pool shares charged tips by role weight and hours, to the cent', () => {
  const shifts = [
    sh('cap', 'captain', { chargedTipsCents: 10_000 }),
    sh('s1', 'server', { chargedTipsCents: 20_000 }),
    sh('s2', 'server'),
    sh('bus', 'busser'),
  ];
  const r = distributeTips(shifts, [], ctx('fine_dining', false));
  // weights 720 : 480 : 480 : 288 over 30,000 -> 10,976 / 7,317 / 7,317 / 4,390
  assert.deepEqual(['cap', 's1', 's2', 'bus'].map((id) => by(r, id).poolShareCents), [10_976, 7_317, 7_317, 4_390]);
  assert.equal(r.shifts.reduce((a, s) => a + s.keptCents, 0), 0, 'pooled tips are not also kept');
  assert.equal(total(r), 30_000);
});

test('a manager in the pool never shares and is flagged', () => {
  const c = ctx('fine_dining', false);
  c.settings.policy.pool.roles.push('general_manager');
  const r = distributeTips([sh('s1', 'server', { chargedTipsCents: 10_000 }), sh('gm', 'general_manager', { chargedTipsCents: 3_000 })], [], c);
  assert.ok(r.issues.some((i) => i.code === 'tip_pool_member_ineligible' && i.employeeId === 'emp_gm'));
  assert.equal(by(r, 'gm').poolShareCents, 0);
  assert.equal(by(r, 'gm').keptCents, 3_000, "the manager's own charged tips are not touched by the pool");
});

test('with a tip credit in effect, a pool of non-tipped roles is blocked; without one it is allowed', () => {
  const credit = ctx('fast_casual', true);
  const blocked = distributeTips([sh('c', 'counter', { chargedTipsCents: 6_000 }), sh('k', 'cook')], [], credit);
  assert.ok(blocked.issues.some((i) => i.code === 'tip_pool_member_ineligible' && i.employeeId === 'emp_k'));
  const free = distributeTips([sh('c', 'counter', { chargedTipsCents: 6_000 }), sh('k', 'cook')], [], ctx('fast_casual', false));
  assert.equal(by(free, 'c').poolShareCents, 3_000);
  assert.equal(by(free, 'k').poolShareCents, 3_000);
});

test('café: the house-counted jar joins the pool and is shared by hours', () => {
  const house: DayHouse[] = [{ date: D, houseTipsCents: 9_000, serviceChargesCents: 0 }];
  const r = distributeTips([sh('b1', 'barista', { minutes: 480 }), sh('b2', 'barista', { minutes: 240 }), sh('mgr', 'store_manager', { minutes: 480 })], house, ctx('cafe_coffee', false));
  assert.equal(by(r, 'b1').poolShareCents, 6_000);
  assert.equal(by(r, 'b2').poolShareCents, 3_000);
  assert.equal(by(r, 'mgr').poolShareCents, 0);
});

test('house tips with no pool configured are blocked, not guessed', () => {
  const r = distributeTips([sh('s', 'server')], [{ date: D, houseTipsCents: 5_000, serviceChargesCents: 0 }], ctx('full_service', true));
  assert.ok(r.issues.some((i) => i.code === 'house_tips_without_pool' && i.severity === 'blocking'));
  assert.equal(r.undistributedCents, 5_000);
});

test('catering: a mandatory service charge is shared as wages by hours among its roles', () => {
  const r = distributeTips(
    [sh('a', 'banquet_server', { minutes: 300 }), sh('b', 'banquet_bartender', { minutes: 300 }), sh('c', 'setup_crew', { minutes: 600 }), sh('cap', 'event_captain', { minutes: 600 })],
    [{ date: D, houseTipsCents: 0, serviceChargesCents: 10_000 }],
    ctx('catering_banquet', false),
  );
  assert.deepEqual(['a', 'b', 'c', 'cap'].map((id) => by(r, id).serviceChargeShareCents), [2_500, 2_500, 5_000, 0]);
});

test('a service charge under a house-revenue policy is not paid out', () => {
  const r = distributeTips([sh('s', 'server')], [{ date: D, houseTipsCents: 0, serviceChargesCents: 4_000 }], ctx('full_service', true));
  assert.equal(r.shifts.reduce((a, s) => a + s.serviceChargeShareCents, 0), 0);
  assert.equal(r.undistributedCents, 4_000);
});

test('card fee is passed on pro rata only when the company turns it on', () => {
  const c = ctx('full_service', true);
  c.settings.policy.cardFeeDeductionBps = 300;
  const r = distributeTips([sh('A', 'server', { chargedTipsCents: 10_000 })], [], c);
  assert.equal(by(r, 'A').cardFeeCents, 300);
  assert.equal(by(r, 'A').keptCents, 9_700);
  const off = distributeTips([sh('A', 'server', { chargedTipsCents: 10_000 })], [], ctx('full_service', true));
  assert.equal(by(off, 'A').cardFeeCents, 0);
});

test('conservation across a messy day', () => {
  const house: DayHouse[] = [{ date: D, houseTipsCents: 1_234, serviceChargesCents: 0 }];
  const c = ctx('fine_dining', false);
  c.settings.policy.tipOuts.push({ id: 'srv_bar', fromRole: 'server', toRole: 'bartender', basis: 'percent_of_tips', bps: 777 });
  const shifts = [
    sh('s1', 'server', { chargedTipsCents: 12_345, minutes: 317 }),
    sh('s2', 'server', { chargedTipsCents: 6_789, minutes: 411 }),
    sh('cap', 'captain', { chargedTipsCents: 3_333, minutes: 503 }),
    sh('bar', 'bartender', { chargedTipsCents: 999, minutes: 299 }),
    sh('bus', 'busser', { minutes: 241 }),
  ];
  const r = distributeTips(shifts, house, c);
  const inputs = shifts.reduce((a, s) => a + s.chargedTipsCents, 0) + 1_234;
  assert.equal(total(r) + r.undistributedCents, inputs);
});

test('tip reporting: $20 monthly threshold, Form 8027 headcount test', () => {
  assert.equal(mustReportCashTips(1_999), false);
  assert.equal(mustReportCashTips(2_000), true);
  assert.equal(form8027Applies(10, true), false);
  assert.equal(form8027Applies(11, true), true);
  assert.equal(form8027Applies(40, false), false);
});

test('FICA tip credit: only tips beyond what lifts cash wages to $5.15 an hour, at 7.65%', () => {
  // 40h × 5.15 = 20,600 needed. Cash wages 8,520 → 12,080 of tips are needed. Tips 50,000 → 37,920 creditable.
  const r = ficaTipCredit([
    { employeeId: 'a', hours: 40, nonTipWagesCents: 8_520, tipsCents: 50_000 },
    { employeeId: 'b', hours: 40, nonTipWagesCents: 8_520, tipsCents: 10_000 }, // below the need: nothing creditable
  ]);
  assert.deepEqual(r.perEmployee.map((p) => p.creditableTipsCents), [37_920, 0]);
  assert.equal(r.creditCents, Math.round(37_920 * 0.0765));
});
