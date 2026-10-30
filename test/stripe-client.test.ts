import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { StripeClient, StripeError, stripeKeyRefused, stripeMode, formEncode } from '../src/money/stripe.ts';

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
  responder = () => ({ status: 200, body: {} });
});

test('form encoding matches Stripe: nested keys and arrays', () => {
  assert.equal(decodeURIComponent(formEncode({ a: { b: 1 }, c: ['x', 'y'], d: undefined, e: null }).join('&')), 'a[b]=1&c[]=x&c[]=y');
});

test('a bank-link session asks for ownership and balances, scoped to one customer, never for payment access', async () => {
  responder = () => ({ status: 200, body: { id: 'fcsess_1', client_secret: 'fcsess_1_secret' } });
  const s = await new StripeClient().createFcSession({ customer: 'cus_1', permissions: ['balances', 'ownership'], prefetch: ['ownership'] }, 'key-1');
  assert.equal(s.id, 'fcsess_1');
  const r = seen[0];
  assert.equal(r.method, 'POST');
  assert.equal(r.url, '/v1/financial_connections/sessions');
  assert.equal(r.headers.authorization, 'Bearer sk_test_unit');
  assert.equal(r.headers['idempotency-key'], 'key-1');
  const f = new URLSearchParams(r.body);
  assert.equal(f.get('account_holder[type]'), 'customer');
  assert.equal(f.get('account_holder[customer]'), 'cus_1');
  assert.deepEqual(f.getAll('permissions[]'), ['balances', 'ownership']);
  assert.deepEqual(f.getAll('prefetch[]'), ['ownership']);
  assert.equal(f.get('filters[country]'), 'US');
  assert.ok(!f.getAll('permissions[]').includes('payment_method'));
});

test('reading a session, an account with ownership expanded, and refreshing', async () => {
  responder = (_n, req) => ({ status: 200, body: req.url!.includes('/sessions/') ? { id: 'fcsess_1', accounts: { data: [{ id: 'fca_1', last4: '6789' }] } } : { id: 'fca_1' } });
  const client = new StripeClient();
  const sess = await client.retrieveFcSession('fcsess_1');
  assert.equal(sess.accounts!.data![0].last4, '6789');
  assert.equal(seen[0].url, '/v1/financial_connections/sessions/fcsess_1');
  await client.retrieveFcAccount('fca_1', { expandOwnership: true });
  assert.equal(decodeURIComponent(seen[1].url), '/v1/financial_connections/accounts/fca_1?expand[]=ownership');
  await client.refreshFcAccount('fca_1', ['ownership', 'balance']);
  assert.equal(seen[2].method, 'POST');
  assert.equal(seen[2].url, '/v1/financial_connections/accounts/fca_1/refresh');
  assert.deepEqual(new URLSearchParams(seen[2].body).getAll('features[]'), ['ownership', 'balance']);
});

test('a customer is created with an idempotency key', async () => {
  responder = () => ({ status: 200, body: { id: 'cus_9' } });
  await new StripeClient().createCustomer({ name: 'Corner Table LLC', metadata: { totali_owner: 'co_1' } }, 'totali_cus_co_1');
  assert.equal(seen[0].headers['idempotency-key'], 'totali_cus_co_1');
  assert.equal(new URLSearchParams(seen[0].body).get('metadata[totali_owner]'), 'co_1');
});

test('a Stripe 4xx is definitive and is not retried', async () => {
  responder = () => ({ status: 400, body: { error: { type: 'invalid_request_error', message: 'nope' } } });
  await assert.rejects(new StripeClient().retrieveFcSession('x'), (e: any) => e instanceof StripeError && e.definitive && e.message === 'nope');
  assert.equal(seen.length, 1);
});

test('a 5xx is retried and then succeeds; persistent 5xx is an unknown outcome', async () => {
  responder = (n) => (n < 3 ? { status: 503, body: { error: { message: 'down' } } } : { status: 200, body: { id: 'fcsess_1' } });
  assert.equal((await new StripeClient().retrieveFcSession('fcsess_1')).id, 'fcsess_1');
  assert.equal(seen.length, 3);
  seen = [];
  responder = () => ({ status: 500, body: {} });
  await assert.rejects(new StripeClient().retrieveFcSession('x'), (e: any) => e instanceof StripeError && e.definitive === false);
});

test('a connection failure is an unknown outcome', async () => {
  process.env.STRIPE_API_BASE = 'http://127.0.0.1:1';
  await assert.rejects(new StripeClient({ timeoutMs: 500 }).retrieveFcSession('x'), (e: any) => e instanceof StripeError && e.definitive === false);
});

test('live keys are refused unless STRIPE_ALLOW_LIVE=1, and nothing is sent', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_live_abc';
  assert.match(stripeKeyRefused()!, /STRIPE_ALLOW_LIVE/);
  assert.equal(stripeMode(), 'live');
  await assert.rejects(new StripeClient().retrieveFcSession('x'), (e: any) => e.type === 'live_key_refused');
  assert.equal(seen.length, 0);
  process.env.STRIPE_ALLOW_LIVE = '1';
  assert.equal(stripeKeyRefused(), null);
});

test('no key configured: a clear error and nothing is sent', async () => {
  delete process.env.STRIPE_SECRET_KEY;
  assert.equal(stripeMode(), 'unconfigured');
  await assert.rejects(new StripeClient().retrieveFcSession('x'), (e: any) => e.type === 'config_error');
  assert.equal(seen.length, 0);
});

test('the client cannot create a payment, a payout or a transfer: Stripe links banks and saves the owner\'s own card for Totali\'s invoices, nothing else', () => {
  const methods = Object.getOwnPropertyNames(StripeClient.prototype).filter((m) => m !== 'constructor');
  // Bank linking: customer, Financial Connections. Billing: save a card (SetupIntent), read it, detach it. No charge, payment intent, payout or transfer.
  assert.deepEqual(methods.sort(), ['call', 'createCustomer', 'createFcSession', 'createSetupIntent', 'detachPaymentMethod', 'key', 'refreshFcAccount', 'retrieveFcAccount', 'retrieveFcSession', 'retrieveSetupIntent', 'updateCustomer']);
  assert.ok(!methods.some((m) => /charge|paymentIntent|payout|transfer|refund/i.test(m)));
});
