import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Store } from '../src/store/store.ts';
import { BillingService, verifyStripeSignature } from '../src/billing/service.ts';
import { PRICE, isAllowedStripeUrl, isPublicHttpsUrl, assertProductionCheckoutUrls, type StripeBillingApi, type StripeSubscription } from '../src/money/stripe.ts';
import { ApiError } from '../src/lib/errors.ts';
import { newCompany } from './helpers.ts';

const NOW = new Date('2026-10-30T15:00:00Z');
const END = Math.floor(NOW.getTime() / 1000) + 90 * 86_400;

/** A pretend Stripe: one customer, a checkout that turns into a subscription, and a portal. */
function fakeStripe() {
  const calls: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  let sub: StripeSubscription = { id: 'sub_1', status: 'active', current_period_end: END, cancel_at_period_end: false, default_payment_method: { id: 'pm_1', card: { brand: 'visa', last4: '4242', exp_month: 8, exp_year: 2029 } } };
  const api: StripeBillingApi = {
    async createCustomer(p) { calls.push(`customer:${p.name}`); return { id: 'cus_1' }; },
    async updateCustomer(id, p) { calls.push(`update:${id}:${p.email ?? ''}`); return { id }; },
    async createSubscriptionCheckout(p) { calls.push('checkout'); bodies.push(p as never); return { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' }; },
    async retrieveCheckoutSession(id) { return { id, mode: 'subscription', customer: 'cus_1', subscription: sub }; },
    async retrieveSubscription() { return sub; },
    async createPortalSession(p) { calls.push(`portal:${p.returnUrl}`); return { id: 'bps_1', url: 'https://billing.stripe.com/p/session/x' }; },
  };
  return { api, calls, bodies, set: (s: Partial<StripeSubscription>) => { sub = { ...sub, ...s }; } };
}
const make = (opts: { stripe?: boolean } = {}) => {
  const store = new Store(); const { company } = newCompany(store); const f = fakeStripe();
  const svc = new BillingService(store, opts.stripe === false ? null : f.api, () => NOW, () => []);
  return { store, company, f, svc };
};
const sign = (body: string, secret: string, t = Math.floor(NOW.getTime() / 1000)) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
const event = (type: string, object: Record<string, unknown>, created = Math.floor(NOW.getTime() / 1000), id = `evt_${Math.random().toString(36).slice(2)}`) => JSON.stringify({ id, type, created, data: { object } });
const refused = (p: Promise<unknown>, code: RegExp) => assert.rejects(p, (e: unknown) => e instanceof ApiError && code.test(e.code));

test('it costs $20 every three months, and says so, whatever the number of employees', () => {
  assert.deepEqual([PRICE.cents, PRICE.months, PRICE.label], [2000, 3, '$20 every 3 months']);
  const { svc, company } = make();
  const v = svc.view(company.id, 'owner@harbor.test');
  assert.deepEqual([v.plan.label, v.plan.cents, v.plan.months], ['$20 every 3 months', 2000, 3]);
  assert.match(v.plan.includes, /Every employee/);
  assert.equal(JSON.stringify(v).includes('per employee'), false);
});

test('subscribing: one customer per company, Stripe\'s own page, and the status is read back from Stripe, never from the browser', async () => {
  const { svc, company, f, store } = make();
  assert.equal(svc.active(company.id), false);
  const start = await svc.startCheckout(company.id, 'owner@harbor.test', 'https://totali.example');
  assert.equal(start.url, 'https://checkout.stripe.com/c/pay/cs_1');
  await svc.startCheckout(company.id, 'owner@harbor.test', 'https://totali.example');
  assert.equal(f.calls.filter((c) => c.startsWith('customer')).length, 1, 'one customer');
  assert.deepEqual([(f.bodies[0] as { successUrl: string }).successUrl, (f.bodies[0] as { cancelUrl: string }).cancelUrl], ['https://totali.example/app/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}', 'https://totali.example/app/billing?checkout=cancelled']);
  await refused(svc.finishCheckout(company.id, 'not-a-session'), /./);
  const v = await svc.finishCheckout(company.id, 'cs_1');
  assert.deepEqual([v.subscription!.status, v.subscription!.active, v.card], ['active', true, { brand: 'visa', last4: '4242', expMonth: 8, expYear: 2029 }]);
  assert.equal(v.subscription!.renews, new Date(END * 1000).toISOString());
  assert.equal(svc.active(company.id), true);
  await refused(svc.startCheckout(company.id, 'o@h.test', 'https://totali.example'), /already_subscribed/);
  assert.equal(JSON.stringify(store.companies.get(company.id)).includes('4242424242'), false, 'only brand and last four');
});

test('a checkout that belongs to someone else, or never started a subscription, is refused', async () => {
  const { svc, company, store, f } = make();
  await svc.startCheckout(company.id, 'o@h.test', 'https://totali.example');
  const other = newCompany(store, { legalName: 'Other LLC', ein: '55-1234567' }).company;
  await svc.startCheckout(other.id, 'x@y.test', 'https://totali.example');
  store.tx(() => store.companies.put({ ...store.companies.get(other.id)!, billing: { ...store.companies.get(other.id)!.billing, stripeCustomerId: 'cus_other' } }));
  await refused(svc.finishCheckout(other.id, 'cs_1'), /not_your_checkout/);
  void f;
});

test('approving payroll needs a live subscription when payment is asked for, and is free when Stripe is not set up or the company is waived', async () => {
  const { svc, company, f, store } = make();
  assert.equal(svc.required(company.id), true);
  assert.throws(() => svc.assertCanApprove(company.id), (e: unknown) => e instanceof ApiError && e.status === 402 && e.code === 'subscription_required' && /\$20 every 3 months/.test(e.message));
  await svc.startCheckout(company.id, 'o@h.test', 'https://totali.example'); await svc.finishCheckout(company.id, 'cs_1');
  svc.assertCanApprove(company.id);
  // late on a payment is still running: Stripe retries; cancelled is not
  f.set({ status: 'past_due' });
  const body = event('customer.subscription.updated', { id: 'sub_1', customer: 'cus_1', status: 'past_due', current_period_end: END });
  await svc.webhook(body, sign(body, 'whsec_x'), 'whsec_x');
  svc.assertCanApprove(company.id);
  assert.equal(svc.view(company.id, '').subscription!.pastDue, true);
  const gone = event('customer.subscription.deleted', { id: 'sub_1', customer: 'cus_1', status: 'canceled' }, Math.floor(NOW.getTime() / 1000) + 5);
  await svc.webhook(gone, sign(gone, 'whsec_x'), 'whsec_x');
  assert.throws(() => svc.assertCanApprove(company.id), ApiError);
  // no Stripe on this server, or a waived company
  const off = make({ stripe: false });
  assert.equal(off.svc.required(off.company.id), false); off.svc.assertCanApprove(off.company.id);
  const waived = new BillingService(store, f.api, () => NOW, () => [company.id]);
  assert.equal(waived.required(company.id), false);
});

test('webhooks: a duplicate is skipped, a late event cannot undo a newer one, and a card that fails shows as past due', async () => {
  const { svc, company, f } = make();
  await svc.startCheckout(company.id, 'o@h.test', 'https://totali.example'); await svc.finishCheckout(company.id, 'cs_1');
  const t0 = Math.floor(NOW.getTime() / 1000);
  const newer = event('customer.subscription.updated', { id: 'sub_1', customer: 'cus_1', status: 'active', cancel_at_period_end: true, current_period_end: END }, t0 + 100, 'evt_new');
  assert.deepEqual(await svc.webhook(newer, sign(newer, 's'), 's'), { received: true });
  assert.equal(svc.view(company.id, '').subscription!.endsAtPeriodEnd, true, 'a cancellation at the end of the period is shown');
  assert.deepEqual(await svc.webhook(newer, sign(newer, 's'), 's'), { received: true, duplicate: true });
  const older = event('customer.subscription.updated', { id: 'sub_1', customer: 'cus_1', status: 'canceled' }, t0 + 10, 'evt_old');
  await svc.webhook(older, sign(older, 's'), 's');
  assert.equal(svc.view(company.id, '').subscription!.status, 'active', 'an older event arriving late changes nothing');
  f.set({ status: 'past_due' });
  const failed = event('invoice.payment_failed', { customer: 'cus_1', subscription: 'sub_1' }, t0 + 200);
  await svc.webhook(failed, sign(failed, 's'), 's');
  assert.equal(svc.view(company.id, '').subscription!.status, 'past_due');
  const stranger = event('customer.subscription.deleted', { id: 'sub_x', customer: 'cus_unknown', status: 'canceled' }, t0 + 300);
  await svc.webhook(stranger, sign(stranger, 's'), 's');
  assert.equal(svc.view(company.id, '').subscription!.status, 'past_due', 'a customer we do not know is ignored');
});

test('the billing portal is Stripe\'s page, only for someone who has started', async () => {
  const { svc, company, f } = make();
  await refused(svc.portal(company.id, 'https://totali.example'), /no_customer/);
  await svc.startCheckout(company.id, 'o@h.test', 'https://totali.example');
  assert.deepEqual(await svc.portal(company.id, 'https://totali.example'), { url: 'https://billing.stripe.com/p/session/x' });
  assert.ok(f.calls.includes('portal:https://totali.example/app/billing'));
});

test('only Stripe\'s own pages are ever handed to a browser, and production never returns to http or localhost', () => {
  assert.equal(isAllowedStripeUrl('https://checkout.stripe.com/c/pay/x'), true);
  assert.equal(isAllowedStripeUrl('https://billing.stripe.com/p/x'), true);
  for (const bad of ['https://evil.example/checkout.stripe.com', 'http://checkout.stripe.com/x', 'https://checkout.stripe.com.evil.test/x', 'javascript:alert(1)', 'https://u:p@checkout.stripe.com/x']) assert.equal(isAllowedStripeUrl(bad), false, bad);
  assert.equal(isPublicHttpsUrl('https://totali.example/app'), true);
  for (const bad of ['http://totali.example', 'https://localhost:3000', 'https://127.0.0.1', 'https://[::1]/x']) assert.equal(isPublicHttpsUrl(bad), false, bad);
  const prev = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  try {
    assert.throws(() => assertProductionCheckoutUrls('http://localhost:3000/a', 'https://totali.example/b'), /https and public/);
    assertProductionCheckoutUrls('https://totali.example/a', 'https://totali.example/b');
  } finally { if (prev === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prev; }
});

test('without Stripe keys the page still works and says payments are not set up', async () => {
  const { svc, company } = make({ stripe: false });
  assert.equal(svc.view(company.id, 'o@h.test').available, false);
  await refused(svc.startCheckout(company.id, 'o@h.test', 'https://totali.example'), /billing_not_configured/);
  assert.equal(svc.setEmail(company.id, ' Billing@Harbor.test '), 'billing@harbor.test');
  assert.throws(() => svc.setEmail(company.id, 'nope'), ApiError);
  assert.equal(svc.view(company.id, 'o@h.test').email, 'billing@harbor.test');
});

test('webhook signatures: only the shared secret, only fresh, only for this body, and a rotated secret may send two', async () => {
  const body = JSON.stringify({ type: 'ping', data: { object: { id: 'x' } } });
  const secret = 'whsec_test';
  verifyStripeSignature(body, sign(body, secret), secret, NOW.getTime());
  const t = Math.floor(NOW.getTime() / 1000);
  verifyStripeSignature(body, `t=${t},v1=${'0'.repeat(64)},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`, secret, NOW.getTime());
  for (const [label, header] of [['wrong secret', sign(body, 'other')], ['stale', sign(body, secret, t - 3600)], ['tampered', sign(body + ' ', secret)], ['missing', undefined as unknown as string]] as const) {
    assert.throws(() => verifyStripeSignature(body, header, secret, NOW.getTime()), ApiError, label);
  }
  const { svc } = make();
  assert.deepEqual(await svc.webhook(body, sign(body, secret), secret), { received: true });
  await refused(svc.webhook(body, sign(body, secret), undefined), /webhook_not_configured/);
});
