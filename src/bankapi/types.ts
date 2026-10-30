/**
 * A bank API adapter sends one ACH credit to the employer's bank, in the
 * employer's name, and reads its status back. It holds no money and approves
 * nothing: Totali only calls an adapter after a named person at the employer
 * has approved the exact file in Totali (see AchService.approveAndSend).
 *
 * Every adapter is written from the bank's public developer documentation and
 * has never run against the bank. It fails closed: an unclear answer is
 * reported as `unknown`, and an `unknown` payment is never sent again by Totali.
 */

export type ApiPaymentState = 'accepted' | 'processing' | 'held_for_client' | 'completed' | 'rejected' | 'returned';

export interface ApiCredentials {
  clientId: string;
  certThumbprint: string;
  privateKeyPem: string;
  environment: 'client_testing' | 'production';
  tokenUrl?: string;
  baseUrl?: string;
  audience?: string;
  debtor: { name: string; accountNumber: string; routingNumber: string; companyId: string };
}

export interface CreditInstruction {
  /** Unique per payment; the bank refuses a repeat. */
  legId: string;
  amountCents: number;
  /** YYYY-MM-DD */
  effectiveDate: string;
  recipientName: string;
  routingNumber: string;
  accountNumber: string;
  accountType: 'checking' | 'savings';
}

export interface SendResult {
  paymentId: string;
  endToEndId: string;
  state: ApiPaymentState;
}

/**
 * not_sent: the bank did not take it and nothing was processed (bad credentials, rate limit, no connection). Safe to try again.
 * rejected: the bank looked at this payment and refused it. It will not be sent; the payment fails.
 * unknown:  the bank may or may not have it (timeout, server error, a duplicate warning). Never retried automatically.
 */
export class BankApiError extends Error {
  readonly outcome: 'not_sent' | 'rejected' | 'unknown';
  constructor(outcome: 'not_sent' | 'rejected' | 'unknown', message: string) {
    super(message);
    this.name = 'BankApiError';
    this.outcome = outcome;
  }
}

export interface BankApiAdapter {
  readonly id: string;
  send(creds: ApiCredentials, instruction: CreditInstruction): Promise<SendResult>;
  status(creds: ApiCredentials, paymentId: string): Promise<{ state: ApiPaymentState; detail?: string }>;
}

export interface HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
}
export type HttpFn = (req: HttpRequest) => Promise<{ status: number; body: string }>;

/** Plain HTTPS with a timeout. A refused or unresolvable connection is reported as `not_sent`; anything else that fails is `unknown`. */
export const defaultHttp: HttpFn = async (req) => {
  try {
    const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(30_000), redirect: 'error' });
    return { status: res.status, body: await res.text() };
  } catch (e) {
    const code = ((e as { cause?: { code?: string } }).cause?.code) ?? '';
    if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) throw new BankApiError('not_sent', `Could not connect to the bank (${code}).`);
    throw new BankApiError('unknown', 'The connection to the bank failed after the request may have been sent.');
  }
};
