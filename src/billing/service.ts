import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError, badRequest, conflict } from '../lib/errors.ts';
import type { Store } from '../store/store.ts';
import type { Company } from '../domain/types.ts';
import { PRICE, eventTime, isAllowedStripeUrl, type StripeBillingApi, type StripeSubscription } from '../money/stripe.ts';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** A subscription that is paid, or is only late and still being retried, keeps the restaurant running. */
const LIVE = new Set(['active', 'trialing', 'past_due']);

/**
 * Billing: Totali costs $20 every three months, whatever the number of employees. It is a Stripe subscription started on
 * Stripe's own hosted Checkout page, so a card number never reaches Totali, and changed or cancelled on Stripe's billing
 * portal. What this keeps is the customer, the subscription's status and renewal date, and the card's brand and last four.
 * Stripe's webhooks keep that current; nothing the browser says is believed without asking Stripe.
 */
export class BillingService {
  private store: Store;
  private stripe: StripeBillingApi | null;
  private now: () => Date;
  private exempt: () => string[];
  constructor(store: Store, stripe: StripeBillingApi | null, now: () => Date = () => new Date(), exempt: () => string[] = () => (process.env.TOTALI_BILLING_EXEMPT ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    this.store = store; this.stripe = stripe; this.now = now; this.exempt = exempt;
  }

  private company(id: string): Company { return this.store.companies.require(id, 'Company'); }
  private on() { return !!this.stripe; }
  private put(c: Company) { this.store.tx(() => this.store.companies.put(c)); }

  /** Payment is asked for when Stripe is set up on this server, except for companies the operator has waived. */
  required(companyId: string): boolean {
    return this.on() && process.env.TOTALI_BILLING_REQUIRED !== '0' && !this.exempt().includes(companyId);
  }
  active(companyId: string): boolean {
    const sub = this.company(companyId).billing?.subscription;
    return !!sub && LIVE.has(sub.status);
  }
  /** Approving payroll needs a live subscription, when payment is asked for. */
  assertCanApprove(companyId: string): void {
    if (this.required(companyId) && !this.active(companyId)) throw new ApiError(402, 'subscription_required', `Start your Totali subscription to approve payroll. It’s ${PRICE.label}, with every employee included.`);
  }

  view(companyId: string, fallbackEmail: string) {
    const c = this.company(companyId);
    const sub = c.billing?.subscription;
    return {
      plan: { name: 'Totali', label: PRICE.label, cents: PRICE.cents, months: PRICE.months, includes: 'Every employee and every pay run' },
      subscription: sub ? { status: sub.status, active: LIVE.has(sub.status), pastDue: sub.status === 'past_due', renews: sub.currentPeriodEnd ?? null, endsAtPeriodEnd: !!sub.cancelAtPeriodEnd } : null,
      card: c.billing?.card ? { brand: c.billing.card.brand, last4: c.billing.card.last4, expMonth: c.billing.card.expMonth, expYear: c.billing.card.expYear } : null,
      email: c.billing?.email ?? fallbackEmail,
      billedTo: c.legalName,
      available: this.on(),
      required: this.required(companyId),
    };
  }

  setEmail(companyId: string, raw: unknown) {
    const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(email)) throw badRequest('Enter a valid email address.', { field: 'email' });
    const c = structuredClone(this.company(companyId));
    c.billing = { ...(c.billing ?? {}), email, updatedAt: this.now().toISOString() };
    this.put(c);
    const id = c.billing.stripeCustomerId;
    if (id && this.stripe) void this.stripe.updateCustomer(id, { email }).catch(() => undefined);
    return email;
  }

  private notReady(): never { throw new ApiError(503, 'billing_not_configured', 'Payments aren’t set up on this server yet. An administrator needs to set STRIPE_SECRET_KEY.'); }

  private async customer(companyId: string, ownerEmail: string): Promise<string> {
    const c = this.company(companyId);
    if (c.billing?.stripeCustomerId) return c.billing.stripeCustomerId;
    const made = await this.stripe!.createCustomer({ name: c.legalName, email: c.billing?.email ?? ownerEmail, metadata: { companyId } }, `totali-customer-${companyId}`);
    const next = structuredClone(this.company(companyId));
    next.billing = { ...(next.billing ?? {}), stripeCustomerId: made.id };
    this.put(next);
    return made.id;
  }

  /** Where to send the owner to subscribe: Stripe's hosted page, which comes back to the Billing page. */
  async startCheckout(companyId: string, ownerEmail: string, origin: string) {
    if (!this.stripe) this.notReady();
    if (this.active(companyId)) throw conflict('already_subscribed', 'You’re already subscribed. Use Manage billing to change your card or cancel.');
    const customer = await this.customer(companyId, ownerEmail);
    const session = await this.stripe!.createSubscriptionCheckout({ customer, companyId, successUrl: `${origin}/app/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`, cancelUrl: `${origin}/app/billing?checkout=cancelled` }, `totali-checkout-${companyId}-${Math.floor(this.now().getTime() / 600_000)}`);
    if (!session.url || !isAllowedStripeUrl(session.url)) throw new ApiError(502, 'checkout_unavailable', 'Stripe didn’t give a payment page. Try again in a minute.');
    return { url: session.url };
  }

  /** The owner is back from Checkout. Ask Stripe what happened. */
  async finishCheckout(companyId: string, sessionId: unknown) {
    if (!this.stripe) this.notReady();
    if (typeof sessionId !== 'string' || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) throw badRequest('That isn’t a checkout.');
    const c = this.company(companyId);
    const session = await this.stripe.retrieveCheckoutSession(sessionId);
    if (!c.billing?.stripeCustomerId || session.customer !== c.billing.stripeCustomerId) throw conflict('not_your_checkout', 'That checkout belongs to a different account.');
    const ref = session.subscription;
    if (!ref) throw conflict('not_subscribed', 'The subscription wasn’t started. Try again.');
    const sub = typeof ref === 'string' ? await this.stripe.retrieveSubscription(ref) : ref;
    this.applySubscription(companyId, sub, this.now().getTime());
    return this.view(companyId, '');
  }

  /** Stripe's page to change the card, read invoices or cancel. */
  async portal(companyId: string, origin: string) {
    if (!this.stripe) this.notReady();
    const customer = this.company(companyId).billing?.stripeCustomerId;
    if (!customer) throw conflict('no_customer', 'There’s nothing to manage yet. Start your subscription first.');
    const s = await this.stripe.createPortalSession({ customer, returnUrl: `${origin}/app/billing` });
    if (!isAllowedStripeUrl(s.url)) throw new ApiError(502, 'portal_unavailable', 'Stripe didn’t give a billing page. Try again in a minute.');
    return { url: s.url };
  }

  /** Keep the subscription's status, renewal and card. A message older than what's held is ignored. */
  private applySubscription(companyId: string, sub: StripeSubscription, at: number, forceStatus?: string) {
    const c = structuredClone(this.company(companyId));
    const held = c.billing?.subscription;
    if (held && held.id === sub.id && at && held.eventAt > at) return;
    const end = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end;
    c.billing = { ...(c.billing ?? {}), updatedAt: this.now().toISOString(),
      subscription: { id: sub.id, status: forceStatus ?? sub.status, ...(end ? { currentPeriodEnd: new Date(end * 1000).toISOString() } : {}), cancelAtPeriodEnd: !!sub.cancel_at_period_end || !!sub.cancel_at, eventAt: at || this.now().getTime() } };
    const pm = sub.default_payment_method;
    if (pm && typeof pm === 'object' && pm.card?.last4) c.billing.card = { paymentMethodId: pm.id, brand: pm.card.brand ?? 'card', last4: pm.card.last4, expMonth: pm.card.exp_month ?? 0, expYear: pm.card.exp_year ?? 0 };
    this.put(c);
  }

  private byCustomer(customer: unknown): Company | undefined {
    return typeof customer === 'string' ? this.store.companies.all().find((c) => c.billing?.stripeCustomerId === customer) : undefined;
  }

  /** A signed event from Stripe. Anything not signed by the shared secret, or older than five minutes, is refused. */
  async webhook(rawBody: string, signatureHeader: string | undefined, secret: string | undefined) {
    if (!secret) throw new ApiError(503, 'webhook_not_configured', 'STRIPE_WEBHOOK_SECRET is not set.');
    verifyStripeSignature(rawBody, signatureHeader, secret, this.now().getTime());
    const event = JSON.parse(rawBody) as { id?: string; type: string; created?: number; data: { object: Record<string, any> } };
    if (event.id && this.store.stripeEvents.get(event.id)) return { received: true, duplicate: true };
    if (this.stripe) await this.apply(event);
    // recorded only once applied, so Stripe's retry runs again if applying failed
    if (event.id) this.store.tx(() => this.store.stripeEvents.put({ id: event.id!, at: this.now().toISOString() }));
    return { received: true };
  }

  private async apply(event: { type: string; created?: number; data: { object: Record<string, any> } }) {
    const obj = event.data.object; const at = eventTime(event);
    if (event.type === 'checkout.session.completed' && obj.mode === 'subscription') {
      const c = this.byCustomer(obj.customer);
      if (!c || (obj.metadata?.companyId && obj.metadata.companyId !== c.id) || typeof obj.subscription !== 'string') return;
      this.applySubscription(c.id, await this.stripe!.retrieveSubscription(obj.subscription), at);
      return;
    }
    if (event.type.startsWith('customer.subscription.')) {
      const c = this.byCustomer(obj.customer);
      if (!c) return;
      this.applySubscription(c.id, obj as StripeSubscription, at, event.type === 'customer.subscription.deleted' ? 'canceled' : undefined);
      return;
    }
    if ((event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') && typeof obj.subscription === 'string') {
      const c = this.byCustomer(obj.customer);
      if (c) this.applySubscription(c.id, await this.stripe!.retrieveSubscription(obj.subscription), at);
    }
  }
}

/** Stripe's scheme: header `t=…,v1=…`, signed payload `t.body` with HMAC-SHA256. More than one v1 is allowed, for a secret being rotated. */
export function verifyStripeSignature(body: string, header: string | undefined, secret: string, nowMs: number, toleranceSeconds = 300): void {
  const bad = new ApiError(400, 'bad_signature', 'The signature doesn’t match.');
  if (!header) throw bad;
  const pieces = header.split(',').map((kv) => { const i = kv.indexOf('='); return i < 0 ? ['', ''] as const : [kv.slice(0, i).trim(), kv.slice(i + 1).trim()] as const; });
  const t = Number(pieces.find((p) => p[0] === 't')?.[1]);
  const sigs = pieces.filter((p) => p[0] === 'v1' && p[1]).map((p) => p[1]);
  if (!Number.isFinite(t) || sigs.length === 0) throw bad;
  if (Math.abs(nowMs / 1000 - t) > toleranceSeconds) throw new ApiError(400, 'stale_signature', 'That event is too old.');
  const want = Buffer.from(createHmac('sha256', secret).update(`${t}.${body}`).digest('hex'), 'hex');
  const ok = sigs.some((s) => { const given = Buffer.from(s, 'hex'); return given.length === want.length && timingSafeEqual(given, want); });
  if (!ok) throw bad;
}
