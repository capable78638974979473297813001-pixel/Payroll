import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GoogleAuth } from '../src/accounts/google.ts';
import { Store } from '../src/store/store.ts';
import { AccountService } from '../src/accounts/accounts.ts';
import { OutboxMailer } from '../src/mail/mailer.ts';
import { ApiError } from '../src/lib/errors.ts';

const NOW = new Date('2026-10-30T15:00:00Z');
const CFG = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'sek', authUrl: 'https://accounts.example/auth', tokenUrl: 'https://accounts.example/token' };
const jwt = (c: Record<string, unknown>) => `x.${Buffer.from(JSON.stringify(c)).toString('base64url')}.y`;
const claims = (nonce: string, over: Record<string, unknown> = {}) => ({ aud: CFG.clientId, iss: 'https://accounts.google.com', exp: Math.floor(NOW.getTime() / 1000) + 600, nonce, email: 'Sam@Harbor.test', email_verified: true, sub: '1234', given_name: 'Sam', family_name: 'Owner', ...over });
function flow(over: Record<string, unknown> = {}, tokenStatus = 200) {
  const calls: Array<{ url: string; body: URLSearchParams }> = [];
  let nonce = '';
  const fake = (async (url: string, init: { body: URLSearchParams }) => { calls.push({ url, body: init.body }); return new Response(JSON.stringify({ id_token: jwt(claims(nonce, over)) }), { status: tokenStatus }); }) as unknown as typeof fetch;
  const g = new GoogleAuth(CFG, fake, () => NOW);
  const begin = g.begin('https://app.example/v1/auth/google/callback');
  const u = new URL(begin.url);
  nonce = u.searchParams.get('nonce')!;
  return { g, begin, u, calls };
}
const q = (state: string, code = 'abc') => new URLSearchParams({ state, code });
const rejects = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: unknown) => e instanceof ApiError && re.test(e.message));

test('the sign-in request carries PKCE, state and a nonce, and the code exchange sends the verifier', async () => {
  const { g, begin, u, calls } = flow();
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('scope'), 'openid email profile');
  const [state, verifier] = begin.secret.split('.');
  assert.equal(u.searchParams.get('code_challenge'), createHash('sha256').update(verifier!).digest('base64url'));
  const p = await g.finish(q(state!), begin.secret, 'https://app.example/v1/auth/google/callback');
  assert.deepEqual(p, { sub: '1234', email: 'sam@harbor.test', givenName: 'Sam', familyName: 'Owner' });
  assert.equal(calls[0]!.body.get('code_verifier'), verifier);
  assert.equal(calls[0]!.body.get('grant_type'), 'authorization_code');
});

test('a forged callback, someone else\'s token, an old token or an unverified email is refused', async () => {
  let f = flow(); const [state] = f.begin.secret.split('.');
  await rejects(f.g.finish(q('wrong-state'), f.begin.secret, 'r'), /didn’t start here/);
  await rejects(f.g.finish(q(state!), undefined, 'r'), /expired/);
  await rejects(f.g.finish(new URLSearchParams({ state: state!, error: 'access_denied' }), f.begin.secret, 'r'), /cancelled/);
  for (const [over, re] of [[{ aud: 'someone-else' }, /different app/], [{ iss: 'https://evil.example' }, /didn’t come from Google/], [{ exp: 1 }, /expired/], [{ nonce: 'other' }, /didn’t start here/], [{ email_verified: false }, /hasn’t verified/]] as Array<[Record<string, unknown>, RegExp]>) {
    f = flow(over); await rejects(f.g.finish(q(f.begin.secret.split('.')[0]!), f.begin.secret, 'r'), re);
  }
  f = flow({}, 400); await rejects(f.g.finish(q(f.begin.secret.split('.')[0]!), f.begin.secret, 'r'), /didn’t accept/);
});

test('a new Google user is verified, has no password, and finishes their business name and terms; an existing one just signs in', async () => {
  const store = new Store(); const accounts = new AccountService(store, new OutboxMailer(), { now: () => NOW });
  const a = accounts.signInWithGoogle({ email: 'sam@harbor.test', givenName: 'Sam', familyName: 'Owner' });
  assert.equal(a.created, true);
  assert.ok(a.user.emailVerifiedAt);
  assert.equal(a.user.passwordHash, '');
  assert.ok(accounts.resolveSession(a.token));
  await assert.rejects(accounts.login('sam@harbor.test', 'anything-at-all-123'), ApiError, 'no password means no password login');
  assert.throws(() => accounts.completeProfile(a.user.id, { businessName: 'Harbor Street Kitchen' }), /Agree to the Terms/);
  const done = accounts.completeProfile(a.user.id, { businessName: 'Harbor Street Kitchen', acceptTerms: true });
  assert.equal(done.businessName, 'Harbor Street Kitchen');
  const b = accounts.signInWithGoogle({ email: 'SAM@harbor.test', givenName: 'Sam', familyName: 'Owner' });
  assert.equal(b.created, false);
  assert.equal(b.user.id, a.user.id);
  assert.equal(store.users.all().length, 1);
});

test('Google proving an address that was only ever signed up (never verified) removes the squatter\'s password and sessions', async () => {
  const store = new Store(); const accounts = new AccountService(store, new OutboxMailer(), { now: () => NOW });
  const squat = await accounts.signup({ firstName: 'Mal', lastName: 'Ice', businessName: 'Nope', email: 'sam@harbor.test', password: 'squatter-password-1', acceptTerms: true });
  assert.ok(accounts.resolveSession(squat.token));
  const real = accounts.signInWithGoogle({ email: 'sam@harbor.test', givenName: 'Sam', familyName: 'Owner' });
  assert.equal(accounts.resolveSession(squat.token), null);
  assert.equal(real.user.passwordHash, '');
  await assert.rejects(accounts.login('sam@harbor.test', 'squatter-password-1'), ApiError);
});
