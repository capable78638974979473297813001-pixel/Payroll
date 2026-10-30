import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store/store.ts';
import { BankService } from '../src/banking/accounts.ts';
import { AchService } from '../src/money/ach.ts';
import { SandboxBank } from '../src/ach/sandbox.ts';
import { createApp } from '../src/api/app.ts';
import type { Config } from '../src/config.ts';
import { approvePayRun, draftPayRun } from '../src/payroll/payRuns.ts';
import { paymentSetupView, setPaymentSetup } from '../src/domain/payment.ts';
import { companyView } from '../src/domain/companies.ts';
import { JpMorganAdapter, achName, creditBody, dollarString, endToEndIdFor, idempotencyKeyFor } from '../src/bankapi/jpmorgan.ts';
import { BankApiError, type HttpRequest } from '../src/bankapi/types.ts';
import { ApiError } from '../src/lib/errors.ts';
import { FakeStripe } from './fake-stripe.ts';
import { day, hire, newCompany, ready, ROUTING, shiftsFor } from './helpers.ts';

const RUN = { periodStart: day(0), periodEnd: day(6), checkDate: day(11) };
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUB = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const BASE = 'https://api-test.payments.jpmorgan.com';
const BANK = { odfiRoutingNumber: ROUTING, odfiName: 'J.P. Morgan', immediateOrigin: '123456789', companyId: '1123456789', bankProfile: 'jpmorgan_commercial' };
const API = { adapter: 'jpmorgan', environment: 'client_testing', baseUrl: BASE, clientId: 'client-abc', certThumbprint: 'AB12CD34', privateKey: PEM, debtorAccountNumber: '123456789012', debtorName: 'Corner Table', maxFileCents: 5_000_00, authorization: { accepted: true, acceptedBy: 'Sam Owner' } };

type Resp = { status: number; body: string };
const ok = (o: unknown, status = 200): Resp => ({ status, body: JSON.stringify(o) });

/** A scripted J.P. Morgan: records every call, and `behave` can override any answer. */
function fakeBank() {
  const reqs: HttpRequest[] = [];
  const posts = () => reqs.filter((r) => r.method === 'POST' && r.url.endsWith('/payment/v2/payments'));
  const tokens = () => reqs.filter((r) => r.url.endsWith('/oauth2/token'));
  const statuses = new Map<string, { paymentStatus: string; paymentSubStatus?: string }>();
  const state = { behave: undefined as undefined | ((req: HttpRequest, n: number) => Resp | undefined), n: 0 };
  const http = async (req: HttpRequest): Promise<Resp> => {
    reqs.push(req);
    if (req.url.endsWith('/oauth2/token')) return ok({ access_token: `tok-${tokens().length}`, expires_in: 28800 });
    const mine = req.method === 'POST' ? posts().length : 0;
    const over = state.behave?.(req, mine);
    if (over) return over;
    if (req.method === 'POST') {
      const id = `pay-${mine}-00000000`;
      statuses.set(id, { paymentStatus: 'ACCEPTED' });
      return ok({ paymentId: id, paymentStatus: 'ACCEPTED', paymentSubStatus: 'ACCEPTED' }, 201);
    }
    const id = req.url.split('/payments/')[1]!.split('?')[0]!;
    return ok({ paymentId: id, ...(statuses.get(id) ?? { paymentStatus: 'PROCESSING' }) });
  };
  return { http, reqs, posts, tokens, statuses, state };
}

async function setup(opts: { api?: Record<string, unknown> | false; staff?: number; bank?: ReturnType<typeof fakeBank> } = {}) {
  const clock = { now: new Date('2026-06-08T15:00:00Z') };
  const store = new Store();
  const banks = new BankService(store, new FakeStripe(), { now: () => clock.now });
  const bank = opts.bank ?? fakeBank();
  const ach = new AchService(store, banks, new SandboxBank(), { originator: { odfiRoutingNumber: '', odfiName: '', immediateOrigin: '', companyName: '', companyId: '' }, holdBankingDays: 2, fundingLeadBankingDays: 1, creditLeadBankingDays: 1, trustSettlementDate: false }, { now: () => clock.now, bankApis: { jpmorgan: new JpMorganAdapter({ http: bank.http, now: () => clock.now }) } });
  const { company, apiKey } = newCompany(store);
  setPaymentSetup(store, company.id, { mode: 'employer_bank', employerBank: { ...BANK, ...(opts.api === false ? {} : { api: { ...API, ...(opts.api ?? {}) } }) } }, 'company');
  for (let i = 0; i < (opts.staff ?? 2); i++) {
    const e = hire(store, company.id, { firstName: `Ana${'abcdefgh'[i]}`, lastName: "O'Brien-Ruiz-Fernandez", payType: { kind: 'hourly', rateCents: 1500 }, roleKey: 'line_cook', tipCreditNoticeDate: undefined });
    ready(store, e.id, `00011122${i}333`);
    shiftsFor(store, company.id, e.id, [0, 1, 2, 3, 4], { minutes: 480 });
  }
  const run = (opts.staff ?? 2) === 0 ? (undefined as never) : approvePayRun(store, company.id, draftPayRun(store, company.id, RUN).id, { acknowledgeReviewIssues: true });
  const prepared = (opts.staff ?? 2) === 0 ? ({ file: null, next: '' } as never) : await ach.preparePayment(company.id, run.id);
  const file = prepared.file ? store.achFiles.get(prepared.file.id)! : (undefined as never);
  const confirm = file ? { entryCount: file.totals.entryCount, creditsCents: file.totals.creditCents } : { entryCount: 0, creditsCents: 0 };
  const send = (over: Record<string, unknown> = {}) => ach.approveAndSend(company.id, file.id, { approvedBy: 'Sam Owner', confirm, ...over } as never);
  const legIds = file ? file.entries.map((e) => e.legId!) : [];
  const entries = () => store.achFiles.get(file.id)!.apiDelivery!.entries;
  return { store, ach, company, apiKey, run, prepared, file, confirm, send, bank, clock, legIds, entries, fileNow: () => store.achFiles.get(file.id)!, legStatus: () => legIds.map((id) => store.legs.get(id)!.status) };
}

const refused = async (p: Promise<unknown>, code?: string) => {
  try { await p; } catch (e) { if (code) assert.equal((e as ApiError).code, code, (e as Error).message); return e as ApiError; }
  assert.fail('expected a refusal');
};

// ---------------------------------------------------------------- adapter

test('the token request is a signed JWT assertion with the claims the docs list', async () => {
  const s = await setup();
  await s.send();
  const t = s.bank.tokens()[0]!;
  assert.equal(t.url, 'https://login.jpmorgan.com/oauth2/token');
  const form = new URLSearchParams(t.body);
  assert.equal(form.get('grant_type'), 'client_credentials');
  assert.equal(form.get('client_assertion_type'), 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
  assert.equal(form.get('audience'), 'jpm:uri:sandbox:payments');
  const jwt = form.get('client_assertion')!;
  assert.ok(!/\s/.test(jwt));
  const [h, c, sig] = jwt.split('.') as [string, string, string];
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.deepEqual({ alg: header.alg, kid: header.kid }, { alg: 'RS256', kid: 'AB12CD34' });
  assert.equal(claims.iss, 'client-abc');
  assert.equal(claims.sub, 'client-abc');
  assert.equal(claims.aud, 'https://login.jpmorgan.com/oauth2/token');
  assert.equal(claims.exp - claims.iat, 30);
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(PUB, Buffer.from(sig, 'base64url')), 'signed with the employer key');
});

test('the payment request follows the documented parameters', async () => {
  const s = await setup({ staff: 1 });
  await s.send();
  const post = s.bank.posts()[0]!;
  const body = JSON.parse(post.body!);
  assert.equal(post.url, `${BASE}/payment/v2/payments`);
  assert.match(post.headers['authorization']!, /^Bearer tok-/);
  assert.match(post.headers['idempotency-key']!, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(body.requestedExecutionDate, s.file.effectiveDate);
  assert.match(body.paymentIdentifiers.endToEndId, /^[A-Z0-9]{15}$/);
  assert.match(body.value.amount, /^\d+\.\d{2}$/);
  assert.equal(Number(body.value.amount) * 100, s.file.totals.creditCents);
  assert.deepEqual([body.transferType, body.paymentType, body.paymentTypeInformation.serviceLevelCode, body.paymentTypeInformation.localInstrumentCode.code, body.paymentPurpose.categoryPurpose.proprietary], ['CREDIT', 'ACH', 'NURG', 'PPD', 'PAYROLL']);
  assert.equal(body.debtor.account.companyId, '1123456789');
  assert.equal(body.debtor.account.accountNumber, '123456789012');
  assert.equal(body.debtor.name, 'CORNER TABLE'); // 16 characters at most
  assert.equal(body.debtorAgent.financialInstitutionIds[0].id, ROUTING);
  assert.equal(body.creditorAgent.financialInstitutionIds[0].idType, 'USABA');
  assert.ok(body.creditor.name.length <= 22 && /^[A-Z0-9 .,&'-]+$/.test(body.creditor.name), body.creditor.name);
  assert.equal(body.creditor.account.accountType, 'CACC');
});

test('amounts, names and ids are formatted exactly, and the same payment always gets the same ids', () => {
  assert.equal(dollarString(5), '0.05');
  assert.equal(dollarString(10150), '101.50');
  assert.equal(dollarString(100), '1.00');
  assert.equal(achName('José Núñez-García', 22), 'JOSE NUNEZ-GARCIA');
  assert.equal(achName('###', 22), 'EMPLOYEE');
  assert.equal(achName('A'.repeat(40), 22).length, 22);
  assert.equal(endToEndIdFor('leg_1'), endToEndIdFor('leg_1'));
  assert.notEqual(endToEndIdFor('leg_1'), endToEndIdFor('leg_2'));
  assert.equal(idempotencyKeyFor('leg_1'), idempotencyKeyFor('leg_1'));
  assert.equal(creditBody({ clientId: 'c', certThumbprint: 't', privateKeyPem: '', environment: 'production', debtor: { name: 'X', accountNumber: '1', routingNumber: '021000021', companyId: '1123456789' } }, { legId: 'l', amountCents: 1, effectiveDate: '2026-06-12', recipientName: 'A B', routingNumber: '110000000', accountNumber: '9', accountType: 'savings' }).creditor.account.accountType, 'SVGS');
});

test('an expired token is refreshed once and cannot pay twice', async () => {
  const s = await setup({ staff: 1 });
  s.bank.state.behave = (req, n) => (req.method === 'POST' && n === 1 ? { status: 401, body: '{}' } : undefined);
  const out = await s.send();
  assert.equal(out.sent, 1);
  assert.equal(s.bank.tokens().length, 2, 'a fresh token was requested after the 401');
  assert.equal(s.bank.posts().length, 2, 'the refused request, then the retry: only one was processed');
});

// ---------------------------------------------------------------- setup

test('the API is set up only for J.P. Morgan, only with the written authorization, and only at the bank\'s own hosts', async () => {
  const s = await setup({ staff: 0 });
  const put = (employerBank: Record<string, unknown>) => () => setPaymentSetup(s.store, s.company.id, { mode: 'employer_bank', employerBank: { ...BANK, ...employerBank } }, 'company');
  assert.throws(put({ bankProfile: 'chase_for_business', api: API }), /needs employerBank.bankProfile 'jpmorgan_commercial'/);
  assert.throws(put({ api: { ...API, authorization: undefined } }), /authorization/);
  assert.throws(put({ api: { ...API, authorization: { accepted: false, acceptedBy: 'x' } } }), /must be true/);
  assert.throws(put({ api: { ...API, baseUrl: 'https://evil.example.com' } }), /bank's own domain/);
  assert.throws(put({ api: { ...API, baseUrl: 'http://api.payments.jpmorgan.com' } }), /https/);
  assert.throws(put({ api: { ...API, tokenUrl: 'https://login.jpmorgan.com.evil.com/oauth2/token' } }), /bank's own domain/);
  assert.throws(put({ api: { ...API, privateKey: 'not a key' } }), /RSA private key/);
  assert.throws(put({ api: { ...API, privateKey: generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() } }), /2048/);
  assert.throws(put({ companyId: '123', api: API }), /exactly 10/);
  assert.throws(put({ api: { ...API, maxFileCents: undefined } }), /maxFileCents/);
  assert.throws(put({ api: { ...API, baseUrl: undefined } }), /baseUrl is required/);
  assert.throws(put({ api: { ...API, debtorName: 'Corner Table Cafe' } }), /debtorName/);
  assert.throws(put({ api: API, sftp: { host: 'sftp.x.test', username: 'u', knownHostsLine: 'k', privateKey: PEM } }), /not both/);
  put({ api: API })();
});

test('secrets are never shown: not in the setup view, the company view, or the stored file', async () => {
  const s = await setup();
  const company = s.store.companies.get(s.company.id)!;
  for (const text of [JSON.stringify(paymentSetupView(company)), JSON.stringify(companyView(company)), JSON.stringify(s.prepared), JSON.stringify(s.store.achFiles.get(s.file.id))]) {
    assert.ok(!text.includes('PRIVATE KEY') && !text.includes('123456789012') && !text.includes('privateKeyEncrypted') && !text.includes('debtorAccountEncrypted'));
  }
  const view = paymentSetupView(company).employerBank!.api!;
  assert.equal(view.debtorAccountLast4, '9012');
  assert.equal(view.hasPrivateKey, true);
  assert.equal(view.authorization.textVersion, '2026-10-bank-api-v1');
  assert.equal(view.authorization.acceptedBy, 'Sam Owner');
});

// ---------------------------------------------------------------- the manual step

test('preparing a payment calls the bank not at all: nothing moves until a person approves', async () => {
  const s = await setup();
  assert.equal(s.bank.reqs.length, 0, 'no token request, no payment');
  assert.equal(s.fileNow().status, 'created');
  assert.match(s.prepared.next, /Nothing has been sent to your bank/);
  assert.match(s.prepared.next, new RegExp(`entryCount: ${s.confirm.entryCount}`));
});

test('approval needs a name and the exact totals, and sends nothing when either is missing or wrong', async () => {
  const s = await setup();
  await refused(s.send({ approvedBy: '  ' }), 'invalid_request');
  await refused(s.send({ confirm: { entryCount: s.confirm.entryCount, creditsCents: s.confirm.creditsCents + 1 } }), 'invalid_request');
  await refused(s.send({ confirm: { entryCount: s.confirm.entryCount + 1, creditsCents: s.confirm.creditsCents } }), 'invalid_request');
  await refused(s.send({ confirm: undefined }), 'invalid_request');
  assert.equal(s.bank.reqs.length, 0);
  assert.equal(s.fileNow().status, 'created');
  assert.deepEqual(s.legStatus(), ['queued', 'queued']);
});

test('a file over the ceiling the employer set is refused, however it was approved', async () => {
  const s = await setup({ api: { maxFileCents: 100_00 } });
  await refused(s.send(), 'over_file_cap');
  assert.equal(s.bank.reqs.length, 0);
});

test('a file whose date has passed is refused and nothing is sent', async () => {
  const s = await setup();
  s.clock.now = new Date('2026-06-13T15:00:00Z');
  await refused(s.send(), 'file_stale');
  assert.equal(s.bank.reqs.length, 0);
});

test('a company with no API set up cannot use it', async () => {
  const s = await setup({ api: false });
  await refused(s.send(), 'api_not_set_up');
});

test("another company's file cannot be approved or sent", async () => {
  const s = await setup();
  const other = newCompany(s.store, { ein: '98-7654321' }).company;
  setPaymentSetup(s.store, other.id, { mode: 'employer_bank', employerBank: { ...BANK, api: API } }, 'company');
  await refused(s.ach.approveAndSend(other.id, s.file.id, { approvedBy: 'x', confirm: s.confirm }), 'invalid_request');
  assert.equal(s.bank.reqs.length, 0);
});

// ---------------------------------------------------------------- sending

test('approval sends every payment once, marks them sent, and records who approved', async () => {
  const s = await setup();
  const out = await s.send();
  assert.deepEqual({ sent: out.sent, rejected: out.rejected, complete: out.complete }, { sent: 2, rejected: 0, complete: true });
  assert.equal(s.bank.posts().length, 2);
  assert.equal(s.bank.tokens().length, 1, 'one token served both payments');
  assert.deepEqual(s.legStatus(), ['submitted', 'submitted']);
  const f = s.fileNow();
  assert.equal(f.status, 'accepted');
  assert.equal(f.releasedBy, 'Sam Owner');
  assert.equal(f.delivery?.channel, 'api');
  assert.equal(f.apiDelivery!.approvals[0]!.by, 'Sam Owner');
  assert.equal(f.apiDelivery!.approvals[0]!.creditsCents, s.confirm.creditsCents);
  assert.ok(Object.values(s.entries()).every((e) => e.state === 'sent' && !!e.paymentId));
  const keys = s.bank.posts().map((p) => p.headers['idempotency-key']);
  assert.equal(new Set(keys).size, 2, 'each payment has its own idempotency key');
});

test('approving again sends nothing more', async () => {
  const s = await setup();
  await s.send();
  const again = await s.send();
  assert.equal(again.sent, 2);
  assert.equal(s.bank.posts().length, 2, 'still two payments at the bank');
});

test('two approvals at the same moment still send each payment once', async () => {
  const s = await setup();
  const results = await Promise.allSettled([s.send(), s.send()]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const err = (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason as ApiError;
  assert.equal(err.code, 'send_in_progress');
  assert.equal(s.bank.posts().length, 2);
});

test('a refused connection leaves the payment unsent and safe to try again', async () => {
  const s = await setup({ staff: 1 });
  s.bank.state.behave = (req) => (req.method === 'POST' ? (() => { throw new BankApiError('not_sent', 'Could not connect to the bank (ECONNREFUSED).'); })() : undefined);
  const first = await s.send();
  assert.deepEqual({ complete: first.complete, notYetSent: first.notYetSent, sent: first.sent }, { complete: false, notYetSent: 1, sent: 0 });
  assert.equal(s.fileNow().status, 'queued');
  assert.deepEqual(s.legStatus(), ['queued']);
  s.bank.state.behave = undefined;
  const second = await s.send();
  assert.equal(second.complete, true);
  assert.equal(s.fileNow().status, 'accepted');
});

test('a timeout after sending is never retried by Totali: it waits for a person', async () => {
  const s = await setup({ staff: 2 });
  s.bank.state.behave = (req, n) => (req.method === 'POST' && n === 2 ? (() => { throw new BankApiError('unknown', 'The connection to the bank failed after the request may have been sent.'); })() : undefined);
  const first = await s.send();
  assert.deepEqual({ sent: first.sent, needsChecking: first.needsChecking, complete: first.complete }, { sent: 1, needsChecking: 1, complete: false });
  const [okLeg, unknownLeg] = Object.entries(s.entries()).sort((a, b) => (a[1].state === 'sent' ? -1 : 1) - (b[1].state === 'sent' ? -1 : 1)).map(([id]) => id) as [string, string];
  assert.equal(s.entries()[unknownLeg]!.state, 'unknown');
  const postsBefore = s.bank.posts().length;
  s.bank.state.behave = undefined;
  await s.send();
  await s.send();
  assert.equal(s.bank.posts().length, postsBefore, 'repeated approval does not resend a payment that may already be at the bank');
  assert.equal(s.store.legs.get(unknownLeg)!.status, 'queued');
  // The person checks the bank. Not there: it can be sent. There: they paste the bank's id.
  await refused(Promise.resolve().then(() => s.ach.resolveApiEntry(s.company.id, s.file.id, okLeg, { outcome: 'not_sent', resolvedBy: 'Sam' })), 'not_unknown');
  assert.throws(() => s.ach.resolveApiEntry(s.company.id, s.file.id, unknownLeg, { outcome: 'sent', resolvedBy: 'Sam' }), /paymentId is required/);
  assert.throws(() => s.ach.resolveApiEntry(s.company.id, s.file.id, unknownLeg, { outcome: 'sent', resolvedBy: '' }), /resolvedBy/);
  s.ach.resolveApiEntry(s.company.id, s.file.id, unknownLeg, { outcome: 'not_sent', resolvedBy: 'Sam' });
  const done = await s.send();
  assert.equal(done.complete, true);
  assert.equal(s.bank.posts().length, postsBefore + 1, 'sent once more, only now');
  assert.equal(s.fileNow().status, 'accepted');
});

test('a person can settle an unclear payment as already sent, with the bank\'s payment id', async () => {
  const s = await setup({ staff: 1 });
  s.bank.state.behave = (req) => (req.method === 'POST' ? (() => { throw new BankApiError('unknown', 'x'); })() : undefined);
  await s.send();
  const leg = s.legIds[0]!;
  s.bank.state.behave = undefined;
  s.ach.resolveApiEntry(s.company.id, s.file.id, leg, { outcome: 'sent', resolvedBy: 'Sam', paymentId: 'abc12345-from-portal' });
  assert.equal(s.entries()[leg]!.state, 'sent');
  assert.equal(s.store.legs.get(leg)!.status, 'submitted');
  const posts = s.bank.posts().length;
  const done = await s.send();
  assert.equal(done.complete, true);
  assert.equal(s.bank.posts().length, posts, 'nothing more is sent');
});

test('a payment the bank rejects fails that employee only, and says why', async () => {
  const s = await setup({ staff: 2 });
  s.bank.state.behave = (req, n) => (req.method === 'POST' && n === 1 ? { status: 400, body: JSON.stringify({ errors: [{ errorCode: '11576', errorMessage: 'Invalid date' }] }) } : undefined);
  const out = await s.send();
  assert.deepEqual({ sent: out.sent, rejected: out.rejected, complete: out.complete }, { sent: 1, rejected: 1, complete: true });
  assert.deepEqual(s.legStatus().sort(), ['failed', 'submitted']);
  const failed = s.store.legs.get(Object.entries(s.entries()).find(([, e]) => e.state === 'rejected')![0])!;
  assert.match(failed.failureMessage!, /11576 Invalid date/);
  assert.ok(s.store.payRuns.get(s.run.id)!.alerts!.some((a) => a.code === 'api_payment_rejected'));
  assert.ok(!JSON.stringify(failed).includes('0001112'), 'no account number in the failure');
});

test('a 5xx, a duplicate warning, and an unreadable answer are all treated as unknown, not as failures', async () => {
  for (const resp of [{ status: 500, body: '{}' }, { status: 409, body: '{}' }, { status: 400, body: '{"errors":[{"errorCode":"11507","errorMessage":"Duplicate."}]}' }, { status: 201, body: 'not json' }, { status: 201, body: '{}' }]) {
    const s = await setup({ staff: 1 });
    s.bank.state.behave = (req) => (req.method === 'POST' ? resp : undefined);
    const out = await s.send();
    assert.equal(out.needsChecking, 1, JSON.stringify(resp));
    assert.equal(s.store.legs.get(s.legIds[0]!)!.status, 'queued');
  }
});

test('bad credentials are not_sent and leave everything as it was', async () => {
  const s = await setup({ staff: 1 });
  s.bank.state.behave = (req) => (req.method === 'POST' ? { status: 403, body: '{}' } : undefined);
  const out = await s.send();
  assert.equal(out.notYetSent, 1);
  assert.match(out.stoppedBecause!, /refused the credentials/);
  const s2 = await setup({ staff: 1 });
  const original = s2.bank.http;
  s2.bank.http = async (req) => (req.url.endsWith('/oauth2/token') ? { status: 401, body: '{}' } : original(req));
  // A rejected token request surfaces as a not_sent failure: covered by the adapter directly.
  const adapter = new JpMorganAdapter({ http: async () => ({ status: 401, body: '{}' }) });
  await assert.rejects(() => adapter.send({ clientId: 'c', certThumbprint: 't', privateKeyPem: PEM, environment: 'client_testing', baseUrl: BASE, debtor: { name: 'X', accountNumber: '1', routingNumber: ROUTING, companyId: '1123456789' } }, { legId: 'l', amountCents: 1, effectiveDate: '2026-06-12', recipientName: 'A', routingNumber: ROUTING, accountNumber: '9', accountType: 'checking' }), (e: BankApiError) => e.outcome === 'not_sent');
});

// ---------------------------------------------------------------- never both ways

test('a file already released by hand cannot also be sent by API', async () => {
  const s = await setup();
  s.ach.markReleased(s.company.id, s.file.id, 'Sam');
  await refused(s.send(), 'already_released');
  assert.equal(s.bank.reqs.length, 0);
});

test('once payments are going out by API the file cannot be marked released by hand or cancelled', async () => {
  const s = await setup({ staff: 2 });
  s.bank.state.behave = (req, n) => (req.method === 'POST' && n === 2 ? (() => { throw new BankApiError('unknown', 'x'); })() : undefined);
  await s.send();
  assert.throws(() => s.ach.markReleased(s.company.id, s.file.id, 'Sam'), (e: ApiError) => e.code === 'sent_by_api');
  assert.throws(() => s.ach.cancelFile(s.company.id, s.file.id), (e: ApiError) => e.code === 'already_sent_by_api');
});

test('a file approved but with nothing sent yet can still be cancelled', async () => {
  const s = await setup({ staff: 1 });
  s.bank.state.behave = (req) => (req.method === 'POST' ? (() => { throw new BankApiError('not_sent', 'x'); })() : undefined);
  await s.send();
  s.ach.cancelFile(s.company.id, s.file.id);
  assert.equal(s.fileNow().status, 'rejected');
  await refused(s.send(), 'file_cancelled');
});

// ---------------------------------------------------------------- status

test('returned, rejected and held payments are picked up by checking status', async () => {
  const s = await setup({ staff: 3 });
  await s.send();
  const ids = Object.entries(s.entries()).map(([leg, e]) => ({ leg, id: e.paymentId! }));
  s.bank.statuses.set(ids[0]!.id, { paymentStatus: 'RETURNED' });
  s.bank.statuses.set(ids[1]!.id, { paymentStatus: 'REJECTED', paymentSubStatus: 'REJECTED_BY_EXTERNAL' });
  s.bank.statuses.set(ids[2]!.id, { paymentStatus: 'PROCESSING', paymentSubStatus: 'PENDING_CLIENT_ACTION' });
  const out = await s.ach.refreshApiStatus(s.company.id, s.file.id, { force: true });
  assert.equal(out.checked, 3);
  assert.equal(s.store.legs.get(ids[0]!.leg)!.status, 'returned');
  assert.equal(s.store.legs.get(ids[1]!.leg)!.status, 'failed');
  assert.equal(s.store.legs.get(ids[2]!.leg)!.status, 'submitted');
  const codes = s.store.payRuns.get(s.run.id)!.alerts!.map((a) => a.code);
  for (const c of ['payout_returned', 'api_payment_rejected', 'api_payment_held']) assert.ok(codes.includes(c), c);
  // The same answer again does not raise the same alert twice.
  await s.ach.refreshApiStatus(s.company.id, s.file.id, { force: true });
  assert.equal(s.store.payRuns.get(s.run.id)!.alerts!.filter((a) => a.code === 'api_payment_held').length, 1);
});

test('status is checked at most every 15 minutes unless forced, and a failed check changes nothing', async () => {
  const s = await setup({ staff: 1 });
  await s.send();
  const gets = () => s.bank.reqs.filter((r) => r.method === 'GET').length;
  await s.ach.refreshApiStatus(s.company.id, s.file.id);
  assert.equal(gets(), 1);
  await s.ach.refreshApiStatus(s.company.id, s.file.id);
  assert.equal(gets(), 1, 'too soon');
  s.clock.now = new Date(s.clock.now.getTime() + 16 * 60_000);
  s.bank.state.behave = (req) => (req.method === 'GET' ? { status: 503, body: '' } : undefined);
  const out = await s.ach.refreshApiStatus(s.company.id, s.file.id);
  assert.equal(out.failed.length, 1);
  assert.equal(s.store.legs.get(s.legIds[0]!)!.status, 'submitted');
});

test('a completed status is recorded without settling anything early', async () => {
  const s = await setup({ staff: 1 });
  await s.send();
  s.bank.statuses.set(s.entries()[s.legIds[0]!]!.paymentId!, { paymentStatus: 'COMPLETED', paymentSubStatus: 'COMPLETED_BY_JPM' });
  await s.ach.refreshApiStatus(s.company.id, s.file.id, { force: true });
  assert.equal(s.entries()[s.legIds[0]!]!.bank, 'completed');
  assert.equal(s.store.legs.get(s.legIds[0]!)!.status, 'submitted', 'settles on the effective date, as every payment does');
  s.ach.advance();
  assert.equal(s.store.legs.get(s.legIds[0]!)!.status, 'submitted');
  s.clock.now = new Date('2026-06-12T15:00:00Z');
  s.ach.advance();
  assert.equal(s.store.legs.get(s.legIds[0]!)!.status, 'settled');
  assert.equal(s.store.ledger.where((l) => l.companyId === s.company.id).length, 0, 'employer-bank money never touches the ledger');
});

test('a payment the bank rejects the moment it takes it is failed straight away', async () => {
  const s = await setup({ staff: 1 });
  s.bank.state.behave = (req) => (req.method === 'POST' ? ok({ paymentId: 'pay-rej-00000000', paymentStatus: 'REJECTED', paymentSubStatus: 'REJECTED_BY_JPM' }, 201) : undefined);
  const out = await s.send();
  assert.equal(out.complete, true);
  assert.equal(s.store.legs.get(s.legIds[0]!)!.status, 'failed');
  assert.equal(s.entries()[s.legIds[0]!]!.state, 'rejected');
});

// ---------------------------------------------------------------- API

const ADMIN = 'admin-token-bank-api-tests';
const config: Config = { port: 0, dataFile: undefined, adminToken: ADMIN, openSignup: false, ach: { mode: 'outbox', outboxDir: '', config: { originator: { odfiRoutingNumber: '', odfiName: '', immediateOrigin: '', companyName: '', companyId: '' }, holdBankingDays: 2, fundingLeadBankingDays: 1, creditLeadBankingDays: 1, trustSettlementDate: false } }, autoDisburse: false, rateLimitPerMinute: 0, trustProxy: false };

test('over HTTP: the authorization text, the approval, and no secret in any response', async () => {
  const s = await setup();
  const app = createApp({ store: s.store, banks: new BankService(s.store, new FakeStripe(), { now: () => s.clock.now }), ach: s.ach, config, now: () => s.clock.now });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  try {
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${s.apiKey}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const text = await res.text();
      return { status: res.status, text, body: text ? JSON.parse(text) : null };
    };
    const C = `/v1/companies/${s.company.id}`;
    const auth = await call('GET', `${C}/payment-setup/api-authorization?accountLast4=9012&maxFileCents=500000`);
    assert.equal(auth.status, 200);
    assert.match(auth.body.text, /account ending 9012/);
    assert.match(auth.body.text, /\$5,000\.00/);
    assert.match(auth.body.text, /named person/);
    assert.equal((await call('GET', `${C}/payment-setup/api-authorization`)).status, 200, 'defaults to what is already set up');

    const wrong = await call('POST', `${C}/ach/files/${s.file.id}/approve-and-send`, { approvedBy: 'Sam', confirm: { entryCount: 1, creditsCents: 1 } });
    assert.equal(wrong.status, 400);
    assert.equal(s.bank.reqs.length, 0);
    const bad = await call('POST', `${C}/ach/files/${s.file.id}/approve-and-send`, { approvedBy: 'Sam' });
    assert.equal(bad.status, 400);

    const sent = await call('POST', `${C}/ach/files/${s.file.id}/approve-and-send`, { approvedBy: 'Sam Owner', confirm: s.confirm });
    assert.equal(sent.status, 200, sent.text);
    assert.equal(sent.body.sent, 2);
    const polled = await call('POST', `${C}/ach/files/${s.file.id}/api-status`, { force: true });
    assert.equal(polled.status, 200);

    for (const path of [`${C}`, `${C}/payment-setup`, `${C}/ach/files`, `${C}/ach/files/${s.file.id}`, `${C}/pay-runs/${s.run.id}`, `${C}/pay-runs/${s.run.id}/legs`]) {
      const r = await call('GET', path);
      assert.ok(!/PRIVATE KEY|123456789012|privateKeyEncrypted|debtorAccountEncrypted/.test(r.text), `${path} leaks a secret`);
    }
    // Another company's key cannot touch this file.
    const other = newCompany(s.store, { ein: '98-7654321' });
    const res = await fetch(`${base}${C}/ach/files/${s.file.id}/approve-and-send`, { method: 'POST', headers: { authorization: `Bearer ${other.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ approvedBy: 'x', confirm: s.confirm }) });
    assert.equal(res.status, 403);
  } finally {
    app.server.close();
  }
});
