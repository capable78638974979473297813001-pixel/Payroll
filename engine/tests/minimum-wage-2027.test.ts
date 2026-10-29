import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { calculatePaycheck } from '../src/calculate.ts';
import { calculateGarnishments } from '../src/garnishment.ts';
import { minimumWage } from '../src/minimum-wage.ts';
import type { PaycheckInput } from '../src/types.ts';

/**
 * The 2027 minimum-wage files (checked 2026-10-25). Before them, any 2027-dated
 * minimum-wage lookup threw "No ruleset at data/minimum-wage/federal-2027.json",
 * and so did a consumer-creditor garnishment for New York or DC on a 2027 check,
 * because those two statutes take their floor from the minimum-wage ruleset.
 * Every figure below is from the state agency's own 2027 announcement or the statute.
 */

const J = '2027-01-15';
const cents = (state: string, extra: Record<string, unknown> = {}) => minimumWage({ checkDate: J, state, ...extra }).cents;

describe('2027 state minimum wages', () => {
  for (const [state, expected] of [
    ['WA', 1773], ['CA', 1740], ['CT', 1748], ['NJ', 1648], ['CO', 1571], ['ME', 1570],
    ['MN', 1187], ['OH', 1140], ['VA', 1375], ['NE', 1526], ['SD', 1230], ['MT', 1120],
    ['AZ', 1565], ['RI', 1700], ['MI', 1500], ['FL', 1500],
  ] as const) {
    test(`${state} is ${expected} cents on 2027-01-15`, () => assert.equal(cents(state), expected));
  }

  test('New York does not index in 2027 (DOL: the off-ramp condition was met): $16.00 upstate, $17.00 downstate', () => {
    assert.equal(cents('NY'), 1600);
    assert.equal(cents('NY', { region: 'downstate' }), 1700);
  });

  test('states that do not move stay put', () => {
    for (const [s, c] of [['IL', 1500], ['MA', 1500], ['MO', 1500], ['TX', 725], ['NV', 1200]] as const) assert.equal(cents(s), c, s);
  });

  test('a state whose rate was not yet announced keeps 2026 and says so (Vermont)', () => {
    assert.equal(cents('VT'), 1442);
  });

  test('the same state on a 2026 date is unchanged', () => {
    assert.equal(minimumWage({ checkDate: '2026-12-15', state: 'WA' }).cents, 1713);
    assert.equal(minimumWage({ checkDate: '2026-12-15', state: 'OH' }).cents, 1100);
  });

  test('mid-year 2027 steps survive: Alaska $15.00 from 2027-07-01, Virginia and Washington unchanged all year', () => {
    assert.equal(minimumWage({ checkDate: '2027-06-30', state: 'AK' }).cents, 1400);
    assert.equal(minimumWage({ checkDate: '2027-07-01', state: 'AK' }).cents, 1500);
    assert.equal(minimumWage({ checkDate: '2027-12-31', state: 'VA' }).cents, 1375);
  });
});

describe('2027 tipped cash wages', () => {
  for (const [state, expected] of [['NJ', 661], ['CO', 1269], ['ME', 785], ['OH', 570], ['SD', 615], ['MI', 630], ['AZ', 1265], ['CT', 638], ['NE', 213], ['VA', 213]] as const) {
    test(`${state} tipped cash floor is ${expected} cents`, () => assert.equal(cents(state, { tipped: true }), expected));
  }
  test('a no-tip-credit state follows its standard rate (Washington, California)', () => {
    assert.equal(cents('WA', { tipped: true }), 1773);
    assert.equal(cents('CA', { tipped: true }), 1740);
  });
});

describe('2027 employer-size tiers', () => {
  test('New Jersey small and seasonal employers owe $16.25', () => assert.equal(cents('NJ', { employeeCount: 3 }), 1625));
  test('New Jersey employers with 6 or more owe $16.48', () => assert.equal(cents('NJ', { employeeCount: 20 }), 1648));
});

describe('provisional notes', () => {
  test('a 2027 answer carries the carry-forward warning; a 2026 answer carries none', () => {
    const a = minimumWage({ checkDate: J, state: 'WA' });
    assert.ok(a.warnings?.some((w) => /Federal minimum wage 2027 rules are provisional/.test(w)));
    assert.ok(a.warnings?.some((w) => /WA minimum wage 2027 rules are provisional/.test(w)));
    assert.equal(minimumWage({ checkDate: '2026-12-15', state: 'WA' }).warnings, undefined);
  });

  test('the local file says its ordinances are not yet updated', () => {
    const a = minimumWage({ checkDate: J, state: 'WA', locality: 'seattle' });
    assert.ok(a.warnings?.some((w) => /WA local minimum wage 2027 rules are provisional/.test(w)));
  });
});

describe('federal contractor rate', () => {
  test('EO 13658 steps to $14.05 on 2027-01-06 (Federal Register 2026-10-08)', async () => {
    const { federalMinimumWageRuleset } = await import('../src/registry.ts');
    const eo = (federalMinimumWageRuleset(J).otherFederalMinimums as { executiveOrder13658: { hourlyCents: number; effectiveFrom: string; tippedCashWageCents: number } }).executiveOrder13658;
    assert.equal(eo.hourlyCents, 1405);
    assert.equal(eo.tippedCashWageCents, 985);
    assert.equal(eo.effectiveFrom, '2027-01-06');
  });
});

describe('garnishments dated in 2027 no longer crash where the statute uses the state minimum wage', () => {
  const paycheck = (state: string) => {
    const input: PaycheckInput = {
      checkDate: J, payFrequency: 'weekly',
      earnings: [{ code: 'REG', category: 'regular', amount: 40_000 }], deductions: [],
      federalW4: { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 },
      ytd: { socialSecurity: 0, medicare: 0, futa: 0 }, workState: { code: state } as PaycheckInput['workState'],
    };
    return calculatePaycheck(input);
  };
  for (const state of ['NY', 'DC']) {
    test(`${state}: a consumer-creditor order on a 2027 check is computed against the 2027 minimum wage`, () => {
      const r = calculateGarnishments({
        checkDate: J, payFrequency: 'weekly', workState: state, paycheck: paycheck(state),
        orders: [{ id: 'o1', type: 'consumer_creditor', amountOrdered: Number.MAX_SAFE_INTEGER }],
      });
      assert.equal(r.lines.length, 1);
      assert.ok(r.lines[0].withheld >= 0);
    });
  }
});
