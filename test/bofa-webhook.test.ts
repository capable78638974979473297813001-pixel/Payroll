import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/api/app.ts';
import { BOFA_ACCESS_TOKEN_TTL_MS, credentialsMatch } from '../src/bofa/notify.ts';
import { Store } from '../src/store/store.ts';
import { BankService } from '../src/banking/accounts.ts';
import { AchService } from '../src/money/ach.ts';
import { SandboxBank } from '../src/ach/sandbox.ts';
import { decryptField } from '../src/lib/crypto.ts';
import type { Config } from '../src/config.ts';
import { FakeStripe } from './fake-stripe.ts';
import { TEST_DATA_KEY } from './helpers.ts';

const USER = 'bofa-test-user';
const KEY = 'bofa-test-auth-key-do-not-log';
const ACCOUNT = '000123456789';
const clock = { now: new Date('2026-11-06T18:00:00.000Z') };
const logs: string[] = [];
const dir = mkdtempSync(join(tmpdir(), 'bofa-'));
const dataFile = join(dir, 'db.sqlite');

const config: Config = {
  port: 0,
  dataFile,
  adminToken: 'admin-token-for-bofa-tests',
  openSignup: false,
  ach: { mode: 'sandbox', outboxDir: '', config: { originator: { odfiRoutingNumber: '021000021', odfiName: 'Test Sponsor Bank', immediateOrigin: '123456789', companyName: 'Totali Payroll', companyId: '1123456789' }, holdBankingDays: 2, fundingLeadBankingDays: 1, creditLeadBankingDays: 1, trustSettlementDate: false } },
  autoDisburse: false,
  rateLimitPerMinute: 0,
  trustProxy: false,
};

const store = new Store(dataFile);
let base = '';
let serverClosed = false;
let serverClose: () => Promise<void> = async () => {};

function setCreds(): void {
  process.env.BOFA_WEBHOOK_USER = USER;
  process.env.BOFA_WEBHOOK_KEY = KEY;
  process.env.TOTALI_DATA_KEY = TEST_DATA_KEY;
}

before(async () => {
  setCreds();
  const banks = new BankService(store, new FakeStripe(), { now: () => clock.now });
  const ach = new AchService(store, banks, new SandboxBank(), config.ach.config, { now: () => clock.now });
  const app = createApp({ store, banks, ach, config, now: () => clock.now, log: (m) => logs.push(m) });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  serverClose = () => new Promise((resolve) => {
    if (serverClosed) return resolve();
    serverClosed = true;
    app.server.close(() => resolve());
  });
});

after(async () => {
  await serverClose();
  try { store.close(); } catch { /* already closed by the persistence test */ }
  rmSync(dir, { recursive: true, force: true });
  delete process.env.BOFA_WEBHOOK_USER;
  delete process.env.BOFA_WEBHOOK_KEY;
});

async function call(path: string, opts: { body?: unknown; raw?: string; headers?: Record<string, string> } = {}) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { ...(opts.body !== undefined || opts.raw !== undefined ? { 'content-type': 'application/json' } : {}), ...opts.headers },
    body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  const text = await res.text();
  let body: any = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body, text, type: res.headers.get('content-type') };
}

function takeLogs(): string {
  return logs.splice(0).join('\n');
}

function assertQuiet(text: string): void {
  assert.equal(text.includes(KEY), false);
  assert.equal(text.includes(USER), false);
  assert.equal(text.includes(ACCOUNT), false);
}

const notice = (over: Record<string, unknown> = {}) => ({
  transactionIdentification: 'TXN-1001',
  status: 'Settlement Complete',
  endToEndIdentification: 'SenderRef18',
  reason: [{ reasonCode: 'CP502', reasonDescription: 'Cannot process due to compliance. Please contact your treasury team.' }],
  accountNumber: ACCOUNT,
  ...over,
});

test('GET on the CashPro URLs is not the holding page', async () => {
  const res = await fetch(base + '/api/bofa/auth');
  const text = await res.text();
  assert.equal(res.status, 405);
  assert.match(res.headers.get('content-type') ?? '', /json/);
  assert.equal(text.includes('<html'), false);
  assert.equal((await fetch(base + '/health')).status, 200);
});

test('auth accepts the published clientID and clientSceret and returns a short accessToken', async () => {
  const res = await call('/api/bofa/auth', { body: { clientID: USER, clientSceret: KEY } });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'SUCCESS');
  assert.equal(typeof res.body.accessToken, 'string');
  assert.ok(res.body.accessToken.length >= 1 && res.body.accessToken.length <= 550);
  assert.equal(res.body.access_token, undefined);
  assert.equal(res.body.token_type, undefined);
  assertQuiet(JSON.stringify(res.body));
  assertQuiet(takeLogs());
  assert.match(takeLogs(), /^$/);
});

test('auth also accepts clientSecret and the userId/userAuthKey headers', async () => {
  const corrected = await call('/api/bofa/auth', { body: { clientID: USER, clientSecret: KEY } });
  assert.equal(corrected.status, 200);
  assert.equal(corrected.body.status, 'SUCCESS');
  const headers = await call('/api/bofa/auth', { headers: { userId: USER, userAuthKey: KEY } });
  assert.equal(headers.status, 200);
  assert.equal(headers.body.status, 'SUCCESS');
  assert.equal(credentialsMatch({ user: USER, key: 'short' }, { user: USER, key: KEY }), false);
  assert.equal(credentialsMatch({ user: 'other-user', key: KEY }, { user: USER, key: KEY }), false);
  assertQuiet(takeLogs());
});

test('auth rejects a wrong or missing UserAuthKey with 401 and no secret in the answer', async () => {
  const wrong = await call('/api/bofa/auth', { body: { clientID: USER, clientSceret: 'wrong-secret-not-the-key' } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.status, 'ERROR');
  assert.equal(wrong.body.errorCode, '101');
  assert.equal(wrong.body.reasonDescription, 'Authentication Failed');
  assert.equal(JSON.stringify(wrong.body).includes('wrong-secret-not-the-key'), false);
  const swapped = await call('/api/bofa/auth', { body: { clientID: 'someone-else', clientSceret: KEY } });
  assert.equal(swapped.status, 401);
  const missing = await call('/api/bofa/auth', { body: {} });
  assert.equal(missing.status, 401);
  const junk = await call('/api/bofa/auth', { raw: '{not json' });
  assert.equal(junk.status, 400);
  const logged = takeLogs();
  assertQuiet(logged);
  assert.match(logged, /bad-credentials/);
});

test('auth and webhook return 503 when either env var is missing and store nothing', async () => {
  const before = store.bofaNotifications.all().length;
  delete process.env.BOFA_WEBHOOK_KEY;
  const auth = await call('/api/bofa/auth', { body: { clientID: USER, clientSceret: KEY } });
  const hook = await call('/api/bofa/webhook', { body: notice(), headers: { authorization: 'Bearer whatever' } });
  assert.equal(auth.status, 503);
  assert.equal(hook.status, 503);
  assert.equal(auth.body.status, 'ERROR');
  assert.equal(hook.body.reasonCode, '503');
  process.env.BOFA_WEBHOOK_KEY = KEY;
  delete process.env.BOFA_WEBHOOK_USER;
  assert.equal((await call('/api/bofa/auth', { body: { clientID: USER, clientSceret: KEY } })).status, 503);
  assert.equal((await call('/api/bofa/webhook', { body: notice() })).status, 503);
  process.env.BOFA_WEBHOOK_USER = '   ';
  process.env.BOFA_WEBHOOK_KEY = '   ';
  assert.equal((await call('/api/bofa/auth', { body: { clientID: USER, clientSceret: KEY } })).status, 503);
  setCreds();
  assert.equal(store.bofaNotifications.all().length, before);
  assertQuiet(takeLogs());
});

test('webhook rejects a missing, wrong, or expired token', async () => {
  const before = store.bofaNotifications.all().length;
  const missing = await call('/api/bofa/webhook', { body: notice() });
  assert.equal(missing.status, 401);
  assert.equal(missing.body.reasonCode, '401');
  assert.equal(missing.body.error, undefined);
  const admin = await call('/api/bofa/webhook', { body: notice(), headers: { authorization: 'Bearer admin-token-for-bofa-tests' } });
  assert.equal(admin.status, 401);
  assert.equal(admin.body.reasonCode, '401');
  const issuedAt = clock.now.getTime();
  const auth = await call('/api/bofa/auth', { body: { clientID: USER, clientSceret: KEY } });
  const token = auth.body.accessToken as string;
  clock.now = new Date(issuedAt + BOFA_ACCESS_TOKEN_TTL_MS - 1);
  const still = await call('/api/bofa/webhook', { body: notice({ transactionIdentification: 'TXN-EDGE' }), headers: { authorization: `Bearer ${token}` } });
  assert.equal(still.status, 200, JSON.stringify(still.body));
  clock.now = new Date(issuedAt + BOFA_ACCESS_TOKEN_TTL_MS);
  const expired = await call('/api/bofa/webhook', { body: notice({ transactionIdentification: 'TXN-LATE' }), headers: { authorization: `Bearer ${token}` } });
  assert.equal(expired.status, 401);
  const fresh = await call('/api/bofa/auth', { body: { clientID: USER, clientSceret: KEY } });
  const again = await call('/api/bofa/webhook', { body: notice({ transactionIdentification: 'TXN-LATE' }), headers: { authorization: `Bearer ${fresh.body.accessToken}` } });
  assert.equal(again.status, 200);
  assert.equal(store.bofaNotifications.all().some((n) => n.transactionIdentification === 'TXN-LATE'), true);
  const logged = takeLogs();
  assert.match(logged, /expired-token/);
  assert.equal(logged.includes(token), false);
  assert.equal(logged.includes(fresh.body.accessToken), false);
  assertQuiet(logged);
  assert.ok(store.bofaNotifications.all().length >= before + 2);
});

test('a repeated payment status is stored once, a new status is stored again, and the body stays encrypted', async () => {
  clock.now = new Date('2026-11-06T18:30:00.000Z');
  const auth = await call('/api/bofa/auth', { body: { clientID: USER, clientSceret: KEY } });
  const token = auth.body.accessToken as string;
  const headers = { authorization: `Bearer ${token}` };
  const firstBody = notice({ transactionIdentification: 'TXN-2002', status: 'Processing By Bank' });
  const first = await call('/api/bofa/webhook', { body: firstBody, headers });
  assert.deepEqual(first.body, { status: 'SUCCESS' });
  const reordered = await call('/api/bofa/webhook', {
    headers,
    body: {
      reason: firstBody.reason,
      accountNumber: ACCOUNT,
      endToEndIdentification: 'SenderRef18',
      status: 'Processing By Bank',
      transactionIdentification: 'TXN-2002',
    },
  });
  assert.equal(reordered.status, 200);
  const rows = store.bofaNotifications.where((n) => n.transactionIdentification === 'TXN-2002');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].receivedAt, '2026-11-06T18:30:00.000Z');
  assert.equal(rows[0].paymentStatus, 'Processing By Bank');
  const saved = JSON.stringify(rows);
  assert.equal(saved.includes(ACCOUNT), false);
  assert.equal(saved.includes(KEY), false);
  const payload = JSON.parse(decryptField(rows[0].payloadEncrypted));
  assert.equal(payload.accountNumber, ACCOUNT);
  assert.equal(payload.status, 'Processing By Bank');
  assert.equal(payload.reason[0].reasonCode, 'CP502');
  const next = await call('/api/bofa/webhook', { headers, body: notice({ transactionIdentification: 'TXN-2002', status: 'Confirmed By Bank' }) });
  assert.equal(next.status, 200);
  assert.equal(store.bofaNotifications.where((n) => n.transactionIdentification === 'TXN-2002').length, 2);
  const bad = await call('/api/bofa/webhook', { headers, raw: '{"transactionIdentification":' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.reasonCode, '903');
  assert.equal(store.ledger.all().length, 0);
  assert.equal(store.legs.all().length, 0);
  assert.equal(store.payRuns.all().length, 0);
  const logged = takeLogs();
  assert.match(logged, /bofa notification stored transaction=TXN-2002 status=Processing By Bank/);
  assert.match(logged, /bofa notification duplicate transaction=TXN-2002/);
  assert.match(logged, /Confirmed By Bank/);
  assertQuiet(logged);
});

test('the notification is on the data disk, encrypted, and still there after a restart', async () => {
  const auth = await call('/api/bofa/auth', { body: { clientID: USER, clientSceret: KEY } });
  const res = await call('/api/bofa/webhook', {
    headers: { authorization: `Bearer ${auth.body.accessToken}` },
    body: notice({ transactionIdentification: 'TXN-DISK', status: 'Rejected By Bank' }),
  });
  assert.equal(res.status, 200);
  const expected = store.bofaNotifications.where((n) => n.transactionIdentification === 'TXN-DISK').length;
  assert.equal(expected, 1);
  await serverClose();
  store.close();
  const files = readdirSync(dir).filter((name) => name.startsWith('db.sqlite'));
  const raw = Buffer.concat(files.map((name) => readFileSync(join(dir, name))));
  assert.equal(raw.includes(Buffer.from(ACCOUNT)), false);
  assert.equal(raw.includes(Buffer.from(KEY)), false);
  const again = new Store(dataFile);
  const row = again.bofaNotifications.where((n) => n.transactionIdentification === 'TXN-DISK')[0];
  assert.ok(row);
  assert.equal(JSON.parse(decryptField(row.payloadEncrypted)).status, 'Rejected By Bank');
  assert.equal(JSON.parse(decryptField(row.payloadEncrypted)).accountNumber, ACCOUNT);
  again.close();
  assertQuiet(takeLogs());
});
