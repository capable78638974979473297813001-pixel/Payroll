import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';

import { calculatePaycheck } from '../src/calculate.ts';
import { statesWithRuleset } from '../src/registry.ts';
import type { PaycheckInput } from '../src/types.ts';

/**
 * Tax year 2027 is a provisional carry-forward of 2026 (started 2026-10-13,
 * before the IRS, SSA and most states publish their 2027 figures). These tests
 * pin what the carry-forward promises: full coverage, a warning on every
 * paycheck, 2026's late-year results, and only the documented 2027 changes.
 */

const pay = (checkDate: string, state: string): PaycheckInput => ({
  checkDate,
  payFrequency: 'biweekly',
  earnings: [{ code: 'REG', category: 'regular', amount: 300000 }],
  deductions: [],
  federalW4: { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 },
  ytd: { socialSecurity: 0, medicare: 0, futa: 0 },
  workState: { code: state } as PaycheckInput['workState'],
});
const amount = (r: ReturnType<typeof calculatePaycheck>, id: string) => r.taxes.find((t) => t.id === id)?.amount;

const STATES = readdirSync(new URL('../data/states', import.meta.url))
  .filter((f) => f.endsWith('-2026.json'))
  .map((f) => f.slice(0, 2));

describe('tax year 2027 (provisional)', () => {
  test('covers every state that 2026 covers', () => {
    const covered = statesWithRuleset('2027-06-11');
    for (const st of STATES) assert.ok(covered.includes(st), st);
  });

  test('every 2027 paycheck carries the provisional warning for federal and the work state', () => {
    for (const st of STATES) {
      const r = calculatePaycheck(pay('2027-06-11', st));
      assert.ok(r.warnings?.some((w) => w.startsWith('Federal 2027')), `${st}: no federal warning`);
      assert.ok(r.warnings?.some((w) => w.startsWith(`${st} 2027`)), `${st}: no state warning`);
    }
  });

  test('2026 paychecks carry no provisional warning', () => {
    const r = calculatePaycheck(pay('2026-10-16', 'IN'));
    assert.equal(r.warnings?.some((w) => /provisional/.test(w)) ?? false, false);
  });

  test("a 2027 check equals a late-2026 check in every state (2026's mid-year overlays are folded in), except Indiana's rate cut, Maine, Alaska and the figures published or enacted since", () => {
    // Maine: ME-2026 folds in MRS's August 2026 booklet (new withholding deduction and surcharge); ME-2027 still
    // carries the earlier booklet's figures until the 2027 follow-up updates it. Alaska: AK-2026's employer
    // new-employer rate was corrected to 1.00%; AK-2027 still carries 1.5% until the same follow-up.
    // Kentucky (2027 standard deduction $3,470, DOR) and Washington (2027 paid-leave premium 1.2%, employee
    // 70.7%, ESD) have published their 2027 figures; tests/audit-2026-10-25.test.ts pins those exactly.
    // North Carolina (3.49% + 0.1%), Mississippi (3.75%) and Nebraska (2027 Circular EN) have enacted or published
    // 2027 figures too; tests/state-2027-enacted.test.ts pins them.
    for (const st of STATES.filter((s) => !['IN', 'ME', 'AK', 'KY', 'WA', 'NC', 'MS', 'NE'].includes(s))) {
      const a = calculatePaycheck(pay('2026-10-16', st));
      const b = calculatePaycheck(pay('2027-01-15', st));
      assert.deepEqual(b.taxes.map((t) => [t.id, t.amount]), a.taxes.map((t) => [t.id, t.amount]), st);
    }
  });

  test('Idaho and West Virginia use their latest 2026 tables from 1 Jan 2027, not the earlier ones', () => {
    for (const st of ['ID', 'WV']) {
      const a = calculatePaycheck(pay('2026-10-16', st));
      const b = calculatePaycheck(pay('2027-01-15', st));
      assert.equal(amount(b, `${st}_SIT`), amount(a, `${st}_SIT`), st);
    }
  });

  test('Indiana: state rate falls from 2.95% to 2.9% (IC 6-3-2-1) on 1 Jan 2027', () => {
    const a = amount(calculatePaycheck(pay('2026-10-16', 'IN')), 'IN_SIT')!;
    const b = amount(calculatePaycheck(pay('2027-01-15', 'IN')), 'IN_SIT')!;
    assert.ok(b < a, `${b} should be below ${a}`);
  });

  test('Indiana 2027 county file carries Boone at its 1 Oct 2026 rate, 1.71%', async () => {
    const f = (await import('../data/local/IN-counties-2027.json', { with: { type: 'json' } })).default;
    assert.equal(f.counties.find((c: { name: string }) => c.name === 'Boone').rate, 0.0171);
    assert.equal(f.counties.find((c: { name: string }) => c.name === 'Boone').rateChanges, undefined);
  });
});
