import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import {
  OREGON_SAVES_EMPLOYER_THRESHOLD,
  OREGON_SAVES_DEFAULT_CONTRIBUTION_RATE,
  OREGON_SAVES_MAX_CONTRIBUTION_RATE,
  OREGON_SAVES_PENALTY_PER_EMPLOYEE,
  OREGON_SAVES_MAX_PENALTY_PER_CALENDAR_YEAR,
  isOregonSavesMandatory,
  oregonSavesContributionRate,
  oregonSavesPenaltyExposure,
} from '../payroll/oregonSaves.ts';

describe('OregonSaves (payroll/oregonSaves.ts)', () => {
  test('coverage requires at least 1 employee and no qualified retirement plan, with no years-in-business test', () => {
    assert.equal(isOregonSavesMandatory(0, false), false);
    assert.equal(isOregonSavesMandatory(OREGON_SAVES_EMPLOYER_THRESHOLD, false), true);
    assert.equal(isOregonSavesMandatory(50, true), false); // has its own qualified plan
  });

  test('the contribution rate starts at 5% with zero full years enrolled', () => {
    assert.equal(oregonSavesContributionRate(0), OREGON_SAVES_DEFAULT_CONTRIBUTION_RATE);
  });

  test('the contribution rate escalates by 1 percentage point per full year enrolled', () => {
    assert.equal(oregonSavesContributionRate(1), 0.06);
    assert.equal(oregonSavesContributionRate(2), 0.07);
    assert.equal(oregonSavesContributionRate(3), 0.08);
    assert.equal(oregonSavesContributionRate(4), 0.09);
  });

  test('the contribution rate caps at 10% after five full years enrolled, never escalating further', () => {
    assert.equal(oregonSavesContributionRate(5), OREGON_SAVES_MAX_CONTRIBUTION_RATE);
    assert.equal(oregonSavesContributionRate(20), OREGON_SAVES_MAX_CONTRIBUTION_RATE);
  });

  test('penalty exposure is $100 per affected employee below the cap', () => {
    assert.equal(oregonSavesPenaltyExposure(10), 10 * OREGON_SAVES_PENALTY_PER_EMPLOYEE);
    assert.equal(oregonSavesPenaltyExposure(10), dollars(1_000));
  });

  test('penalty exposure caps at $5,000 per calendar year regardless of employee count', () => {
    assert.equal(oregonSavesPenaltyExposure(50), OREGON_SAVES_MAX_PENALTY_PER_CALENDAR_YEAR);
    assert.equal(oregonSavesPenaltyExposure(1_000), OREGON_SAVES_MAX_PENALTY_PER_CALENDAR_YEAR);
  });

  test('zero or negative affected employees carries zero exposure', () => {
    assert.equal(oregonSavesPenaltyExposure(0), 0);
    assert.equal(oregonSavesPenaltyExposure(-5), 0);
  });
});
