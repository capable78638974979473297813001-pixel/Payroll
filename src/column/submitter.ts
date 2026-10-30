import { BankApiError } from '../bankapi/types.ts';
import type { AchSubmitter, EntryResult, ExternalStatus, SubmitInput, SubmitResult } from '../ach/submitter.ts';
import type { ColumnClient } from './client.ts';

/** Column's status values, grouped by what Totali does about each. The docs list these 16 without defining them: the groups follow their names. */
const IN_FLIGHT = new Set(['INITIATED', 'PENDING_SUBMISSION', 'SUBMITTED', 'SCHEDULED', 'PENDING_RETURN']);
const HELD = new Set(['PRE_REVIEW', 'HOLD', 'MANUAL_REVIEW', 'MANUAL_REVIEW_APPROVED']);
const SETTLED = new Set(['SETTLED', 'COMPLETED']);
const RETURNED = new Set(['RETURNED']);
const NEEDS_REVIEW = new Set(['RETURN_CONTESTED', 'RETURN_DISHONORED', 'RETURN_DISHONORED_FUNDS_UNLOCKED']);

export function mapColumnStatus(status: string): ExternalStatus['state'] {
  if (SETTLED.has(status)) return 'settled';
  if (RETURNED.has(status)) return 'returned';
  if (status === 'CANCELED') return 'cancelled';
  if (HELD.has(status)) return 'held';
  if (NEEDS_REVIEW.has(status)) return 'needs_review';
  if (IN_FLIGHT.has(status)) return 'in_flight';
  return 'needs_review'; // a status Totali does not know is never assumed to be fine
}

/**
 * Sends each payment in a file to Column as its own ACH transfer.
 *
 * Every payment carries an Idempotency-Key made from the file and the payment,
 * and Column returns the first result for a repeated key. So when an answer is
 * lost, sending it again cannot pay twice. A payment Column refuses is failed
 * on its own; the others go ahead.
 */
export class ColumnSubmitter implements AchSubmitter {
  readonly name = 'column';
  private readonly client: ColumnClient;

  constructor(client: ColumnClient) {
    this.client = client;
  }

  async submit(f: SubmitInput): Promise<SubmitResult> {
    const results: Record<string, EntryResult> = {};
    let stopped: string | undefined;
    for (const e of f.entries) {
      if (e.externalId) {
        results[e.ref] = { state: 'accepted', externalId: e.externalId };
        continue;
      }
      if (stopped) {
        results[e.ref] = { state: 'retry' };
        continue;
      }
      const debit = e.kind === 'debit' || e.kind === 'prenote_debit';
      try {
        const t = await this.client.createTransfer({
          idempotencyKey: `totali:${f.fileId}:${e.ref}`,
          type: debit ? 'DEBIT' : 'CREDIT',
          amountCents: e.amountCents,
          entryClassCode: e.standardEntryClass,
          effectiveDate: f.effectiveDate,
          companyName: f.companyName,
          entryDescription: f.description,
          description: `Totali ${f.fileId} ${e.ref}`,
          receiverName: e.name,
          receiverId: e.individualId,
          counterparty: { routingNumber: e.routingNumber, accountNumber: e.accountNumber, accountType: e.accountType, name: e.name },
        });
        results[e.ref] = { state: 'accepted', externalId: t.id, externalStatus: t.status, ...(t.trace_number ? { traceNumber: t.trace_number } : {}) };
      } catch (err) {
        if (err instanceof BankApiError && err.outcome === 'rejected') {
          results[e.ref] = { state: 'rejected', message: err.message };
        } else {
          const message = err instanceof BankApiError ? err.message : 'Unexpected error while sending.';
          results[e.ref] = { state: 'retry', message };
          stopped = message;
        }
      }
    }
    const all = Object.values(results);
    const retry = all.filter((r) => r.state === 'retry').length;
    const accepted = all.filter((r) => r.state === 'accepted').length;
    const rejected = all.filter((r) => r.state === 'rejected').length;
    const summary = `${accepted} accepted by Column, ${rejected} rejected, ${retry} still to send`;
    if (retry > 0) return { status: 'queued', message: `${summary}. ${stopped ?? ''} Totali will try again.`.trim(), entries: results };
    if (accepted === 0) return { status: 'rejected', message: `Column rejected every payment. ${all[0]?.message ?? ''}`.trim(), entries: results };
    return { status: 'accepted', message: summary, entries: results };
  }

  async status(externalId: string): Promise<ExternalStatus> {
    const t = await this.client.getTransfer(externalId);
    const state = mapColumnStatus(t.status);
    const code = t.return_details?.find((r) => r.return_code)?.return_code ?? undefined;
    return { state, detail: t.status, ...(code ? { returnCode: code } : {}), ...(t.trace_number ? { traceNumber: t.trace_number } : {}), ...(typeof t.amount === 'number' ? { amountCents: t.amount } : {}) };
  }
}
