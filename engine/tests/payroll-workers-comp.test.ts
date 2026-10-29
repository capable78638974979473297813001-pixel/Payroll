import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import { STATES_NOT_EXCLUDING_OVERTIME_PREMIUM, workersCompPremium, workersCompSubjectWages } from '../payroll/workersComp.ts';

describe('workers\' comp subject wages / overtime premium exclusion (payroll/workersComp.ts)', () => {
  test('excludes the overtime premium portion in an ordinary state', () => {
    // $3,000 gross, $60 of which is the "extra half" premium on overtime hours.
    const subject = workersCompSubjectWages(dollars(3_000), dollars(60), 'TX');
    assert.equal(subject, dollars(2_940));
  });

  test('does NOT exclude the overtime premium in Pennsylvania or Delaware', () => {
    assert.equal(workersCompSubjectWages(dollars(3_000), dollars(60), 'PA'), dollars(3_000));
    assert.equal(workersCompSubjectWages(dollars(3_000), dollars(60), 'DE'), dollars(3_000));
  });

  test('the exception set contains exactly PA and DE', () => {
    assert.equal(STATES_NOT_EXCLUDING_OVERTIME_PREMIUM.has('PA'), true);
    assert.equal(STATES_NOT_EXCLUDING_OVERTIME_PREMIUM.has('DE'), true);
    assert.equal(STATES_NOT_EXCLUDING_OVERTIME_PREMIUM.has('TX'), false);
    assert.equal(STATES_NOT_EXCLUDING_OVERTIME_PREMIUM.size, 2);
  });

  test('zero overtime premium leaves subject wages equal to gross wages', () => {
    assert.equal(workersCompSubjectWages(dollars(3_000), 0, 'TX'), dollars(3_000));
  });
});

describe('workers\' comp premium calculation (payroll/workersComp.ts)', () => {
  test('matches the standard hand-computed formula: (payroll / 100) x rate x ex-mod', () => {
    // $3,000 subject payroll, $3.50 per $100 rate, ex-mod 1.0 -> 30 x $3.50 = $105.00
    const premium = workersCompPremium(dollars(3_000), dollars(3.5), 1.0);
    assert.equal(premium, dollars(105));
  });

  test('an experience mod above 1.0 increases the premium proportionally', () => {
    // Same as above but a 1.2 ex-mod (a worse-than-average claims history) -> $126.00
    const premium = workersCompPremium(dollars(3_000), dollars(3.5), 1.2);
    assert.equal(premium, dollars(126));
  });

  test('an experience mod below 1.0 (a better-than-average claims history) decreases the premium', () => {
    const premium = workersCompPremium(dollars(3_000), dollars(3.5), 0.8);
    assert.equal(premium, dollars(84));
  });

  test('zero subject payroll produces zero premium', () => {
    assert.equal(workersCompPremium(0, dollars(3.5), 1.0), 0);
  });
});
