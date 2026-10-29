import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { emptyPtoBalance } from '../payroll/pto.ts';
import { approvePtoRequest, cancelPtoRequest, createPtoRequest, denyPtoRequest } from '../payroll/ptoRequest.ts';

function balanceWith(hours: number) {
  return { ...emptyPtoBalance('e1', 'policy-1'), balanceHours: hours };
}

describe('creating a PTO request (payroll/ptoRequest.ts)', () => {
  test('a fresh request starts pending', () => {
    const request = createPtoRequest('e1', 'policy-1', 8, '2026-07-01', '2026-07-01', '2026-06-01');
    assert.equal(request.status, 'pending');
    assert.equal(request.employeeId, 'e1');
    assert.equal(request.hoursRequested, 8);
  });

  test('refuses a non-positive hours request', () => {
    assert.throws(() => createPtoRequest('e1', 'policy-1', 0, '2026-07-01', '2026-07-01', '2026-06-01'));
    assert.throws(() => createPtoRequest('e1', 'policy-1', -5, '2026-07-01', '2026-07-01', '2026-06-01'));
  });

  test('refuses an end date before its own start date', () => {
    assert.throws(() => createPtoRequest('e1', 'policy-1', 8, '2026-07-05', '2026-07-01', '2026-06-01'), /before its own start date/);
  });
});

describe('approving a PTO request (payroll/ptoRequest.ts)', () => {
  test('a request fully covered by the balance is approved and the balance is deducted', () => {
    const request = createPtoRequest('e1', 'policy-1', 8, '2026-07-01', '2026-07-01', '2026-06-01');
    const result = approvePtoRequest(request, balanceWith(40), 'admin', '2026-06-02');
    assert.equal(result.approved, true);
    assert.equal(result.request.status, 'approved');
    assert.equal(result.request.reviewedBy, 'admin');
    assert.equal(result.request.reviewedAt, '2026-06-02');
    assert.equal(result.balance.balanceHours, 32);
  });

  test('a request exceeding the balance stays PENDING rather than being silently denied, and the balance is untouched', () => {
    const request = createPtoRequest('e1', 'policy-1', 50, '2026-07-01', '2026-07-01', '2026-06-01');
    const result = approvePtoRequest(request, balanceWith(40), 'admin', '2026-06-02');
    assert.equal(result.approved, false);
    assert.equal(result.shortfallHours, 10);
    assert.equal(result.request.status, 'pending');
    assert.equal(result.balance.balanceHours, 40);
  });

  test('refuses to approve a request that is not pending', () => {
    const request = createPtoRequest('e1', 'policy-1', 8, '2026-07-01', '2026-07-01', '2026-06-01');
    const approved = { ...request, status: 'approved' as const };
    assert.throws(() => approvePtoRequest(approved, balanceWith(40), 'admin', '2026-06-02'), /already "approved"/);
  });
});

describe('denying a PTO request (payroll/ptoRequest.ts)', () => {
  test('a denial records who denied it, when, and an optional reason', () => {
    const request = createPtoRequest('e1', 'policy-1', 8, '2026-07-01', '2026-07-01', '2026-06-01');
    const denied = denyPtoRequest(request, 'admin', '2026-06-02', 'Blackout week for the team');
    assert.equal(denied.status, 'denied');
    assert.equal(denied.reviewedBy, 'admin');
    assert.equal(denied.denialReason, 'Blackout week for the team');
  });

  test('refuses to deny a request that is not pending', () => {
    const request = createPtoRequest('e1', 'policy-1', 8, '2026-07-01', '2026-07-01', '2026-06-01');
    const cancelled = { ...request, status: 'cancelled' as const };
    assert.throws(() => denyPtoRequest(cancelled, 'admin', '2026-06-02'), /already "cancelled"/);
  });
});

describe('cancelling a PTO request (payroll/ptoRequest.ts)', () => {
  test('a pending request can be cancelled', () => {
    const request = createPtoRequest('e1', 'policy-1', 8, '2026-07-01', '2026-07-01', '2026-06-01');
    const cancelled = cancelPtoRequest(request);
    assert.equal(cancelled.status, 'cancelled');
  });

  test('an already-approved request cannot be cancelled here — withdrawing it would need to refund hours, which this module does not attempt', () => {
    const request = createPtoRequest('e1', 'policy-1', 8, '2026-07-01', '2026-07-01', '2026-06-01');
    const approved = { ...request, status: 'approved' as const };
    assert.throws(() => cancelPtoRequest(approved), /already "approved", not pending/);
  });
});
