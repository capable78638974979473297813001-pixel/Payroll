import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import './helpers.ts';
import { Store } from '../src/store/store.ts';
import { createCompanyFromSetup } from '../src/builder/finish.ts';
import { PosService, type OAuthSession, type SquareOAuthApp } from '../src/pos/service.ts';
import { SQUARE_DEFAULT_REDIRECT_URL, loadPosApps, posSetupWarnings } from '../src/pos/config.ts';
import { SQUARE_HOSTS, SQUARE_OAUTH_STATE_MS } from '../src/pos/square.ts';
import { getJson, redactSecrets } from '../src/pos/http.ts';
import { decryptField } from '../src/lib/crypto.ts';
import { ApiError } from '../src/lib/errors.ts';
import { mintApiKey } from '../src/domain/auth.ts';
import { newId } from '../src/lib/ids.ts';
import { createApp } from '../src/api/app.ts';
import { AccountService } from '../src/accounts/accounts.ts';
import { OutboxMailer } from '../src/mail/mailer.ts';
import { BankService } from '../src/banking/accounts.ts';
import { AchService } from '../src/money/ach.ts';
import { SandboxBank } from '../src/ach/sandbox.ts';
import { FakeStripe } from './fake-stripe.ts';
import type { Answers } from '../src/builder/catalog.ts';
import type { User } from '../src/accounts/types.ts';
import type { Config } from '../src/config.ts';

const D = '2026-10-30T15:00:00Z';
const REDIRECT = SQUARE_DEFAULT_REDIRECT_URL;
const APP_ID = 'sq0idp-sandbox-test-app';
const SECRET = 'sq0csp-sandbox-secret-value';
const ACCESS = 'EAAAaccessTokenSandboxValueXXXX';
const REFRESH = 'EAAArefreshTokenSandboxValueYYYY';
const ACCESS2 = 'EAAAaccessTokenSandboxValueZZZZ';
const CODE = 'auth-code-boom-value';
const BASE: Answers = { state: 'MI', locations: [{ name: 'Main', city: 'Detroit', state: 'MI' }], team: '1-10', tips: { on: true, pool: 'hours' }, frequency: { value: 'weekly', weekday: 'friday' }, contractors: { on: false } };
const SECRETS = [SECRET, ACCESS, REFRESH, ACCESS2, CODE];

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
const squareApp = (over: Partial<SquareOAuthApp> = {}): SquareOAuthApp => ({ appId: APP_ID, secret: SECRET, environment: 'sandbox', redirectUrl: REDIRECT, ...over });
const session = (id = 'ses_owner', userId = 'usr_owner'): OAuthSession => ({ userId, sessionId: id });

function fake(handlers: Array<[RegExp, (c: Call) => unknown]>) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const c: Call = { url, method: init.method ?? 'GET', headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)])), body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    const h = handlers.find(([re]) => re.test(`${c.method} ${url}`));
    if (!h) return new Response('{}', { status: 404 });
    const out = h[1](c);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { f, calls };
}

function leaked(text: string): string | undefined {
  return SECRETS.find((s) => s.length >= 6 && text.includes(s));
}

function company(store: Store, name: string) {
  return createCompanyFromSetup(store, { id: name, businessName: name } as User, 'restaurant', BASE, '2026-10-30', new Date(D));
}

function harness(handlers: Array<[RegExp, (c: Call) => unknown]> = [], hosts: { square?: string } = {}) {
  let t = Date.parse(D);
  const fx = fake(handlers);
  const store = new Store();
  const a = company(store, 'Harbor');
  const b = company(store, 'Other');
  const svc = new PosService(store, () => new Date(t), fx.f, hosts, { square: squareApp() });
  return { fx, store, a, b, svc, advance: (ms: number) => { t += ms; } };
}

const tokenOk = (access = ACCESS, refresh = REFRESH, extraMs = 30 * 86_400_000) => ({ access_token: access, token_type: 'bearer', expires_at: new Date(Date.parse(D) + extraMs).toISOString(), merchant_id: 'MER1', refresh_token: refresh });
const locations = () => ({ locations: [{ id: 'L1', name: 'Harbor Street', status: 'ACTIVE' }] });

test('Square error text drops access tokens, refresh tokens and the application secret', async () => {
  const raw = `Bearer ${ACCESS} Client ${SECRET} {"access_token":"${ACCESS}","refresh_token":"${REFRESH}","client_secret":"${SECRET}"}`;
  const clean = redactSecrets(raw, [SECRET, CODE]);
  assert.equal(leaked(clean), undefined, clean);
  assert.equal(redactSecrets(`https://totali.tax/v1/pos/square/callback?code=${CODE}&state=abc`).includes(CODE), false);
  assert.match(clean, /\[redacted\]/);
  const f = (async () => new Response(JSON.stringify({ message: 'nope', access_token: ACCESS, refresh_token: REFRESH, client_secret: SECRET }), { status: 500 })) as typeof fetch;
  await assert.rejects(getJson(f, 'Square', 'https://connect.squareupsandbox.com/oauth2/token'), (e: unknown) => {
    assert.equal(leaked((e as Error).message), undefined, (e as Error).message);
    return e instanceof ApiError && e.code === 'pos_error';
  });
});

test('Connect Square is sandbox only and uses the existing callback route', () => {
  const planted = 'super-secret-env-value';
  const creds = { SQUARE_APPLICATION_ID: APP_ID, SQUARE_APPLICATION_SECRET: SECRET };
  assert.equal(loadPosApps({}).square, undefined);
  assert.equal(loadPosApps({ ...creds, SQUARE_ENVIRONMENT: 'production' }).square, undefined);
  assert.equal(loadPosApps({ ...creds, SQUARE_ENVIRONMENT: planted }).square, undefined);
  assert.equal(loadPosApps({ ...creds, SQUARE_ENVIRONMENT: 'sandbox', SQUARE_REDIRECT_URL: 'https://totali.tax/v1/integrations/square/callback' }).square, undefined);
  assert.equal(loadPosApps({ ...creds, SQUARE_ENVIRONMENT: 'sandbox', SQUARE_REDIRECT_URL: 'http://evil.example/v1/pos/square/callback' }).square, undefined);
  const loaded = loadPosApps({ ...creds, SQUARE_ENVIRONMENT: ' sandbox ' });
  assert.deepEqual(loaded.square, { appId: APP_ID, secret: SECRET, environment: 'sandbox', redirectUrl: REDIRECT });
  const warnings = posSetupWarnings({ ...creds, SQUARE_ENVIRONMENT: planted }).join('\n');
  assert.match(warnings, /must be sandbox/);
  assert.equal(warnings.includes(planted), false);
  assert.equal(warnings.includes(SECRET), false);
  assert.equal(SQUARE_DEFAULT_REDIRECT_URL, 'https://totali.tax/v1/pos/square/callback');
  const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(example, /SQUARE_APPLICATION_ID=sandbox-sq0idb-cdO9zp6TwXpggEEG3CmFEQ/);
  assert.match(example, /SQUARE_ENVIRONMENT=sandbox/);
  assert.match(example, /SQUARE_REDIRECT_URL=https:\/\/totali\.tax\/v1\/pos\/square\/callback/);
  assert.equal(/SQUARE_APPLICATION_SECRET=\S/.test(example), false, 'the example does not contain a secret');
  for (const file of ['src/pos/config.ts', 'src/pos/service.ts', 'src/pos/square.ts', 'src/api/app.ts', 'src/pos/http.ts']) {
    assert.equal(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').includes('sandbox-sq0idb-cdO9zp6TwXpggEEG3CmFEQ'), false, file);
  }
  assert.match(readFileSync(new URL('../web/js/app/pos.js', import.meta.url), 'utf8'), /Connect Square/);
});

test('authorize redirect, callback, bad expired and reused state, and no production host', async () => {
  const { fx, store, a, b, svc, advance } = harness([
    [/POST .*\/oauth2\/token/, (c) => (c.body as { code?: string }).code === CODE ? new Response(JSON.stringify({ access_token: ACCESS, refresh_token: REFRESH, client_secret: SECRET, code: CODE }), { status: 500 }) : tokenOk()],
    [/GET .*\/v2\/locations$/, locations],
    [/POST .*\/oauth2\/revoke/, () => ({ success: true })],
  ]);
  const off = new PosService(store, () => new Date(D), fx.f, { square: SQUARE_HOSTS.production }, { square: { ...squareApp(), environment: 'production' as 'sandbox' } });
  assert.equal(off.catalog(a.id).providers.find((p) => p.id === 'square')!.signIn, false);
  assert.throws(() => off.oauthStart(a.id, 'square', 'https://evil.example/cb', session()), (e: unknown) => e instanceof ApiError && e.code === 'sign_in_not_set_up');
  assert.equal(fx.calls.length, 0, 'a non-sandbox app does not call Square');

  assert.throws(() => svc.oauthStart(a.id, 'square', REDIRECT, null), /Sign in to connect Square/);
  const started = svc.oauthStart(a.id, 'square', 'https://attacker.example/v1/pos/square/callback', session());
  const url = new URL(started.url);
  assert.equal(url.origin, SQUARE_HOSTS.sandbox);
  assert.equal(url.pathname, '/oauth2/authorize');
  assert.equal(url.searchParams.get('client_id'), APP_ID);
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT, 'the redirect is the configured callback, not the caller-supplied one');
  assert.equal(url.searchParams.get('scope'), 'EMPLOYEES_READ TIMECARDS_READ MERCHANT_PROFILE_READ PAYMENTS_READ');
  assert.equal(url.searchParams.get('session'), 'false');
  assert.equal(url.searchParams.get('state'), started.state);
  assert.equal(started.url.includes(SECRET), false);

  await assert.rejects(svc.oauthFinish('square', new URLSearchParams({ state: 'not-a-real-state', code: CODE }), a.id, session()), /not valid/);
  assert.equal(fx.calls.length, 0);
  const expired = svc.oauthStart(a.id, 'square', REDIRECT, session());
  advance(SQUARE_OAUTH_STATE_MS + 1);
  await assert.rejects(svc.oauthFinish('square', new URLSearchParams({ state: expired.state, code: CODE }), a.id, session()), /expired/);
  assert.equal(fx.calls.length, 0, 'an expired state is not exchanged');

  const wrong = svc.oauthStart(a.id, 'square', REDIRECT, session());
  await assert.rejects(svc.oauthFinish('square', new URLSearchParams({ state: wrong.state, code: CODE }), b.id, session('ses_other', 'usr_other')), (e: unknown) => e instanceof ApiError && e.code === 'wrong_company');
  await assert.rejects(svc.oauthFinish('square', new URLSearchParams({ state: wrong.state, code: CODE }), a.id, session()), /already used/);
  const otherSession = svc.oauthStart(a.id, 'square', REDIRECT, session());
  await assert.rejects(svc.oauthFinish('square', new URLSearchParams({ state: otherSession.state, code: CODE }), a.id, session('ses_other')), (e: unknown) => e instanceof ApiError && e.code === 'wrong_session');
  assert.equal(fx.calls.length, 0);

  const badCode = svc.oauthStart(a.id, 'square', REDIRECT, session());
  await assert.rejects(svc.oauthFinish('square', new URLSearchParams({ state: badCode.state, code: CODE }), a.id, session()), (e: unknown) => {
    assert.equal(leaked((e as Error).message), undefined, (e as Error).message);
    return /answered with an error/.test((e as Error).message);
  });
  assert.equal(store.posConnections.all().length, 0, 'a failed exchange stores nothing');

  const again = svc.oauthStart(a.id, 'square', REDIRECT, session());
  const conn = await svc.oauthFinish('square', new URLSearchParams({ state: again.state, code: 'the-code' }), a.id, session());
  assert.equal(conn.label, 'Square: Harbor Street');
  await assert.rejects(svc.oauthFinish('square', new URLSearchParams({ state: again.state, code: 'the-code' }), a.id, session()), /already used/);
  const exchange = fx.calls.filter((c) => c.url === `${SQUARE_HOSTS.sandbox}/oauth2/token` && (c.body as { grant_type?: string }).grant_type === 'authorization_code');
  assert.equal(exchange.length, 2, 'the failed code and the successful code, and not the reused state');
  assert.equal(fx.calls.some((c) => c.url.startsWith(SQUARE_HOSTS.production)), false);
  const stored = JSON.stringify(store.posConnections.all());
  assert.equal(leaked(stored), undefined, 'tokens are not stored in the clear');
  const saved = JSON.parse(decryptField(store.posConnections.all()[0]!.credentialsEncrypted)) as { accessToken: string; refreshToken: string; environment: string };
  assert.deepEqual([saved.accessToken, saved.refreshToken, saved.environment], [ACCESS, REFRESH, 'sandbox']);
  assert.equal(svc.catalog(b.id).connection, null);
  await assert.rejects(svc.people(b.id), (e: unknown) => e instanceof ApiError && e.code === 'not_connected');
  await assert.rejects(svc.disconnect(b.id), (e: unknown) => e instanceof ApiError && e.status === 404);
  assert.equal(store.posConnections.all().length, 1, 'the other business cannot disconnect this connection');
});

test('Square refresh runs before expiry and again on 401, and disconnect revokes before deleting', async () => {
  let teamCalls = 0;
  const { fx, store, a, b, svc, advance } = harness([
    [/POST .*\/oauth2\/token/, (c) => {
      const body = c.body as { grant_type?: string; refresh_token?: string };
      if (body.grant_type === 'refresh_token') return tokenOk(ACCESS2, body.refresh_token, 30 * 86_400_000);
      return tokenOk();
    }],
    [/GET .*\/v2\/locations$/, locations],
    [/POST .*\/v2\/team-members\/search/, () => {
      teamCalls += 1;
      if (teamCalls === 1) return new Response(JSON.stringify({ access_token: ACCESS, message: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } });
      return { team_members: [] };
    }],
    [/POST .*\/oauth2\/revoke/, (c) => (c.body as { access_token?: string }).access_token === ACCESS2 ? { success: true } : new Response(JSON.stringify({ access_token: ACCESS, client_secret: SECRET }), { status: 500 })],
  ]);
  const mine = session();
  const conn = await svc.oauthFinish('square', new URLSearchParams({ state: svc.oauthStart(a.id, 'square', REDIRECT, mine).state, code: 'the-code' }), a.id, mine);
  assert.equal(conn.provider, 'square');
  // The access token is still a month from expiry, so the refresh is the 401, not the 24-hour window.
  await svc.people(a.id);
  const refresh = fx.calls.find((c) => (c.body as { grant_type?: string } | undefined)?.grant_type === 'refresh_token');
  assert.ok(refresh);
  assert.equal(refresh!.url, `${SQUARE_HOSTS.sandbox}/oauth2/token`);
  assert.equal(refresh!.body && (refresh!.body as { refresh_token: string }).refresh_token, REFRESH);
  assert.equal(fx.calls.filter((c) => /team-members/.test(c.url)).at(-1)!.headers.authorization, `Bearer ${ACCESS2}`);
  const after = JSON.parse(decryptField(store.posConnections.where((c) => c.companyId === a.id)[0]!.credentialsEncrypted)) as { accessToken: string };
  assert.equal(after.accessToken, ACCESS2);
  assert.equal(leaked(JSON.stringify(store.posConnections.all())), undefined);

  const theirs = session('ses_b', 'usr_b');
  await svc.oauthFinish('square', new URLSearchParams({ state: svc.oauthStart(b.id, 'square', REDIRECT, theirs).state, code: 'other-code' }), b.id, theirs);
  const before = fx.calls.length;
  await assert.rejects(svc.disconnect(b.id), (e: unknown) => {
    assert.equal(leaked((e as Error).message), undefined, (e as Error).message);
    return /refused to revoke/.test((e as Error).message);
  });
  assert.equal(store.posConnections.where((c) => c.companyId === b.id).length, 1, 'a failed revoke keeps the tokens');
  assert.equal(fx.calls.slice(before).some((c) => c.url.startsWith(SQUARE_HOSTS.production)), false);
  await svc.disconnect(a.id);
  const revoke = fx.calls.filter((c) => c.url === `${SQUARE_HOSTS.sandbox}/oauth2/revoke`).at(-1)!;
  assert.equal(revoke.headers.authorization, `Client ${SECRET}`);
  assert.deepEqual(revoke.body, { client_id: APP_ID, access_token: ACCESS2, revoke_only_access_token: false });
  assert.equal(store.posConnections.where((c) => c.companyId === a.id).length, 0);
  assert.equal(store.posConnections.where((c) => c.companyId === b.id).length, 1, 'disconnecting one business leaves the other connected');
  assert.equal(fx.calls.some((c) => c.url.startsWith(SQUARE_HOSTS.production)), false);
  void advance;
});

test('a sandbox host override cannot send OAuth to Square production', async () => {
  const { fx, store, a, svc } = harness([
    [/POST .*\/oauth2\/token/, () => tokenOk()],
    [/POST .*\/oauth2\/revoke/, () => ({ success: true })],
  ], { square: SQUARE_HOSTS.production });
  const mine = session();
  const state = svc.oauthStart(a.id, 'square', REDIRECT, mine).state;
  await assert.rejects(svc.oauthFinish('square', new URLSearchParams({ state, code: 'the-code' }), a.id, mine), /cannot call Square production/);
  assert.equal(store.posConnections.all().length, 0);
  assert.equal(fx.calls.some((c) => c.url.startsWith(SQUARE_HOSTS.production)), false);
  assert.ok(fx.calls.some((c) => c.url === `${SQUARE_HOSTS.sandbox}/oauth2/revoke`), 'the unused token is revoked');
});

test('the HTTP callback is bound to the signed-in business and session, and logs stay clean', async () => {
  const logs: string[] = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const prev = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  for (const m of methods) console[m] = (...args: unknown[]) => { logs.push(args.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
  const fx = fake([
    [/POST .*\/oauth2\/token/, (c) => (c.body as { code?: string }).code === CODE ? new Response(JSON.stringify({ access_token: ACCESS, refresh_token: REFRESH, client_secret: SECRET, code: CODE }), { status: 500 }) : tokenOk()],
    [/GET .*\/v2\/locations$/, locations],
    [/POST .*\/oauth2\/revoke/, () => ({ success: true })],
  ]);
  const store = new Store();
  const mailer = new OutboxMailer();
  const accounts = new AccountService(store, mailer);
  const a = company(store, 'Harbor');
  const b = company(store, 'Other');
  const owner = (companyId: string, email: string) => {
    const user: User = { id: newId('usr'), email, firstName: 'Sam', lastName: 'Owner', businessName: email, passwordHash: 'x', emailVerifiedAt: '2026-10-01T00:00:00Z', termsAcceptedAt: '2026-10-01T00:00:00Z', termsVersion: '1', companyId, createdAt: '2026-10-01T00:00:00Z' };
    store.tx(() => store.users.put(user));
    return `totali_session=${accounts.createSession(user.id)}`;
  };
  const cookieA = owner(a.id, 'a@harbor.test');
  const cookieB = owner(b.id, 'b@harbor.test');
  const config: Config = { publicBaseUrl: 'https://totali.tax', port: 0, dataFile: undefined, adminToken: 'admin-token-square-tests-0123456789abcdef', openSignup: false, ach: { mode: 'outbox', outboxDir: '', config: { originator: { odfiRoutingNumber: '', odfiName: '', immediateOrigin: '', companyName: '', companyId: '' }, holdBankingDays: 2, fundingLeadBankingDays: 1, creditLeadBankingDays: 1, trustSettlementDate: false } }, autoDisburse: false, rateLimitPerMinute: 0, trustProxy: false };
  const banks = new BankService(store, new FakeStripe());
  const app = createApp({ store, banks, ach: new AchService(store, banks, new SandboxBank(), config.ach.config), config, mailer, accounts, oauth: { square: squareApp() }, posFetch: fx.f, log: (m) => logs.push(m) });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  try {
    const start = await fetch(`${base}/v1/companies/${a.id}/pos/square/start`, { headers: { cookie: cookieA } });
    const started = await start.json() as { url: string };
    assert.equal(start.status, 200);
    const auth = new URL(started.url);
    assert.equal(auth.origin, SQUARE_HOSTS.sandbox);
    assert.equal(auth.searchParams.get('redirect_uri'), REDIRECT);
    assert.equal(leaked(JSON.stringify(started)), undefined);
    const state = auth.searchParams.get('state')!;
    const crossed = await fetch(`${base}/v1/pos/square/callback?state=${encodeURIComponent(state)}&code=the-code`, { headers: { cookie: cookieB }, redirect: 'manual' });
    assert.equal(crossed.status, 302);
    assert.match(decodeURIComponent(crossed.headers.get('location') ?? ''), /same Totali account/);
    assert.equal(store.posConnections.all().length, 0);

    const again = await fetch(`${base}/v1/companies/${a.id}/pos/square/start`, { headers: { cookie: cookieA } });
    const second = new URL(((await again.json()) as { url: string }).url);
    const blown = await fetch(`${base}/v1/pos/square/callback?state=${encodeURIComponent(second.searchParams.get('state')!)}&code=${CODE}`, { headers: { cookie: cookieA }, redirect: 'manual' });
    const blownAt = decodeURIComponent(blown.headers.get('location') ?? '');
    assert.match(blownAt, /pos_error=/);
    assert.equal(leaked(blownAt), undefined, blownAt);
    assert.equal(store.posConnections.all().length, 0);

    const third = await fetch(`${base}/v1/companies/${a.id}/pos/square/start`, { headers: { cookie: cookieA } });
    const okUrl = new URL(((await third.json()) as { url: string }).url);
    const done = await fetch(`${base}/v1/pos/square/callback?state=${encodeURIComponent(okUrl.searchParams.get('state')!)}&code=the-code`, { headers: { cookie: cookieA }, redirect: 'manual' });
    assert.equal(done.headers.get('location'), '/app/settings/pos?pos=connected');
    const seen = await fetch(`${base}/v1/companies/${a.id}/pos`, { headers: { cookie: cookieA } });
    const mine = await seen.json() as { connection: { label: string; provider: string } | null };
    assert.equal(mine.connection?.label, 'Square: Harbor Street');
    assert.equal(leaked(JSON.stringify(mine)), undefined);
    const denied = await fetch(`${base}/v1/companies/${a.id}/pos`, { headers: { cookie: cookieB } });
    assert.equal(denied.status, 403);
    const key = mintApiKey(store, b.id, 'other');
    const byKey = await fetch(`${base}/v1/companies/${a.id}/pos`, { headers: { authorization: `Bearer ${key}` } });
    assert.equal(byKey.status, 403);
    const keyStart = await fetch(`${base}/v1/companies/${b.id}/pos/square/start`, { headers: { authorization: `Bearer ${key}` } });
    assert.equal(keyStart.status, 400, 'an API key has no browser session to bind the state to');
    const off = await fetch(`${base}/v1/companies/${a.id}/pos`, { method: 'DELETE', headers: { cookie: cookieA, origin: base, 'x-totali-csrf': '1' } });
    assert.equal(off.status, 200);
    assert.equal(store.posConnections.all().length, 0);
    assert.ok(fx.calls.some((c) => c.url === `${SQUARE_HOSTS.sandbox}/oauth2/revoke`));
    const trail = [...logs, ...store.auditLog.all().map((row) => JSON.stringify(row))].join('\n');
    assert.equal(leaked(trail), undefined, trail);
    assert.equal(fx.calls.some((c) => c.url.startsWith(SQUARE_HOSTS.production)), false);
  } finally {
    for (const m of methods) console[m] = prev[m];
    await new Promise<void>((resolve, reject) => app.server.close((err) => err ? reject(err) : resolve()));
  }
});
