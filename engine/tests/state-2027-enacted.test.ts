import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { calculatePaycheck } from '../src/calculate.ts';
import type { PaycheckInput } from '../src/types.ts';

/**
 * 2027 figures that are already fixed by enacted law or a published 2027 employer
 * guide, checked 2026-10-25: North Carolina (S.L. 2026-41), Mississippi (H.B. 1,
 * 2025), Nebraska (2027 Circular EN). Each test compares against a hand calculation
 * from the source's own formula, and against the unchanged 2026 result.
 */

const pay = (checkDate: string, state: string, payFrequency: PaycheckInput['payFrequency'], amount: number, certificate: Record<string, unknown> = {}): PaycheckInput => ({
  checkDate,
  payFrequency,
  earnings: [{ code: 'REG', category: 'regular', amount }],
  deductions: [],
  federalW4: { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 },
  ytd: { socialSecurity: 0, medicare: 0, futa: 0 },
  workState: { code: state, certificate } as PaycheckInput['workState'],
});
const sit = (r: ReturnType<typeof calculatePaycheck>, id: string) => r.taxes.find((t) => t.id === id)?.amount;
const file = (name: string) => JSON.parse(readFileSync(new URL(`../data/states/${name}.json`, import.meta.url), 'utf8'));

describe('North Carolina 2027 (S.L. 2026-41: income tax 3.49% + 0.1% withholding add-on)', () => {
  test('withholds at 3.59% in 2027 and still 4.09% in 2026', () => {
    // $3,000 biweekly: 78,000 - 12,750 standard deduction = 65,250
    assert.equal(sit(calculatePaycheck(pay('2026-12-15', 'NC', 'biweekly', 300_000)), 'NC_SIT'), 10_300); // 65,250 x 4.09% / 26 = 102.64 -> $103
    assert.equal(sit(calculatePaycheck(pay('2027-01-15', 'NC', 'biweekly', 300_000)), 'NC_SIT'), 9_000); // 65,250 x 3.59% / 26 = 90.10 -> $90
  });

  test('the flat supplemental rate follows, and the file records the source', () => {
    const f = file('NC-2027');
    assert.equal(f.flatRateStatusDeduction.rate, 0.0359);
    assert.equal(f.supplementalWages.flatRate, 0.0359);
    assert.match(JSON.stringify(f.provisional.updatedFor2027), /S\.L\. 2026-41/);
  });
});

describe('Mississippi 2027 (Build-Up Mississippi Act: 3.75% above $10,000)', () => {
  test('3.75% in 2027, 4.0% in 2026', () => {
    // $3,000 biweekly: 78,000 - 2,300 = 75,700; excess over 10,000 = 65,700
    assert.equal(sit(calculatePaycheck(pay('2026-12-15', 'MS', 'biweekly', 300_000)), 'MS_SIT'), 10_100); // 65,700 x 4.0% / 26 = 101.08 -> $101
    assert.equal(sit(calculatePaycheck(pay('2027-01-15', 'MS', 'biweekly', 300_000)), 'MS_SIT'), 9_500); // 65,700 x 3.75% / 26 = 94.76 -> $95
  });
});

describe('Nebraska 2027 (Circular EN for wages paid on or after 2027-01-01)', () => {
  test('single weekly $1,000, no allowances: $24.66 + 3.93% of the excess over $794', () => {
    const r = calculatePaycheck(pay('2027-01-15', 'NE', 'weekly', 100_000));
    assert.equal(sit(r, 'NE_SIT'), 3_276); // 24.66 + 0.0393 x 206 = 32.76
  });

  test('married biweekly $3,000 with 2 allowances ($96.54 each): $73.65 + 3.93% of the excess over $2,476', () => {
    const r = calculatePaycheck(pay('2027-01-15', 'NE', 'biweekly', 300_000, { maritalStatus: 'married', allowances: 2 }));
    // 3,000 - 193.08 = 2,806.92; 73.65 + 0.0393 x 330.92 = 86.655 -> 86.66
    assert.equal(sit(r, 'NE_SIT'), 8_666);
  });

  test('the same single check in 2026 still uses the 2026 Circular EN', () => {
    assert.equal(sit(calculatePaycheck(pay('2026-12-15', 'NE', 'weekly', 100_000)), 'NE_SIT'), 3_606);
  });

  test('every 2027 table row is continuous (each base is the previous base plus width x rate)', () => {
    const b = file('NE-2027').bracketPerPeriodAllowance.brackets;
    for (const status of ['single', 'married']) {
      for (const [period, rows] of Object.entries<Array<{ from: number; to: number | null; base: number; rate: number }>>(b[status])) {
        assert.equal(rows.length, 7, `${status} ${period}`);
        for (let i = 1; i < rows.length - 1; i++) {
          const expected = rows[i].base + (rows[i].to! - rows[i].from) * rows[i].rate;
          assert.ok(Math.abs(expected - rows[i + 1].base) <= 0.6, `${status} ${period} row ${i}: ${expected} vs ${rows[i + 1].base}`);
        }
      }
    }
  });
});

describe('enacted 2027 changes that cannot be applied yet are recorded, not silently ignored', () => {
  for (const st of ['MT', 'GA', 'HI', 'SC']) {
    test(`${st}-2027 lists its pending statutory change and what is missing`, () => {
      const pending = file(`${st}-2027`).provisional.pendingStatutoryChanges;
      assert.ok(Array.isArray(pending) && pending.length > 0, st);
      for (const p of pending) assert.match(p.status, /^NOT APPLIED/);
    });
  }
});

describe('2027 state unemployment wage bases published by the state or fixed by statute', () => {
  const expected: Record<string, number> = { CO: 32_100, NV: 45_400, OK: 24_400, IL: 14_592, DE: 16_500, IA: 21_100, NJ: 46_400 };
  for (const [st, base] of Object.entries(expected)) {
    test(`${st}: employer unemployment tax on a $300,000 month is capped at $${base.toLocaleString('en-US')}`, () => {
      const r = calculatePaycheck(pay('2027-01-15', st, 'monthly', 30_000_000));
      const sui = r.taxes.find((t) => t.id === `${st}_SUI_ER`);
      assert.ok(sui, `${st} has no employer SUI line`);
      assert.match(String(sui.detail), new RegExp(`^\\$${base}\\.00 @`));
    });
  }

  test('the 2026 base is unchanged on a December 2026 check', () => {
    const r = calculatePaycheck(pay('2026-12-15', 'CO', 'monthly', 30_000_000));
    assert.match(String(r.taxes.find((t) => t.id === 'CO_SUI_ER')?.detail), /^\$30600\.00 @/);
  });

  test('Washington, Wyoming: the 2027 file carries the published base', () => {
    assert.equal(file('WA-2027').suiEmployer.wageBase, 82_000);
    assert.equal(file('WY-2027').suiEmployer.wageBase, 34_900);
  });

  test('New Jersey worker-side bases move too (UI/WF $46,400; TDI and FLI $177,100)', () => {
    const nj = file('NJ-2027');
    assert.equal(nj.stateUnemploymentEmployee.wageBase, 46_400);
    assert.equal(nj.stateDisabilityEmployee.wageBase, 177_100);
    assert.equal(nj.statePaidLeaveEmployee.wageBase, 177_100);
  });
});
