import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.ts';
import { approvePayRun, draftPayRun } from '../src/payroll/payRuns.ts';
import { socialSecurityTips, tipSplit } from '../src/tax/tipSplit.ts';
import { tipReport } from '../src/restaurant/reports.ts';
import type { Paycheck } from '../src/domain/types.ts';
import { day, hire, newCompany, ready, shiftsFor } from './helpers.ts';

const pc = (over: Partial<Paycheck> & { ssTaxable: number; tipAmt: number }): Paycheck => {
  const { ssTaxable, tipAmt: tips, ...rest } = over;
  return {
    employeeId: 'e', name: 'E', hours: 0, taxableWagesCents: 100_000, reimbursementCents: 0, cashTipsCents: 0, netPayCents: 0, payableCents: 0, employeeTaxCents: 0, employerTaxCents: 0, deductionsCents: 0, deductionLines: [], uncollectedCents: 0, weeks: [],
    earnings: [{ code: 'REG', category: 'regular', amountCents: 100_000 - tips, detail: '', paidByPayroll: true }, ...(tips ? [{ code: 'TIPS_CHARGED', category: 'regular' as const, amountCents: tips, detail: '', paidByPayroll: true }] : [])],
    taxLines: [{ id: 'US_SS_EE', name: 'Social Security', payer: 'employee', jurisdiction: 'federal', taxableWages: ssTaxable, amount: 0 }],
    tips: { chargedKeptCents: tips, tipOutReceivedCents: 0, tipOutPaidCents: 0, poolShareCents: 0, cashCents: 0, serviceChargeCents: 0, cardFeeCents: 0 },
    ...rest,
  };
};

test('tip split: with no wage-base cap every tip dollar is a Social Security tip', () => {
  assert.deepEqual(socialSecurityTips(pc({ ssTaxable: 100_000, tipAmt: 30_000 })), { ssWagesCents: 70_000, ssTipsCents: 30_000 });
  assert.deepEqual(socialSecurityTips(pc({ ssTaxable: 100_000, tipAmt: 0 })), { ssWagesCents: 100_000, ssTipsCents: 0 });
});

test('tip split: the wage base is used by wages first, so a binding cap truncates the tips', () => {
  // $1,000 paid, of which $300 tips. Only $800 was under the base: wages take $700 of it, tips get the last $100.
  assert.deepEqual(socialSecurityTips(pc({ ssTaxable: 80_000, tipAmt: 30_000 })), { ssWagesCents: 70_000, ssTipsCents: 10_000 });
  // base already exhausted: no tips count
  assert.deepEqual(socialSecurityTips(pc({ ssTaxable: 0, tipAmt: 30_000 })), { ssWagesCents: 0, ssTipsCents: 0 });
  // base exhausted by wages alone
  assert.equal(socialSecurityTips(pc({ ssTaxable: 50_000, tipAmt: 30_000 })).ssTipsCents, 0);
});

test('tip split: cafeteria-plan deductions lower non-tip wages first; 401(k) deferrals do not reduce Social Security wages', () => {
  // $1,000, $300 tips, $50 section 125: Social Security wages are $950 and tips are all still counted
  const s125 = pc({ ssTaxable: 95_000, tipAmt: 30_000, deductionLines: [{ code: 'MED', category: 'section125', amountCents: 5_000 }] });
  assert.deepEqual(socialSecurityTips(s125), { ssWagesCents: 65_000, ssTipsCents: 30_000 });
  const k401 = pc({ ssTaxable: 100_000, tipAmt: 30_000, deductionLines: [{ code: '401K', category: 'deferral_401k', amountCents: 5_000 }] });
  assert.deepEqual(socialSecurityTips(k401), { ssWagesCents: 70_000, ssTipsCents: 30_000 });
});

function restaurant() {
  const store = new Store();
  const { company } = newCompany(store);
  const ana = hire(store, company.id, { firstName: 'Ana', lastName: 'Ruiz', roleKey: 'server' });
  const dee = hire(store, company.id, { firstName: 'Dee', lastName: 'Park', roleKey: 'line_cook', payType: { kind: 'hourly', rateCents: 1700 }, tipCreditNoticeDate: undefined });
  for (const e of [ana, dee]) ready(store, e.id);
  shiftsFor(store, company.id, ana.id, [0, 1, 2, 3, 4, 7, 8, 9, 10, 11], { chargedTipsCents: 8_000, cashTipsCents: 2_000, salesCents: 60_000 });
  shiftsFor(store, company.id, dee.id, [0, 1, 2, 3, 4, 7, 8, 9, 10, 11], { minutes: 480 });
  const run = approvePayRun(store, company.id, draftPayRun(store, company.id, { periodStart: day(0), periodEnd: day(13), checkDate: day(18) }).id, { acknowledgeReviewIssues: true });
  return { store, company, run, ana, dee };
}

test('the 941 split ties to the run: 5a plus 5b equals all Social Security wages, at 12.4%', () => {
  const { run, ana } = restaurant();
  const split = tipSplit([run], { year: 2026, quarter: 2 });
  const f = split.form941!;
  const allSs = run.paychecks.reduce((a, p) => a + (p.taxLines.find((t) => t.id === 'US_SS_EE')?.taxableWages ?? 0), 0);
  assert.equal(f.line5a1_socialSecurityWagesCents + f.line5b1_socialSecurityTipsCents, allSs);
  // Ana's tips: 10 days of 6,500 kept after tip-outs, plus 2,000 of cash tips a day
  const anaPc = run.paychecks.find((p) => p.employeeId === ana.id)!;
  const anaTips = anaPc.earnings.filter((e) => e.code.startsWith('TIPS_')).reduce((a, e) => a + e.amountCents, 0);
  assert.equal(f.line5b1_socialSecurityTipsCents, anaTips);
  assert.equal(f.line5b2_taxCents, Math.round(anaTips * 0.124));
  assert.equal(f.line5a2_taxCents, Math.round(f.line5a1_socialSecurityWagesCents * 0.124));
  const box7 = split.w2.find((w) => w.employeeId === ana.id)!;
  assert.equal(box7.box7_socialSecurityTipsCents, anaTips);
  assert.equal(box7.box8_allocatedTipsCents, 0);
  assert.equal(split.w2.find((w) => w.employeeId !== ana.id)!.box7_socialSecurityTipsCents, 0, 'the cook has no tips of their own... but receives none here');
  assert.equal(tipSplit([run], { year: 2026, quarter: 3 }).form941!.line5b1_socialSecurityTipsCents, 0, 'nothing was paid in Q3');
  assert.equal(tipSplit([run], { year: 2025 }).w2.length, 0);
});

test('tip reporting: the $20 monthly threshold counts card plus cash, and the due date moves off a weekend', () => {
  const { store, company, ana } = restaurant();
  const r = tipReport(store, company.id, day(0), day(30));
  const row = r.tipReporting.find((x) => x.employeeId === ana.id)!;
  assert.equal(row.month, '2026-06');
  assert.equal(row.cashTipsCents, 20_000);
  assert.equal(row.cardTipsCents, 80_000);
  assert.equal(row.totalTipsCents, 100_000);
  assert.equal(row.mustReport, true);
  assert.equal(row.reportDueBy, '2026-07-10', 'July 10 2026 is a Friday');

  // a month where only $15 was received: under the threshold
  const { company: c2 } = (() => {
    const s2 = new Store();
    const co = newCompany(s2, { ein: '98-7654321' });
    const e = hire(s2, co.company.id);
    shiftsFor(s2, co.company.id, e.id, [0], { chargedTipsCents: 1_500 });
    return { company: tipReport(s2, co.company.id, day(0), day(30)) };
  })();
  assert.equal(c2.tipReporting[0].mustReport, false);

  // tips received in September are due October 10, a Saturday; Monday the 12th is Columbus Day, so Tuesday the 13th
  const s3 = new Store();
  const co3 = newCompany(s3, { ein: '55-5555555' });
  const e3 = hire(s3, co3.company.id);
  shiftsFor(s3, co3.company.id, e3.id, [], {});
  s3.tx(() => s3.shifts.put({ id: 'shf_sep', companyId: co3.company.id, employeeId: e3.id, workDate: '2026-09-15', roleKey: 'server', minutes: 360, chargedTipsCents: 5_000, cashTipsCents: 0, salesCents: 0, mealBreakViolation: false, restBreakViolation: false, createdAt: '2026-09-15T00:00:00Z' }));
  assert.equal(tipReport(s3, co3.company.id, '2026-09-01', '2026-09-30').tipReporting[0].reportDueBy, '2026-10-13');
});

test('the FICA tip credit is figured one employee-month at a time', () => {
  const { store, company } = restaurant();
  const r = tipReport(store, company.id, day(0), day(30));
  assert.equal(r.ficaTipCredit.byMonth.length, 1);
  assert.equal(r.ficaTipCredit.byMonth[0].month, '2026-06');
  assert.equal(r.ficaTipCredit.creditCents, r.ficaTipCredit.byMonth[0].creditCents);
  assert.ok(r.ficaTipCredit.creditCents > 0);
  assert.match(r.ficaTipCredit.note, /employee-month/);
  assert.equal(r.form8027.applies, true);
});

test('a salary below the federal exemption level blocks the run; one above it records that duties are not tested', () => {
  const store = new Store();
  const { company } = newCompany(store);
  const low = hire(store, company.id, { roleKey: 'general_manager', payType: { kind: 'salary', annualCents: 3_000_000 } }); // $577/week
  const run = draftPayRun(store, company.id, { periodStart: day(0), periodEnd: day(6), checkDate: day(11) });
  assert.ok(run.issues.some((i) => i.code === 'salary_below_exempt_threshold' && i.severity === 'blocking' && i.employeeId === low.id));

  const store2 = new Store();
  const { company: c2 } = newCompany(store2);
  const ok = hire(store2, c2.id, { roleKey: 'general_manager', payType: { kind: 'salary', annualCents: 5_200_000 } }); // $1,000/week
  const run2 = draftPayRun(store2, c2.id, { periodStart: day(0), periodEnd: day(6), checkDate: day(11) });
  assert.ok(!run2.issues.some((i) => i.code === 'salary_below_exempt_threshold'));
  assert.ok(run2.issues.some((i) => i.code === 'exemption_duties_not_tested' && i.severity === 'info' && i.employeeId === ok.id));
});
