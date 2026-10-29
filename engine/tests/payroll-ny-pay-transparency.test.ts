import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  NY_PAY_TRANSPARENCY_EMPLOYER_THRESHOLD,
  NY_PAY_TRANSPARENCY_FIRST_VIOLATION_PENALTY,
  NY_PAY_TRANSPARENCY_SECOND_VIOLATION_PENALTY,
  NY_PAY_TRANSPARENCY_THIRD_OR_SUBSEQUENT_VIOLATION_PENALTY,
  isNyPayTransparencyRequired,
  nyPayTransparencyPenaltyForViolationNumber,
} from '../payroll/nyPayTransparency.ts';

describe('New York pay transparency law (payroll/nyPayTransparency.ts)', () => {
  test('coverage requires 4+ employees', () => {
    assert.equal(isNyPayTransparencyRequired(3), false);
    assert.equal(isNyPayTransparencyRequired(NY_PAY_TRANSPARENCY_EMPLOYER_THRESHOLD), true);
  });

  test('the first violation carries a $1,000 penalty', () => {
    assert.equal(nyPayTransparencyPenaltyForViolationNumber(1), NY_PAY_TRANSPARENCY_FIRST_VIOLATION_PENALTY);
  });

  test('the second violation carries a $2,000 penalty', () => {
    assert.equal(nyPayTransparencyPenaltyForViolationNumber(2), NY_PAY_TRANSPARENCY_SECOND_VIOLATION_PENALTY);
  });

  test('the third violation and every one after it carry a flat $3,000 penalty, never escalating further', () => {
    assert.equal(nyPayTransparencyPenaltyForViolationNumber(3), NY_PAY_TRANSPARENCY_THIRD_OR_SUBSEQUENT_VIOLATION_PENALTY);
    assert.equal(nyPayTransparencyPenaltyForViolationNumber(4), NY_PAY_TRANSPARENCY_THIRD_OR_SUBSEQUENT_VIOLATION_PENALTY);
    assert.equal(nyPayTransparencyPenaltyForViolationNumber(50), NY_PAY_TRANSPARENCY_THIRD_OR_SUBSEQUENT_VIOLATION_PENALTY);
  });

  test('a violation number below 1 carries no penalty', () => {
    assert.equal(nyPayTransparencyPenaltyForViolationNumber(0), 0);
    assert.equal(nyPayTransparencyPenaltyForViolationNumber(-1), 0);
  });
});
