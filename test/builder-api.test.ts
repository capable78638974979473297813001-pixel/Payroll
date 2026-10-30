import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store/store.ts';
import { BankService } from '../src/banking/accounts.ts';
import { AchService } from '../src/money/ach.ts';
import { SandboxBank } from '../src/ach/sandbox.ts';
import { createApp } from '../src/api/app.ts';
import { AccountService } from '../src/accounts/accounts.ts';
import { setPasswordCost } from '../src/accounts/password.ts';
import { OutboxMailer } from '../src/mail/mailer.ts';
import type { Config } from '../src/config.ts';
import { lagDays } from '../src/builder/finish.ts';
import { approvePayRun, draftPayRun } from '../src/payroll/payRuns.ts';
import { FakeStripe } from './fake-stripe.ts';
import { day, hire, newCompany, shiftsFor } from './helpers.ts';

setPasswordCost(1024);
const store = new Store();
const mailer = new OutboxMailer();
let base = '';
let close: () => void;
const config: Config = { port: 0, dataFile: undefined, adminToken: 'admin-token-builder-tests', openSignup: false, ach: { mode: 'outbox', outboxDir: '', config: { originator: { odfiRoutingNumber: '', odfiName: '', immediateOrigin: '', companyName: '', companyId: '' }, holdBankingDays: 2, fundingLeadBankingDays: 1, creditLeadBankingDays: 1, trustSettlementDate: false } }, autoDisburse: false, rateLimitPerMinute: 0, trustProxy: false };

before(async () => {
  const banks = new BankService(store, new FakeStripe());
  const app = createApp({ store, banks, ach: new AchService(store, banks, new SandboxBank(), config.ach.config), config, mailer, accounts: new AccountService(store, mailer) });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  close = () => app.server.close();
});
after(() => close());

async function call(method: string, path: string, o: { body?: unknown; cookie?: string } = {}) {
  const res = await fetch(base + path, { method, headers: { 'x-totali-csrf': '1', ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(o.cookie ? { cookie: o.cookie } : {}) }, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* text */ }
  return { status: res.status, json, text, headers: res.headers };
}

/** A signed-in, verified user. */
let seq = 0;
async function person(verified = true) {
  const email = `owner${++seq}@harbor.test`;
  const s = await call('POST', '/v1/auth/signup', { body: { firstName: 'Sam', lastName: 'Owner', businessName: `Harbor Street Kitchen ${seq}`, email, password: 'a-good-password', acceptTerms: true } });
  const cookie = (s.headers.get('set-cookie') ?? '').split(';')[0]!;
  if (verified) {
    const code = /\b(\d{6})\b/.exec(mailer.messages.filter((m) => m.to === email).at(-1)!.text)![1]!;
    assert.equal((await call('POST', '/v1/auth/verify', { cookie, body: { code } })).status, 200);
  }
  return { email, cookie };
}

const FULL = { state: 'MI', locations: [{ name: 'Detroit', city: 'Detroit', state: 'MI' }, { name: 'Ferndale', city: 'Ferndale', state: 'MI' }], team: '11-25', tips: { on: true, pool: 'hours' }, frequency: { value: 'weekly', weekday: 'friday' }, contractors: { on: true, count: 2 } };

test('the industry list is public and carries every question and the supported states', async () => {
  const r = await call('GET', '/v1/builder/industries');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.industries.map((i: { id: string }) => i.id), ['restaurant', 'hotel_lodging', 'construction_trades', 'office_studios', 'delivery_couriers']);
  assert.deepEqual(r.json.industries[0].tags, ['Tips', 'Shift hours', 'Tip pool']);
  assert.equal(r.json.industries[0].questions.length, 6);
  assert.ok(r.json.states.some((s: { code: string; name: string }) => s.code === 'MI' && s.name === 'Michigan'));
  assert.equal(r.json.states.length, 51);
});

test('the preview needs a signed-in person, and returns the design\'s numbers for the design\'s answers', async () => {
  assert.equal((await call('POST', '/v1/builder/preview', { body: { industry: 'restaurant', answers: {} } })).status, 401);
  const { cookie } = await person();
  const base0 = await call('POST', '/v1/builder/preview', { cookie, body: { industry: 'restaurant', answers: {} } });
  assert.deepEqual(base0.json.counts, { modules: 5, items: 12, forms: 3 });
  const full = await call('POST', '/v1/builder/preview', { cookie, body: { industry: 'restaurant', answers: FULL } });
  assert.deepEqual(full.json.counts, { modules: 8, items: 28, forms: 4 });
  assert.equal(full.json.progress.ready, true);
  const bad = await call('POST', '/v1/builder/preview', { cookie, body: { industry: 'restaurant', answers: { state: 'ZZ', team: '11-25' } } });
  assert.match(bad.json.errors.state, /can't run payroll/);
  assert.equal(bad.json.answers.team, '11-25', 'the good answer is kept');
  assert.equal((await call('POST', '/v1/builder/preview', { cookie, body: { industry: 'bank', answers: {} } })).status, 400);
});

test('an unverified person can preview but cannot build a company', async () => {
  const { cookie } = await person(false);
  await call('PUT', '/v1/builder/draft', { cookie, body: { industry: 'restaurant', answers: FULL, step: 'review' } });
  const r = await call('POST', '/v1/builder/finish', { cookie });
  assert.equal(r.status, 403);
});

test('answers are saved as they go, and come back with the person', async () => {
  const { cookie } = await person();
  const saved = await call('PUT', '/v1/builder/draft', { cookie, body: { industry: 'restaurant', answers: { state: 'MI', team: '11-25', junk: 1 }, step: 'tips' } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.user.setup.answers, { state: 'MI', team: '11-25' });
  const me = await call('GET', '/v1/auth/me', { cookie });
  assert.equal(me.json.user.setup.step, 'tips');
  assert.equal(me.json.user.setup.industry, 'restaurant');
});

test('building too early is refused and says what is next', async () => {
  const { cookie } = await person();
  assert.equal((await call('POST', '/v1/builder/finish', { cookie })).json.error.code, 'setup_incomplete');
  await call('PUT', '/v1/builder/draft', { cookie, body: { industry: 'restaurant', answers: { state: 'MI' }, step: 'locations' } });
  const r = await call('POST', '/v1/builder/finish', { cookie });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.details.next, 'locations');
});

test('building makes the company the answers describe, once, and the person can then use it', async () => {
  const { cookie } = await person();
  await call('PUT', '/v1/builder/draft', { cookie, body: { industry: 'restaurant', answers: FULL, step: 'review' } });
  const done = await call('POST', '/v1/builder/finish', { cookie });
  assert.equal(done.status, 201, done.text);
  const cid = done.json.companyId as string;
  assert.equal(done.json.user.companyId, cid);
  const c = store.companies.get(cid)!;
  assert.deepEqual([c.industry, c.niche, c.homeState, c.ein], ['restaurant', 'full_service', 'MI', '']);
  assert.match(c.legalName, /^Harbor Street Kitchen/);
  assert.deepEqual(c.paySchedule, { frequency: 'weekly', checkDateLagDays: 5, payWeekday: 'friday' });
  assert.equal(c.locations!.length, 2);
  assert.equal(c.payment.mode, 'employer_bank', 'Totali never holds the money unless an admin says so');
  assert.equal(c.settings.policy.pool.enabled, true);
  assert.equal(c.settings.policy.pool.basis, 'hours');
  assert.ok(c.settings.policy.pool.roles.length > 0 && !c.settings.policy.pool.roles.includes('general_manager'));
  assert.equal((await call('POST', '/v1/builder/finish', { cookie })).json.error.code, 'company_exists');
  assert.equal((await call('PUT', '/v1/builder/draft', { cookie, body: { industry: 'restaurant', answers: {} } })).status, 409);
  // The cookie now opens the company's own routes, with no API key.
  const view = await call('GET', `/v1/companies/${cid}`, { cookie });
  assert.equal(view.status, 200);
  assert.equal(view.json.homeState, 'MI');
  assert.equal((await call('GET', `/v1/companies/${cid}/employees`, { cookie })).status, 200);
});

test('one person\'s session cannot open another person\'s company', async () => {
  const a = await person(); const b = await person();
  for (const p of [a, b]) {
    await call('PUT', '/v1/builder/draft', { cookie: p.cookie, body: { industry: 'restaurant', answers: FULL, step: 'review' } });
    await call('POST', '/v1/builder/finish', { cookie: p.cookie });
  }
  const aid = (await call('GET', '/v1/auth/me', { cookie: a.cookie })).json.user.companyId;
  const bid = (await call('GET', '/v1/auth/me', { cookie: b.cookie })).json.user.companyId;
  assert.notEqual(aid, bid);
  assert.equal((await call('GET', `/v1/companies/${bid}`, { cookie: a.cookie })).status, 403);
  assert.equal((await call('GET', `/v1/companies/${aid}`)).status, 401);
});

test('a person who has not built a company yet cannot reach company routes', async () => {
  const { cookie } = await person();
  const r = await call('GET', '/v1/companies/co_anything', { cookie });
  assert.equal(r.status, 403);
});

test('no tips means no tip pool and the fast-casual starting point; other industries get their own', async () => {
  const mk = async (industry: string, answers: unknown) => {
    const { cookie } = await person();
    await call('PUT', '/v1/builder/draft', { cookie, body: { industry, answers, step: 'review' } });
    const r = await call('POST', '/v1/builder/finish', { cookie });
    assert.equal(r.status, 201, r.text);
    return store.companies.get(r.json.companyId)!;
  };
  const noTips = await mk('restaurant', { ...FULL, tips: { on: false, pool: 'none' } });
  assert.deepEqual([noTips.niche, noTips.settings.policy.takesTipCredit, noTips.settings.policy.pool.enabled], ['fast_casual', false, false]);
  const hotel = await mk('hotel_lodging', { state: 'OH', locations: [{ name: 'Inn', city: 'Columbus', state: 'OH' }], team: '26-50', frequency: { value: 'biweekly', weekday: 'thursday' }, service: { on: true } });
  assert.deepEqual([hotel.industry, hotel.niche, hotel.settings.policy.serviceCharge, hotel.paySchedule.frequency], ['hotel_lodging', 'hotel_venue', 'distribute_to_staff', 'biweekly']);
  const trades = await mk('construction_trades', { state: 'TX', locations: [{ name: 'Yard', city: 'Austin', state: 'TX' }], team: '1-10', frequency: { value: 'weekly', weekday: 'friday' }, jobs: { on: true } });
  assert.deepEqual([trades.niche, trades.settings.workweekStartDay, trades.paySchedule.checkDateLagDays], ['trades_contractor', 1, 5]);
});

test('the pay day sets the lag from the end of the workweek', () => {
  assert.equal(lagDays(1, 'friday'), 5, 'a Monday week ends Sunday; Friday is five days on');
  assert.equal(lagDays(0, 'friday'), 6, 'a Sunday week ends Saturday');
  assert.equal(lagDays(1, 'sunday'), 7, 'the day after it ends is one; the same day is a full week');
  assert.equal(lagDays(1, 'monday'), 1);
});

test('payroll cannot be approved until the EIN has been added', () => {
  const s = new Store();
  const { company } = newCompany(s);
  const cid = company.id;
  const e = hire(s, cid, { firstName: 'Ana', lastName: 'Ruiz', payType: { kind: 'hourly', rateCents: 1500 }, roleKey: 'line_cook', tipCreditNoticeDate: undefined });
  shiftsFor(s, cid, e.id, [0, 1, 2], { minutes: 480 });
  const run = draftPayRun(s, cid, { periodStart: day(0), periodEnd: day(6), checkDate: day(11) });
  s.tx(() => s.companies.put({ ...s.companies.require(cid, 'Company'), ein: '' }));
  assert.throws(() => approvePayRun(s, cid, run.id, { acknowledgeReviewIssues: true }), (err: { code?: string }) => err.code === 'company_not_verified');
  s.tx(() => s.companies.put({ ...s.companies.require(cid, 'Company'), ein: '12-3456789' }));
  assert.equal(approvePayRun(s, cid, run.id, { acknowledgeReviewIssues: true }).status, 'approved');
});
