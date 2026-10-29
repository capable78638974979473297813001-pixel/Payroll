import { randomUUID } from 'node:crypto';
import { usePto } from './pto.ts';
import type { PtoBalance } from './pto.ts';

/**
 * The employee-facing side of PTO: a REQUEST an employee submits, that
 * sits PENDING until a manager/admin decides it, rather than
 * payroll/pto.ts's own usePto() applying instantly with no review step
 * at all. Real time-off in a real company is a request-and-approval
 * workflow, not an instant self-service withdrawal — this module is that
 * workflow; usePto() itself stays exactly what it was (the balance
 * arithmetic), called here only at the moment of approval, never at the
 * moment of request.
 *
 * SCOPE: a single pending -> approved|denied|cancelled state machine, no
 * multi-level approval chain, no calendar/team-coverage conflict check
 * (whether two people on the same team requested the same week) — real,
 * separate features a full HCM's time-off module builds, not modelled
 * here. Cancellation is only possible while a request is still PENDING:
 * withdrawing an already-APPROVED request would need to refund hours
 * back to the balance, a real feature this module doesn't attempt, the
 * same "disclosed, not built" choice this project makes elsewhere rather
 * than guessing at a policy (does the employer allow it? on what notice?)
 * nothing here has been told.
 */

export type PtoRequestStatus = 'pending' | 'approved' | 'denied' | 'cancelled';

export interface PtoRequest {
  id: string;
  employeeId: string;
  policyId: string;
  hoursRequested: number;
  /** The time off itself, not the request date — when the employee will actually be out. */
  startDate: string;
  endDate: string;
  requestedAt: string;
  status: PtoRequestStatus;
  reviewedBy?: string;
  reviewedAt?: string;
  denialReason?: string;
}

export function createPtoRequest(
  employeeId: string,
  policyId: string,
  hoursRequested: number,
  startDate: string,
  endDate: string,
  requestedAt: string,
): PtoRequest {
  if (hoursRequested <= 0) {
    throw new Error('A PTO request must be for a positive number of hours');
  }
  if (endDate < startDate) {
    throw new Error(`PTO request end date ${endDate} is before its own start date ${startDate}`);
  }
  return { id: randomUUID(), employeeId, policyId, hoursRequested, startDate, endDate, requestedAt, status: 'pending' };
}

export interface PtoRequestApprovalResult {
  request: PtoRequest;
  balance: PtoBalance;
  /** False when the balance can't cover the full request — the request is left PENDING (not silently denied), so a manager can either deny it outright or wait for more accrual, the same "never partially grant, never guess the right response" discipline usePto() itself uses. */
  approved: boolean;
  shortfallHours: number;
}

export function approvePtoRequest(request: PtoRequest, balance: PtoBalance, reviewedBy: string, reviewedAt: string): PtoRequestApprovalResult {
  if (request.status !== 'pending') {
    throw new Error(`Cannot approve PTO request ${request.id}: it is already "${request.status}"`);
  }
  const usage = usePto(balance, request.hoursRequested);
  if (!usage.approved) {
    return { request, balance, approved: false, shortfallHours: usage.shortfallHours };
  }
  return {
    request: { ...request, status: 'approved', reviewedBy, reviewedAt },
    balance: usage.balance,
    approved: true,
    shortfallHours: 0,
  };
}

export function denyPtoRequest(request: PtoRequest, reviewedBy: string, reviewedAt: string, reason?: string): PtoRequest {
  if (request.status !== 'pending') {
    throw new Error(`Cannot deny PTO request ${request.id}: it is already "${request.status}"`);
  }
  return { ...request, status: 'denied', reviewedBy, reviewedAt, denialReason: reason };
}

/** Withdraws a request before it's been decided — see this module's own header on why an already-approved request can't be cancelled here. */
export function cancelPtoRequest(request: PtoRequest): PtoRequest {
  if (request.status !== 'pending') {
    throw new Error(`Cannot cancel PTO request ${request.id}: it is already "${request.status}", not pending`);
  }
  return { ...request, status: 'cancelled' };
}
