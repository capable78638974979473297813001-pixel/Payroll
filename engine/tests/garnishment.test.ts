import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { calculatePaycheck } from '../src/calculate.ts';
import { calculateGarnishments, disposableEarnings } from '../src/garnishment.ts';
import { dollars } from '../src/money.ts';
import type { Cents } from '../src/money.ts';
import type { GarnishmentOrder } from '../src/garnishment.ts';
import type { PaycheckInput, PaycheckResult, PayFrequency } from '../src/types.ts';

/**
 * Every expected figure below was hand-derived from the CCPA's own published
 * rule (DOL Fact Sheet #30 / 29 CFR 870.10) before the code ran — same
 * discipline as this project's other test suites. The $217.50/$290.00
 * weekly break points come directly from 30x/40x the $7.25 federal minimum
 * wage; the state-override figures come from data/garnishment/
 * state-overrides-2026.json's own cited statutes.
 */

// A synthetic PaycheckResult with an exact, hand-chosen disposable-earnings
// figure — isolates garnishment math from any particular state's tax rules.
function paycheckOf(gross: Cents, mandatoryTax: Cents, pretax: Cents = 0): PaycheckResult {
  return {
    checkDate: '2026-06-15',
    grossPay: gross,
    pretaxDeductions: pretax,
    posttaxDeductions: 0,
    taxes: [
      {
        id: 'US_FIT',
        name: 'Federal Income Tax',
        payer: 'employee',
        jurisdiction: 'federal',
        taxableWages: gross - pretax,
        amount: mandatoryTax,
      },
    ],
    employeeTaxTotal: mandatoryTax,
    employerTaxTotal: 0,
    netPay: gross - pretax - mandatoryTax,
  };
}

function order(overrides: Partial<GarnishmentOrder> & Pick<GarnishmentOrder, 'id' | 'type'>): GarnishmentOrder {
  return { amountOrdered: Number.MAX_SAFE_INTEGER, ...overrides };
}

function run(
  paycheck: PaycheckResult,
  orders: GarnishmentOrder[],
  // AL has no state departure on file (confirmed via search synthesis — it
  // follows the plain federal CCPA default), which is exactly what these
  // tests without an explicit workState want to isolate. This used to be
  // 'CA' before California got its own real, researched override
  // (Cal. Civ. Proc. Code § 706.050) — every test below that didn't name a
  // state was unknowingly relying on California having none.
  workState = 'AL',
  payFrequency: PayFrequency = 'weekly',
) {
  return calculateGarnishments({
    checkDate: '2026-06-15',
    payFrequency,
    workState,
    paycheck,
    orders,
  });
}

describe('disposableEarnings', () => {
  test('subtracts only employee-paid taxes, never pretax deductions', () => {
    const paycheck = paycheckOf(dollars(1000), dollars(150), dollars(200));
    // $1000 gross - $150 tax = $850, NOT $1000 - $200 - $150 = $650. The
    // $200 pretax deduction lowered what was taxed, but the CCPA still
    // counts it as part of disposable earnings — see garnishment.ts's
    // header comment for why that's correct, not a bug.
    assert.equal(disposableEarnings(paycheck), dollars(850));
  });

  test('matches a real calculatePaycheck() result the same way', () => {
    const input: PaycheckInput = {
      checkDate: '2026-06-15',
      payFrequency: 'weekly',
      earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
      deductions: [{ code: '401K', category: 'deferral_401k', amount: dollars(100) }],
      federalW4: {
        filingStatus: 'single',
        multipleJobs: false,
        dependentCredit: 0,
        otherIncome: 0,
        deductions: 0,
        extraWithholding: 0,
      },
      ytd: { socialSecurity: 0, medicare: 0, futa: 0 },
    };
    const result = calculatePaycheck(input);
    const expected = result.grossPay - result.employeeTaxTotal;
    assert.equal(disposableEarnings(result), expected);
    // The pretax 401(k) deferral must NOT have been subtracted a second time.
    assert.notEqual(disposableEarnings(result), result.netPay);
  });
});

describe('ordinary (consumer/creditor) garnishment — federal default', () => {
  test('below the 30x-minimum-wage floor: nothing may be withheld', () => {
    // $250 gross - $50 tax = $200 disposable, under the weekly $217.50 floor.
    const r = run(paycheckOf(dollars(250), dollars(50)), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ]);
    assert.equal(r.disposableEarnings, dollars(200));
    assert.equal(r.totalWithheld, 0);
  });

  test('between the floor and the 25% crossover: the floor rule binds', () => {
    // $300 gross - $50 tax = $250 disposable. 25% of $250 = $62.50; the
    // floor rule gives $250 - $217.50 = $32.50, the smaller of the two.
    const r = run(paycheckOf(dollars(300), dollars(50)), [
      order({ id: 'A', type: 'consumer_creditor', amountOrdered: dollars(500) }),
    ]);
    assert.equal(r.disposableEarnings, dollars(250));
    assert.equal(r.totalWithheld, dollars(32.5));
  });

  test('well above the crossover: the flat 25% rule binds', () => {
    // $1000 disposable: 25% = $250; the floor rule would allow $782.50.
    const r = run(paycheckOf(dollars(1000), 0), [
      order({ id: 'A', type: 'consumer_creditor', amountOrdered: dollars(1000) }),
    ]);
    assert.equal(r.totalWithheld, dollars(250));
  });

  test('never withholds more than the order itself demands', () => {
    const r = run(paycheckOf(dollars(1000), 0), [
      order({ id: 'A', type: 'consumer_creditor', amountOrdered: dollars(40) }),
    ]);
    assert.equal(r.totalWithheld, dollars(40));
  });

  test('the 30x floor scales by pay frequency (biweekly = 60x, monthly = 130x)', () => {
    // Biweekly floor: 60 * $7.25 = $435.00. $500 disposable clears it by $65.
    // AL, not CA -- California has its own real override now (Cal. Civ.
    // Proc. Code 706.050), so this uses a state confirmed to have none.
    const biweekly = run(
      paycheckOf(dollars(500), 0),
      [order({ id: 'A', type: 'consumer_creditor', amountOrdered: dollars(500) })],
      'AL',
      'biweekly',
    );
    assert.equal(biweekly.totalWithheld, dollars(65)); // lesser of 25%=$125 and $65
    // Monthly floor: 130 * $7.25 = $942.50 — $900 disposable falls under it.
    const monthly = run(
      paycheckOf(dollars(900), 0),
      [order({ id: 'A', type: 'consumer_creditor', amountOrdered: dollars(900) })],
      'AL',
      'monthly',
    );
    assert.equal(monthly.totalWithheld, 0);
  });
});

describe('ordinary garnishment — state overrides', () => {
  for (const state of ['TX', 'PA', 'NC', 'SC']) {
    test(`${state} prohibits ordinary consumer garnishment outright`, () => {
      const r = run(paycheckOf(dollars(2000), 0), [
        order({ id: 'A', type: 'consumer_creditor', amountOrdered: dollars(1000) }),
      ], state);
      assert.equal(r.totalWithheld, 0);
      assert.match(r.lines[0].detail, new RegExp(`prohibited in ${state}`));
    });

    test(`${state}'s prohibition does not touch a child support order`, () => {
      const r = run(paycheckOf(dollars(1000), 0), [
        order({ id: 'S', type: 'child_support', amountOrdered: dollars(300), supportingOtherFamily: false }),
      ], state);
      assert.equal(r.totalWithheld, dollars(300));
    });
  }

  test('Maryland: lesser of 25% of disposable and disposable over 30x its own $15.00 minimum wage', () => {
    // Md. Code Com. Law 15-601.1 (2020 amendment, uniform statewide): floor
    // is 30 x $15.00 = $450/week. $1000 disposable: 25%=$250, floor excess
    // is $1000-$450=$550 -- 25% is smaller.
    const aboveFloor = run(paycheckOf(dollars(1000), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'MD');
    assert.equal(aboveFloor.totalWithheld, dollars(250));

    // $500 disposable: 25%=$125, but floor excess is only $500-$450=$50 --
    // the floor binds instead.
    const floorBinds = run(paycheckOf(dollars(500), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'MD');
    assert.equal(floorBinds.totalWithheld, dollars(50));
  });

  test('Georgia: no state departure — computes identically to the plain federal default', () => {
    // O.C.G.A. 18-4-5 just re-enacts the federal 25%/30x-federal-min-wage
    // rule verbatim; $1000 disposable => 25%=$250 (floor excess is $782.50,
    // so the fraction binds, same as the federal-default test above).
    const r = run(paycheckOf(dollars(1000), 0), [order({ id: 'A', type: 'consumer_creditor' })], 'GA');
    assert.equal(r.totalWithheld, dollars(250));
  });

  test('California: lesser of 20% of disposable and 40% of the excess over 48x its own $16.90 minimum wage', () => {
    // Cal. Civ. Proc. Code 706.050. Floor = 48 x $16.90 = $811.20/week.
    // $3000 disposable: 20%=$600; 40% of ($3000-$811.20)=$875.52 -- the 20%
    // fraction is smaller.
    const fractionBinds = run(paycheckOf(dollars(3000), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'CA');
    assert.equal(fractionBinds.totalWithheld, dollars(600));

    // $1500 disposable: 20%=$300; 40% of ($1500-$811.20)=40% of $688.80=
    // $275.52 -- here the 40%-of-excess test is smaller, unlike every OTHER
    // state in this file (which all take 100% of the excess once the floor
    // binds) -- this is the whole reason minimumWageExcessFraction exists.
    const excessFractionBinds = run(paycheckOf(dollars(1500), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'CA');
    assert.equal(excessFractionBinds.totalWithheld, dollars(275.52));
  });

  test('New Mexico: lesser of 25% of disposable and disposable over 40x its own $12.00 minimum wage', () => {
    // N.M. Stat. Ann. 35-12-7. Floor = 40 x $12.00 = $480/week.
    const fractionBinds = run(paycheckOf(dollars(1000), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'NM');
    assert.equal(fractionBinds.totalWithheld, dollars(250)); // 25% of $1000

    const floorBinds = run(paycheckOf(dollars(520), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'NM');
    assert.equal(floorBinds.totalWithheld, dollars(40)); // $520-$480 excess
  });

  test("South Dakota: lesser of 20% of disposable and disposable over 40x its own $11.85 minimum wage, less $25/week per dependent", () => {
    // S.D. Codified Laws 21-18-51. Floor = 40 x $11.85 = $474/week.
    const noDependents = run(paycheckOf(dollars(1000), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'SD');
    assert.equal(noDependents.totalWithheld, dollars(200)); // 20% of $1000

    const withDependents = run(paycheckOf(dollars(1000), 0), [
      order({ id: 'A', type: 'consumer_creditor', dependents: 2 }),
    ], 'SD');
    assert.equal(withDependents.totalWithheld, dollars(150)); // $200 - 2x$25

    const floorBinds = run(paycheckOf(dollars(500), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'SD');
    assert.equal(floorBinds.totalWithheld, dollars(26)); // $500-$474 excess
  });

  test('Virginia: lesser of 25% of disposable and disposable over 40x its own $12.77 minimum wage', () => {
    // Va. Code Ann. 34-29. Floor = 40 x $12.77 = $510.80/week.
    const fractionBinds = run(paycheckOf(dollars(1000), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'VA');
    assert.equal(fractionBinds.totalWithheld, dollars(250)); // 25% of $1000

    const floorBinds = run(paycheckOf(dollars(600), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'VA');
    assert.equal(floorBinds.totalWithheld, dollars(89.20)); // $600-$510.80
  });

  test('West Virginia: lesser of 20% of disposable and disposable over 50x the FEDERAL $7.25 minimum wage', () => {
    // W. Va. Code 38-5A-3 -- names the federal minimum wage specifically,
    // never West Virginia's own (lower) state figure. Floor = 50 x $7.25 =
    // $362.50/week.
    const fractionBinds = run(paycheckOf(dollars(1000), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'WV');
    assert.equal(fractionBinds.totalWithheld, dollars(200)); // 20% of $1000

    const floorBinds = run(paycheckOf(dollars(400), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'WV');
    assert.equal(floorBinds.totalWithheld, dollars(37.50)); // $400-$362.50
  });

  test("Washington DC: 25% of the excess over 40x DC's own minimum wage, dated", () => {
    // D.C. Code 16-572. The floor is 40x the District minimum wage in
    // effect on the check date: $17.95 through 2026-06-30, $18.40 from
    // 2026-07-01. 25% of a large disposable amount is unchanged by the
    // floor; the floor binds on a check that sits just above it.
    const r = run(paycheckOf(dollars(2000), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'DC');
    assert.equal(r.totalWithheld, dollars(500)); // 25% of $2000

    const before = run(paycheckOf(dollars(800), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'DC');
    assert.equal(before.totalWithheld, dollars(82)); // $800 - 40x$17.95

    const after = calculateGarnishments({
      checkDate: '2026-07-15',
      payFrequency: 'weekly',
      workState: 'DC',
      paycheck: paycheckOf(dollars(800), 0),
      orders: [order({ id: 'A', type: 'consumer_creditor' })],
    });
    assert.equal(after.totalWithheld, dollars(64)); // $800 - 40x$18.40
  });

  test('Nebraska: matches the federal default in general, but drops to 15% (same 30x-federal floor) for a head-of-family debtor', () => {
    // Neb. Rev. Stat. 25-1558.
    const notHeadOfFamily = run(paycheckOf(dollars(1000), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'NE');
    assert.equal(notHeadOfFamily.totalWithheld, dollars(250)); // 25%, same as federal default

    const headOfFamily = run(paycheckOf(dollars(1000), 0), [
      order({ id: 'A', type: 'consumer_creditor', headOfFamily: true }),
    ], 'NE');
    assert.equal(headOfFamily.totalWithheld, dollars(150)); // 15% instead of 25%

    // $250 disposable, head of family: 15%=$37.50, but floor excess is only
    // $250-$217.50=$32.50 -- the floor binds even at the reduced fraction.
    const floorBinds = run(paycheckOf(dollars(250), 0), [
      order({ id: 'A', type: 'consumer_creditor', headOfFamily: true }),
    ], 'NE');
    assert.equal(floorBinds.totalWithheld, dollars(32.50));
  });

  test('Illinois: lesser of 15% of GROSS and disposable over 45x its own $15 minimum wage', () => {
    // $1000 gross, $100 tax => $900 disposable. 15% of gross = $150;
    // disposable over 45*$15=$675 is $225. $150 is smaller.
    const r = run(paycheckOf(dollars(1000), dollars(100)), [
      order({ id: 'A', type: 'consumer_creditor', amountOrdered: dollars(1000) }),
    ], 'IL');
    assert.equal(r.totalWithheld, dollars(150));
  });

  test("Illinois's 45x floor still protects a low earner even though 15% of gross alone would allow something", () => {
    // $700 gross, $50 tax => $650 disposable, under the $675 floor.
    // 15% of $700 = $105, but the floor rule gives $0 and the lesser wins.
    const r = run(paycheckOf(dollars(700), dollars(50)), [
      order({ id: 'A', type: 'consumer_creditor', amountOrdered: dollars(700) }),
    ], 'IL');
    assert.equal(r.totalWithheld, 0);
  });

  test('Connecticut: lesser of 25% of disposable and disposable over 40x its own $16.94 minimum wage', () => {
    // $677.60 = 40 * $16.94 is the floor.
    const belowFloor = run(paycheckOf(dollars(600), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'CT');
    assert.equal(belowFloor.totalWithheld, 0);

    // $700 disposable: 25% = $175; floor excess = $700 - $677.60 = $22.40 (smaller).
    const floorBinds = run(paycheckOf(dollars(700), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'CT');
    assert.equal(floorBinds.totalWithheld, dollars(22.4));

    // $2000 disposable: 25% = $500; floor excess = $1322.40 (25% smaller).
    const fractionBinds = run(paycheckOf(dollars(2000), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'CT');
    assert.equal(fractionBinds.totalWithheld, dollars(500));
  });

  test('Minnesota: cliff-bracket tiers, not a "lesser of" formula', () => {
    // Weekly thresholds at $11.41/hr: 40x=$456.40, 60x=$684.60, 80x=$912.80.
    assert.equal(
      run(paycheckOf(dollars(400), 0), [order({ id: 'A', type: 'consumer_creditor' })], 'MN')
        .totalWithheld,
      0, // at or below 40x: fully exempt
    );
    assert.equal(
      run(paycheckOf(dollars(500), 0), [order({ id: 'A', type: 'consumer_creditor' })], 'MN')
        .totalWithheld,
      dollars(50), // 40x-60x tier: flat 10% of the WHOLE $500, not just the excess
    );
    assert.equal(
      run(paycheckOf(dollars(700), 0), [order({ id: 'A', type: 'consumer_creditor' })], 'MN')
        .totalWithheld,
      dollars(105), // 60x-80x tier: flat 15%
    );
    assert.equal(
      run(paycheckOf(dollars(1000), 0), [order({ id: 'A', type: 'consumer_creditor' })], 'MN')
        .totalWithheld,
      dollars(250), // above 80x: flat 25%
    );
  });

  test('New York: lesser of 10% of GROSS, 25% of disposable, and disposable over 30x its own $16 minimum wage', () => {
    // $1000 gross, $100 tax => $900 disposable. 10% of gross = $100 (smallest).
    const grossBinds = run(paycheckOf(dollars(1000), dollars(100)), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'NY');
    assert.equal(grossBinds.totalWithheld, dollars(100));

    // $600 gross, $100 tax => $500 disposable. 10%*600=$60; 25%*500=$125;
    // floor excess = $500-$480(=30x$16)=$20 (smallest).
    const floorBinds = run(paycheckOf(dollars(600), dollars(100)), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'NY');
    assert.equal(floorBinds.totalWithheld, dollars(20));

    // $400 disposable is under the $480 floor: fully exempt.
    const exempt = run(paycheckOf(dollars(400), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'NY');
    assert.equal(exempt.totalWithheld, 0);
  });

  test('Massachusetts: lesser of 15% of GROSS and disposable over 50x its own $15 minimum wage', () => {
    // $1200 gross, $200 tax => $1000 disposable. 15%*1200=$180;
    // floor excess = $1000 - $750(=50x$15) = $250 (fraction is smaller).
    const fractionBinds = run(paycheckOf(dollars(1200), dollars(200)), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'MA');
    assert.equal(fractionBinds.totalWithheld, dollars(180));

    // $900 gross, $100 tax => $800 disposable. 15%*900=$135;
    // floor excess = $800-$750=$50 (floor is smaller).
    const floorBinds = run(paycheckOf(dollars(900), dollars(100)), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'MA');
    assert.equal(floorBinds.totalWithheld, dollars(50));
  });

  test('Delaware: a flat 15% of disposable earnings, with no separate minimum-wage floor', () => {
    assert.equal(
      run(paycheckOf(dollars(1000), 0), [order({ id: 'A', type: 'consumer_creditor' })], 'DE')
        .totalWithheld,
      dollars(150),
    );
    // Even a very low earner gets no floor protection beyond the flat 15% —
    // unlike every other override in this file, DE names no separate floor.
    assert.equal(
      run(paycheckOf(dollars(100), 0), [order({ id: 'A', type: 'consumer_creditor' })], 'DE')
        .totalWithheld,
      dollars(15),
    );
  });

  test("Florida: a head-of-family debtor owes $0 at ANY income level, not just below a threshold", () => {
    const r = run(paycheckOf(dollars(5000), 0), [
      order({ id: 'A', type: 'consumer_creditor', headOfFamily: true }),
    ], 'FL');
    assert.equal(r.totalWithheld, 0);
  });

  test('Florida: a head-of-family debtor who waived the exemption in writing gets the plain federal default', () => {
    // $1000 disposable, no state departure beyond the (waived) exemption:
    // federal 25% = $250 binds (floor excess would be $782.50).
    const r = run(paycheckOf(dollars(1000), 0), [
      order({
        id: 'A',
        type: 'consumer_creditor',
        headOfFamily: true,
        wageExemptionWaivedInWriting: true,
      }),
    ], 'FL');
    assert.equal(r.totalWithheld, dollars(250));
  });

  test('Florida: a non-head-of-family debtor gets the plain federal default too', () => {
    const r = run(paycheckOf(dollars(1000), 0), [
      order({ id: 'A', type: 'consumer_creditor', headOfFamily: false }),
    ], 'FL');
    assert.equal(r.totalWithheld, dollars(250));
  });
});

describe('child support / alimony withholding orders', () => {
  test('60% ceiling when not supporting another spouse or child', () => {
    const r = run(paycheckOf(dollars(1000), 0), [
      order({ id: 'S', type: 'child_support', amountOrdered: dollars(800), supportingOtherFamily: false }),
    ]);
    assert.equal(r.aggregateCeiling, dollars(600));
    assert.equal(r.totalWithheld, dollars(600));
  });

  test('50% ceiling when supporting another spouse or child', () => {
    const r = run(paycheckOf(dollars(1000), 0), [
      order({ id: 'S', type: 'child_support', amountOrdered: dollars(800), supportingOtherFamily: true }),
    ]);
    assert.equal(r.totalWithheld, dollars(500));
  });

  test('+5 points for 12+ weeks in arrears (60% -> 65%)', () => {
    const r = run(paycheckOf(dollars(1000), 0), [
      order({
        id: 'S',
        type: 'child_support',
        amountOrdered: dollars(800),
        supportingOtherFamily: false,
        arrearsOver12Weeks: true,
      }),
    ]);
    assert.equal(r.totalWithheld, dollars(650));
  });

  test('never withholds more than the order itself demands, even under a higher ceiling', () => {
    const r = run(paycheckOf(dollars(1000), 0), [
      order({ id: 'S', type: 'child_support', amountOrdered: dollars(300), supportingOtherFamily: false }),
    ]);
    assert.equal(r.totalWithheld, dollars(300));
  });

  test('multiple support orders share ONE ceiling, prorated by each order\'s own demanded amount', () => {
    // $1000 disposable, 60% ceiling = $600. Two orders demand $300 and
    // $600 (total $900, over the $600 ceiling) -> prorated 1:2.
    const r = run(paycheckOf(dollars(1000), 0), [
      order({ id: 'S1', type: 'child_support', amountOrdered: dollars(300), supportingOtherFamily: false }),
      order({ id: 'S2', type: 'child_support', amountOrdered: dollars(600), supportingOtherFamily: false }),
    ]);
    assert.equal(r.totalWithheld, dollars(600));
    const s1 = r.lines.find((l) => l.orderId === 'S1')!;
    const s2 = r.lines.find((l) => l.orderId === 'S2')!;
    assert.equal(s1.withheld, dollars(200)); // 300/900 * 600
    assert.equal(s2.withheld, dollars(400)); // 600/900 * 600
  });
});

describe('support-order proration rounding', () => {
  test('rounded shares never add up to more than the combined ceiling', () => {
    // $50.01 disposable, 60% ceiling = $30.01 (3001 cents, from 3000.6). Two
    // equal $100 orders split it 1500.5 / 1500.5; rounding each half up gave 3002.
    const r = run(paycheckOf(5001, 0), [
      order({ id: 'S1', type: 'child_support', amountOrdered: dollars(100), supportingOtherFamily: false }),
      order({ id: 'S2', type: 'child_support', amountOrdered: dollars(100), supportingOtherFamily: false }),
    ]);
    assert.equal(r.aggregateCeiling, 3001);
    assert.equal(r.totalWithheld, 3001);
    for (const l of r.lines) assert.ok(l.withheld === 1500 || l.withheld === 1501);
  });

  test('rounded shares never fall short of the ceiling when orders demand more than it', () => {
    // 3 equal orders over a 10-cent ceiling: 3.33 each rounds to 9; all 10 are owed.
    const r = run(paycheckOf(17, 0), [
      order({ id: 'S1', type: 'child_support', amountOrdered: dollars(100), supportingOtherFamily: false }),
      order({ id: 'S2', type: 'child_support', amountOrdered: dollars(100), supportingOtherFamily: false }),
      order({ id: 'S3', type: 'child_support', amountOrdered: dollars(100), supportingOtherFamily: false }),
    ]);
    assert.equal(r.aggregateCeiling, 10);
    assert.equal(r.totalWithheld, 10);
  });
});

describe('stacking a support order with an ordinary garnishment', () => {
  test('support already withheld counts against the ordinary limit (DOL Fact Sheet #30, Example 6)', () => {
    // $370 weekly disposable, $140 withheld for support. The ordinary limit is
    // 25% = $92.50; $140 is already more than that, so the creditor gets $0 even
    // though the support ceiling (50%) would leave $45 of room.
    const r = run(paycheckOf(dollars(370), 0), [
      order({ id: 'S', type: 'child_support', amountOrdered: dollars(140), supportingOtherFamily: true }),
      order({ id: 'C', type: 'consumer_creditor', amountOrdered: dollars(500), priority: 1 }),
    ]);
    assert.equal(r.aggregateCeiling, dollars(185));
    assert.equal(r.lines.find((l) => l.orderId === 'S')!.withheld, dollars(140));
    assert.equal(r.lines.find((l) => l.orderId === 'C')!.withheld, 0);
    assert.equal(r.totalWithheld, dollars(140));
  });

  test('when support is below the ordinary limit, the creditor gets only the difference', () => {
    // $1000 disposable, 60% support ceiling = $600. Support takes $100; the
    // ordinary limit is 25% = $250, so the creditor may take $150 more.
    const r = run(paycheckOf(dollars(1000), 0), [
      order({ id: 'S', type: 'child_support', amountOrdered: dollars(100), supportingOtherFamily: false }),
      order({ id: 'C', type: 'consumer_creditor', amountOrdered: dollars(500), priority: 1 }),
    ]);
    assert.equal(r.lines.find((l) => l.orderId === 'C')!.withheld, dollars(150));
    assert.equal(r.totalWithheld, dollars(250));
    assert.match(r.lines.find((l) => l.orderId === 'C')!.detail, /already garnished/);
  });

  test('several ordinary orders share one ordinary limit even when the 30x floor makes it smaller than 25%', () => {
    // $250 disposable: 25% = $62.50 but only $32.50 is above 30 x $7.25 = $217.50.
    // The first order takes the $32.50; the second gets nothing.
    const r = run(paycheckOf(dollars(250), 0), [
      order({ id: 'C1', type: 'consumer_creditor', amountOrdered: dollars(1000), priority: 1 }),
      order({ id: 'C2', type: 'consumer_creditor', amountOrdered: dollars(1000), priority: 2 }),
    ]);
    assert.equal(r.lines.find((l) => l.orderId === 'C1')!.withheld, dollars(32.5));
    assert.equal(r.lines.find((l) => l.orderId === 'C2')!.withheld, 0);
    assert.equal(r.totalWithheld, dollars(32.5));
  });

  test('a support order that consumes the full ceiling leaves nothing for anything junior', () => {
    const r = run(paycheckOf(dollars(1000), 0), [
      order({ id: 'S', type: 'child_support', amountOrdered: dollars(600), supportingOtherFamily: false }),
      order({ id: 'C', type: 'consumer_creditor', amountOrdered: dollars(500), priority: 1 }),
    ]);
    assert.equal(r.lines.find((l) => l.orderId === 'S')!.withheld, dollars(600));
    assert.equal(r.lines.find((l) => l.orderId === 'C')!.withheld, 0);
  });
});

describe('federal student loan default (34 CFR 34.19)', () => {
  test('capped at the lesser of 15% of disposable earnings and the 30x floor', () => {
    const r = run(paycheckOf(dollars(1000), 0), [
      order({ id: 'L', type: 'federal_student_loan_default' }),
    ]);
    assert.equal(r.totalWithheld, dollars(150));
  });

  test('combined with a consumer garnishment, the two never exceed the 25% aggregate ceiling', () => {
    // $1000 disposable, no support order -> 25% aggregate ceiling = $250.
    // Student loan (priority 1) draws its own $150 cap first, leaving $100
    // of room; the consumer garnishment (own cap $250) is limited to that.
    const r = run(paycheckOf(dollars(1000), 0), [
      order({ id: 'L', type: 'federal_student_loan_default', priority: 1 }),
      order({ id: 'C', type: 'consumer_creditor', amountOrdered: dollars(500), priority: 2 }),
    ]);
    assert.equal(r.lines.find((l) => l.orderId === 'L')!.withheld, dollars(150));
    assert.equal(r.lines.find((l) => l.orderId === 'C')!.withheld, dollars(100));
    assert.equal(r.totalWithheld, dollars(250));
  });

  test("a state's ordinary-garnishment prohibition does not touch a federal student loan default", () => {
    const r = run(paycheckOf(dollars(1000), 0), [
      order({ id: 'L', type: 'federal_student_loan_default' }),
    ], 'TX');
    assert.equal(r.totalWithheld, dollars(150));
  });
});

describe('more state overrides — cliff-on-dollar, marginal-bracket and head-of-family shapes', () => {
  test('Colorado: lesser of 20% of disposable and disposable over 40x its own $15.16 minimum wage', () => {
    // Floor: 40 * $15.16 = $606.40.
    const floorBinds = run(paycheckOf(dollars(700), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'CO');
    assert.equal(floorBinds.totalWithheld, dollars(93.6)); // $700-$606.40, smaller than 20%*$700=$140

    const fractionBinds = run(paycheckOf(dollars(2000), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'CO');
    assert.equal(fractionBinds.totalWithheld, dollars(400)); // 20%*$2000, smaller than the floor excess

    const exempt = run(paycheckOf(dollars(500), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'CO');
    assert.equal(exempt.totalWithheld, 0); // under the $606.40 floor
  });

  test('Washington: lesser of 20% of disposable and disposable over 35x its own $17.13 minimum wage', () => {
    // Floor: 35 * $17.13 = $599.55.
    const floorBinds = run(paycheckOf(dollars(700), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'WA');
    assert.equal(floorBinds.totalWithheld, dollars(100.45)); // $700-$599.55, smaller than 20%*$700=$140

    const fractionBinds = run(paycheckOf(dollars(2000), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'WA');
    assert.equal(fractionBinds.totalWithheld, dollars(400)); // 20%*$2000
  });

  test('Nevada: an 18%/25% cliff keyed on a FIXED gross-weekly dollar threshold, applied to disposable earnings', () => {
    // Floor: 50 * $7.25 = $362.50 (the federal rate specifically, not Nevada's own).
    // Gross <= $770 -> 18% tier.
    const lowTier = run(paycheckOf(dollars(700), dollars(50)), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'NV');
    assert.equal(lowTier.totalWithheld, dollars(117)); // 18% of $650 disposable

    // Gross > $770 -> 25% tier.
    const highTier = run(paycheckOf(dollars(1000), dollars(100)), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'NV');
    assert.equal(highTier.totalWithheld, dollars(225)); // 25% of $900 disposable

    // The floor still binds even in the 25% tier at low disposable earnings.
    const floorBinds = run(paycheckOf(dollars(1000), dollars(600)), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'NV');
    assert.equal(floorBinds.totalWithheld, dollars(37.5)); // $400-$362.50, smaller than 25%*$400=$100
  });

  test('Hawaii: MARGINAL brackets on monthly-prorated disposable earnings, not a cliff', () => {
    // Weekly-prorated breakpoints: $100/mo -> $23.08/week, $200/mo -> $46.15/week.
    const withinFirstBracket = run(paycheckOf(dollars(10), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'HI');
    assert.equal(withinFirstBracket.totalWithheld, dollars(0.5)); // 5% of the whole $10

    const acrossTwoBrackets = run(paycheckOf(dollars(40), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'HI');
    // 5% of the first $23.08 ($1.15) + 10% of the next $16.92 ($1.69) = $2.84 —
    // NOT 10% of the whole $40, which is what a cliff rule would give.
    assert.equal(acrossTwoBrackets.totalWithheld, dollars(2.84));

    const acrossAllThreeBrackets = run(paycheckOf(dollars(100), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'HI');
    // 5% of $23.08 ($1.15) + 10% of $23.07 ($2.31) + 20% of the remaining $53.85 ($10.77) = $14.23.
    assert.equal(acrossAllThreeBrackets.totalWithheld, dollars(14.23));
  });

  test('Missouri: a head-of-family debtor gets 10% instead of the ordinary 25%, never a full exemption', () => {
    const r = run(paycheckOf(dollars(1000), 0), [
      order({ id: 'A', type: 'consumer_creditor', headOfFamily: true }),
    ], 'MO');
    assert.equal(r.totalWithheld, dollars(100)); // 10% of $1000, smaller than the floor excess

    // The 30x-federal-minimum-wage floor ($217.50) still binds independently.
    const floorBinds = run(paycheckOf(dollars(220), 0), [
      order({ id: 'A', type: 'consumer_creditor', headOfFamily: true }),
    ], 'MO');
    assert.equal(floorBinds.totalWithheld, dollars(2.5)); // $220-$217.50, smaller than 10%*$220=$22

    // Not head-of-family: Missouri has no other departure, so the plain
    // federal 25%/30x default applies.
    const notHeadOfFamily = run(paycheckOf(dollars(1000), 0), [
      order({ id: 'A', type: 'consumer_creditor', headOfFamily: false }),
    ], 'MO');
    assert.equal(notHeadOfFamily.totalWithheld, dollars(250));
  });

  test('Wisconsin: lesser of 20% of disposable and disposable over 30x the FEDERAL minimum wage', () => {
    // Floor: 30 * $7.25 = $217.50.
    const floorBinds = run(paycheckOf(dollars(250), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'WI');
    assert.equal(floorBinds.totalWithheld, dollars(32.5)); // $250-$217.50, smaller than 20%*$250=$50

    const fractionBinds = run(paycheckOf(dollars(2000), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'WI');
    assert.equal(fractionBinds.totalWithheld, dollars(400)); // 20%*$2000
  });

  test("Maine: lesser of 25% of disposable and disposable over 40x its own $15.10 minimum wage", () => {
    // Floor: 40 * $15.10 = $604.00.
    const floorBinds = run(paycheckOf(dollars(700), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'ME');
    assert.equal(floorBinds.totalWithheld, dollars(96)); // $700-$604, smaller than 25%*$700=$175

    const fractionBinds = run(paycheckOf(dollars(2000), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'ME');
    assert.equal(fractionBinds.totalWithheld, dollars(500)); // 25%*$2000
  });

  test('Vermont: the MORE protective consumer-credit-transaction rule (15%/40x federal) governs an ordinary garnishment', () => {
    // Floor: 40 * $7.25 = $290.00.
    const floorBinds = run(paycheckOf(dollars(300), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'VT');
    assert.equal(floorBinds.totalWithheld, dollars(10)); // $300-$290, smaller than 15%*$300=$45

    const fractionBinds = run(paycheckOf(dollars(2000), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'VT');
    assert.equal(fractionBinds.totalWithheld, dollars(300)); // 15%*$2000
  });

  test('North Dakota: the 25%/40x-federal cap is further reduced by $20/week per dependent', () => {
    const noDependents = run(paycheckOf(dollars(1000), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'ND');
    assert.equal(noDependents.totalWithheld, dollars(250)); // 25%*$1000, floor excess is $710

    const twoDependents = run(paycheckOf(dollars(1000), 0), [
      order({ id: 'A', type: 'consumer_creditor', dependents: 2 }),
    ], 'ND');
    assert.equal(twoDependents.totalWithheld, dollars(210)); // $250 - 2*$20

    // The per-dependent reduction never pushes the cap below zero.
    const reductionExceedsCap = run(paycheckOf(dollars(300), 0), [
      order({ id: 'A', type: 'consumer_creditor', dependents: 3 }),
    ], 'ND');
    assert.equal(reductionExceedsCap.totalWithheld, 0); // base cap is $10 (floor-bound); 3*$20=$60 would go negative
  });

  test('New Jersey: 10% of GROSS while at/under 250% of the household poverty guideline, else the federal default', () => {
    // Household of 4: 2026 HHS guideline $33,000 x 250% = $82,500. $1000/week
    // annualizes to $52,000 -- at or under the threshold, so the 10%-of-gross
    // tier applies: 10% x $1000 = $100. The $48/week flat floor ($1000-$48=
    // $952) doesn't bind here.
    const belowThreshold = run(paycheckOf(dollars(1000), 0), [
      order({ id: 'A', type: 'consumer_creditor', householdSize: 4 }),
    ], 'NJ');
    assert.equal(belowThreshold.totalWithheld, dollars(100));

    // Household of 1: guideline $15,960 x 250% = $39,900. The same $1000/week
    // ($52,000/year) now EXCEEDS the threshold, so N.J. Stat. 2A:17-56 leaves
    // it to court discretion -- this engine falls through to the plain
    // federal default: lesser of 25%*$1000 and $1000-$217.50(30x $7.25).
    const aboveThreshold = run(paycheckOf(dollars(1000), 0), [
      order({ id: 'A', type: 'consumer_creditor', householdSize: 1 }),
    ], 'NJ');
    assert.equal(aboveThreshold.totalWithheld, dollars(250));

    // No household size supplied at all: never guessed, same federal
    // fallback as the above-threshold case.
    const noHouseholdSize = run(paycheckOf(dollars(1000), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'NJ');
    assert.equal(noHouseholdSize.totalWithheld, dollars(250));

    // At very low income the separate $48/week flat exemption (2A:17-50)
    // binds ahead of the 10% fraction: 10%*$50=$5, but the flat floor only
    // leaves $50-$48=$2 exposed.
    const flatFloorBinds = run(paycheckOf(dollars(50), 0), [
      order({ id: 'A', type: 'consumer_creditor', householdSize: 1 }),
    ], 'NJ');
    assert.equal(flatFloorBinds.totalWithheld, dollars(2));
  });

  test('Arizona: lesser of 10% of disposable and disposable over 60x its own $15.15 minimum wage (Prop 209)', () => {
    // $1000 disposable: 10% = $100; floor excess = $1000 - 60*$15.15
    // ($909.00) = $91.00 (smaller).
    const r = run(paycheckOf(dollars(1000), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'AZ');
    assert.equal(r.totalWithheld, dollars(91));

    // Below the $909.00 floor: fully exempt, even though 10% of gross
    // alone would allow something.
    const belowFloor = run(paycheckOf(dollars(900), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'AZ');
    assert.equal(belowFloor.totalWithheld, 0);
  });

  test("Alaska: greater of $473/week (or $743 sole-support) exempt, or 75% of disposable — flat-dollar floor, not minimum-wage-derived", () => {
    // $1000 disposable: 25% = $250; flat floor excess = $1000 - $473 =
    // $527 (25% is smaller — the ordinary case, high income).
    const highIncome = run(paycheckOf(dollars(1000), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'AK');
    assert.equal(highIncome.totalWithheld, dollars(250));

    // $600 disposable: 25% = $150; flat floor excess = $600 - $473 = $127
    // (the floor is smaller here — the low-income case the flat dollar
    // figure exists to protect).
    const lowIncome = run(paycheckOf(dollars(600), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'AK');
    assert.equal(lowIncome.totalWithheld, dollars(127));

    // Same $600, but the debtor has filed the sole-support affidavit:
    // floor rises to $743, exceeding disposable entirely -> $0 withheld.
    const soleSupport = run(paycheckOf(dollars(600), 0), [
      order({ id: 'A', type: 'consumer_creditor', soleHouseholdSupport: true }),
    ], 'AK');
    assert.equal(soleSupport.totalWithheld, 0);
  });

  test('Iowa: the plain federal 25%/30x test, further capped by a CUMULATIVE annual dollar limit per creditor', () => {
    // $1000 disposable: federal weekly cap = lesser of 25%=$250 or
    // disposable-over-$217.50=$782.50 -> $250. Expected annual earnings
    // $10,000 is under the $12,000 tier -> $250/year cap. With $200
    // already garnished this year, only $50 of annual room remains,
    // which binds tighter than the $250 weekly federal cap.
    const annualCapBinds = run(paycheckOf(dollars(1000), 0), [
      order({
        id: 'A',
        type: 'consumer_creditor',
        expectedAnnualEarnings: dollars(10000),
        garnishedThisYearForThisOrder: dollars(200),
      }),
    ], 'IA');
    assert.equal(annualCapBinds.totalWithheld, dollars(50));

    // Same paycheck, no expectedAnnualEarnings supplied at all: the extra
    // annual layer never applies (never guessed), so the plain federal
    // weekly cap governs unchanged.
    const noAnnualFact = run(paycheckOf(dollars(1000), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'IA');
    assert.equal(noAnnualFact.totalWithheld, dollars(250));

    // A high earner ($60,000 expected) falls in the top, percentage tier:
    // 10% of $60,000 = $6,000/year. With nothing garnished yet this year,
    // the full $250 weekly federal cap has plenty of annual room left.
    const topTier = run(paycheckOf(dollars(1000), 0), [
      order({ id: 'A', type: 'consumer_creditor', expectedAnnualEarnings: dollars(60000) }),
    ], 'IA');
    assert.equal(topTier.totalWithheld, dollars(250));
  });

  test('Oregon: lesser of 25% of disposable and disposable over its own dated flat weekly floor (ORS 18.385(2))', () => {
    // run() uses a 2026-06-15 check date, so the $338 step (wages payable
    // 2025-07-01 through 2026-06-30) applies.
    // $1000 disposable: 25% = $250; floor excess = $1000-$338 = $662
    // (25% is smaller — the ordinary, higher-income case).
    const higherIncome = run(paycheckOf(dollars(1000), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'OR');
    assert.equal(higherIncome.totalWithheld, dollars(250));

    // $400 disposable: 25% = $100; floor excess = $400-$338 = $62
    // (the flat floor is smaller — the low-income case it exists to protect).
    const lowerIncome = run(paycheckOf(dollars(400), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'OR');
    assert.equal(lowerIncome.totalWithheld, dollars(62));

    // At or under the floor nothing may be withheld.
    const underFloor = run(paycheckOf(dollars(338), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'OR');
    assert.equal(underFloor.totalWithheld, 0);
  });

  test('Oregon: the weekly floor steps with the check date, and other pay periods use the statute\'s own printed figures', () => {
    const withheld = (checkDate: string, disposable: number, frequency: PayFrequency) =>
      calculateGarnishments({
        checkDate,
        payFrequency: frequency,
        workState: 'OR',
        paycheck: paycheckOf(dollars(disposable), 0),
        orders: [order({ id: 'A', type: 'consumer_creditor' })],
      }).totalWithheld;

    // Weekly, $340 disposable: 25% = $85, so the floor excess governs
    // whenever it is smaller. Only 2026 check dates are reachable: the
    // garnishment data files are one per calendar year.
    assert.equal(withheld('2026-01-01', 340, 'weekly'), dollars(2)); // $338 floor
    assert.equal(withheld('2026-06-30', 340, 'weekly'), dollars(2));
    assert.equal(withheld('2026-07-01', 340, 'weekly'), 0); // $400 floor
    assert.equal(withheld('2026-07-01', 420, 'weekly'), dollars(20));
    assert.equal(withheld('2026-06-30', 420, 'weekly'), dollars(82)); // 25% = $105; excess over $338 is $82

    // Printed per-period figures, wages payable on or after 2026-07-01:
    // biweekly $832, semimonthly $912, monthly $1,792 — not 2x/2.17x/4.33x $400.
    assert.equal(withheld('2026-07-01', 900, 'biweekly'), dollars(68));
    assert.equal(withheld('2026-07-01', 1000, 'semimonthly'), dollars(88));
    assert.equal(withheld('2026-07-01', 1900, 'monthly'), dollars(108));

    // A daily pay period is "a period of one week or less" and takes the full
    // weekly floor (ORS 18.385(2)(a)), not a fifth of it.
    assert.equal(withheld('2026-07-01', 100, 'daily'), 0); // under the $400 floor: nothing may be withheld
    assert.equal(withheld('2026-07-01', 400, 'daily'), 0);
    assert.equal(withheld('2026-07-01', 420, 'daily'), dollars(20)); // excess over $400; 25% would be $105
    assert.equal(withheld('2026-06-30', 340, 'daily'), dollars(2)); // the $338 step before 2026-07-01
  });

  test('Tennessee: the plain federal 25%/30x test, reduced $2.50/week per qualifying dependent child', () => {
    // $1000 disposable: 25% = $250 (30x-federal floor excess is larger,
    // $782.50, so 25% governs) less 2 x $2.50 = $5 -> $245.
    const withDependents = run(paycheckOf(dollars(1000), 0), [
      order({ id: 'A', type: 'consumer_creditor', dependents: 2 }),
    ], 'TN');
    assert.equal(withDependents.totalWithheld, dollars(245));

    // Same paycheck, no dependents asserted: no reduction, plain $250.
    const noDependents = run(paycheckOf(dollars(1000), 0), [
      order({ id: 'A', type: 'consumer_creditor' }),
    ], 'TN');
    assert.equal(noDependents.totalWithheld, dollars(250));
  });
});
