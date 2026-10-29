import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  CA_BEREAVEMENT_LEAVE_EMPLOYER_THRESHOLD,
  CA_BEREAVEMENT_LEAVE_MIN_TENURE_DAYS,
  CA_BEREAVEMENT_LEAVE_DAYS,
  isCaBereavementLeaveEmployerCovered,
  isCaBereavementLeaveEligible,
  caBereavementLeaveCompletionDeadline,
  isCaBereavementLeaveTimely,
  caBereavementDocumentationRequestDeadline,
  caBereavementLeavePaidDays,
  caBereavementLeaveUnpaidDays,
} from '../payroll/caBereavementLeave.ts';

describe('California bereavement leave (payroll/caBereavementLeave.ts)', () => {
  test('an employer is covered at exactly 5 employees', () => {
    assert.equal(isCaBereavementLeaveEmployerCovered(4), false);
    assert.equal(isCaBereavementLeaveEmployerCovered(CA_BEREAVEMENT_LEAVE_EMPLOYER_THRESHOLD), true);
  });

  test('an employee is eligible at exactly 30 days of tenure before the leave starts', () => {
    assert.equal(isCaBereavementLeaveEligible(29), false);
    assert.equal(isCaBereavementLeaveEligible(CA_BEREAVEMENT_LEAVE_MIN_TENURE_DAYS), true);
  });

  test('the completion deadline is 3 calendar months after the date of death', () => {
    assert.equal(caBereavementLeaveCompletionDeadline('2026-03-15'), '2026-06-15');
  });

  test('leave taken on or before the completion deadline is timely; after it is not', () => {
    assert.equal(isCaBereavementLeaveTimely('2026-03-15', '2026-06-15'), true);
    assert.equal(isCaBereavementLeaveTimely('2026-03-15', '2026-06-16'), false);
    assert.equal(isCaBereavementLeaveTimely('2026-03-15', '2026-04-01'), true); // need not be taken consecutively or immediately
  });

  test('the documentation request window is 30 days from the first day of leave', () => {
    assert.equal(caBereavementDocumentationRequestDeadline('2026-04-01'), '2026-05-01');
  });

  test('paid days owed is whatever the existing policy already pays, capped at 5', () => {
    assert.equal(caBereavementLeavePaidDays(0), 0);
    assert.equal(caBereavementLeavePaidDays(3), 3);
    assert.equal(caBereavementLeavePaidDays(CA_BEREAVEMENT_LEAVE_DAYS), CA_BEREAVEMENT_LEAVE_DAYS);
    assert.equal(caBereavementLeavePaidDays(10), CA_BEREAVEMENT_LEAVE_DAYS); // a more generous policy doesn't create MORE mandated paid days
    assert.equal(caBereavementLeavePaidDays(-1), 0); // never negative
  });

  test('unpaid days owed makes up the difference to reach 5 total days', () => {
    assert.equal(caBereavementLeaveUnpaidDays(0), 5);
    assert.equal(caBereavementLeaveUnpaidDays(3), 2);
    assert.equal(caBereavementLeaveUnpaidDays(CA_BEREAVEMENT_LEAVE_DAYS), 0);
    assert.equal(caBereavementLeaveUnpaidDays(10), 0); // a fully-paid 5+ day policy leaves nothing unpaid
  });
});
