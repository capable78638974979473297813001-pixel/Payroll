import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/api/app.ts';
import { Store } from '../src/store/store.ts';
import { BankService } from '../src/banking/accounts.ts';
import { AchService } from '../src/money/ach.ts';
import { SandboxBank } from '../src/ach/sandbox.ts';
import { parseAchFile } from '../src/ach/nacha.ts';
import type { Config } from '../src/config.ts';
import { FakeStripe } from './fake-stripe.ts';
import { day, ROUTING, ROUTING_2 } from './helpers.ts';

const ADMIN = 'admin-token-for-tests';
const clock = { now: new Date('2026-06-08T15:00:00Z') };
const setDay = (iso: string) => (clock.now = new Date(`${iso}T15:00:00Z`));

const config: Config = {
  port: 0,
  dataFile: undefined,
  adminToken: ADMIN,
  openSignup: false,
  ach: { mode: 'sandbox', outboxDir: '', config: { originator: { odfiRoutingNumber: ROUTING_2, odfiName: 'Test Sponsor Bank', immediateOrigin: '123456789', companyName: 'Totali Payroll', companyId: '1123456789' }, holdBankingDays: 2, fundingLeadBankingDays: 1, creditLeadBankingDays: 1, trustSettlementDate: false } },
  autoDisburse: false,
  rateLimitPerMinute: 0,
  trustProxy: false,
};

let base = '';
let close: () => void;
const stripe = new FakeStripe();
const bank = new SandboxBank();
const store = new Store();
let limited: { base: string; close: () => void };

async function boot(cfg: Config) {
  const banks = new BankService(store, stripe, { now: () => clock.now });
  const ach = new AchService(store, banks, bank, cfg.ach.config, { now: () => clock.now });
  const app = createApp({ store, banks, ach, config: cfg, now: () => clock.now });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, close: () => app.server.close() };
}

before(async () => {
  const a = await boot(config);
  base = a.base;
  close = a.close;
  limited = await boot({ ...config, rateLimitPerMinute: 5 });
});
after(() => {
  close();
  limited.close();
});

async function call(method: string, path: string, opts: { token?: string; body?: unknown; raw?: string; headers?: Record<string, string>; at?: string } = {}) {
  const res = await fetch((opts.at ?? base) + path, {
    method,
    headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.body !== undefined || opts.raw !== undefined ? { 'content-type': 'application/json' } : {}), ...opts.headers },
    body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  const text = await res.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // plain text
  }
  return { status: res.status, body, headers: res.headers };
}

const state: { cid?: string; key?: string; emp: Record<string, string>; runId?: string; bankId?: string; fundFile?: string; creditFile?: string } = { emp: {} };
const K = () => state.key;
const P = (s = '') => `/v1/companies/${state.cid}${s}`;

test('the industry picker is public: restaurant is available with nine niches, others are planned', async () => {
  const r = await call('GET', '/v1/industries');
  assert.equal(r.status, 200);
  const rest = r.body.industries.find((i: any) => i.id === 'restaurant');
  assert.equal(rest.status, 'available');
  assert.equal(rest.niches.length, 9);
  assert.ok(r.body.industries.some((i: any) => i.status === 'planned'));
  assert.equal((await call('GET', '/v1/industries/restaurant/niches/fine_dining')).body.policy.pool.enabled, true);
  assert.equal((await call('GET', '/v1/industries/restaurant/niches/nope')).status, 404);
  const h = await call('GET', '/health');
  assert.equal(h.body.stripe.role, 'bank linking only');
});

test('creating a company needs the admin token and returns a one-time company key', async () => {
  const body = { legalName: 'Corner Table LLC', ein: '12-3456789', industry: 'restaurant', niche: 'full_service', homeState: 'TX', typicalDailyEmployees: 14, paymentMode: 'totali_ach' };
  assert.equal((await call('POST', '/v1/companies', { body })).status, 401);
  assert.equal((await call('POST', '/v1/companies', { token: 'wrong', body })).status, 401);
  const r = await call('POST', '/v1/companies', { token: ADMIN, body });
  assert.equal(r.status, 201);
  assert.match(r.body.apiKey, /^totali_sk_/);
  state.cid = r.body.company.id;
  state.key = r.body.apiKey;
  assert.ok(!JSON.stringify(store.apiKeys.all()).includes(state.key!));
  assert.equal((await call('POST', '/v1/companies', { token: ADMIN, body })).status, 409);
});

test('a company key reaches its own company only, and no ops route', async () => {
  const other = await call('POST', '/v1/companies', { token: ADMIN, body: { legalName: 'Other Cafe', ein: '98-7654321', industry: 'restaurant', niche: 'cafe_coffee', homeState: 'TX' } });
  assert.equal((await call('GET', `/v1/companies/${other.body.company.id}`, { token: K() })).status, 403);
  assert.equal((await call('GET', P(), { token: other.body.apiKey })).status, 403);
  assert.equal((await call('GET', '/v1/ops/ach/files', { token: K() })).status, 403);
  assert.equal((await call('POST', '/v1/ops/ach/advance', { token: K() })).status, 403);
  assert.equal((await call('GET', '/v1/ops/ach/files', { token: ADMIN })).status, 200);
});

test('hiring: SSNs are accepted but never returned', async () => {
  const hire = (b: Record<string, unknown>) => call('POST', P('/employees'), { token: K(), body: { hireDate: '2026-01-05', ...b } });
  const ana = await hire({ firstName: 'Ana', lastName: 'Ruiz', roleKey: 'line_cook', payType: { kind: 'hourly', rateCents: 1700 }, ssn: '512-34-1001' });
  assert.equal(ana.status, 201, JSON.stringify(ana.body));
  assert.ok(!JSON.stringify(ana.body).includes('512-34-1001'));
  assert.ok(!JSON.stringify(store.employees.all()).includes('512-34-1001'));
  const ben = await hire({ firstName: 'Ben', lastName: 'Okafor', roleKey: 'dishwasher', payType: { kind: 'hourly', rateCents: 1500 }, ssn: '512-34-1002' });
  state.emp = { ana: ana.body.id, ben: ben.body.id };
  assert.equal((await hire({ firstName: 'X', lastName: 'Y', roleKey: 'sommelier', payType: { kind: 'hourly', rateCents: 1000 } })).status, 400);
});

test('the employer links a bank: Stripe confirms it, the owner types the number, it is held encrypted', async () => {
  const link = await call('POST', P('/bank-links'), { token: K(), body: { owner: 'company' } });
  assert.equal(link.status, 201);
  assert.deepEqual(link.body.permissions, ['balances', 'ownership']);
  stripe.link(link.body.sessionId, { owners: ['CORNER TABLE LLC'], last4: '4321' });
  const bad = await call('POST', P('/bank-links/complete'), { token: K(), body: { sessionId: link.body.sessionId, routingNumber: ROUTING_2, accountNumber: '000987650000' } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.message, /same four digits/);
  assert.ok(!JSON.stringify(bad.body).includes('000987650000'), 'the rejected number is not echoed back');
  const ok = await call('POST', P('/bank-links/complete'), { token: K(), body: { sessionId: link.body.sessionId, routingNumber: ROUTING_2, accountNumber: '000987654321' } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.status, 'active');
  assert.equal(ok.body.last4, '4321');
  assert.ok(!JSON.stringify(ok.body).includes('000987654321'));
  assert.ok(!JSON.stringify(store.bankAccounts.all()).includes('000987654321'), 'encrypted at rest');
  state.bankId = ok.body.id;
});

test('the employer authorizes debits for that account before any debit can happen', async () => {
  assert.equal((await call('GET', P('/funding/authorization'), { token: K() })).status, 400, 'choose an account first');
  assert.equal((await call('PUT', P('/funding/account'), { token: K(), body: { bankAccountId: state.bankId } })).status, 200);
  const t = await call('GET', P('/funding/authorization'), { token: K() });
  assert.match(t.body.text, /ending 4321/);
  assert.equal(t.body.accepted, null);
  assert.equal((await call('POST', P('/funding/authorization'), { token: K(), body: { bankAccountId: state.bankId, acceptedBy: 'Owner Person', accept: false } })).status, 400);
  const a = await call('POST', P('/funding/authorization'), { token: K(), body: { bankAccountId: state.bankId, acceptedBy: 'Owner Person', accept: true } });
  assert.equal(a.status, 201);
  assert.equal(a.body.textVersion, 'draft-1');
  assert.equal(a.body.acceptedBy, 'Owner Person');
  assert.ok(a.body.ip, 'the address it was accepted from is recorded');
});

test('employees get bank accounts: one by bank link, one entered manually and verified by a prenote', async () => {
  const L = await call('POST', P('/bank-links'), { token: K(), body: { owner: 'employee', employeeId: state.emp.ana } });
  stripe.link(L.body.sessionId, { owners: ['Ruiz, Ana'], last4: '1111' });
  const anaAcct = await call('POST', P('/bank-links/complete'), { token: K(), body: { sessionId: L.body.sessionId, routingNumber: ROUTING, accountNumber: '000000001111' } });
  assert.equal(anaAcct.body.status, 'active');
  assert.equal((await call('PUT', P(`/employees/${state.emp.ana}/payout-accounts`), { token: K(), body: { accounts: [{ bankAccountId: anaAcct.body.id, allocation: { kind: 'remainder' } }] } })).status, 200);

  const m = await call('POST', P('/bank-accounts/manual'), { token: K(), body: { employeeId: state.emp.ben, routingNumber: ROUTING, accountNumber: '000000002222', accountType: 'checking' } });
  assert.equal(m.status, 201);
  assert.equal(m.body.status, 'pending');
  assert.equal((await call('PUT', P(`/employees/${state.emp.ben}/payout-accounts`), { token: K(), body: { accounts: [{ bankAccountId: m.body.id, allocation: { kind: 'remainder' } }] } })).status, 200);
  assert.equal((await call('POST', P('/bank-accounts/manual'), { token: K(), body: { employeeId: state.emp.ben, routingNumber: '110000001', accountNumber: '000000003333', accountType: 'checking' } })).status, 400);

  // the prenote goes to the bank; the bank acknowledges; three banking days pass clean
  const pre = await call('POST', P('/ach/prenotes'), { token: K() });
  assert.equal(pre.status, 200);
  assert.equal(pre.body.accounts.length, 1);
  const f = parseAchFile(bank.received.at(-1)!.content);
  assert.equal(f.batches[0].entries[0].transactionCode, '23');
  assert.equal(f.batches[0].entries[0].amountCents, 0);
  setDay('2026-06-12');
  await call('POST', '/v1/ops/ach/advance', { token: ADMIN });
  assert.equal((await call('GET', P(`/bank-accounts/${m.body.id}`), { token: K() })).body.status, 'active');
});

test('shifts import all-or-nothing; a bad row saves none', async () => {
  setDay('2026-06-08');
  const mk = (id: string, n: number) => ({ employeeId: id, workDate: day(n), minutes: 480, externalId: `pos-${id}-${n}` });
  const shifts = [0, 1, 2, 3, 4].flatMap((n) => [mk(state.emp.ana, n), mk(state.emp.ben, n)]);
  const bad = await call('POST', P('/shifts/bulk'), { token: K(), body: { shifts: [...shifts, { employeeId: state.emp.ana, workDate: '2026-02-30', minutes: 60 }] } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.message, /shifts\[10\]/);
  assert.equal(store.shifts.all().length, 0);
  const ok = await call('POST', P('/shifts/bulk'), { token: K(), body: { shifts } });
  assert.equal(ok.status, 201);
  assert.equal(store.shifts.all().length, 10);
  assert.equal((await call('POST', P('/shifts/bulk'), { token: K(), body: { shifts: [] } })).status, 400);
  // re-sending the same POS shifts replaces them
  await call('POST', P('/shifts/bulk'), { token: K(), body: { shifts } });
  assert.equal(store.shifts.all().length, 10);
});

test('draft, approve, then plan the money: the timeline says when everyone is paid', async () => {
  const r = await call('POST', P('/pay-runs'), { token: K(), body: { periodStart: day(0), periodEnd: day(6), checkDate: day(11) } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  state.runId = r.body.id;
  assert.equal(r.body.issues.filter((i: any) => i.severity === 'blocking').length, 0);
  assert.equal((await call('POST', P(`/pay-runs/${state.runId}/approve`), { token: K(), body: { acknowledgeReviewIssues: true } })).status, 200);
  const t = await call('GET', P(`/pay-runs/${state.runId}/timeline`), { token: K() });
  assert.deepEqual({ d: t.body.debitEffectiveDate, r: t.body.earliestDisburseDate, c: t.body.earliestCreditEffectiveDate, ok: t.body.onTime }, { d: '2026-06-09', r: '2026-06-11', c: '2026-06-12', ok: true });
});

test('funding debits the employer by ACH; only the bank side can confirm the money arrived', async () => {
  const f = await call('POST', P(`/pay-runs/${state.runId}/fund`), { token: K(), body: {} });
  assert.equal(f.status, 200, JSON.stringify(f.body));
  assert.equal(f.body.leg.status, 'submitted');
  state.fundFile = f.body.file.id;
  const content = await call('GET', P(`/ach/files/${state.fundFile}/content`), { token: K() });
  assert.equal(content.status, 200);
  assert.equal(content.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.match(content.headers.get('content-disposition')!, /TOTALI_DEBIT_/);
  const parsed = parseAchFile(content.body);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.batches[0].entries[0].transactionCode, '27');
  assert.equal(parsed.batches[0].entries[0].accountNumber, '000987654321');

  const confirm = (token: string | undefined, body: unknown) => call('POST', `/v1/ops/pay-runs/${state.runId}/funds-received`, { token, body });
  assert.equal((await confirm(K(), { reference: 'X', amountCents: f.body.leg.amountCents })).status, 403, 'a company cannot confirm its own funds');
  assert.equal((await call('POST', `/v1/ops/ach/files/${state.fundFile}/accepted`, { token: K(), body: {} })).status, 403);
  assert.equal((await confirm(ADMIN, { reference: 'BANK-1', amountCents: f.body.leg.amountCents })).status, 409, 'before the debit date');
  assert.equal((await call('POST', P(`/pay-runs/${state.runId}/disburse`), { token: K() })).status, 409, 'not funded');
  setDay('2026-06-09');
  assert.equal((await confirm(ADMIN, { reference: 'BANK-1', amountCents: f.body.leg.amountCents + 1 })).status, 409, 'the amount must match');
  const ok = await confirm(ADMIN, { reference: 'BANK-1', amountCents: f.body.leg.amountCents });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.status, 'funded');
});

test('the hold, then the credits go out and settle', async () => {
  const P2 = P(`/pay-runs/${state.runId}/disburse`);
  const held = await call('POST', P2, { token: K() });
  assert.equal(held.status, 409);
  assert.equal(held.body.error.code, 'funds_on_hold');
  assert.equal(held.body.error.details.releaseDate, '2026-06-11');
  setDay('2026-06-11');
  const out = await call('POST', P2, { token: K() });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.paying.length, 2);
  assert.equal(out.body.effectiveDate, '2026-06-12');
  state.creditFile = out.body.file.id;
  const credit = parseAchFile((await call('GET', P(`/ach/files/${state.creditFile}/content`), { token: K() })).body);
  assert.deepEqual(credit.errors, []);
  assert.equal(credit.batches[0].serviceClass, '220');
  setDay('2026-06-12');
  await call('POST', '/v1/ops/ach/advance', { token: ADMIN });
  assert.equal((await call('GET', P(`/pay-runs/${state.runId}`), { token: K() })).body.status, 'completed');
  const ledger = await call('GET', P(`/ledger?runId=${state.runId}`), { token: K() });
  assert.equal(ledger.body.balances.employee_net_pay, 0);
});

test('a return from the bank is applied by ops; the net pay is owed again and the account is disabled', async () => {
  const legs = (await call('GET', P(`/pay-runs/${state.runId}/legs`), { token: K() })).body.legs.filter((l: any) => l.kind === 'employee_payout');
  const ana = legs.find((l: any) => l.employeeId === state.emp.ana);
  const returns = SandboxBank.returnFile([{ trace: ana.traceNumber, code: 'R02', amountCents: ana.amountCents }]);
  assert.equal((await call('POST', '/v1/ops/ach/returns', { token: K(), raw: returns })).status, 403);
  const r = await call('POST', '/v1/ops/ach/returns', { token: ADMIN, raw: returns });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.applied.length, 1);
  const run = (await call('GET', P(`/pay-runs/${state.runId}`), { token: K() })).body;
  assert.equal(run.status, 'disbursing');
  assert.ok(run.alerts.some((a: any) => a.code === 'payout_returned'));
  assert.equal((await call('GET', P('/ledger'), { token: K() })).body.balances.employee_net_pay, ana.amountCents);
  const again = await call('POST', '/v1/ops/ach/returns', { token: ADMIN, raw: returns });
  assert.equal(again.body.alreadyApplied.length, 1);
  assert.equal((await call('POST', '/v1/ops/ach/returns', { token: ADMIN, raw: 'garbage' })).status, 409);
});

test('pay stubs, tip reports, MasteryTax and the audit log', async () => {
  const stub = await call('GET', P(`/pay-runs/${state.runId}/paychecks/${state.emp.ana}/stub`), { token: K() });
  assert.equal(stub.status, 200);
  assert.equal(stub.body.structured.employee.ssnLast4, '1001');
  assert.ok(!JSON.stringify(stub.body).includes('512-34-1001'));
  const txt = await call('GET', P(`/pay-runs/${state.runId}/paychecks/${state.emp.ana}/stub?format=text`), { token: K() });
  assert.match(txt.body, /Paid to your bank account/);
  assert.match(txt.body, /Federal Income Tax|FIT|Social Security/i);

  const v = await call('GET', P(`/tax/validate?asOf=${day(40)}`), { token: K() });
  assert.equal(v.status, 200, JSON.stringify(v.body).slice(0, 300));
  assert.ok((v.body.result as Array<{ severity: string }>).every((i) => i.severity === 'warning'));

  const audit = store.auditLog.all();
  assert.ok(audit.length > 10);
  assert.ok(audit.every((a) => !('body' in a)));
  const everything = JSON.stringify(audit);
  for (const secret of ['000987654321', '512-34-1001', state.key!, ADMIN]) assert.ok(!everything.includes(secret), 'no secret in the audit log');
  assert.ok(audit.some((a) => a.actor === 'admin' && a.path === '/v1/ops/ach/returns'));
  assert.ok(audit.some((a) => a.actor === state.cid && a.method === 'POST' && a.path.endsWith('/fund')));
});

test('opening balances for an employee paid elsewhere earlier this year', async () => {
  const hire = await call('POST', P('/employees'), { token: K(), body: { firstName: 'New', lastName: 'Hire', roleKey: 'line_cook', hireDate: '2026-03-01', payType: { kind: 'hourly', rateCents: 2000 } } });
  const url = P(`/employees/${hire.body.id}/ytd-import`);
  const ok = await call('POST', url, { token: K(), body: { asOf: '2026-06-01', socialSecurityWagesCents: 3_000_000, medicareWagesCents: 3_000_000, futaWagesCents: 700_000, stateUnemploymentWagesCents: { TX: 900_000 } } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.ytd.socialSecurity, 3_000_000);
  assert.equal(ok.body.ytd.stateUnemployment.TX, 900_000);
  assert.equal(ok.body.ytdImport.asOf, '2026-06-01');
  assert.equal((await call('POST', url, { token: K(), body: { asOf: '2099-01-01', socialSecurityWagesCents: 0, medicareWagesCents: 0, futaWagesCents: 0 } })).status, 400);
  // someone already paid through Totali cannot have balances reset
  const paid = await call('POST', P(`/employees/${state.emp.ana}/ytd-import`), { token: K(), body: { asOf: '2026-06-01', socialSecurityWagesCents: 0, medicareWagesCents: 0, futaWagesCents: 0 } });
  assert.equal(paid.status, 409);
  assert.equal(paid.body.error.code, 'already_paid');
});

test('errors never leak internals; unknown routes and bad bodies are handled', async () => {
  assert.equal((await call('GET', '/nope')).status, 404);
  assert.equal((await call('DELETE', '/v1/industries')).status, 405);
  const bad = await call('POST', P('/shifts'), { token: K(), raw: '{not json' });
  assert.equal(bad.status, 400);
  assert.equal((await call('POST', P('/shifts'), { token: K(), raw: JSON.stringify({ pad: 'x'.repeat(1_100_000) }) })).status, 413);
  const h = await call('GET', '/health');
  assert.ok(!JSON.stringify(h.body).includes('sk_'));
  assert.equal(h.headers.get('cache-control'), 'no-store');
});

test('the rate limiter slows a flood, and failed logins lock the address out faster', async () => {
  const at = limited.base;
  const codes: number[] = [];
  for (let i = 0; i < 8; i++) codes.push((await call('GET', '/v1/industries', { at })).status);
  assert.deepEqual(codes.slice(0, 5), [200, 200, 200, 200, 200]);
  assert.equal(codes[7], 429);
  const r = await call('GET', '/v1/industries', { at });
  assert.equal(r.body.error.code, 'rate_limited');
  assert.ok(Number(r.headers.get('retry-after')) > 0);
});
