import { createHash, randomBytes } from 'node:crypto';
import { ApiError } from '../lib/errors.ts';

/**
 * Sign in with Google: the authorization-code flow with PKCE, a random state and a nonce. The id token arrives
 * straight from Google's token endpoint over TLS in answer to our own code exchange, so (as the OpenID Connect spec
 * allows) it is not re-verified by signature; its audience, issuer, expiry, nonce and verified email are checked.
 */
export interface GoogleConfig { clientId: string; clientSecret: string; authUrl: string; tokenUrl: string }

export function googleFromEnv(env: NodeJS.ProcessEnv = process.env): GoogleConfig | null {
  const clientId = (env.GOOGLE_CLIENT_ID ?? '').trim(); const clientSecret = (env.GOOGLE_CLIENT_SECRET ?? '').trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, authUrl: (env.GOOGLE_AUTH_URL ?? 'https://accounts.google.com/o/oauth2/v2/auth').trim(), tokenUrl: (env.GOOGLE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token').trim() };
}

export interface GoogleProfile { sub: string; email: string; givenName: string; familyName: string }
const b64url = (b: Buffer) => b.toString('base64url');

export class GoogleAuth {
  private cfg: GoogleConfig; private fetchFn: typeof fetch; private now: () => Date;
  constructor(cfg: GoogleConfig, fetchFn: typeof fetch = fetch, now: () => Date = () => new Date()) { this.cfg = cfg; this.fetchFn = fetchFn; this.now = now; }

  /** The address to send the browser to, and the secret to keep in a short-lived cookie until it comes back. */
  begin(redirectUri: string): { url: string; secret: string } {
    const state = b64url(randomBytes(24)); const verifier = b64url(randomBytes(32)); const nonce = b64url(randomBytes(16));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const q = new URLSearchParams({ client_id: this.cfg.clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email profile', state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account' });
    return { url: `${this.cfg.authUrl}?${q}`, secret: `${state}.${verifier}.${nonce}` };
  }

  async finish(query: URLSearchParams, secret: string | undefined, redirectUri: string): Promise<GoogleProfile> {
    const bad = (m: string) => new ApiError(400, 'google_failed', m);
    const [state, verifier, nonce] = (secret ?? '').split('.');
    if (!state || !verifier || !nonce) throw bad('That sign-in expired. Start again.');
    if (query.get('error')) throw bad(query.get('error') === 'access_denied' ? 'You cancelled the Google sign-in.' : 'Google didn’t sign you in.');
    if (query.get('state') !== state) throw bad('That sign-in didn’t start here. Start again.');
    const code = query.get('code');
    if (!code) throw bad('Google didn’t send a code.');
    let res: Response;
    try {
      res = await this.fetchFn(this.cfg.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier }), signal: AbortSignal.timeout(15_000) });
    } catch { throw new ApiError(503, 'google_unreachable', 'Couldn’t reach Google. Try again, or use your email.'); }
    if (!res.ok) throw bad('Google didn’t accept that sign-in. Start again.');
    const tok = (await res.json().catch(() => null)) as { id_token?: string } | null;
    const parts = (tok?.id_token ?? '').split('.');
    if (parts.length !== 3) throw bad('Google’s answer was incomplete.');
    let c: Record<string, unknown>;
    try { c = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')); } catch { throw bad('Google’s answer was incomplete.'); }
    if (c.aud !== this.cfg.clientId) throw bad('That sign-in was meant for a different app.');
    if (c.iss !== 'https://accounts.google.com' && c.iss !== 'accounts.google.com') throw bad('That sign-in didn’t come from Google.');
    if (typeof c.exp !== 'number' || c.exp * 1000 < this.now().getTime()) throw bad('That sign-in expired. Start again.');
    if (c.nonce !== nonce) throw bad('That sign-in didn’t start here. Start again.');
    if (c.email_verified !== true || typeof c.email !== 'string' || typeof c.sub !== 'string') throw bad('Google hasn’t verified that email address.');
    const clip = (s: unknown) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60) : '');
    return { sub: c.sub, email: c.email.toLowerCase(), givenName: clip(c.given_name) || clip(c.name).split(' ')[0] || 'there', familyName: clip(c.family_name) };
  }
}
