/**
 * Stripe, used for two things: connecting to people's banks, and Totali's own subscription (a hosted Checkout page
 * that bills the restaurant $20 every three months, and a billing portal to change the card or cancel). It never moves
 * payroll money.
 *
 * Bank linking:
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

/** What Totali costs: $20 every three months, however many people are on payroll. */
export const PRICE = { cents: 2000, months: 3, label: '$20 every 3 months' } as const;

export interface StripePaymentMethodCard { id: string; card?: { brand?: string; last4?: string; exp_month?: number; exp_year?: number } }
export interface StripeSubscription {
  id: string;
  status: string;
  customer?: string | { id: string };
  current_period_end?: number;
  cancel_at_period_end?: boolean;
  cancel_at?: number | null;
  items?: { data?: Array<{ current_period_end?: number }> };
  default_payment_method?: string | StripePaymentMethodCard | null;
}
export interface StripeCheckoutSession {
  id: string;
  mode?: string;
  status?: string;
  customer?: string | null;
  client_reference_id?: string | null;
  metadata?: Record<string, string>;
  subscription?: string | StripeSubscription | null;
}

const isLocalHost = (host: string) => { const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, ''); return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0' || /^127(?:\.\d{1,3}){3}$/.test(h); };

/** A return URL Stripe will send a customer back to: https and not localhost. */
export function isPublicHttpsUrl(value: string): boolean {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !!u.hostname && !isLocalHost(u.hostname); } catch { return false; }
}

/** In production a checkout or portal never returns to http or localhost. Ported from the Omnia Tax billing. */
export function assertProductionCheckoutUrls(...urls: string[]): void {
  const production = process.env.NODE_ENV === 'production' || Boolean((process.env.RENDER ?? '').trim());
  if (!production) return;
  if (urls.every(isPublicHttpsUrl)) return;
  throw new StripeError('Checkout return links must be https and public in production. Set PUBLIC_BASE_URL to your https address.', 0, { type: 'checkout_origin_invalid', definitive: true });
}

/** Only Stripe's own hosted pages are ever handed to a browser (a test stub's own host is allowed when STRIPE_API_BASE points at one). */
export function isAllowedStripeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const stub = (process.env.STRIPE_API_BASE ?? '').trim();
    if (stub && stub !== 'https://api.stripe.com') { try { if (new URL(stub).host === u.host) return true; } catch { /* a bad stub base */ } }
    return u.protocol === 'https:' && !u.username && !u.password && (u.hostname === 'checkout.stripe.com' || u.hostname === 'billing.stripe.com');
  } catch { return false; }
}

/** The order Stripe's events happened in, whatever order they arrive. */
export const eventTime = (e: { created?: number }) => (typeof e.created === 'number' ? e.created * 1000 : 0);

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

  updateCustomer(id: string, p: { email?: string; name?: string }) {
    return this.call<{ id: string }>('POST', `/v1/customers/${encodeURIComponent(id)}`, p);
  }

  /** A hosted Checkout page that starts the subscription. The price is built here, so there is nothing to set up in the Dashboard. */
  createSubscriptionCheckout(p: { customer: string; successUrl: string; cancelUrl: string; companyId: string }, key: string) {
    assertProductionCheckoutUrls(p.successUrl, p.cancelUrl);
    const priceId = (process.env.STRIPE_PRICE_ID ?? '').trim();
    const line = priceId
      ? { price: priceId, quantity: 1 }
      : { quantity: 1, price_data: { currency: 'usd', unit_amount: PRICE.cents, recurring: { interval: 'month', interval_count: PRICE.months }, product_data: { name: 'Totali payroll', description: 'Every employee included. Billed every three months.' } } };
    return this.call<{ id: string; url: string | null }>('POST', '/v1/checkout/sessions', {
      mode: 'subscription', customer: p.customer, line_items: [line], payment_method_collection: 'always',
      success_url: p.successUrl, cancel_url: p.cancelUrl, client_reference_id: p.companyId,
      metadata: { companyId: p.companyId }, subscription_data: { metadata: { companyId: p.companyId } },
    }, key);
  }

  retrieveCheckoutSession(id: string) {
    return this.call<StripeCheckoutSession>('GET', `/v1/checkout/sessions/${encodeURIComponent(id)}`, { expand: ['subscription.default_payment_method'] });
  }

  retrieveSubscription(id: string) {
    return this.call<StripeSubscription>('GET', `/v1/subscriptions/${encodeURIComponent(id)}`, { expand: ['default_payment_method'] });
  }

  /** Stripe's own page where the customer changes the card, reads invoices or cancels. */
  createPortalSession(p: { customer: string; returnUrl: string }) {
    assertProductionCheckoutUrls(p.returnUrl, p.returnUrl);
    return this.call<{ id: string; url: string }>('POST', '/v1/billing_portal/sessions', { customer: p.customer, return_url: p.returnUrl });
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

/** What billing needs from Stripe: a customer, a subscription started on a hosted page, and a page to manage it. */
export interface StripeBillingApi {
  createCustomer(p: { name: string; email?: string; metadata?: Record<string, string> }, idempotencyKey: string): Promise<{ id: string }>;
  updateCustomer(id: string, p: { email?: string; name?: string }): Promise<{ id: string }>;
  createSubscriptionCheckout(p: { customer: string; successUrl: string; cancelUrl: string; companyId: string }, idempotencyKey: string): Promise<{ id: string; url: string | null }>;
  retrieveCheckoutSession(id: string): Promise<StripeCheckoutSession>;
  retrieveSubscription(id: string): Promise<StripeSubscription>;
  createPortalSession(p: { customer: string; returnUrl: string }): Promise<{ id: string; url: string }>;
}

export function stripeFromEnv(): StripeApi {
  return new StripeClient();
}
