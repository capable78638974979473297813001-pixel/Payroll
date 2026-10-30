import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Store } from '../src/store/store.ts';
import { BillingService, verifyStripeSignature } from '../src/billing/service.ts';
import type { StripeBillingApi } from '../src/money/stripe.ts';
import { ApiError } from '../src/lib/errors.ts';
import { newCompany } from './helpers.ts';

function fakeStripe() {
  const calls: string[] = [];
  let intentStatus = 'succeeded';
  const api: StripeBillingApi = {
    async createCustomer(p) { calls.push(`customer:${p.name}`); return { id: 'cus_1' }; },
    async updateCustomer(id, p) { calls.push(`update:${id}:${p.invoice_settings?.default_payment_method ?? ''}`); return { id }; },
    async createSetupIntent(p) { calls.push(`intent:${p.customer}`); return { id: 'seti_1', client_secret: 'seti_1_secret_x' }; },
    async retrieveSetupIntent(id) { return { id, status: intentStatus, customer: 'cus_1', payment_method: { id: 'pm_1', card: { brand: 'visa', last4: '4242', exp_month: 8, exp_year: 2029 } } }; },
    async detachPaymentMethod(id) { calls.push(`detach:${id}`); return { id }; },
  };
  return { api, calls, setStatus: (s: string) => { intentStatus = s; } };
}
const NOW = new Date('2026-10-30T15:00:00Z');
const make = () => { const store = new Store(); const { company } = newCompany(store); const f = fakeStripe(); const svc = new BillingService(store, f.api, () => NOW, () => 'pk_test_123'); return { store, company, svc, f }; };
const sign = (body: string, secret: string, t = Math.floor(NOW.getTime() / 1000)) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

test('saving a card: a customer, a setup intent, and only the brand and last four are kept', async () => {
  const { svc, company, store, f } = make();
  const start = await svc.startCard(company.id, 'owner@harbor.test');
  assert.equal(start.clientSecret, 'seti_1_secret_x');
  assert.equal(start.publishableKey, 'pk_test_123');
  await svc.startCard(company.id, 'owner@harbor.test');
  assert.equal(f.calls.filter((c) => c.startsWith('customer')).length, 1, 'one customer per company');
  const done = await svc.finishCard(company.id, 'seti_1');
  assert.deepEqual(done, { brand: 'visa', last4: '4242' });
  assert.ok(f.calls.includes('update:cus_1:pm_1'));
  const view = svc.view(company.id, 'owner@harbor.test');
  assert.deepEqual(view.card, { brand: 'visa', last4: '4242', expMonth: 8, expYear: 2029 });
  assert.equal(JSON.stringify(store.companies.get(company.id)).includes('4242424242'), false);
  assert.equal(view.plan.label, 'Early access');
  assert.equal(JSON.stringify(view).match(/\$\d/), null, 'no price appears anywhere');
});

test('a card that was not saved, or belongs to someone else, is refused; a replaced card is detached', async () => {
  const { svc, company, f } = make();
  await svc.startCard(company.id, 'o@h.test');
  f.setStatus('requires_action');
  await assert.rejects(svc.finishCard(company.id, 'seti_1'), (e: unknown) => e instanceof ApiError && e.code === 'card_not_saved');
  await assert.rejects(svc.finishCard(company.id, 'not-a-setup-intent'), ApiError);
  f.setStatus('succeeded');
  await svc.finishCard(company.id, 'seti_1');
  const other = newCompany((svc as unknown as { store: Store }).store, { legalName: 'Other LLC', ein: '55-1234567' }).company;
  await assert.rejects(svc.finishCard(other.id, 'seti_1'), (e: unknown) => e instanceof ApiError && e.code === 'not_your_card');
});

test('without Stripe keys, cards are unavailable and the page still works', async () => {
  const store = new Store(); const { company } = newCompany(store);
  const svc = new BillingService(store, null, () => NOW, () => '');
  assert.equal(svc.view(company.id, 'o@h.test').cardsAvailable, false);
  await assert.rejects(svc.startCard(company.id, 'o@h.test'), (e: unknown) => e instanceof ApiError && e.code === 'billing_not_configured');
  assert.equal(svc.setEmail(company.id, ' Billing@Harbor.test '), 'billing@harbor.test');
  assert.throws(() => svc.setEmail(company.id, 'nope'), ApiError);
  assert.equal(svc.view(company.id, 'o@h.test').email, 'billing@harbor.test');
});

test('webhook signatures: only the shared secret, only fresh, only for this body', async () => {
  const body = JSON.stringify({ type: 'ping', data: { object: { id: 'x' } } });
  const secret = 'whsec_test';
  verifyStripeSignature(body, sign(body, secret), secret, NOW.getTime());
  for (const [label, header] of [['wrong secret', sign(body, 'other')], ['stale', sign(body, secret, Math.floor(NOW.getTime() / 1000) - 3600)], ['tampered', sign(body + ' ', secret)], ['missing', undefined as unknown as string], ['garbage', 'v1=zz']] as const) {
    assert.throws(() => verifyStripeSignature(body, header, secret, NOW.getTime()), ApiError, label);
  }
  const { svc } = make();
  assert.deepEqual(await svc.webhook(body, sign(body, secret), secret), { received: true });
  await assert.rejects(svc.webhook(body, sign(body, secret), undefined), (e: unknown) => e instanceof ApiError && e.code === 'webhook_not_configured');
});
