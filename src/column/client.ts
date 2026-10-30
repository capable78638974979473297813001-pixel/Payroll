import { Buffer } from 'node:buffer';
import { BankApiError, defaultHttp, type HttpFn } from '../bankapi/types.ts';

/**
 * Column (column.com) is a bank with a public API, so Totali can send ACH
 * through it as the originating bank, for every employer whatever bank they use.
 *
 * Read from docs.column.com on 2026-10-30:
 *   Getting started   basic auth, empty username, the key as password; base https://api.column.com
 *   Create transfer   POST /transfers/ach  (fields below)
 *   Get transfer      GET  /transfers/ach/{id}
 *   Cancel transfer   POST /transfers/ach/{id}/cancel  (only while INITIATED, before it goes to the Fed)
 *   Idempotency       Idempotency-Key header; a repeat returns the first successful result and creates nothing
 *   Sandbox           the same host with a test_ key; /simulate/transfers/ach/settle and return simulation by receiver_name
 *
 * Not read, and so not relied on: webhook signing (status is polled), the full list of status meanings
 * (the docs list 16 values without defining them), and anything about how a platform is approved to originate.
 */

export interface ColumnTransferInput {
  /** Used as the Idempotency-Key, so sending the same payment twice never creates two transfers. */
  idempotencyKey: string;
  type: 'CREDIT' | 'DEBIT';
  amountCents: number;
  entryClassCode: string;
  effectiveDate: string;
  companyName: string;
  entryDescription: string;
  description: string;
  receiverName: string;
  receiverId: string;
  counterparty: { routingNumber: string; accountNumber: string; accountType: 'checking' | 'savings'; name: string };
}

export interface ColumnTransfer {
  id: string;
  status: string;
  amount?: number;
  trace_number?: string;
  return_details?: Array<{ return_code?: string | null; description?: string | null }>;
}

export class ColumnClient {
  private readonly apiKey: string;
  private readonly bankAccountId: string;
  private readonly baseUrl: string;
  private readonly http: HttpFn;

  constructor(opts: { apiKey: string; bankAccountId: string; baseUrl?: string; http?: HttpFn }) {
    this.apiKey = opts.apiKey;
    this.bankAccountId = opts.bankAccountId;
    this.baseUrl = opts.baseUrl ?? 'https://api.column.com';
    this.http = opts.http ?? defaultHttp;
  }

  get sandbox(): boolean {
    return this.apiKey.startsWith('test_');
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Basic ${Buffer.from(`:${this.apiKey}`).toString('base64')}`, accept: 'application/json', ...extra };
  }

  private static text(body: string): string {
    try {
      const j = JSON.parse(body) as { message?: string; code?: string };
      return [j.code, j.message].filter(Boolean).join(' ').slice(0, 200);
    } catch {
      return '';
    }
  }

  async createTransfer(t: ColumnTransferInput): Promise<ColumnTransfer> {
    const body = {
      bank_account_id: this.bankAccountId,
      type: t.type,
      amount: t.amountCents,
      currency_code: 'USD',
      entry_class_code: t.entryClassCode,
      effective_date: t.effectiveDate,
      same_day: false,
      company_name: t.companyName.slice(0, 16),
      company_entry_description: t.entryDescription.slice(0, 10),
      description: t.description.slice(0, 255),
      receiver_name: t.receiverName.slice(0, 22),
      receiver_id: t.receiverId.slice(0, 15),
      counterparty: { routing_number: t.counterparty.routingNumber, account_number: t.counterparty.accountNumber, account_type: t.counterparty.accountType, name: t.counterparty.name.slice(0, 127) },
    };
    const res = await this.http({ method: 'POST', url: `${this.baseUrl}/transfers/ach`, headers: this.headers({ 'content-type': 'application/json', 'idempotency-key': t.idempotencyKey }), body: JSON.stringify(body) });
    const msg = ColumnClient.text(res.body);
    if (res.status >= 200 && res.status < 300) {
      let j: ColumnTransfer;
      try { j = JSON.parse(res.body) as ColumnTransfer; } catch { throw new BankApiError('unknown', 'Column answered in a form Totali cannot read.'); }
      if (!j.id) throw new BankApiError('unknown', 'Column answered without a transfer id.');
      return j;
    }
    // Because a repeat with the same Idempotency-Key returns the first result, 'unknown' and 'not_sent' are both safe to send again.
    if (res.status === 401 || res.status === 403) throw new BankApiError('not_sent', `Column refused the API key or its permission to originate (HTTP ${res.status}). ${msg}`.trim());
    if (res.status === 429) throw new BankApiError('not_sent', 'Column asked Totali to slow down (HTTP 429).');
    if (res.status === 409) throw new BankApiError('unknown', `Column reports a conflict (HTTP 409). ${msg}`.trim());
    if (res.status >= 400 && res.status < 500) throw new BankApiError('rejected', `Column rejected this payment (HTTP ${res.status}). ${msg}`.trim());
    throw new BankApiError('unknown', `Column had a problem (HTTP ${res.status}). ${msg}`.trim());
  }

  async getTransfer(id: string): Promise<ColumnTransfer> {
    if (!/^[A-Za-z0-9_]{6,80}$/.test(id)) throw new BankApiError('unknown', 'The stored transfer id is not one Totali can look up.');
    const res = await this.http({ method: 'GET', url: `${this.baseUrl}/transfers/ach/${id}`, headers: this.headers() });
    if (res.status !== 200) throw new BankApiError('unknown', `Could not read the transfer (HTTP ${res.status}).`);
    try { return JSON.parse(res.body) as ColumnTransfer; } catch { throw new BankApiError('unknown', 'The transfer answer was not readable.'); }
  }

  /** Only works while the transfer is INITIATED. */
  async cancelTransfer(id: string): Promise<void> {
    if (!/^[A-Za-z0-9_]{6,80}$/.test(id)) throw new BankApiError('unknown', 'The stored transfer id is not one Totali can look up.');
    const res = await this.http({ method: 'POST', url: `${this.baseUrl}/transfers/ach/${id}/cancel`, headers: this.headers({ 'content-type': 'application/json' }), body: '{}' });
    if (res.status < 200 || res.status >= 300) throw new BankApiError('rejected', `Column would not cancel the transfer (HTTP ${res.status}). It may already be on its way to the Federal Reserve. ${ColumnClient.text(res.body)}`.trim());
  }
}
