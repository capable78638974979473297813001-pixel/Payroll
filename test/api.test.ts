import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/api/app.ts';
import { Store } from '../src/store/store.ts';
import { MoneyService } from '../src/money/service.ts';
import { signPayload } from '../src/money/webhooks.ts';
import type { Config } from '../src/config.ts';
import { FakeStripe } from './fake-stripe.ts';
import { day } from './helpers.ts';

const ADMIN = 'admin-token-for-tests';
const WH = 'whsec_api_test';
const config: Config = { port: 0, dataFile: undefined, adminToken: ADMIN, openSignup: false, webhookSecrets: [WH, 'whsec_connect_endpoint'], holdHours: 0, autoDisburse: false };

let base = '';
let close: () => void;
const stripe = new FakeStripe();
const store = new Store();

before(async () => {
  const money = new MoneyService(store, stripe, { holdHours: 0 });
  const app = createApp({ store, money, config });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  close = () => app.server.close();
});
after(() => close());

async function call(method: string, path: string, opts: { token?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.body !== undefined || opts.raw !== undefined ? { 'content-type': 'application/json' } : {}), ...opts.headers },
    body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

let evSeq = 0;
async function webhook(type: string, object: Record<string, unknown>, opts: { secret?: string; account?: string } = {}) {
  const raw = JSON.stringify({ id: `evt_api_${++evSeq}`, type, ...(opts.account ? { account: opts.account } : {}), data: { object } });
  return call('POST', '/v1/webhooks/stripe', { raw, headers: { 'stripe-signature': signPayload(raw, opts.secret ?? WH) } });
}

const state: { cid?: string; key?: string; emp: Record<string, string>; runId?: string } = { emp: {} };

test('the industry picker is public and shows restaurant as available, others as planned', async () => {
  const r = await call('GET', '/v1/industries');
  assert.equal(r.status, 200);
  const rest = r.body.industries.find((i: any) => i.id === 'restaurant');
  assert.equal(rest.status, 'available');
  assert.equal(rest.niches.length, 9);
  assert.ok(r.body.industries.some((i: any) => i.status === 'planned'));
  const niche = await call('GET', '/v1/industries/restaurant/niches/fine_dining');
  assert.equal(niche.body.policy.pool.enabled, true);
  assert.equal(niche.body.policy.takesTipCredit, false);
  assert.equal((await call('GET', '/v1/industries/restaurant/niches/nope')).status, 404);
});

test('creating a company needs the admin token, and returns a one-time company key', async () => {
  const body = { legalName: 'Corner Table LLC', ein: '12-3456789', industry: 'restaurant', niche: 'full_service', homeState: 'TX', typicalDailyEmployees: 14 };
  assert.equal((await call('POST', '/v1/companies', { body })).status, 401);
  assert.equal((await call('POST', '/v1/companies', { token: 'wrong', body })).status, 401);
  const r = await call('POST', '/v1/companies', { token: ADMIN, body });
  assert.equal(r.status, 201);
  assert.match(r.body.apiKey, /^totali_sk_/);
  assert.equal(r.body.company.niche.id, 'full_service');
  assert.ok(r.body.company.checklist.some((c: any) => c.id === 'tip_credit_notice'));
  assert.ok(!r.body.company.checklist.some((c: any) => c.id === 'ca_meal_rest'), 'California items do not apply to a Texas restaurant');
  state.cid = r.body.company.id;
  state.key = r.body.apiKey;
  // the stored key is a hash, not the secret
  assert.ok(!JSON.stringify(store.apiKeys.all()).includes(state.key!));
  assert.equal((await call('POST', '/v1/companies', { token: ADMIN, body })).status, 409, 'same EIN twice');
});

test('a company key reaches its own company only', async () => {
  assert.equal((await call('GET', `/v1/companies/${state.cid}`, { token: state.key })).status, 200);
  assert.equal((await call('GET', `/v1/companies/${state.cid}`)).status, 401);
  const other = await call('POST', '/v1/companies', { token: ADMIN, body: { legalName: 'Other Cafe', ein: '98-7654321', industry: 'restaurant', niche: 'cafe_coffee', homeState: 'TX' } });
  assert.equal((await call('GET', `/v1/companies/${other.body.company.id}`, { token: state.key })).status, 403);
  assert.equal((await call('GET', `/v1/companies/${state.cid}`, { token: other.body.apiKey })).status, 403);
  assert.equal((await call('POST', '/v1/companies', { token: state.key, body: {} })).status, 403, 'a company key cannot create companies');
});

test('hiring: roles come from the niche, SSNs are accepted but never returned', async () => {
  const P = `/v1/companies/${state.cid}/employees`;
  const hire = (b: Record<string, unknown>) => call('POST', P, { token: state.key, body: { hireDate: '2026-01-05', tipCreditNoticeDate: '2026-01-05', ...b } });
  const ana = await hire({ firstName: 'Ana', lastName: 'Ruiz', roleKey: 'server', payType: { kind: 'hourly', rateCents: 213 }, ssn: '512-34-1001' });
  assert.equal(ana.status, 201, JSON.stringify(ana.body));
  assert.equal(ana.body.ssnOnFile, true);
  assert.equal(ana.body.ssnLast4, '1001');
  assert.ok(!JSON.stringify(ana.body).includes('512-34-1001'));
  assert.ok(!('ssnEncrypted' in ana.body));
  assert.ok(!JSON.stringify(store.employees.all()).includes('512-34-1001'), 'encrypted at rest');
  const ben = await hire({ firstName: 'Ben', lastName: 'Okafor', roleKey: 'busser', payType: { kind: 'hourly', rateCents: 213 }, ssn: '512-34-1002' });
  const dee = await hire({ firstName: 'Dee', lastName: 'Park', roleKey: 'line_cook', payType: { kind: 'hourly', rateCents: 1700 }, ssn: '512-34-1003' });
  state.emp = { ana: ana.body.id, ben: ben.body.id, dee: dee.body.id };
  assert.equal((await hire({ firstName: 'X', lastName: 'Y', roleKey: 'sommelier', payType: { kind: 'hourly', rateCents: 1000 } })).status, 400, 'sommelier is a fine-dining role');
  assert.equal((await hire({ firstName: 'X', lastName: 'Y', roleKey: 'server', payType: { kind: 'hourly', rateCents: 1000 }, ssn: '000-12-3456' })).status, 400, 'not an issuable SSN');
  assert.equal((await hire({ firstName: 'X', lastName: 'Y', roleKey: 'server', payType: { kind: 'hourly', rateCents: 1000.5 } })).status, 400, 'fractional cents');
});

test('shifts with tips are validated', async () => {
  const P = `/v1/companies/${state.cid}/shifts`;
  const put = (b: Record<string, unknown>) => call('POST', P, { token: state.key, body: b });
  for (const n of [0, 1, 2, 3, 4]) {
    assert.equal((await put({ employeeId: state.emp.ana, workDate: day(n), minutes: 360, chargedTipsCents: 8_000, cashTipsCents: 2_000, salesCents: 60_000, externalId: `pos-ana-${n}` })).status, 201);
    assert.equal((await put({ employeeId: state.emp.ben, workDate: day(n), minutes: 360 })).status, 201);
    assert.equal((await put({ employeeId: state.emp.dee, workDate: day(n), clockIn: `${day(n)}T14:00:00Z`, clockOut: `${day(n)}T22:30:00Z`, unpaidBreakMinutes: 30 })).status, 201);
  }
  assert.equal((await put({ employeeId: state.emp.dee, workDate: day(0), minutes: 60, chargedTipsCents: 100 })).status, 400, 'a cook has no tips of their own');
  assert.equal((await put({ employeeId: state.emp.ana, workDate: '2026-02-30', minutes: 60 })).status, 400, 'not a real date');
  assert.equal((await put({ employeeId: state.emp.ana, workDate: day(0), minutes: 5000 })).status, 400);
  // re-sending the same POS shift replaces it, it does not add a second one
  const again = await put({ employeeId: state.emp.ana, workDate: day(0), minutes: 360, chargedTipsCents: 9_000, cashTipsCents: 2_000, salesCents: 60_000, externalId: 'pos-ana-0' });
  assert.equal(again.status, 201);
  const list = await call('GET', `${P}?from=${day(0)}&to=${day(6)}&employeeId=${state.emp.ana}`, { token: state.key });
  assert.equal(list.body.shifts.length, 5);
  assert.equal(list.body.shifts.find((s: any) => s.externalId === 'pos-ana-0').chargedTipsCents, 9_000);
});

test('draft a pay run: the niche rules ran, issues are reported, nothing is approved yet', async () => {
  const r = await call('POST', `/v1/companies/${state.cid}/pay-runs`, { token: state.key, body: { periodStart: day(0), periodEnd: day(6), checkDate: day(11) } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  state.runId = r.body.id;
  assert.equal(r.body.status, 'draft');
  const ana = r.body.paychecks.find((p: any) => p.employeeId === state.emp.ana);
  assert.ok(ana.earnings.some((e: any) => e.code === 'TIPS_CASH' && e.paidByPayroll === false));
  // only a busser worked: 1.5% of 60,000 sales = 900 a night. No bartender was on, so the bar tip-out was not taken.
  assert.equal(ana.tips.tipOutPaidCents, 900 * 5);
  assert.ok(r.body.issues.some((i: any) => i.code === 'tip_out_no_recipient'));
  assert.ok(r.body.issues.some((i: any) => i.code === 'payout_account_not_ready' && i.severity === 'review'));
  assert.equal(r.body.issues.filter((i: any) => i.severity === 'blocking').length, 0);
});

test('approval needs the operator to acknowledge review issues', async () => {
  const P = `/v1/companies/${state.cid}/pay-runs/${state.runId}`;
  const refused = await call('POST', `${P}/approve`, { token: state.key, body: {} });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'review_not_acknowledged');
  assert.ok(refused.body.error.details.issues.length > 0);
});

test('employees connect their own bank through Stripe; Totali only hears back by webhook', async () => {
  for (const id of Object.values(state.emp)) {
    const r = await call('POST', `/v1/companies/${state.cid}/employees/${id}/payout/onboarding`, { token: state.key, body: { returnUrl: 'https://app.totali.test/done', refreshUrl: 'https://app.totali.test/retry' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.url, /^https:\/\/connect\.stripe\.test\//);
    const acct = r.body.accountId;
    const w = await webhook('account.updated', { id: acct, payouts_enabled: true, details_submitted: true, external_accounts: { data: [{ last4: '6789' }] } });
    assert.equal(w.status, 200);
    assert.equal(w.body.handled, true);
  }
  const e = await call('GET', `/v1/companies/${state.cid}/employees/${state.emp.ana}`, { token: state.key });
  assert.equal(e.body.payout.status, 'ready');
  assert.equal(e.body.payout.bankLast4, '6789');
});

test('the employer links a bank through Stripe, then the webhook marks funding ready', async () => {
  const r = await call('POST', `/v1/companies/${state.cid}/funding/setup`, { token: state.key });
  assert.equal(r.status, 200);
  assert.match(r.body.clientSecret, /^seti_secret_/);
  await webhook('setup_intent.succeeded', { id: r.body.setupIntentId, payment_method: 'pm_bank_api', metadata: { company_id: state.cid } });
  const c = await call('GET', `/v1/companies/${state.cid}`, { token: state.key });
  assert.equal(c.body.funding.status, 'ready');
  assert.equal(c.body.funding.bankLast4, '6789');
});

test('a second endpoint (Connect) with its own secret is accepted too', async () => {
  const w = await webhook('payout.failed', { id: 'po_1' }, { secret: 'whsec_connect_endpoint', account: 'acct_unknown' });
  assert.equal(w.status, 200);
});

test('webhooks must be signed; a bad signature changes nothing', async () => {
  const raw = JSON.stringify({ id: 'evt_forged', type: 'payment_intent.succeeded', data: { object: { id: 'pi_x' } } });
  assert.equal((await call('POST', '/v1/webhooks/stripe', { raw })).status, 400);
  assert.equal((await call('POST', '/v1/webhooks/stripe', { raw, headers: { 'stripe-signature': signPayload(raw, 'whsec_wrong') } })).status, 400);
  assert.equal(store.webhookEvents.get('evt_forged'), undefined);
});

test('approve, fund, settle by webhook, disburse', async () => {
  const P = `/v1/companies/${state.cid}/pay-runs/${state.runId}`;
  const fresh = await call('POST', `${P}/recalculate`, { token: state.key });
  assert.equal(fresh.status, 200);
  const ok = await call('POST', `${P}/approve`, { token: state.key, body: { acknowledgeReviewIssues: true } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.status, 'approved');

  const funded = await call('POST', `${P}/fund`, { token: state.key });
  assert.equal(funded.status, 200, JSON.stringify(funded.body));
  assert.equal(funded.body.leg.status, 'processing');
  assert.equal(funded.body.leg.amountCents, ok.body.totals.fundingRequiredCents);
  assert.equal((await call('POST', `${P}/disburse`, { token: state.key })).status, 409, 'not funded until the bank settles');

  const pi = stripe.settle([...stripe.intents.keys()][0]);
  const w = await webhook('payment_intent.succeeded', { id: pi.id, amount: pi.amount, latest_charge: pi.latest_charge, metadata: { run_id: state.runId, leg_id: funded.body.leg.id } });
  assert.equal(w.body.handled, true);
  assert.equal((await call('GET', P, { token: state.key })).body.status, 'funded');

  const out = await call('POST', `${P}/disburse`, { token: state.key });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.status, 'completed');
  assert.equal(out.body.paid.length, 3);
  assert.equal(stripe.transfers.length, 3);

  const ledger = await call('GET', `/v1/companies/${state.cid}/ledger?runId=${state.runId}`, { token: state.key });
  assert.equal(ledger.body.balances.employee_net_pay, 0);
  assert.equal(ledger.body.balances.stripe_cash, ok.body.totals.employeeTaxCents + ok.body.totals.employerTaxCents + ok.body.totals.deductionsCents);
});

test('after the run: tip report, MasteryTax check and 941 over HTTP', async () => {
  const tips = await call('GET', `/v1/companies/${state.cid}/reports/tips?from=${day(0)}&to=${day(30)}`, { token: state.key });
  assert.equal(tips.status, 200);
  const anaRow = tips.body.cashTipReporting.find((r: any) => r.employeeId === state.emp.ana);
  assert.equal(anaRow.cashTipsCents, 10_000);
  assert.equal(anaRow.mustReport, true);
  assert.equal(anaRow.reportDueBy, '2026-07-10');
  assert.equal(tips.body.form8027.applies, true);
  assert.ok(tips.body.ficaTipCredit.creditCents > 0);

  const v = await call('GET', `/v1/companies/${state.cid}/tax/validate?asOf=${day(40)}`, { token: state.key });
  assert.equal(v.status, 200, JSON.stringify(v.body).slice(0, 300));
  // No withholding variance. The only findings are the registration facts this test company never supplied.
  const findings = v.body.result as Array<{ severity: string; code: string }>;
  assert.ok(findings.every((i) => i.severity === 'warning'), JSON.stringify(findings));
  assert.deepEqual(findings.map((i) => i.code).sort(), ['default-sui-rate', 'not-registered'].sort());
  const f = await call('GET', `/v1/companies/${state.cid}/tax/941?year=2026&quarter=2&asOf=${day(40)}`, { token: state.key });
  assert.equal(f.status, 200);
  assert.equal((await call('GET', `/v1/companies/${state.cid}/tax/941?asOf=${day(40)}`, { token: state.key })).status, 400, 'year and quarter required');
  assert.equal((await call('GET', `/v1/companies/${state.cid}/tax/bogus`, { token: state.key })).status, 404);
});

test('the run is final: shifts cannot change and a second run cannot overlap it', async () => {
  const P = `/v1/companies/${state.cid}`;
  const shifts = (await call('GET', `${P}/shifts?from=${day(0)}&to=${day(0)}`, { token: state.key })).body.shifts;
  assert.equal((await call('DELETE', `${P}/shifts/${shifts[0].id}`, { token: state.key })).status, 409);
  assert.equal((await call('POST', `${P}/pay-runs`, { token: state.key, body: { periodStart: day(3), periodEnd: day(9), checkDate: day(12) } })).status, 409);
  assert.equal((await call('POST', `${P}/pay-runs/${state.runId}/void`, { token: state.key })).status, 409, 'money has moved');
});

test('errors never leak internals; unknown routes and bad bodies are handled', async () => {
  assert.equal((await call('GET', '/nope')).status, 404);
  assert.equal((await call('DELETE', '/v1/industries')).status, 405);
  const bad = await call('POST', `/v1/companies/${state.cid}/shifts`, { token: state.key, raw: '{not json' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'invalid_request');
  const huge = await call('POST', `/v1/companies/${state.cid}/shifts`, { token: state.key, raw: JSON.stringify({ pad: 'x'.repeat(1_100_000) }) });
  assert.equal(huge.status, 413);
  const h = await call('GET', '/health');
  assert.equal(h.body.ok, true);
  assert.ok(!JSON.stringify(h.body).includes('sk_'));
  assert.equal(h.headers.get('cache-control'), 'no-store');
});
