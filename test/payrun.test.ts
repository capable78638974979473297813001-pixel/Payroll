import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.ts';
import { draftPayRun, approvePayRun, voidPayRun, recalculatePayRun } from '../src/payroll/payRuns.ts';
import { recordHouseDay, recordShift } from '../src/domain/timekeeping.ts';
import { addEmployee } from '../src/domain/employees.ts';
import { day, hire, newCompany, ready, shiftsFor } from './helpers.ts';

const RUN = { periodStart: day(0), periodEnd: day(13), checkDate: day(18) };

/** A small TX full-service restaurant: a server, busser, bartender, cook and a salaried GM, two weeks of shifts. */
function restaurant() {
  const store = new Store();
  const { company } = newCompany(store);
  const ana = hire(store, company.id, { firstName: 'Ana', lastName: 'Ruiz', roleKey: 'server' });
  const ben = hire(store, company.id, { firstName: 'Ben', lastName: 'Okafor', roleKey: 'busser' });
  const cy = hire(store, company.id, { firstName: 'Cy', lastName: 'Lindqvist', roleKey: 'bartender' });
  const dee = hire(store, company.id, { firstName: 'Dee', lastName: 'Park', roleKey: 'line_cook', payType: { kind: 'hourly', rateCents: 1700 }, tipCreditNoticeDate: undefined });
  const eli = hire(store, company.id, { firstName: 'Eli', lastName: 'Voss', roleKey: 'general_manager', payType: { kind: 'salary', annualCents: 5_200_000 } });
  for (const e of [ana, ben, cy, dee, eli]) ready(store, e.id);
  // weekday shifts in both weeks: Mon-Fri
  const weekdays = [0, 1, 2, 3, 4, 7, 8, 9, 10, 11];
  shiftsFor(store, company.id, ana.id, weekdays, { chargedTipsCents: 8_000, cashTipsCents: 2_000, salesCents: 60_000 });
  shiftsFor(store, company.id, ben.id, weekdays);
  shiftsFor(store, company.id, cy.id, weekdays);
  shiftsFor(store, company.id, dee.id, weekdays, { minutes: 480 });
  return { store, company, ana, ben, cy, dee, eli };
}

const paycheckOf = (run: ReturnType<typeof draftPayRun>, id: string) => run.paychecks.find((p) => p.employeeId === id)!;
const code = (pc: ReturnType<typeof paycheckOf>, c: string) => pc.earnings.find((e) => e.code === c)?.amountCents;

test('a restaurant two-week run: wages, tips, tip-outs, cash tips and the funding identity', () => {
  const { store, company, ana, ben, cy, dee, eli } = restaurant();
  const run = draftPayRun(store, company.id, RUN);
  assert.deepEqual(run.issues.filter((i) => i.severity === 'blocking'), []);

  const a = paycheckOf(run, ana.id);
  // 60h at 213¢ cash wage
  assert.equal(code(a, 'REG'), 213 * 60);
  // each of 10 days: 8,000 charged − busser 1.5% of 60,000 (900) − bar 1% (600) = 6,500
  assert.equal(code(a, 'TIPS_CHARGED'), 65_000);
  assert.equal(code(a, 'TIPS_CASH'), 20_000);
  assert.equal(code(a, 'TIP_MAKEUP'), undefined, 'tips of 85,000 cover the 30,720 credit');
  assert.equal(a.cashTipsCents, 20_000);
  // taxable = 12,780 + 65,000 + 20,000
  assert.equal(a.taxableWagesCents, 97_780);
  const ss = a.taxLines.find((t) => t.id === 'US_SS_EE')!;
  assert.equal(ss.amount, Math.round(97_780 * 0.062));
  // cash tips are taxed but not paid by payroll
  assert.equal(a.payableCents, a.netPayCents - 20_000);

  assert.equal(code(paycheckOf(run, ben.id), 'TIPS_TIPOUT'), 9_000);
  assert.equal(code(paycheckOf(run, cy.id), 'TIPS_TIPOUT'), 6_000);
  assert.equal(code(paycheckOf(run, dee.id), 'REG'), 1700 * 80);
  assert.equal(code(paycheckOf(run, eli.id), 'SALARY'), 200_000);

  // funding = what is paid out + taxes withheld + employer taxes + deductions held
  const t = run.totals;
  assert.equal(t.fundingRequiredCents, t.payableCents + t.employeeTaxCents + t.employerTaxCents + t.deductionsCents);
  assert.equal(t.payableCents, run.paychecks.reduce((s, p) => s + p.payableCents, 0));
  // every cent of gross is accounted for: paid out + withheld + held − what employees already hold in cash tips
  const grossAll = run.paychecks.reduce((s, p) => s + p.taxableWagesCents + p.reimbursementCents, 0);
  assert.equal(grossAll - t.cashTipsCents, t.payableCents + t.employeeTaxCents + t.deductionsCents);
});

test('tips conserved across the run: card tips in = tips paid out', () => {
  const { store, company } = restaurant();
  const run = draftPayRun(store, company.id, RUN);
  const paidTips = run.paychecks.reduce((s, p) => s + p.tips.chargedKeptCents + p.tips.tipOutReceivedCents + p.tips.poolShareCents, 0);
  assert.equal(paidTips, 10 * 8_000);
});

test('a missing tip-credit notice blocks approval and removes the credit', () => {
  const store = new Store();
  const { company } = newCompany(store);
  const ana = hire(store, company.id, { tipCreditNoticeDate: undefined });
  shiftsFor(store, company.id, ana.id, [0, 1, 2], { chargedTipsCents: 5_000 });
  const run = draftPayRun(store, company.id, { periodStart: day(0), periodEnd: day(6), checkDate: day(11) });
  const codes = run.issues.filter((i) => i.severity === 'blocking').map((i) => i.code);
  assert.ok(codes.includes('tip_credit_notice_missing'));
  assert.ok(codes.includes('below_minimum_wage'), 'without the credit, 213¢/h is below the $7.25 minimum');
  assert.throws(() => approvePayRun(store, company.id, run.id, { acknowledgeReviewIssues: true }), (e: any) => e.code === 'blocking_issues');
});

test('review issues must be acknowledged before approval', () => {
  const { store, company } = restaurant();
  store.tx(() => store.employees.all().forEach((e) => store.employees.put({ ...e, payout: { status: 'none' } })));
  const run = draftPayRun(store, company.id, RUN);
  assert.ok(run.issues.some((i) => i.code === 'payout_account_not_ready'));
  assert.throws(() => approvePayRun(store, company.id, run.id, {}), (e: any) => e.code === 'review_not_acknowledged');
  assert.equal(approvePayRun(store, company.id, run.id, { acknowledgeReviewIssues: true }).status, 'approved');
});

test('approval locks shifts and rolls year-to-date; the next run sees the wage base', () => {
  const { store, company, eli } = restaurant();
  for (const e of store.employees.all()) store.tx(() => store.employees.put({ ...e, payout: { status: 'ready' } }));
  const run = draftPayRun(store, company.id, RUN);
  const approved = approvePayRun(store, company.id, run.id, { acknowledgeReviewIssues: true });
  assert.equal(approved.status, 'approved');
  assert.equal(store.employees.get(eli.id)!.ytd.socialSecurity, 200_000);
  assert.ok(store.shifts.all().filter((s) => s.workDate <= day(13)).every((s) => s.lockedByRunId === run.id));
  // a new shift dated inside the approved period would never be paid, so it is refused
  assert.throws(() => recordShift(store, company.id, { employeeId: eli.id, workDate: day(0), minutes: 60 }), (e: any) => e.code === 'period_closed');
  assert.throws(() => recordHouseDay(store, company.id, { date: day(3), houseTipsCents: 100 }), (e: any) => e.code === 'period_closed');
  assert.throws(() => recalculatePayRun(store, company.id, run.id), (e: any) => e.code === 'not_a_draft');
});

test('a period that overlaps an existing run is refused (the double-pay guard)', () => {
  const { store, company } = restaurant();
  draftPayRun(store, company.id, RUN);
  assert.throws(() => draftPayRun(store, company.id, { periodStart: day(7), periodEnd: day(20), checkDate: day(25) }), (e: any) => e.code === 'period_overlap');
  assert.doesNotThrow(() => draftPayRun(store, company.id, { periodStart: day(14), periodEnd: day(27), checkDate: day(32) }));
});

test('voiding an approved run restores year-to-date and unlocks shifts exactly', () => {
  const { store, company, eli } = restaurant();
  for (const e of store.employees.all()) store.tx(() => store.employees.put({ ...e, payout: { status: 'ready' } }));
  const before = JSON.stringify(store.employees.get(eli.id)!.ytd);
  const run = draftPayRun(store, company.id, RUN);
  approvePayRun(store, company.id, run.id, { acknowledgeReviewIssues: true });
  voidPayRun(store, company.id, run.id);
  assert.equal(JSON.stringify(store.employees.get(eli.id)!.ytd), before);
  assert.ok(store.shifts.all().every((s) => !s.lockedByRunId));
  assert.equal(store.payRuns.get(run.id)!.status, 'voided');
  // and the period is free to run again
  assert.doesNotThrow(() => draftPayRun(store, company.id, RUN));
});

test('a draft recalculates after a shift is corrected', () => {
  const { store, company, ana } = restaurant();
  const run = draftPayRun(store, company.id, RUN);
  recordShift(store, company.id, { employeeId: ana.id, workDate: day(0), minutes: 360, externalId: 'pos-1', chargedTipsCents: 0, salesCents: 0 });
  const again = recalculatePayRun(store, company.id, run.id);
  assert.equal(again.id, run.id);
  assert.notEqual(JSON.stringify(again.paychecks), JSON.stringify(run.paychecks));
});

test('tip tax larger than the cash pay left is capped and reported, never invented', () => {
  const store = new Store();
  const { company } = newCompany(store);
  const ana = hire(store, company.id);
  ready(store, ana.id);
  // 2 hours of cash wage but a night of $400 in cash tips
  shiftsFor(store, company.id, ana.id, [0], { minutes: 120, cashTipsCents: 40_000 });
  const run = draftPayRun(store, company.id, { periodStart: day(0), periodEnd: day(6), checkDate: day(11) });
  const p = run.paychecks[0];
  assert.ok(p.uncollectedCents > 0);
  assert.equal(p.payableCents, 0);
  assert.ok(run.issues.some((i) => i.code === 'tip_tax_uncollected'));
  assert.equal(run.totals.fundingRequiredCents, run.totals.payableCents + run.totals.employeeTaxCents + run.totals.employerTaxCents + run.totals.deductionsCents);
});

test('fine dining: pooled tips, full minimum wage, no make-up, manager excluded', () => {
  const store = new Store();
  const { company } = newCompany(store, { niche: 'fine_dining', ein: '98-7654321' });
  const s1 = hire(store, company.id, { roleKey: 'server', payType: { kind: 'hourly', rateCents: 1200 } });
  const cap = hire(store, company.id, { roleKey: 'captain', payType: { kind: 'hourly', rateCents: 1200 } });
  const bus = hire(store, company.id, { roleKey: 'busser', payType: { kind: 'hourly', rateCents: 1200 } });
  shiftsFor(store, company.id, s1.id, [0], { chargedTipsCents: 20_000 });
  shiftsFor(store, company.id, cap.id, [0], { chargedTipsCents: 10_000 });
  shiftsFor(store, company.id, bus.id, [0]);
  const run = draftPayRun(store, company.id, { periodStart: day(0), periodEnd: day(6), checkDate: day(11) });
  assert.deepEqual(run.issues.filter((i) => i.severity === 'blocking'), []);
  // points 1 : 1.5 : 0.6 over 30,000 with equal hours
  const shares = [s1, cap, bus].map((e) => run.paychecks.find((p) => p.employeeId === e.id)!.tips.poolShareCents);
  assert.equal(shares.reduce((a, b) => a + b, 0), 30_000);
  assert.deepEqual(shares, [9_677, 14_516, 5_807]);
  assert.ok(run.paychecks.every((p) => !p.earnings.some((e) => e.code === 'TIP_MAKEUP')));
});

test('catering: a service charge is wages, shared by hours, taxed as regular pay', () => {
  const store = new Store();
  const { company } = newCompany(store, { niche: 'catering_banquet', ein: '55-5555555' });
  const a = hire(store, company.id, { roleKey: 'banquet_server', payType: { kind: 'hourly', rateCents: 1200 } });
  const b = hire(store, company.id, { roleKey: 'setup_crew', payType: { kind: 'hourly', rateCents: 1200 } });
  shiftsFor(store, company.id, a.id, [2], { minutes: 300 });
  shiftsFor(store, company.id, b.id, [2], { minutes: 600 });
  recordHouseDay(store, company.id, { date: day(2), serviceChargesCents: 30_000 });
  const run = draftPayRun(store, company.id, { periodStart: day(0), periodEnd: day(6), checkDate: day(11) });
  assert.equal(code(paycheckOf(run, a.id), 'SVC_CHG'), 10_000);
  assert.equal(code(paycheckOf(run, b.id), 'SVC_CHG'), 20_000);
});

test('a company in an unsupported or planned industry cannot be created', () => {
  const store = new Store();
  assert.throws(() => newCompany(store, { industry: 'retail', niche: 'x' }), (e: any) => e.code === 'industry_not_available');
  assert.throws(() => newCompany(store, { niche: 'nope' }), (e: any) => e.status === 404);
});

test('an employee must hold a role the company has, paid the way the role is paid', () => {
  const store = new Store();
  const { company } = newCompany(store);
  assert.throws(() => addEmployee(store, company.id, { firstName: 'A', lastName: 'B', roleKey: 'wizard', hireDate: '2026-01-01', payType: { kind: 'hourly', rateCents: 1000 } }), /not a role/);
  assert.throws(() => addEmployee(store, company.id, { firstName: 'A', lastName: 'B', roleKey: 'general_manager', hireDate: '2026-01-01', payType: { kind: 'hourly', rateCents: 1000 } }), /paid salary/);
});

test('updating an employee: a new W-4 and a raise apply to the next draft only, and cannot rewrite history', async () => {
  const { updateEmployee } = await import('../src/domain/employees.ts');
  const { store, company, dee } = restaurant();
  const before = draftPayRun(store, company.id, RUN);
  updateEmployee(store, company.id, dee.id, { payType: { kind: 'hourly', rateCents: 2000 }, federalW4: { filingStatus: 'married_joint', extraWithholding: 1_000 } });
  const after = recalculatePayRun(store, company.id, before.id);
  assert.equal(code(paycheckOf(after, dee.id), 'REG'), 2000 * 80);
  assert.equal(code(paycheckOf(before, dee.id), 'REG'), 1700 * 80);
  assert.throws(() => updateEmployee(store, company.id, dee.id, { hireDate: '2020-01-01' }), /cannot be changed/);
  assert.throws(() => updateEmployee(store, company.id, dee.id, { roleKey: 'general_manager' }), /paid salary/);
  assert.throws(() => updateEmployee(store, company.id, dee.id, { ssn: '000-00-0000' }), /SSN/);
  updateEmployee(store, company.id, dee.id, { ssn: '512-34-9999' });
  assert.equal(store.employees.get(dee.id)!.ssnLast4, '9999');
});
