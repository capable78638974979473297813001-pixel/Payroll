import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store/store.ts';
import { BankService } from '../src/banking/accounts.ts';
import { AchService } from '../src/money/ach.ts';
import { SandboxBank } from '../src/ach/sandbox.ts';
import { createApp } from '../src/api/app.ts';
import type { Config } from '../src/config.ts';
import { AccountService, CODE_MINUTES, RESEND_SECONDS } from '../src/accounts/accounts.ts';
import { hashPassword, passwordProblem, setPasswordCost, verifyPassword } from '../src/accounts/password.ts';
import { OutboxMailer, ResendMailer, fromAddress, scrubMailLog, RESEND_TEST_SENDER } from '../src/mail/mailer.ts';
import { resolveInside } from '../src/web/static.ts';
import { ApiError } from '../src/lib/errors.ts';
import { FakeStripe } from './fake-stripe.ts';

setPasswordCost(1024);

const GOOD = { firstName: 'Sam', lastName: 'Owner', businessName: 'Harbor Street Kitchen', email: 'sam@harbor.test', password: 'a-good-password', acceptTerms: true };

function service(start = '2026-10-30T15:00:00Z') {
  const clock = { now: new Date(start) };
  const store = new Store();
  const mailer = new OutboxMailer();
  const accounts = new AccountService(store, mailer, { now: () => clock.now });
  const code = () => /\b(\d{6})\b/.exec(mailer.messages.at(-1)!.text)![1]!;
  return { clock, store, mailer, accounts, code, advance: (ms: number) => (clock.now = new Date(clock.now.getTime() + ms)) };
}
const fails = async (p: Promise<unknown> | (() => unknown), code?: string) => {
  try { await (typeof p === 'function' ? p() : p); } catch (e) { if (code) assert.equal((e as ApiError).code, code, (e as Error).message); return e as ApiError; }
  assert.fail('expected a refusal');
};

// ---------------------------------------------------------------- passwords

test('passwords are scrypt hashes with a fresh salt, and tampered hashes cannot burn the CPU', async () => {
  const a = await hashPassword('correct horse battery');
  const b = await hashPassword('correct horse battery');
  assert.notEqual(a, b);
  assert.match(a, /^scrypt\$1024\$8\$1\$/);
  assert.equal(await verifyPassword('correct horse battery', a), true);
  assert.equal(await verifyPassword('wrong horse battery', a), false);
  assert.equal(await verifyPassword('x', undefined), false);
  assert.equal(await verifyPassword('x', 'plaintext'), false);
  const t0 = Date.now();
  assert.equal(await verifyPassword('x', a.replace('$1024$', `$${2 ** 30}$`)), false, 'a stored cost above the maximum is refused outright');
  assert.ok(Date.now() - t0 < 2000);
});

test('the password rules say what is wrong', () => {
  assert.match(passwordProblem('short')!, /at least 10/);
  assert.match(passwordProblem('aaaaaaaaaaaa')!, /repetitive/);
  assert.match(passwordProblem('password123')!, /common/);
  assert.match(passwordProblem('sam.harbor@x.test', 'sam.harbor@x.test')!, /email/);
  assert.match(passwordProblem('prefix-samharbor-1', 'samharbor@x.test')!, /email/);
  assert.equal(passwordProblem('a-good-password', 'sam@harbor.test'), null);
  assert.equal(passwordProblem('x'.repeat(201)), 'Use at most 200 characters.');
});

// ---------------------------------------------------------------- signup and codes

test('signup creates an unverified account, stores no plaintext, and emails a code that lasts 15 minutes', async () => {
  const s = service();
  const { user, sent, token } = await s.accounts.signup(GOOD);
  assert.equal(user.emailVerifiedAt, undefined);
  assert.ok(token.startsWith('tsess_'));
  assert.equal(sent.resendAfterSeconds, RESEND_SECONDS);
  assert.equal(CODE_MINUTES, 15);
  assert.equal(Date.parse(sent.expiresAt) - s.clock.now.getTime(), 15 * 60_000);
  const m = s.mailer.messages.at(-1)!;
  assert.equal(m.to, 'sam@harbor.test');
  assert.match(m.subject, /Totali code/i);
  assert.match(m.html, /Sam/);
  const stored = JSON.stringify([...s.store.users.all(), ...s.store.emailCodes.all(), ...s.store.sessions.all()]);
  assert.ok(!stored.includes(s.code()), 'the code is stored only as a hash');
  assert.ok(!stored.includes(token), 'so is the session token');
  assert.ok(!stored.includes('a-good-password'), 'and the password');
});

test('signup validates every field with a message the form can show', async () => {
  const s = service();
  const bad = async (over: Record<string, unknown>, re: RegExp) => assert.match((await fails(s.accounts.signup({ ...GOOD, ...over }))).message, re);
  await bad({ firstName: ' ' }, /first name/);
  await bad({ lastName: undefined }, /last name/);
  await bad({ businessName: 'x'.repeat(121) }, /too long/);
  await bad({ businessName: 'Evil <script>' }, /characters we can't accept/);
  await bad({ email: 'not-an-email' }, /valid work email/);
  await bad({ password: 'short' }, /at least 10/);
  await bad({ acceptTerms: false }, /Terms and Privacy/);
  await bad({ acceptTerms: undefined }, /Terms and Privacy/);
  assert.equal(s.store.users.all().length, 0, 'a refused signup leaves nothing behind');
  assert.equal(s.mailer.messages.length, 0);
});

test('emails are matched without regard to case, and a verified account cannot be taken over', async () => {
  const s = service();
  const { user } = await s.accounts.signup({ ...GOOD, email: 'Sam@Harbor.TEST ' });
  assert.equal(user.email, 'sam@harbor.test');
  s.accounts.verifyEmail(user.id, s.code());
  await fails(s.accounts.signup({ ...GOOD, firstName: 'Mallory' }), 'account_exists');
  assert.equal(s.store.users.get(user.id)!.firstName, 'Sam');
});

test('an unverified signup can be redone with corrected details; the old code stops working', async () => {
  const s = service();
  const first = await s.accounts.signup(GOOD);
  const oldCode = s.code();
  s.advance(61_000);
  const second = await s.accounts.signup({ ...GOOD, firstName: 'Samuel', password: 'another-good-pass' });
  assert.equal(second.user.id, first.user.id);
  assert.equal(second.user.firstName, 'Samuel');
  assert.notEqual(oldCode, s.code());
  const e = await fails(() => s.accounts.verifyEmail(first.user.id, oldCode));
  assert.equal((e as ApiError).code, 'code_wrong');
  s.accounts.verifyEmail(first.user.id, s.code());
  assert.ok(s.store.users.get(first.user.id)!.emailVerifiedAt);
});

test('a wrong code costs a try and says how many are left; five wrong tries cancel it', async () => {
  const s = service();
  const { user } = await s.accounts.signup(GOOD);
  const right = s.code();
  const wrong = right === '000000' ? '111111' : '000000';
  const left: number[] = [];
  for (let i = 0; i < 5; i++) left.push(((await fails(() => s.accounts.verifyEmail(user.id, wrong))) as ApiError & { details: { attemptsLeft: number } }).details.attemptsLeft);
  assert.deepEqual(left, [4, 3, 2, 1, 0]);
  assert.match(((await fails(() => s.accounts.verifyEmail(user.id, right), 'code_invalid')) as ApiError).message, /isn’t valid any more/);
  assert.equal(s.store.users.get(user.id)!.emailVerifiedAt, undefined, 'the right code no longer works after five wrong ones');
  s.advance(61_000);
  await s.accounts.sendCode(user.id);
  s.accounts.verifyEmail(user.id, s.code());
  assert.ok(s.store.users.get(user.id)!.emailVerifiedAt);
});

test('the wording matches the design: "2 tries left."', async () => {
  const s = service();
  const { user } = await s.accounts.signup(GOOD);
  const w = s.code() === '000000' ? '111111' : '000000';
  await fails(() => s.accounts.verifyEmail(user.id, w));
  await fails(() => s.accounts.verifyEmail(user.id, w));
  assert.equal(((await fails(() => s.accounts.verifyEmail(user.id, w))) as ApiError).message, 'That code didn’t match. 2 tries left.');
});

test('a code expires after 15 minutes, and spaces in a pasted code are fine', async () => {
  const s = service();
  const { user } = await s.accounts.signup(GOOD);
  const c = s.code();
  s.advance(15 * 60_000 + 1000);
  await fails(() => s.accounts.verifyEmail(user.id, c), 'code_expired');
  s.advance(1000);
  await s.accounts.sendCode(user.id);
  const fresh = s.code();
  s.accounts.verifyEmail(user.id, `${fresh.slice(0, 3)} ${fresh.slice(3)}`);
  assert.ok(s.store.users.get(user.id)!.emailVerifiedAt);
});

test('codes must be six digits; a malformed one costs nothing', async () => {
  const s = service();
  const { user } = await s.accounts.signup(GOOD);
  for (const bad of ['12345', '1234567', 'abcdef', '', undefined, 123456]) await fails(() => s.accounts.verifyEmail(user.id, bad), 'invalid_request');
  assert.equal(s.store.emailCodes.all().find((c) => !c.usedAt)!.attemptsLeft, 5);
});

test('resend waits 60 seconds, is limited to six an hour, and kills the earlier code', async () => {
  const s = service();
  const { user } = await s.accounts.signup(GOOD);
  const first = s.code();
  const e = (await fails(s.accounts.sendCode(user.id), 'resend_too_soon')) as ApiError & { details: { retryAfterSeconds: number } };
  assert.equal(e.details.retryAfterSeconds, 60);
  s.advance(60_000);
  await s.accounts.sendCode(user.id);
  assert.notEqual(s.code(), first);
  await fails(() => s.accounts.verifyEmail(user.id, first), 'code_wrong');
  for (let i = 0; i < 4; i++) { s.advance(60_000); await s.accounts.sendCode(user.id); }
  s.advance(60_000);
  await fails(s.accounts.sendCode(user.id), 'too_many_codes');
});

test('"Change it" moves the account to a new address, and the old address\'s code is dead', async () => {
  const s = service();
  const { user } = await s.accounts.signup(GOOD);
  const oldCode = s.code();
  const out = await s.accounts.changeEmail(user.id, 'Sam.Right@Harbor.test');
  assert.equal(out.email, 'sam.right@harbor.test');
  assert.equal(s.mailer.messages.at(-1)!.to, 'sam.right@harbor.test');
  await fails(() => s.accounts.verifyEmail(user.id, oldCode), 'code_wrong');
  s.accounts.verifyEmail(user.id, s.code());
  await fails(s.accounts.changeEmail(user.id, 'other@harbor.test'), 'already_verified');
});

test('"Change it" cannot take an address that already has a verified account', async () => {
  const s = service();
  const a = await s.accounts.signup({ ...GOOD, email: 'taken@harbor.test' });
  s.accounts.verifyEmail(a.user.id, s.code());
  const b = await s.accounts.signup(GOOD);
  await fails(s.accounts.changeEmail(b.user.id, 'taken@harbor.test'), 'account_exists');
});

// ---------------------------------------------------------------- login

test('login says the same thing for a wrong password and an unknown account', async () => {
  const s = service();
  await s.accounts.signup(GOOD);
  const a = await fails(s.accounts.login('sam@harbor.test', 'wrong-password-1'));
  const b = await fails(s.accounts.login('nobody@harbor.test', 'wrong-password-1'));
  assert.equal(a.message, b.message);
  assert.equal(a.status, 401);
  const ok = await s.accounts.login('SAM@harbor.test', 'a-good-password');
  assert.ok(ok.token.startsWith('tsess_'));
});

test('ten wrong passwords lock the account for the window, and the right one is refused while locked', async () => {
  const s = service();
  await s.accounts.signup(GOOD);
  for (let i = 0; i < 10; i++) await fails(s.accounts.login('sam@harbor.test', 'wrong-password-1'), 'unauthorized');
  await fails(s.accounts.login('sam@harbor.test', 'a-good-password'), 'too_many_attempts');
  s.advance(16 * 60_000);
  await s.accounts.login('sam@harbor.test', 'a-good-password');
});

test('a session stays signed in until sign out, even after months', async () => {
  const s = service();
  const { token, user } = await s.accounts.signup(GOOD);
  assert.equal(s.accounts.resolveSession(token)!.user.id, user.id);
  s.advance(200 * 86_400_000);
  assert.ok(s.accounts.resolveSession(token), 'used within the year, so it slides on');
  s.advance(200 * 86_400_000);
  assert.ok(s.accounts.resolveSession(token));
  s.accounts.destroySession(token);
  assert.equal(s.accounts.resolveSession(token), null);
  assert.equal(s.accounts.resolveSession('tsess_nonsense'), null);
});

test('a session left unused for a year ends', async () => {
  const s = service();
  const { token } = await s.accounts.signup(GOOD);
  s.advance(366 * 86_400_000);
  assert.equal(s.accounts.resolveSession(token), null);
});

// ---------------------------------------------------------------- forgotten passwords

test('a reset code is only sent to an address with a verified account, and the answer never says which', async () => {
  const s = service();
  await s.accounts.requestReset('nobody@harbor.test');
  assert.equal(s.mailer.messages.length, 0, 'no account, no email');
  const { user } = await s.accounts.signup(GOOD);
  const before = s.mailer.messages.length;
  await s.accounts.requestReset(GOOD.email);
  assert.equal(s.mailer.messages.length, before, 'an unverified account gets nothing either');
  s.accounts.verifyEmail(user.id, s.code());
  s.advance(61_000);
  await s.accounts.requestReset(GOOD.email);
  assert.match(s.mailer.messages.at(-1)!.subject, /password reset code/);
});

test('the reset code sets a new password, ends every session, and works once', async () => {
  const s = service();
  const { user, token } = await s.accounts.signup(GOOD);
  s.accounts.verifyEmail(user.id, s.code());
  s.advance(61_000);
  await s.accounts.requestReset(GOOD.email);
  const code = s.code();
  await fails(s.accounts.resetPassword(GOOD.email, code, 'short'), 'invalid_request');
  await s.accounts.resetPassword(GOOD.email, code, 'a-brand-new-password');
  assert.equal(s.accounts.resolveSession(token), null, 'the old browser is signed out');
  await fails(s.accounts.login(GOOD.email, 'a-good-password'), 'unauthorized');
  await s.accounts.login(GOOD.email, 'a-brand-new-password');
  await fails(s.accounts.resetPassword(GOOD.email, code, 'yet-another-password'), 'code_invalid');
});

test('a wrong reset code costs a try, five cancel it, an old one expires, and the verification code is not a reset code', async () => {
  const s = service();
  const { user } = await s.accounts.signup(GOOD);
  const verifyCode = s.code();
  s.accounts.verifyEmail(user.id, verifyCode);
  s.advance(61_000);
  await fails(s.accounts.resetPassword(GOOD.email, verifyCode, 'a-brand-new-password'), 'code_invalid');
  await s.accounts.requestReset(GOOD.email);
  const code = s.code();
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 4; i++) await fails(s.accounts.resetPassword(GOOD.email, wrong, 'a-brand-new-password'), 'code_wrong');
  await fails(s.accounts.resetPassword(GOOD.email, wrong, 'a-brand-new-password'), 'code_wrong');
  await fails(s.accounts.resetPassword(GOOD.email, code, 'a-brand-new-password'), 'code_invalid');
  s.advance(61_000);
  await s.accounts.requestReset(GOOD.email);
  const second = s.code();
  s.advance(16 * 60_000);
  await fails(s.accounts.resetPassword(GOOD.email, second, 'a-brand-new-password'), 'code_expired');
});

// ---------------------------------------------------------------- Resend

test('Resend gets the message with the headers its edge needs, and the key never reaches the log', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const mailer = new ResendMailer({ apiKey: 're_secret_key_123', from: () => 'Totali <verify@harbor.test>', fetcher: async (url, init) => (calls.push({ url: String(url), init: init! }), new Response('{}', { status: 200 })) as never });
  const r = await mailer.send({ to: 'sam@harbor.test', subject: 'Hi', html: '<p>x</p>', text: 'x', replyTo: 'owner@harbor.test' });
  assert.equal(r.sent, true);
  assert.equal(calls[0]!.url, 'https://api.resend.com/emails');
  const h = calls[0]!.init.headers as Record<string, string>;
  assert.equal(h['Authorization'], 'Bearer re_secret_key_123');
  assert.match(h['User-Agent']!, /totali/);
  const body = JSON.parse(calls[0]!.init.body as string);
  assert.deepEqual([body.from, body.to, body.reply_to], ['Totali <verify@harbor.test>', ['sam@harbor.test'], 'owner@harbor.test']);

  const failing = new ResendMailer({ apiKey: 're_secret_key_123', fetcher: async () => new Response('bad key re_secret_key_123 code 482913', { status: 401 }) as never });
  const f = await failing.send({ to: 'a@b.test', subject: 's', html: '', text: '' });
  assert.equal(f.sent, false);
  assert.ok(!f.reason!.includes('re_secret_key_123') && !f.reason!.includes('482913'), f.reason!);
  assert.match(f.reason!, /401/);
});

test('an unverified sending domain falls back to Resend\'s test address once, and says so', async () => {
  const senders: string[] = [];
  const logs: string[] = [];
  const mailer = new ResendMailer({ apiKey: 're_x', from: () => 'Totali <verify@new.test>', log: (m) => logs.push(m), fetcher: async (_u, init) => {
    const from = JSON.parse(init!.body as string).from as string;
    senders.push(from);
    return (from === RESEND_TEST_SENDER ? new Response('{}', { status: 200 }) : new Response('The new.test domain is not verified', { status: 403 })) as never;
  } });
  assert.equal((await mailer.send({ to: 'a@b.test', subject: 's', html: '', text: '' })).sent, true);
  assert.deepEqual(senders, ['Totali <verify@new.test>', RESEND_TEST_SENDER]);
  assert.match(logs[0]!, /not verified/);
  const stillFails = new ResendMailer({ apiKey: 're_x', fetcher: async () => new Response('domain not verified', { status: 403 }) as never, from: () => 'Totali <v@new.test>' });
  assert.equal((await stillFails.send({ to: 'a@b.test', subject: 's', html: '', text: '' })).sent, false);
});

test('the From address follows RESEND_FROM, then the public address, then Resend\'s test sender', () => {
  assert.equal(fromAddress({ RESEND_FROM: 'verify@harbor.test' }), 'Totali <verify@harbor.test>');
  assert.equal(fromAddress({ RESEND_FROM: '"Harbor Payroll <pay@harbor.test>"' }), 'Harbor Payroll <pay@harbor.test>');
  assert.equal(fromAddress({ PUBLIC_BASE_URL: 'https://www.totali.example' }), 'Totali <verify@totali.example>');
  assert.equal(fromAddress({ PUBLIC_BASE_URL: 'http://localhost:8787' }), RESEND_TEST_SENDER);
  assert.equal(fromAddress({}), RESEND_TEST_SENDER);
  assert.equal(scrubMailLog('key re_abc123 sk_live_xyz Bearer tok 123456\nnext'), 'key [redacted] [redacted] Bearer [redacted] [code] next');
});

test('a network failure is reported, not thrown, and the outbox mailer never claims delivery', async () => {
  const down = new ResendMailer({ apiKey: 're_x', fetcher: async () => { throw new Error('getaddrinfo ENOTFOUND api.resend.com'); } });
  const r = await down.send({ to: 'a@b.test', subject: 's', html: '', text: '' });
  assert.equal(r.sent, false);
  assert.match(r.reason!, /ENOTFOUND/);
  const box = new OutboxMailer();
  assert.equal((await box.send({ to: 'a@b.test', subject: 's', html: '', text: '' })).sent, false);
});

// ---------------------------------------------------------------- static files

test('static paths cannot leave the web folder', () => {
  const root = '/srv/web';
  assert.equal(resolveInside(root, '/js/app.js'), '/srv/web/js/app.js');
  for (const bad of ['/../etc/passwd', '/%2e%2e/etc/passwd', '/js/../../secret', '/.env', '/js/.hidden', '/a%00b', '/a\\b', '/%2e%2e%2fsecret', '/..%5csecret', '/%']) assert.equal(resolveInside(root, bad), null, bad);
});

// ---------------------------------------------------------------- over HTTP

let base = '';
let close: () => void;
let outbox: OutboxMailer;
let secureBase = '';
let secureClose: () => void;
let tmp = '';

const config = (over: Partial<Config> = {}): Config => ({ port: 0, dataFile: undefined, adminToken: 'admin-token-accounts-tests', openSignup: false, ach: { mode: 'outbox', outboxDir: '', config: { originator: { odfiRoutingNumber: '', odfiName: '', immediateOrigin: '', companyName: '', companyId: '' }, holdBankingDays: 2, fundingLeadBankingDays: 1, creditLeadBankingDays: 1, trustSettlementDate: false } }, autoDisburse: false, rateLimitPerMinute: 0, trustProxy: false, ...over });

async function boot(over: Partial<Config>, mailer: OutboxMailer) {
  const store = new Store();
  const cfg = config(over);
  const app = createApp({ store, banks: new BankService(store, new FakeStripe()), ach: new AchService(store, new BankService(store, new FakeStripe()), new SandboxBank(), cfg.ach.config), config: cfg, mailer });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, close: () => app.server.close() };
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'totali-web-'));
  mkdirSync(join(tmp, 'js'));
  writeFileSync(join(tmp, 'index.html'), '<!doctype html><title>Totali</title><div id=app></div>');
  writeFileSync(join(tmp, 'js', 'main.js'), 'export const x = 1;');
  writeFileSync(join(tmp, '.secret'), 'nope');
  outbox = new OutboxMailer();
  const a = await boot({ webRoot: tmp, devTools: true }, outbox);
  base = a.base; close = a.close;
  const b = await boot({ webRoot: tmp, publicBaseUrl: 'https://app.harbor.test' }, new OutboxMailer());
  secureBase = b.base; secureClose = b.close;
});
after(() => { close(); secureClose(); rmSync(tmp, { recursive: true, force: true }); });

async function call(method: string, path: string, o: { body?: unknown; cookie?: string; csrf?: boolean; origin?: string; base?: string } = {}) {
  const res = await fetch((o.base ?? base) + path, { method, redirect: 'manual', headers: { ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.csrf === false ? {} : { 'x-totali-csrf': '1' }), ...(o.origin ? { origin: o.origin } : {}) }, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, headers: res.headers, text, json };
}
const cookieOf = (r: { headers: Headers }) => (r.headers.get('set-cookie') ?? '').split(';')[0]!;

test('the app is served: pages fall back to index.html, missing files are 404, dotfiles and traversal are refused', async () => {
  const index = await call('GET', '/');
  assert.equal(index.status, 200);
  assert.match(index.text, /id=app/);
  assert.match(index.headers.get('content-security-policy')!, /default-src 'self'/);
  assert.equal(index.headers.get('x-frame-options'), 'DENY');
  assert.equal((await call('GET', '/signup/verify')).status, 200, 'a route of the app');
  assert.match((await call('GET', '/signup/verify')).text, /id=app/);
  const js = await call('GET', '/js/main.js');
  assert.match(js.headers.get('content-type')!, /javascript/);
  assert.equal((await call('GET', '/js/missing.js')).status, 404);
  assert.equal((await call('GET', '/.secret')).status, 404);
  for (const p of ['/..%2f..%2fpackage.json', '/%2e%2e/package.json', '/js/..%2f..%2f..%2fetc%2fpasswd']) assert.equal((await call('GET', p)).status, 404, p);
  const etag = js.headers.get('etag')!;
  const again = await fetch(`${base}/js/main.js`, { headers: { 'if-none-match': etag } });
  assert.equal(again.status, 304);
  assert.equal((await fetch(`${base}/js/main.js`, { method: 'HEAD' })).status, 200);
});

test('signup over HTTP sets an HttpOnly, SameSite cookie and returns the verification state', async () => {
  const r = await call('POST', '/v1/auth/signup', { body: { ...GOOD, email: 'http1@harbor.test' } });
  assert.equal(r.status, 201, r.text);
  const sc = r.headers.get('set-cookie')!;
  assert.match(sc, /^totali_session=tsess_/);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Lax/);
  assert.ok(!/Secure/.test(sc), 'not on plain http');
  assert.equal(r.json.user.emailVerified, false);
  assert.equal(r.json.verification.resendAfterSeconds, 60);
  assert.ok(!JSON.stringify(r.json).includes('passwordHash'));
  const me = await call('GET', '/v1/auth/me', { cookie: cookieOf(r) });
  assert.equal(me.json.user.email, 'http1@harbor.test');
  assert.equal((await call('GET', '/v1/auth/me')).json.user, null);
});

test('the cookie is Secure when the site is public over https', async () => {
  const r = await call('POST', '/v1/auth/signup', { base: secureBase, body: { ...GOOD, email: 'sec@harbor.test' } });
  assert.match(r.headers.get('set-cookie')!, /; Secure/);
});

test('a request that does not carry our own header, or comes from another origin, is refused', async () => {
  assert.equal((await call('POST', '/v1/auth/signup', { csrf: false, body: { ...GOOD, email: 'csrf@harbor.test' } })).status, 403);
  assert.equal((await call('POST', '/v1/auth/login', { csrf: false, body: { email: 'x@y.test', password: 'whatever-it-is' } })).status, 403);
  assert.equal((await call('POST', '/v1/auth/signup', { origin: 'https://evil.example', body: { ...GOOD, email: 'csrf@harbor.test' } })).status, 403);
  const ok = await call('POST', '/v1/auth/signup', { body: { ...GOOD, email: 'csrf2@harbor.test' } });
  const cookie = cookieOf(ok);
  assert.equal((await call('POST', '/v1/auth/verify', { cookie, csrf: false, body: { code: '123456' } })).status, 403, 'a signed-in browser without the header is a forged request');
  assert.equal((await call('POST', '/v1/auth/verify', { cookie, origin: 'https://evil.example', body: { code: '123456' } })).status, 403);
  assert.equal((await call('POST', '/v1/auth/verify', { cookie, origin: base, body: { code: '123456' } })).status, 400, 'from our own origin it is judged on the code');
});

test('verify, resend and change-email need a signed-in user', async () => {
  for (const [path, body] of [['/v1/auth/verify', { code: '123456' }], ['/v1/auth/resend', {}], ['/v1/auth/change-email', { email: 'a@b.test' }]] as const) {
    assert.equal((await call('POST', path, { body })).status, 401, path);
  }
});

test('the whole flow over HTTP: signup, a wrong code, the right code from the email, sign out, sign back in', async () => {
  const email = 'flow@harbor.test';
  const s = await call('POST', '/v1/auth/signup', { body: { ...GOOD, email } });
  let cookie = cookieOf(s);
  const code = /\b(\d{6})\b/.exec(outbox.messages.filter((m) => m.to === email).at(-1)!.text)![1]!;
  const wrong = await call('POST', '/v1/auth/verify', { cookie, body: { code: code === '000000' ? '111111' : '000000' } });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.json.error.details.attemptsLeft, 4);
  assert.equal((await call('POST', '/v1/auth/resend', { cookie })).status, 429, 'inside the 60 second gap');
  const right = await call('POST', '/v1/auth/verify', { cookie, body: { code } });
  assert.equal(right.status, 200);
  assert.equal(right.json.user.emailVerified, true);
  const out = await call('POST', '/v1/auth/logout', { cookie });
  assert.match(out.headers.get('set-cookie')!, /Max-Age=0/);
  assert.equal((await call('GET', '/v1/auth/me', { cookie })).json.user, null, 'the old cookie is dead');
  const bad = await call('POST', '/v1/auth/login', { body: { email, password: 'not-the-password' } });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error.message, 'That email and password don’t match.');
  const inn = await call('POST', '/v1/auth/login', { body: { email, password: 'a-good-password' } });
  assert.equal(inn.status, 200);
  cookie = cookieOf(inn);
  assert.equal((await call('GET', '/v1/auth/me', { cookie })).json.user.emailVerified, true);
});

test('"keep me signed in" off gives a browser-session cookie; on gives a long one; forgot and reset work over HTTP without revealing accounts', async () => {
  const email = 'remember@harbor.test';
  const s = await call('POST', '/v1/auth/signup', { body: { ...GOOD, email } });
  const code = /\b(\d{6})\b/.exec(outbox.messages.filter((m) => m.to === email).at(-1)!.text)![1]!;
  await call('POST', '/v1/auth/verify', { cookie: cookieOf(s), body: { code } });
  assert.match((await call('POST', '/v1/auth/login', { body: { email, password: 'a-good-password' } })).headers.get('set-cookie')!, /Max-Age=31536000/);
  assert.ok(!/Max-Age/.test((await call('POST', '/v1/auth/login', { body: { email, password: 'a-good-password', remember: false } })).headers.get('set-cookie')!), 'it ends when the browser closes');
  const a = await call('POST', '/v1/auth/forgot', { body: { email: 'ghost@harbor.test' } });
  const b = await call('POST', '/v1/auth/forgot', { body: { email } });
  assert.deepEqual(a.json, b.json, 'the same answer for an account and for no account');
  assert.equal((await call('POST', '/v1/auth/forgot', { csrf: false, body: { email } })).status, 403);
  const reset = /\b(\d{6})\b/.exec(outbox.messages.filter((m) => m.to === email && /reset/i.test(m.subject)).at(-1)!.text)![1]!;
  assert.equal((await call('POST', '/v1/auth/reset', { body: { email, code: reset, password: 'my-new-password-1' } })).status, 200);
  assert.equal((await call('POST', '/v1/auth/login', { body: { email, password: 'a-good-password' } })).status, 401);
  assert.equal((await call('POST', '/v1/auth/login', { body: { email, password: 'my-new-password-1' } })).status, 200);
});

test('the dev outbox is off unless asked for, and the verification code is never in the signup response', async () => {
  const email = 'dev@harbor.test';
  const s = await call('POST', '/v1/auth/signup', { body: { ...GOOD, email } });
  assert.ok(!s.text.match(/\b\d{6}\b/), 'no code in the response');
  const dev = await call('GET', '/v1/dev/outbox');
  assert.equal(dev.status, 200);
  assert.ok(dev.json.messages.some((m: { to: string }) => m.to === email));
  assert.equal((await call('GET', '/v1/dev/outbox', { base: secureBase })).status, 404);
});
