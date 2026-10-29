import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/api/app.ts';
import { Store } from '../src/store/store.ts';
import { BankService } from '../src/banking/accounts.ts';
import { AchService } from '../src/money/ach.ts';
import { SandboxBank } from '../src/ach/sandbox.ts';
import { SftpDelivery } from '../src/ach/sftp.ts';
import { parseAchFile } from '../src/ach/nacha.ts';
import type { Config } from '../src/config.ts';
import { FakeStripe } from './fake-stripe.ts';
import { day, ROUTING } from './helpers.ts';

const ADMIN = 'admin-token-employer-tests';
const clock = { now: new Date('2026-06-08T15:00:00Z') };
const emptyOriginator = { odfiRoutingNumber: '', odfiName: '', immediateOrigin: '', companyName: '', companyId: '' };
const config: Config = { port: 0, dataFile: undefined, adminToken: ADMIN, openSignup: false, ach: { mode: 'outbox', outboxDir: '', config: { originator: emptyOriginator, holdBankingDays: 2, fundingLeadBankingDays: 1, creditLeadBankingDays: 1, trustSettlementDate: false } }, autoDisburse: false, rateLimitPerMinute: 0, trustProxy: false };

const store = new Store();
let base = '';
let close: () => void;
const sent: Array<{ args: string[]; input: string }> = [];

before(async () => {
  const banks = new BankService(store, new FakeStripe(), { now: () => clock.now });
  const ach = new AchService(store, banks, new SandboxBank(), config.ach.config, { now: () => clock.now, sftp: new SftpDelivery({ runner: async (_c, args, o) => (sent.push({ args, input: o.input }), { code: 0, stdout: '', stderr: '' }) }) });
  const app = createApp({ store, banks, ach, config, now: () => clock.now });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  close = () => app.server.close();
});
after(() => close());

async function call(method: string, path: string, opts: { token?: string; body?: unknown; raw?: string } = {}) {
  const res = await fetch(base + path, { method, headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.body !== undefined || opts.raw !== undefined ? { 'content-type': 'application/json' } : {}) }, body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined) });
  const text = await res.text();
  let body: any = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* plain text */ }
  return { status: res.status, body };
}

const co: Record<string, { id: string; key: string }> = {};
const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU=\n-----END OPENSSH PRIVATE KEY-----';
const KNOWN = 'sftp.mainstreetbank.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ0hQvT1x9mXx1Z9mQJ7bq6k3fT0m1b8w3a9sD0n';
let state: { emp?: string; runId?: string; fileId?: string } = {};

test('a new company defaults to employer-bank mode and can set up its bank', async () => {
  for (const [name, ein] of [['a', '12-3456789'], ['b', '98-7654321']] as const) {
    const r = await call('POST', '/v1/companies', { token: ADMIN, body: { legalName: `Cafe ${name.toUpperCase()} LLC`, ein, industry: 'restaurant', niche: 'cafe_coffee', homeState: 'TX' } });
    assert.equal(r.status, 201);
    assert.equal(r.body.company.payment.mode, 'employer_bank');
    co[name] = { id: r.body.company.id, key: r.body.apiKey };
  }
  const put = await call('PUT', `/v1/companies/${co.a.id}/payment-setup`, { token: co.a.key, body: { mode: 'employer_bank', employerBank: { odfiRoutingNumber: ROUTING, odfiName: 'Main Street Bank', immediateOrigin: '123456789', companyId: '1123456789', sftp: { host: 'sftp.mainstreetbank.test', username: 'cafe-a', remoteDir: '/in', knownHostsLine: KNOWN, privateKey: KEY } } } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.employerBank.sftp.hasPrivateKey, true);
  assert.ok(!JSON.stringify(put.body).includes('PRIVATE KEY'));
  const get = await call('GET', `/v1/companies/${co.a.id}/payment-setup`, { token: co.a.key });
  assert.ok(!JSON.stringify(get.body).includes('PRIVATE KEY'));
  const company = await call('GET', `/v1/companies/${co.a.id}`, { token: co.a.key });
  assert.ok(!JSON.stringify(company.body).includes('privateKeyEncrypted'));
  assert.equal((await call('PUT', `/v1/companies/${co.a.id}/payment-setup`, { token: co.a.key, body: { mode: 'totali_ach' } })).status, 403);
  assert.equal((await call('PUT', `/v1/companies/${co.a.id}/payment-setup`, { token: ADMIN, body: { mode: 'employer_bank', employerBank: { odfiRoutingNumber: '110000001', odfiName: 'x', immediateOrigin: '1', companyId: '1' } } })).status, 400);
});

test('prepare the payment, see the file, release it; another company cannot touch it', async () => {
  const hire = await call('POST', `/v1/companies/${co.a.id}/employees`, { token: co.a.key, body: { firstName: 'Ana', lastName: 'Ruiz', roleKey: 'barista', hireDate: '2026-01-05', payType: { kind: 'hourly', rateCents: 1700 }, tipCreditNoticeDate: '2026-01-05' } });
  state.emp = hire.body.id;
  const acct = await call('POST', `/v1/companies/${co.a.id}/bank-accounts/manual`, { token: co.a.key, body: { employeeId: state.emp, routingNumber: ROUTING, accountNumber: '000246813579', accountType: 'checking' } });
  await call('POST', `/v1/ops/companies/${co.a.id}/bank-accounts/${acct.body.id}/activate`, { token: ADMIN, body: { reason: 'verified by phone' } });
  await call('PUT', `/v1/companies/${co.a.id}/employees/${state.emp}/payout-accounts`, { token: co.a.key, body: { accounts: [{ bankAccountId: acct.body.id, allocation: { kind: 'remainder' } }] } });
  for (let n = 0; n < 5; n++) await call('POST', `/v1/companies/${co.a.id}/shifts`, { token: co.a.key, body: { employeeId: state.emp, workDate: day(n), minutes: 480 } });
  const run = await call('POST', `/v1/companies/${co.a.id}/pay-runs`, { token: co.a.key, body: { periodStart: day(0), periodEnd: day(6), checkDate: day(11) } });
  state.runId = run.body.id;
  assert.equal((await call('POST', `/v1/companies/${co.a.id}/pay-runs/${state.runId}/approve`, { token: co.a.key, body: { acknowledgeReviewIssues: true } })).status, 200);

  assert.equal((await call('POST', `/v1/companies/${co.a.id}/pay-runs/${state.runId}/fund`, { token: co.a.key, body: {} })).body.error.code, 'wrong_payment_mode');
  const t = await call('GET', `/v1/companies/${co.a.id}/pay-runs/${state.runId}/timeline`, { token: co.a.key });
  assert.equal(t.body.mode, 'employer_bank');

  const prep = await call('POST', `/v1/companies/${co.a.id}/pay-runs/${state.runId}/prepare-payment`, { token: co.a.key, body: {} });
  assert.equal(prep.status, 200, JSON.stringify(prep.body));
  state.fileId = prep.body.file.id;
  assert.equal(prep.body.file.status, 'queued', 'delivered by SFTP, not yet released');
  assert.equal(prep.body.file.delivery.status, 'sent');
  assert.equal(sent.length, 1);
  assert.ok(sent[0].args.includes('StrictHostKeyChecking=yes'));
  assert.match(prep.body.next, /Approve it in your bank/);

  const content = await call('GET', `/v1/companies/${co.a.id}/ach/files/${state.fileId}/content`, { token: co.a.key });
  const parsed = parseAchFile(content.body);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.immediateDestination, ROUTING);
  assert.equal(parsed.control.debitCents, 0);

  assert.equal((await call('POST', `/v1/companies/${co.b.id}/ach/files/${state.fileId}/released`, { token: co.b.key, body: { releasedBy: 'Mallory' } })).status, 400);
  assert.equal((await call('POST', `/v1/companies/${co.a.id}/ach/files/${state.fileId}/released`, { token: co.b.key, body: { releasedBy: 'Mallory' } })).status, 403);
  assert.equal((await call('GET', `/v1/companies/${co.b.id}/ach/files/${state.fileId}`, { token: co.b.key })).status, 404);
  assert.equal((await call('POST', `/v1/companies/${co.a.id}/ach/files/${state.fileId}/released`, { token: co.a.key, body: {} })).status, 400, 'who released it is required');
  const rel = await call('POST', `/v1/companies/${co.a.id}/ach/files/${state.fileId}/released`, { token: co.a.key, body: { releasedBy: 'Owner Person' } });
  assert.equal(rel.status, 200);
  assert.equal(rel.body.status, 'accepted');
});

test('the employer uploads the bank\'s return file; the ops-only bank calls stay admin-only', async () => {
  const legs = (await call('GET', `/v1/companies/${co.a.id}/pay-runs/${state.runId}/legs`, { token: co.a.key })).body.legs;
  const ret = SandboxBank.returnFile([{ trace: legs[0].traceNumber, code: 'R02', amountCents: legs[0].amountCents }]);
  const other = await call('POST', `/v1/companies/${co.b.id}/ach/returns`, { token: co.b.key, raw: ret });
  assert.deepEqual(other.body.applied, []);
  assert.deepEqual(other.body.unmatched, [legs[0].traceNumber]);
  const mine = await call('POST', `/v1/companies/${co.a.id}/ach/returns`, { token: co.a.key, raw: ret });
  assert.equal(mine.body.applied.length, 1);
  assert.equal((await call('POST', `/v1/ops/ach/files/${state.fileId}/accepted`, { token: co.a.key, body: {} })).status, 403);
  assert.equal((await call('GET', `/v1/companies/${co.a.id}/ledger`, { token: co.a.key })).body.entries.length, 0);
});
