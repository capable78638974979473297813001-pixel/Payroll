import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import {
  HSA_SELF_ONLY_LIMIT_2026,
  HSA_FAMILY_LIMIT_2026,
  HSA_CATCH_UP_LIMIT_2026,
  HEALTH_FSA_LIMIT_2026,
  DEPENDENT_CARE_FSA_LIMIT_2026,
  DEPENDENT_CARE_FSA_LIMIT_MFS_2026,
  hsaContributionLimit,
  remainingHsaContributionRoom,
  cappedHsaContributionForPayPeriod,
  remainingHealthFsaRoom,
  cappedHealthFsaContributionForPayPeriod,
  dependentCareFsaLimit,
  remainingDependentCareFsaRoom,
  cappedDependentCareFsaContributionForPayPeriod,
} from '../payroll/hsaFsaLimits.ts';

describe('HSA/FSA contribution limits (payroll/hsaFsaLimits.ts)', () => {
  test('HSA limit is the self-only or family base figure with no catch-up under 55', () => {
    assert.equal(hsaContributionLimit('self_only', 40), HSA_SELF_ONLY_LIMIT_2026);
    assert.equal(hsaContributionLimit('family', 40), HSA_FAMILY_LIMIT_2026);
  });

  test('the 55+ catch-up adds to the base limit with no upper age cutoff', () => {
    assert.equal(hsaContributionLimit('self_only', 55), HSA_SELF_ONLY_LIMIT_2026 + HSA_CATCH_UP_LIMIT_2026);
    assert.equal(hsaContributionLimit('family', 80), HSA_FAMILY_LIMIT_2026 + HSA_CATCH_UP_LIMIT_2026);
    assert.equal(hsaContributionLimit('self_only', 54), HSA_SELF_ONLY_LIMIT_2026); // one year short, no catch-up
  });

  test('remaining HSA room is the limit minus YTD, never negative', () => {
    assert.equal(remainingHsaContributionRoom(dollars(1_000), 'self_only', 40), HSA_SELF_ONLY_LIMIT_2026 - dollars(1_000));
    assert.equal(remainingHsaContributionRoom(HSA_FAMILY_LIMIT_2026 + dollars(500), 'family', 40), 0);
  });

  test('a requested HSA contribution is capped to remaining room', () => {
    assert.equal(cappedHsaContributionForPayPeriod(dollars(500), HSA_SELF_ONLY_LIMIT_2026 - dollars(200), 'self_only', 40), dollars(200));
    assert.equal(cappedHsaContributionForPayPeriod(dollars(100), dollars(0), 'self_only', 40), dollars(100));
  });

  test('health FSA room does not depend on age or coverage tier', () => {
    assert.equal(remainingHealthFsaRoom(dollars(1_000)), HEALTH_FSA_LIMIT_2026 - dollars(1_000));
    assert.equal(remainingHealthFsaRoom(HEALTH_FSA_LIMIT_2026 + dollars(1)), 0);
  });

  test('a requested health FSA contribution is capped to remaining room', () => {
    assert.equal(cappedHealthFsaContributionForPayPeriod(dollars(200), HEALTH_FSA_LIMIT_2026 - dollars(100)), dollars(100));
  });

  test('dependent-care FSA limit is halved for married filing separately', () => {
    assert.equal(dependentCareFsaLimit(false), DEPENDENT_CARE_FSA_LIMIT_2026);
    assert.equal(dependentCareFsaLimit(true), DEPENDENT_CARE_FSA_LIMIT_MFS_2026);
    assert.equal(DEPENDENT_CARE_FSA_LIMIT_MFS_2026 * 2, DEPENDENT_CARE_FSA_LIMIT_2026);
  });

  test('remaining and capped dependent-care FSA room respect the filing-status-specific limit', () => {
    assert.equal(remainingDependentCareFsaRoom(dollars(1_000), false), DEPENDENT_CARE_FSA_LIMIT_2026 - dollars(1_000));
    assert.equal(remainingDependentCareFsaRoom(dollars(1_000), true), DEPENDENT_CARE_FSA_LIMIT_MFS_2026 - dollars(1_000));
    assert.equal(cappedDependentCareFsaContributionForPayPeriod(dollars(5_000), DEPENDENT_CARE_FSA_LIMIT_MFS_2026 - dollars(500), true), dollars(500));
  });
});
