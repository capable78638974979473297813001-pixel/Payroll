/**
 * Stripe, used for one thing: connecting to people's banks.
 *
 * Totali moves the money itself, by ACH (see src/ach and src/money/ach.ts).
 * Stripe Financial Connections is how an employer or an employee proves they
 * can log in to a bank account, and how Totali learns that account's last
 * four digits, its owners' names and its balance. Nothing here creates a
 * payment, a payout or a transfer.
 *
 * It reads the secret key from STRIPE_SECRET_KEY, over plain fetch so the
 * repo stays dependency-free. Live-mode keys (sk_live_ / rk_live_) are
 * refused unless STRIPE_ALLOW_LIVE=1, so a live key pasted into a dev
 * environment does nothing until someone says so on purpose.
 *
 * What Stripe does NOT hand over: Financial Connections returns tokenized
 * account numbers that only work for ACH on Stripe. Full account numbers for
 * ACH outside Stripe are available only to businesses Stripe approves. So the
 * account holder enters the full number, and Totali checks its last four
 * digits against what Stripe confirmed.
 */

export class StripeError extends Error {
  status: number;
  type: string | undefined;
  code: string | undefined;
  /** True when Stripe definitely rejected the request. False when the outcome is unknown (network, 5xx). */
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

/** Form-encode nested objects the way Stripe expects: a[b]=1, a[]=x. */
export function formEncode(obj: Record<string, unknown>, prefix = ''): string[] {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item) => {
        if (typeof item === 'object' && item !== null) parts.push(...formEncode(item as Record<string, unknown>, `${key}[]`));
        else parts.push(`${encodeURIComponent(`${key}[]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof v === 'object') parts.push(...formEncode(v as Record<string, unknown>, key));
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return parts;
}

export type FcPermission = 'balances' | 'ownership' | 'payment_method' | 'transactions';

export interface FcAccount {
  id: string;
  status: 'active' | 'inactive' | 'disconnected';
  category: string;
  subcategory: string;
  last4?: string | null;
  institution_name?: string;
  display_name?: string | null;
  account_holder?: { type?: string; customer?: string } | null;
  permissions?: string[] | null;
  balance?: { as_of?: number; type?: string; cash?: { available?: { usd?: number } }; current?: { usd?: number } } | null;
  balance_refresh?: { status?: string; next_refresh_available_at?: number | null } | null;
  /** Present as an id until expanded; an object with owners once `expand[]=ownership` is used and a refresh has completed. */
  ownership?: string | { owners?: { data?: Array<{ name?: string }> } } | null;
  ownership_refresh?: { status?: string; next_refresh_available_at?: number | null } | null;
  account_numbers?: Array<{ identifier_type?: 'account_number' | 'tokenized_account_number'; status?: string }> | null;
}

export interface FcSession {
  id: string;
  client_secret?: string;
  accounts?: { data?: FcAccount[] };
}

export interface StripeApi {
  createCustomer(p: { name: string; email?: string; metadata?: Record<string, string> }, idempotencyKey: string): Promise<{ id: string }>;
  createFcSession(p: { customer: string; permissions: FcPermission[]; prefetch?: Array<'balances' | 'ownership'> }, idempotencyKey: string): Promise<{ id: string; client_secret: string }>;
  retrieveFcSession(id: string): Promise<FcSession>;
  retrieveFcAccount(id: string, opts?: { expandOwnership?: boolean }): Promise<FcAccount>;
  refreshFcAccount(id: string, features: Array<'balance' | 'ownership'>): Promise<FcAccount>;
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
    const encoded = formEncode(params).join('&');
    const body = method === 'POST' ? encoded : undefined;
    const query = method === 'GET' && encoded ? `?${encoded}` : '';
    const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
    if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    if (process.env.STRIPE_API_VERSION) headers['Stripe-Version'] = process.env.STRIPE_API_VERSION;

    let lastErr: unknown;
    // A retry is safe for reads, and for writes that carry an idempotency key.
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

  createFcSession(p: { customer: string; permissions: FcPermission[]; prefetch?: Array<'balances' | 'ownership'> }, key: string) {
    return this.call<{ id: string; client_secret: string }>(
      'POST',
      '/v1/financial_connections/sessions',
      { account_holder: { type: 'customer', customer: p.customer }, permissions: p.permissions, filters: { country: 'US' }, ...(p.prefetch?.length ? { prefetch: p.prefetch } : {}) },
      key,
    );
  }

  retrieveFcSession(id: string) {
    return this.call<FcSession>('GET', `/v1/financial_connections/sessions/${encodeURIComponent(id)}`);
  }

  retrieveFcAccount(id: string, opts: { expandOwnership?: boolean } = {}) {
    return this.call<FcAccount>('GET', `/v1/financial_connections/accounts/${encodeURIComponent(id)}`, opts.expandOwnership ? { expand: ['ownership'] } : {});
  }

  refreshFcAccount(id: string, features: Array<'balance' | 'ownership'>) {
    return this.call<FcAccount>('POST', `/v1/financial_connections/accounts/${encodeURIComponent(id)}/refresh`, { features });
  }
}

export function stripeFromEnv(): StripeApi {
  return new StripeClient();
}
