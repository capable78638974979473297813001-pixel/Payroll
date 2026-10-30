import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError, badRequest, conflict } from '../lib/errors.ts';
import type { Store } from '../store/store.ts';
import type { Company } from '../domain/types.ts';
import type { StripeBillingApi } from '../money/stripe.ts';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const monthOf = (iso: string) => iso.slice(0, 7);
const lastDayOf = (month: string) => { const [y, m] = month.split('-').map(Number) as [number, number]; return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };

/**
 * Billing: one price per employee who is on a pay run that month. The price is not shown in the app; it is confirmed
 * with the customer before the first invoice. What this holds is a card on file, saved through Stripe's own form so
 * the number never reaches Totali, and the email that invoices go to.
 */
export class BillingService {
  private store: Store;
  private stripe: StripeBillingApi | null;
  private now: () => Date;
  private publishableKey: () => string;
  constructor(store: Store, stripe: StripeBillingApi | null, now: () => Date = () => new Date(), publishableKey: () => string = () => (process.env.STRIPE_PUBLISHABLE_KEY ?? '').trim()) {
    this.store = store; this.stripe = stripe; this.now = now; this.publishableKey = publishableKey;
  }

  private company(id: string): Company { return this.store.companies.require(id, 'Company'); }
  private ready() { return !!this.stripe && !!this.publishableKey(); }

  view(companyId: string, fallbackEmail: string) {
    const c = this.company(companyId);
    const today = this.now().toISOString().slice(0, 10);
    const month = monthOf(today);
    const runs = this.store.payRuns.where((r) => r.companyId === companyId && r.status !== 'voided' && r.status !== 'draft');
    const counted = new Set(runs.filter((r) => monthOf(r.checkDate) === month).flatMap((r) => r.paychecks.map((p) => p.employeeId)));
    const invited = this.store.employees.where((e) => e.companyId === companyId && !e.terminationDate && !counted.has(e.id) && !!e.onboarding?.requested).length;
    return {
      plan: { name: 'Totali', label: 'Early access' },
      onPayRun: counted.size, invitedNotCounted: invited,
      nextInvoice: runs.length ? lastDayOf(month) : null,
      invoices: [] as Array<{ id: string; date: string; amountCents: number }>,
      card: c.billing?.card ? { brand: c.billing.card.brand, last4: c.billing.card.last4, expMonth: c.billing.card.expMonth, expYear: c.billing.card.expYear } : null,
      email: c.billing?.email ?? fallbackEmail,
      billedTo: c.legalName,
      cardsAvailable: this.ready(),
    };
  }

  setEmail(companyId: string, raw: unknown) {
    const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(email)) throw badRequest('Enter a valid email address.', { field: 'email' });
    const c = structuredClone(this.company(companyId));
    c.billing = { ...(c.billing ?? {}), email, updatedAt: this.now().toISOString() };
    this.store.tx(() => this.store.companies.put(c));
    return email;
  }

  /** Start saving a card: a Stripe customer for the company, and a SetupIntent the browser's Payment Element confirms. */
  async startCard(companyId: string, ownerEmail: string) {
    if (!this.stripe || !this.ready()) throw new ApiError(503, 'billing_not_configured', 'Card payments aren’t set up on this server yet. An administrator needs to set STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY.');
    let c = this.company(companyId);
    let customer = c.billing?.stripeCustomerId;
    if (!customer) {
      const made = await this.stripe.createCustomer({ name: c.legalName, email: c.billing?.email ?? ownerEmail, metadata: { companyId } }, `totali-customer-${companyId}`);
      customer = made.id;
      c = structuredClone(this.company(companyId));
      c.billing = { ...(c.billing ?? {}), stripeCustomerId: customer };
      const next = c; this.store.tx(() => this.store.companies.put(next));
    }
    const intent = await this.stripe.createSetupIntent({ customer, metadata: { companyId } }, `totali-setup-${companyId}-${this.now().getTime()}`);
    return { clientSecret: intent.client_secret, publishableKey: this.publishableKey() };
  }

  /** The browser says the card was saved. Ask Stripe, never believe the browser. */
  async finishCard(companyId: string, setupIntentId: unknown) {
    if (!this.stripe) throw new ApiError(503, 'billing_not_configured', 'Card payments aren’t set up on this server yet.');
    if (typeof setupIntentId !== 'string' || !/^seti_[A-Za-z0-9_]+$/.test(setupIntentId)) throw badRequest('That isn’t a card setup.');
    const si = await this.stripe.retrieveSetupIntent(setupIntentId);
    return this.applyIntent(companyId, si);
  }

  private async applyIntent(companyId: string, si: Awaited<ReturnType<StripeBillingApi['retrieveSetupIntent']>>) {
    const c = structuredClone(this.company(companyId));
    if (!c.billing?.stripeCustomerId || si.customer !== c.billing.stripeCustomerId) throw conflict('not_your_card', 'That card setup belongs to a different account.');
    if (si.status !== 'succeeded' || !si.payment_method?.card) throw conflict('card_not_saved', 'The card wasn’t saved. Try again.');
    const pm = si.payment_method;
    const old = c.billing.card?.paymentMethodId;
    c.billing.card = { paymentMethodId: pm.id, brand: pm.card!.brand, last4: pm.card!.last4, expMonth: pm.card!.exp_month, expYear: pm.card!.exp_year };
    c.billing.updatedAt = this.now().toISOString();
    this.store.tx(() => this.store.companies.put(c));
    await this.stripe!.updateCustomer(c.billing.stripeCustomerId!, { invoice_settings: { default_payment_method: pm.id } }).catch(() => undefined);
    if (old && old !== pm.id) await this.stripe!.detachPaymentMethod(old).catch(() => undefined);
    return { brand: c.billing.card.brand, last4: c.billing.card.last4 };
  }

  /** A signed event from Stripe. Anything not signed by the shared secret, or older than five minutes, is refused. */
  async webhook(rawBody: string, signatureHeader: string | undefined, secret: string | undefined) {
    if (!secret) throw new ApiError(503, 'webhook_not_configured', 'STRIPE_WEBHOOK_SECRET is not set.');
    verifyStripeSignature(rawBody, signatureHeader, secret, this.now().getTime());
    const event = JSON.parse(rawBody) as { type: string; data: { object: { id: string; status?: string; customer?: string; metadata?: Record<string, string> } } };
    if (event.type === 'setup_intent.succeeded' && this.stripe) {
      const obj = event.data.object;
      const companyId = obj.metadata?.companyId;
      if (companyId && this.store.companies.get(companyId)) await this.applyIntent(companyId, await this.stripe.retrieveSetupIntent(obj.id));
    }
    return { received: true };
  }
}

/** Stripe's scheme: header `t=…,v1=…`, signed payload `t.body` with HMAC-SHA256. */
export function verifyStripeSignature(body: string, header: string | undefined, secret: string, nowMs: number, toleranceSeconds = 300): void {
  const bad = new ApiError(400, 'bad_signature', 'The signature doesn’t match.');
  if (!header) throw bad;
  const parts = Object.fromEntries(header.split(',').map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; }));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) throw bad;
  if (Math.abs(nowMs / 1000 - t) > toleranceSeconds) throw new ApiError(400, 'stale_signature', 'That event is too old.');
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  const given = Buffer.from(parts.v1, 'hex'); const want = Buffer.from(expected, 'hex');
  if (given.length !== want.length || !timingSafeEqual(given, want)) throw bad;
}
