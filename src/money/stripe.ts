/**
 * A small Stripe client over plain fetch, so the repo stays dependency-free
 * (the same choice the tax engine's own Stripe code makes). It reads the
 * secret key from STRIPE_SECRET_KEY and nothing else.
 *
 * Live-mode keys (sk_live_ / rk_live_) move real money. They are refused
 * unless STRIPE_ALLOW_LIVE=1, so a live key pasted into a dev environment
 * does nothing until someone says so on purpose.
 *
 * Every call that creates money movement takes an idempotency key. A retry
 * after a timeout, crash or network error carries the same key, so Stripe
 * returns the first result instead of moving the money twice.
 */

export class StripeError extends Error {
  status: number;
  type: string | undefined;
  code: string | undefined;
  /** True when the request definitely did not complete (a 4xx Stripe rejected). False when the outcome is unknown (network, 5xx). */
  definitive: boolean;
  constructor(message: string, status: number, opts: { type?: string; code?: string; definitive?: boolean } = {}) {
    super(message);
    this.name = 'StripeError';
    this.status = status;
    this.type = opts.type;
    this.code = opts.code;
    this.definitive = opts.definitive ?? (status >= 400 && status < 500 && status !== 409 && status !== 429);
  }
}

const apiBase = () => (process.env.STRIPE_API_BASE ?? 'https://api.stripe.com').trim().replace(/\/+$/, '');
const secret = () => (process.env.STRIPE_SECRET_KEY ?? '').trim();

export function stripeKeyRefused(): string | null {
  const k = secret();
  if (!k) return null;
  if (/^(sk|rk)_live_/.test(k) && process.env.STRIPE_ALLOW_LIVE !== '1') {
    return 'STRIPE_SECRET_KEY is a live-mode key. Set STRIPE_ALLOW_LIVE=1 to use it. Test mode uses an sk_test_ key.';
  }
  return null;
}

export function stripeConfigured(): boolean {
  return Boolean(secret()) && !stripeKeyRefused();
}

export function stripeMode(): 'live' | 'test' | 'unconfigured' {
  const k = secret();
  if (!k) return 'unconfigured';
  return /^(sk|rk)_live_/.test(k) ? 'live' : 'test';
}

/** Form-encode nested objects the way Stripe expects: a[b]=1, a[0]=x. */
export function formEncode(obj: Record<string, unknown>, prefix = ''): string[] {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === 'object' && item !== null) parts.push(...formEncode(item as Record<string, unknown>, `${key}[${i}]`));
        else parts.push(`${encodeURIComponent(`${key}[]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof v === 'object') parts.push(...formEncode(v as Record<string, unknown>, key));
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return parts;
}

export interface StripePaymentIntent {
  id: string;
  status: 'requires_payment_method' | 'requires_confirmation' | 'requires_action' | 'processing' | 'succeeded' | 'canceled' | 'requires_capture';
  amount: number;
  latest_charge?: string | null;
  last_payment_error?: { code?: string; message?: string } | null;
}

export interface StripeTransfer {
  id: string;
  amount: number;
  destination: string;
  reversed?: boolean;
}

export interface StripeAccount {
  id: string;
  payouts_enabled?: boolean;
  details_submitted?: boolean;
  requirements?: { disabled_reason?: string | null };
  external_accounts?: { data?: Array<{ last4?: string }> };
}

export interface StripeApi {
  createCustomer(p: { name: string; email?: string; metadata?: Record<string, string> }, key: string): Promise<{ id: string }>;
  createSetupIntent(p: { customer: string; metadata?: Record<string, string> }, key: string): Promise<{ id: string; client_secret: string }>;
  retrievePaymentMethod(id: string): Promise<{ id: string; us_bank_account?: { last4?: string; bank_name?: string } }>;
  createPaymentIntent(p: { amount: number; customer: string; paymentMethod: string; transferGroup: string; description: string; metadata: Record<string, string> }, key: string): Promise<StripePaymentIntent>;
  retrievePaymentIntent(id: string): Promise<StripePaymentIntent>;
  createAccount(p: { email?: string; metadata: Record<string, string> }, key: string): Promise<StripeAccount>;
  createAccountLink(p: { account: string; refreshUrl: string; returnUrl: string }): Promise<{ url: string }>;
  retrieveAccount(id: string): Promise<StripeAccount>;
  createTransfer(p: { amount: number; destination: string; transferGroup: string; metadata: Record<string, string>; description: string }, key: string): Promise<StripeTransfer>;
  availableBalanceCents(): Promise<number>;
}

export class StripeClient implements StripeApi {
  private readonly timeoutMs: number;
  constructor(opts: { timeoutMs?: number } = {}) {
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  private key(): string {
    const k = secret();
    if (!k) throw new StripeError('STRIPE_SECRET_KEY is not set in this environment.', 0, { type: 'config_error', definitive: true });
    const refused = stripeKeyRefused();
    if (refused) throw new StripeError(refused, 0, { type: 'live_key_refused', definitive: true });
    return k;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, params: Record<string, unknown> = {}, idempotencyKey?: string): Promise<T> {
    const key = this.key();
    const body = method === 'POST' ? formEncode(params).join('&') : undefined;
    const query = method === 'GET' && Object.keys(params).length ? `?${formEncode(params).join('&')}` : '';
    const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
    if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    if (process.env.STRIPE_API_VERSION) headers['Stripe-Version'] = process.env.STRIPE_API_VERSION;

    let lastErr: unknown;
    // A retry is only safe when an idempotency key makes it so, or the call is a read.
    const attempts = method === 'GET' || idempotencyKey ? 3 : 1;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(`${apiBase()}${path}${query}`, { method, headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
        const text = await res.text();
        let json: any;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        if (res.ok) return json as T;
        const err = json?.error ?? {};
        const e = new StripeError(err.message ?? `Stripe returned HTTP ${res.status}`, res.status, { type: err.type, code: err.code });
        if (res.status >= 500 || res.status === 429 || res.status === 409) {
          lastErr = e;
          await new Promise((r) => setTimeout(r, 200 * 2 ** i));
          continue;
        }
        throw e;
      } catch (e) {
        if (e instanceof StripeError && e.definitive) throw e;
        lastErr = e;
        await new Promise((r) => setTimeout(r, 200 * 2 ** i));
      }
    }
    if (lastErr instanceof StripeError) throw lastErr;
    throw new StripeError(`Could not reach Stripe: ${(lastErr as Error)?.message ?? 'unknown error'}`, 0, { type: 'network_error', definitive: false });
  }

  createCustomer(p: { name: string; email?: string; metadata?: Record<string, string> }, key: string) {
    return this.call<{ id: string }>('POST', '/v1/customers', p, key);
  }

  createSetupIntent(p: { customer: string; metadata?: Record<string, string> }, key: string) {
    return this.call<{ id: string; client_secret: string }>(
      'POST',
      '/v1/setup_intents',
      {
        customer: p.customer,
        usage: 'off_session',
        payment_method_types: ['us_bank_account'],
        payment_method_options: { us_bank_account: { financial_connections: { permissions: ['payment_method'] }, verification_method: 'automatic' } },
        metadata: p.metadata,
      },
      key,
    );
  }

  retrievePaymentMethod(id: string) {
    return this.call<{ id: string; us_bank_account?: { last4?: string; bank_name?: string } }>('GET', `/v1/payment_methods/${encodeURIComponent(id)}`);
  }

  createPaymentIntent(p: { amount: number; customer: string; paymentMethod: string; transferGroup: string; description: string; metadata: Record<string, string> }, key: string) {
    return this.call<StripePaymentIntent>(
      'POST',
      '/v1/payment_intents',
      {
        amount: p.amount,
        currency: 'usd',
        customer: p.customer,
        payment_method: p.paymentMethod,
        payment_method_types: ['us_bank_account'],
        confirm: true,
        off_session: true,
        transfer_group: p.transferGroup,
        description: p.description,
        metadata: p.metadata,
      },
      key,
    );
  }

  retrievePaymentIntent(id: string) {
    return this.call<StripePaymentIntent>('GET', `/v1/payment_intents/${encodeURIComponent(id)}`);
  }

  createAccount(p: { email?: string; metadata: Record<string, string> }, key: string) {
    const recipient = (process.env.STRIPE_CONNECT_SERVICE_AGREEMENT ?? 'full').trim() === 'recipient';
    return this.call<StripeAccount>(
      'POST',
      '/v1/accounts',
      {
        type: 'express',
        country: 'US',
        email: p.email,
        business_type: 'individual',
        capabilities: { transfers: { requested: true } },
        ...(recipient ? { tos_acceptance: { service_agreement: 'recipient' } } : {}),
        metadata: p.metadata,
      },
      key,
    );
  }

  createAccountLink(p: { account: string; refreshUrl: string; returnUrl: string }) {
    return this.call<{ url: string }>('POST', '/v1/account_links', { account: p.account, refresh_url: p.refreshUrl, return_url: p.returnUrl, type: 'account_onboarding' });
  }

  retrieveAccount(id: string) {
    return this.call<StripeAccount>('GET', `/v1/accounts/${encodeURIComponent(id)}`);
  }

  createTransfer(p: { amount: number; destination: string; transferGroup: string; metadata: Record<string, string>; description: string }, key: string) {
    return this.call<StripeTransfer>('POST', '/v1/transfers', { amount: p.amount, currency: 'usd', destination: p.destination, transfer_group: p.transferGroup, description: p.description, metadata: p.metadata }, key);
  }

  async availableBalanceCents(): Promise<number> {
    const b = await this.call<{ available: Array<{ amount: number; currency: string }> }>('GET', '/v1/balance');
    return b.available.filter((x) => x.currency === 'usd').reduce((a, x) => a + x.amount, 0);
  }
}

export function stripeFromEnv(): StripeApi {
  return new StripeClient();
}
