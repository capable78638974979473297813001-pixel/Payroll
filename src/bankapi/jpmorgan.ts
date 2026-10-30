import { createHash, createSign, randomUUID } from 'node:crypto';
import { BankApiError, defaultHttp, type ApiCredentials, type ApiPaymentState, type BankApiAdapter, type CreditInstruction, type HttpFn, type SendResult } from './types.ts';

/**
 * J.P. Morgan Payments, "Global Payments 2" ACH API.
 *
 * Read from developer.payments.jpmorgan.com on 2026-10-30:
 *   OAuth      https://developer.payments.jpmorgan.com/api/oauth
 *   Initiate   .../global-payments-2/ach/how-to/initiate-ach-payment
 *   Parameters .../global-payments-2/ach/payment-parameters-credit
 *   Status     .../global-payments-2/ach/how-to/get-ach-request-status and .../ach/error-codes
 *   Callbacks  .../global-payments-2/callbacks
 *
 * Known gaps, none of which this code papers over:
 *  - Never run against J.P. Morgan. Onboarding, certificates and a client-testing
 *    environment come from the employer's J.P. Morgan relationship.
 *  - The docs show no state for "waiting for the client to release" and no cancel call. A payment
 *    sent here is accepted for execution, so approval happens in Totali, before the call.
 *  - The docs say mTLS with a digital signature "may be required depending on the capability". Whether
 *    ACH needs it is not stated, and this adapter does neither.
 *  - Callbacks (webhooks) need an implementation request with the bank; status is polled instead.
 */

const LOGIN = 'https://login.jpmorgan.com/oauth2/token';
const PRODUCTION = 'https://api.payments.jpmorgan.com';

const PATH = '/payment/v2/payments';

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export const dollarString = (cents: number) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

/** 1-15 letters and digits, unique per payment for 60 days. Derived from the leg so the same payment always has the same id. */
export const endToEndIdFor = (legId: string) => createHash('sha256').update(`totali:e2e:${legId}`).digest('hex').slice(0, 15).toUpperCase();

/** The same payment always sends the same Idempotency-Key. */
export function idempotencyKeyFor(legId: string): string {
  const h = createHash('sha256').update(`totali:idem:${legId}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x40;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** Names go to an ACH network: ASCII letters, digits and a few marks, at most 22 characters. */
export function achName(name: string, max: number): string {
  const clean = name.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/[^A-Za-z0-9 .,&'-]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
  return (clean || 'EMPLOYEE').slice(0, max);
}

export function clientAssertion(creds: ApiCredentials, nowSeconds: number, audience = LOGIN): string {
  const header = { alg: 'RS256', typ: 'JWT', kid: creds.certThumbprint };
  const claims = { iss: creds.clientId, sub: creds.clientId, aud: audience, iat: nowSeconds, nbf: nowSeconds, exp: nowSeconds + 30, jti: randomUUID() };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = createSign('RSA-SHA256').update(input).sign(creds.privateKeyPem);
  return `${input}.${b64url(sig)}`;
}

export function creditBody(creds: ApiCredentials, i: CreditInstruction) {
  return {
    requestedExecutionDate: i.effectiveDate,
    paymentIdentifiers: { endToEndId: endToEndIdFor(i.legId) },
    value: { currency: 'USD', amount: dollarString(i.amountCents) },
    transferType: 'CREDIT',
    paymentType: 'ACH',
    paymentTypeInformation: { serviceLevelCode: 'NURG', localInstrumentCode: { code: 'PPD' } },
    debtor: { name: achName(creds.debtor.name, 16), account: { accountNumber: creds.debtor.accountNumber, accountCurrency: 'USD', companyId: creds.debtor.companyId }, postalAddress: { country: 'US' } },
    debtorAgent: { financialInstitutionIds: [{ id: creds.debtor.routingNumber, idType: 'USABA' }], postalAddress: { country: 'US' } },
    creditorAgent: { financialInstitutionIds: [{ id: i.routingNumber, idType: 'USABA' }], postalAddress: { country: 'US' } },
    creditor: { name: achName(i.recipientName, 22), account: { accountNumber: i.accountNumber, accountType: i.accountType === 'savings' ? 'SVGS' : 'CACC' }, postalAddress: { country: 'US' } },
    paymentPurpose: { categoryPurpose: { proprietary: 'PAYROLL' } },
  };
}

export function mapStatus(status: unknown, sub: unknown): ApiPaymentState {
  switch (status) {
    case 'ACCEPTED': return 'accepted';
    case 'COMPLETED': return 'completed';
    case 'REJECTED': return 'rejected';
    case 'RETURNED': return 'returned';
    case 'PROCESSING': return sub === 'PENDING_CLIENT_ACTION' ? 'held_for_client' : 'processing';
    default: return 'processing';
  }
}

/** The bank's own error text, cut short. Never the request, which holds account numbers. */
function bankMessage(body: string): string {
  try {
    const j = JSON.parse(body) as { errors?: Array<{ errorCode?: string; errorMessage?: string }>; message?: string };
    const first = j.errors?.[0];
    if (first) return `${first.errorCode ?? ''} ${first.errorMessage ?? ''}`.trim().slice(0, 200);
    if (j.message) return String(j.message).slice(0, 200);
  } catch { /* not JSON */ }
  return '';
}

export class JpMorganAdapter implements BankApiAdapter {
  readonly id = 'jpmorgan';
  private readonly http: HttpFn;
  private readonly now: () => Date;
  private tokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(opts: { http?: HttpFn; now?: () => Date } = {}) {
    this.http = opts.http ?? defaultHttp;
    this.now = opts.now ?? (() => new Date());
  }

  private urls(c: ApiCredentials) {
    if (c.environment === 'production') return { token: c.tokenUrl ?? LOGIN, base: c.baseUrl ?? PRODUCTION, audience: c.audience ?? 'jpm:uri:prod:payments' };
    // Client testing: the docs give the same login URL, but no base URL and no audience value for it. Both come from J.P. Morgan.
    if (!c.baseUrl) throw new BankApiError('not_sent', 'Client testing needs the base URL J.P. Morgan gave you.');
    return { token: c.tokenUrl ?? LOGIN, base: c.baseUrl, audience: c.audience ?? 'jpm:uri:sandbox:payments' };
  }

  private async token(c: ApiCredentials, fresh = false): Promise<string> {
    const u = this.urls(c);
    const cacheKey = `${c.clientId}|${u.token}|${u.audience}`;
    const hit = this.tokens.get(cacheKey);
    const nowMs = this.now().getTime();
    if (!fresh && hit && hit.expiresAt - 60_000 > nowMs) return hit.token;
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: clientAssertion(c, Math.floor(nowMs / 1000), u.token),
      audience: u.audience,
    });
    const res = await this.http({ method: 'POST', url: u.token, headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form.toString() });
    if (res.status < 200 || res.status >= 300) throw new BankApiError('not_sent', `The bank would not issue an access token (HTTP ${res.status}). Check the client id, the certificate on file with J.P. Morgan, and its thumbprint.`);
    let j: { access_token?: string; expires_in?: number };
    try { j = JSON.parse(res.body); } catch { throw new BankApiError('not_sent', 'The bank returned an unreadable token response.'); }
    if (!j.access_token) throw new BankApiError('not_sent', 'The bank returned no access token.');
    this.tokens.set(cacheKey, { token: j.access_token, expiresAt: nowMs + (j.expires_in ?? 300) * 1000 });
    return j.access_token;
  }

  async send(c: ApiCredentials, i: CreditInstruction): Promise<SendResult> {
    const u = this.urls(c);
    const body = JSON.stringify(creditBody(c, i));
    const attempt = async (fresh: boolean) => {
      const token = await this.token(c, fresh);
      return this.http({ method: 'POST', url: `${u.base}${PATH}`, headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json', 'idempotency-key': idempotencyKeyFor(i.legId), 'request-id': randomUUID() }, body });
    };
    let res = await attempt(false);
    // An expired token is refused before anything is processed, so asking again with a fresh one cannot pay twice.
    if (res.status === 401) res = await attempt(true);
    const msg = bankMessage(res.body);
    if (res.status === 200 || res.status === 201 || res.status === 202) {
      let j: { paymentId?: string; paymentStatus?: string; paymentSubStatus?: string };
      try { j = JSON.parse(res.body); } catch { throw new BankApiError('unknown', 'The bank answered, but not in a form Totali can read. The payment may have been accepted.'); }
      if (!j.paymentId) throw new BankApiError('unknown', 'The bank answered without a payment id. The payment may have been accepted.');
      return { paymentId: j.paymentId, endToEndId: endToEndIdFor(i.legId), state: mapStatus(j.paymentStatus, j.paymentSubStatus) };
    }
    if (res.status === 401 || res.status === 403) throw new BankApiError('not_sent', `The bank refused the credentials or this account's permission to send payments (HTTP ${res.status}). ${msg}`.trim());
    if (res.status === 429) throw new BankApiError('not_sent', 'The bank asked Totali to slow down (HTTP 429). Try again shortly.');
    if (/\b11507\b/.test(res.body) || res.status === 409) throw new BankApiError('unknown', `The bank reports a duplicate for this payment. It may already have been accepted: check your J.P. Morgan portal. ${msg}`.trim());
    if (res.status >= 400 && res.status < 500) throw new BankApiError('rejected', `The bank rejected this payment (HTTP ${res.status}). ${msg}`.trim());
    throw new BankApiError('unknown', `The bank had a problem (HTTP ${res.status}) and the payment may or may not have been accepted. ${msg}`.trim());
  }

  async status(c: ApiCredentials, paymentId: string): Promise<{ state: ApiPaymentState; detail?: string }> {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(paymentId)) throw new BankApiError('unknown', 'The stored payment id is not one Totali can look up.');
    const u = this.urls(c);
    const token = await this.token(c);
    const res = await this.http({ method: 'GET', url: `${u.base}${PATH}/${paymentId}?view=SUMMARY`, headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'request-id': randomUUID() } });
    if (res.status !== 200) throw new BankApiError('unknown', `Could not read the payment's status (HTTP ${res.status}).`);
    let j: { paymentStatus?: string; paymentSubStatus?: string };
    try { j = JSON.parse(res.body); } catch { throw new BankApiError('unknown', 'The status answer was not readable.'); }
    return { state: mapStatus(j.paymentStatus, j.paymentSubStatus), detail: [j.paymentStatus, j.paymentSubStatus].filter(Boolean).join(' / ') };
  }
}
