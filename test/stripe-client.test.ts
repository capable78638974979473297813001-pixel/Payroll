import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { StripeClient, StripeError, stripeKeyRefused, stripeMode, formEncode } from '../src/money/stripe.ts';
import { constructEvent, signPayload } from '../src/money/webhooks.ts';

let server: Server;
let base = '';
type Seen = { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string };
let seen: Seen[] = [];
let responder: (n: number, req: Seen) => { status: number; body: unknown } = () => ({ status: 200, body: {} });

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const s: Seen = { method: req.method!, url: req.url!, headers: req.headers, body };
      seen.push(s);
      const r = responder(seen.length, s);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => server.close());
beforeEach(() => {
  seen = [];
  process.env.STRIPE_API_BASE = base;
  process.env.STRIPE_SECRET_KEY = 'sk_test_unit';
  delete process.env.STRIPE_ALLOW_LIVE;
  delete process.env.STRIPE_CONNECT_SERVICE_AGREEMENT;
  responder = () => ({ status: 200, body: {} });
});

test('form encoding matches Stripe: nested keys and arrays', () => {
  assert.equal(decodeURIComponent(formEncode({ a: { b: 1 }, c: ['x', 'y'], d: undefined, e: null }).join('&')), 'a[b]=1&c[]=x&c[]=y');
});

test('a transfer carries the secret key, the idempotency key and an integer amount in a form body', async () => {
  responder = () => ({ status: 200, body: { id: 'tr_1', amount: 12345, destination: 'acct_1' } });
  const t = await new StripeClient().createTransfer({ amount: 12345, destination: 'acct_1', transferGroup: 'run_1', description: 'Payroll', metadata: { run_id: 'run_1' } }, 'totali_payout_run_1_emp_1_a1');
  assert.equal(t.id, 'tr_1');
  const r = seen[0];
  assert.equal(r.method, 'POST');
  assert.equal(r.url, '/v1/transfers');
  assert.equal(r.headers.authorization, 'Bearer sk_test_unit');
  assert.equal(r.headers['idempotency-key'], 'totali_payout_run_1_emp_1_a1');
  const form = new URLSearchParams(r.body);
  assert.equal(form.get('amount'), '12345');
  assert.equal(form.get('currency'), 'usd');
  assert.equal(form.get('destination'), 'acct_1');
  assert.equal(form.get('metadata[run_id]'), 'run_1');
});

test('the employer debit is an off-session us_bank_account PaymentIntent', async () => {
  responder = () => ({ status: 200, body: { id: 'pi_1', status: 'processing', amount: 5000 } });
  await new StripeClient().createPaymentIntent({ amount: 5000, customer: 'cus_1', paymentMethod: 'pm_1', transferGroup: 'run_1', description: 'd', metadata: { run_id: 'run_1' } }, 'k1');
  const f = new URLSearchParams(seen[0].body);
  assert.equal(f.get('payment_method_types[]'), 'us_bank_account');
  assert.equal(f.get('confirm'), 'true');
  assert.equal(f.get('off_session'), 'true');
  assert.equal(f.get('customer'), 'cus_1');
  assert.equal(f.get('payment_method'), 'pm_1');
});

test('a Stripe 4xx is definitive and is not retried', async () => {
  responder = () => ({ status: 402, body: { error: { type: 'card_error', code: 'x', message: 'nope' } } });
  await assert.rejects(new StripeClient().createTransfer({ amount: 1, destination: 'a', transferGroup: 'g', description: 'd', metadata: {} }, 'k'), (e: any) => e instanceof StripeError && e.definitive && e.message === 'nope');
  assert.equal(seen.length, 1);
});

test('a 5xx is retried with the same idempotency key and then succeeds', async () => {
  responder = (n) => (n < 3 ? { status: 503, body: { error: { message: 'down' } } } : { status: 200, body: { id: 'tr_9', amount: 1, destination: 'a' } });
  const t = await new StripeClient().createTransfer({ amount: 1, destination: 'a', transferGroup: 'g', description: 'd', metadata: {} }, 'same-key');
  assert.equal(t.id, 'tr_9');
  assert.equal(seen.length, 3);
  assert.ok(seen.every((s) => s.headers['idempotency-key'] === 'same-key'));
});

test('persistent 5xx surfaces as an unknown outcome, not a definitive failure', async () => {
  responder = () => ({ status: 500, body: {} });
  await assert.rejects(new StripeClient().createTransfer({ amount: 1, destination: 'a', transferGroup: 'g', description: 'd', metadata: {} }, 'k'), (e: any) => e instanceof StripeError && e.definitive === false);
});

test('a connection failure is an unknown outcome', async () => {
  process.env.STRIPE_API_BASE = 'http://127.0.0.1:1';
  await assert.rejects(new StripeClient({ timeoutMs: 500 }).createTransfer({ amount: 1, destination: 'a', transferGroup: 'g', description: 'd', metadata: {} }, 'k'), (e: any) => e instanceof StripeError && e.definitive === false);
});

test('live keys are refused unless STRIPE_ALLOW_LIVE=1, and nothing is sent', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_live_abc';
  assert.match(stripeKeyRefused()!, /STRIPE_ALLOW_LIVE/);
  assert.equal(stripeMode(), 'live');
  await assert.rejects(new StripeClient().availableBalanceCents(), (e: any) => e.type === 'live_key_refused');
  assert.equal(seen.length, 0);
  process.env.STRIPE_ALLOW_LIVE = '1';
  assert.equal(stripeKeyRefused(), null);
});

test('no key configured: a clear error and nothing is sent', async () => {
  delete process.env.STRIPE_SECRET_KEY;
  assert.equal(stripeMode(), 'unconfigured');
  await assert.rejects(new StripeClient().availableBalanceCents(), (e: any) => e.type === 'config_error');
  assert.equal(seen.length, 0);
});

test('connected accounts are Express with transfers only; the recipient agreement is opt-in', async () => {
  responder = () => ({ status: 200, body: { id: 'acct_1' } });
  await new StripeClient().createAccount({ email: 'a@b.test', metadata: { employee_id: 'emp_1' } }, 'k1');
  let f = new URLSearchParams(seen[0].body);
  assert.equal(f.get('type'), 'express');
  assert.equal(f.get('capabilities[transfers][requested]'), 'true');
  assert.equal(f.get('tos_acceptance[service_agreement]'), null);
  process.env.STRIPE_CONNECT_SERVICE_AGREEMENT = 'recipient';
  await new StripeClient().createAccount({ metadata: { employee_id: 'emp_2' } }, 'k2');
  f = new URLSearchParams(seen[1].body);
  assert.equal(f.get('tos_acceptance[service_agreement]'), 'recipient');
});

test('balance sums available USD only', async () => {
  responder = () => ({ status: 200, body: { available: [{ amount: 500, currency: 'usd' }, { amount: 900, currency: 'eur' }, { amount: 250, currency: 'usd' }] } });
  assert.equal(await new StripeClient().availableBalanceCents(), 750);
});

// ---------------------------------------------------------------- webhook signatures

const SECRET = 'whsec_unit';
const body = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded', data: { object: { id: 'pi_1' } } });

test('webhook: a valid signature is accepted', () => {
  const now = 1_800_000_000;
  assert.equal(constructEvent(body, signPayload(body, SECRET, now), SECRET, now).id, 'evt_1');
});

test('webhook: a tampered body, wrong secret, stale timestamp, or missing header is rejected', () => {
  const now = 1_800_000_000;
  const good = signPayload(body, SECRET, now);
  assert.throws(() => constructEvent(body.replace('pi_1', 'pi_2'), good, SECRET, now), /does not match/);
  assert.throws(() => constructEvent(body, signPayload(body, 'whsec_other', now), SECRET, now), /does not match/);
  assert.throws(() => constructEvent(body, good, SECRET, now + 301), /tolerance/);
  assert.throws(() => constructEvent(body, undefined, SECRET, now), /Missing/);
  assert.throws(() => constructEvent(body, 'garbage', SECRET, now), /Malformed/);
  assert.throws(() => constructEvent(body, good, '', now), /not set/);
});

test('webhook: any one of several configured endpoint secrets may match', () => {
  const now = 1_800_000_000;
  const header = signPayload(body, 'whsec_connect', now);
  assert.equal(constructEvent(body, header, ['whsec_main', 'whsec_connect'], now).id, 'evt_1');
  assert.throws(() => constructEvent(body, header, ['whsec_main', 'whsec_other'], now), /does not match/);
});

test('webhook: any one of several v1 signatures may match (key rotation)', () => {
  const now = 1_800_000_000;
  const good = signPayload(body, SECRET, now);
  const header = good.replace('v1=', 'v1=deadbeef,v1=');
  assert.equal(constructEvent(body, header, SECRET, now).type, 'payment_intent.succeeded');
});
