import { randomInt, randomBytes } from 'node:crypto';
import { newId } from '../lib/ids.ts';
import { newSecret, safeEqual, sha256 } from '../lib/crypto.ts';
import { ApiError, badRequest, conflict, unauthorized } from '../lib/errors.ts';
import type { Store } from '../store/store.ts';
import type { Mailer } from '../mail/mailer.ts';
import { verificationEmail } from '../mail/mailer.ts';
import { hashPassword, passwordProblem, verifyPassword } from './password.ts';
import type { EmailCode, Session, SetupDraft, User } from './types.ts';

export const TERMS_VERSION = '2026-10-terms-v1';
export const CODE_MINUTES = 15;
export const CODE_TRIES = 5;
export const RESEND_SECONDS = 60;
const SENDS_PER_HOUR = 6;
const SESSION_DAYS = 365;
const LOGIN_FAILURES = 10;
const LOGIN_WINDOW_MS = 15 * 60_000;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export interface PublicUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  businessName: string;
  emailVerified: boolean;
  companyId: string | null;
  setup: SetupDraft | null;
}

export function publicUser(u: User): PublicUser {
  return { id: u.id, email: u.email, firstName: u.firstName, lastName: u.lastName, businessName: u.businessName, emailVerified: !!u.emailVerifiedAt, companyId: u.companyId ?? null, setup: u.setup ?? null };
}

const clean = (s: unknown, field: string, max: number): string => {
  if (typeof s !== 'string' || s.trim() === '') throw badRequest(`Enter your ${field}.`, { field });
  const t = s.trim().replace(/\s+/g, ' ');
  if (t.length > max) throw badRequest(`${field} is too long.`, { field });
  // Control characters have no place in a name, and a name ends up in email and on pay stubs.
  if (/[\u0000-\u001f\u007f<>]/.test(t)) throw badRequest(`${field} has characters we can't accept.`, { field });
  return t;
};

export function normalizeEmail(raw: unknown): string {
  if (typeof raw !== 'string') throw badRequest('Enter a valid work email.', { field: 'email' });
  const e = raw.trim().toLowerCase();
  if (e.length > 254 || !EMAIL.test(e)) throw badRequest('Enter a valid work email.', { field: 'email' });
  return e;
}

export class AccountService {
  private readonly store: Store;
  private readonly mailer: Mailer;
  private readonly now: () => Date;
  private readonly log: (m: string) => void;
  private readonly failures = new Map<string, { count: number; first: number }>();

  constructor(store: Store, mailer: Mailer, opts: { now?: () => Date; log?: (m: string) => void } = {}) {
    this.store = store;
    this.mailer = mailer;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? (() => {});
  }

  private iso(): string {
    return this.now().toISOString();
  }

  findByEmail(email: string): User | undefined {
    return this.store.users.where((u) => u.email === email)[0];
  }

  // ------------------------------------------------------------------ signup and verification

  async signup(body: Record<string, unknown>): Promise<{ user: User; sent: SendOutcome; token: string }> {
    const firstName = clean(body.firstName, 'first name', 60);
    const lastName = clean(body.lastName, 'last name', 60);
    const businessName = clean(body.businessName, 'business name', 120);
    const email = normalizeEmail(body.email);
    const problem = passwordProblem(body.password, email);
    if (problem) throw badRequest(problem, { field: 'password' });
    if (body.acceptTerms !== true) throw badRequest('Agree to the Terms and Privacy Policy to continue.', { field: 'acceptTerms' });

    const passwordHash = await hashPassword(body.password as string);
    const existing = this.findByEmail(email);
    if (existing?.emailVerifiedAt) throw conflict('account_exists', 'An account with that email already exists. Log in instead.');

    const at = this.iso();
    // An unverified account is replaced, not refused: someone who mistyped their details can start again.
    const user: User = this.store.tx(() => {
      const u: User = { id: existing?.id ?? newId('usr'), email, firstName, lastName, businessName, passwordHash, termsAcceptedAt: at, termsVersion: TERMS_VERSION, createdAt: existing?.createdAt ?? at };
      return this.store.users.put(u);
    });
    const token = this.createSession(user.id);
    const sent = await this.sendCode(user.id);
    return { user: this.store.users.require(user.id, 'User'), sent, token };
  }

  /** Send a fresh code. Earlier codes stop working. Refused inside the resend gap and past the hourly limit. */
  async sendCode(userId: string): Promise<SendOutcome> {
    const user = this.store.users.require(userId, 'User');
    if (user.emailVerifiedAt) throw conflict('already_verified', 'That email is already verified.');
    const nowMs = this.now().getTime();
    const recent = this.store.emailCodes.where((c) => c.userId === userId && c.purpose === 'verify_email').sort((a, b) => b.sentAt.localeCompare(a.sentAt));
    const last = recent[0];
    if (last) {
      const wait = Math.ceil((Date.parse(last.sentAt) + RESEND_SECONDS * 1000 - nowMs) / 1000);
      if (wait > 0) throw new ApiError(429, 'resend_too_soon', `Wait ${wait} seconds before asking for another code.`, { retryAfterSeconds: wait });
    }
    if (recent.filter((c) => Date.parse(c.sentAt) > nowMs - 3_600_000).length >= SENDS_PER_HOUR) throw new ApiError(429, 'too_many_codes', 'Too many codes sent. Try again in an hour.', { retryAfterSeconds: 3600 });

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const salt = randomBytes(12).toString('hex');
    const expiresAt = new Date(nowMs + CODE_MINUTES * 60_000).toISOString();
    this.store.tx(() => {
      // Only one live code at a time.
      for (const c of recent) if (!c.usedAt) this.store.emailCodes.put({ ...c, usedAt: this.iso(), attemptsLeft: 0 });
      this.store.emailCodes.put({ id: newId('code'), userId, purpose: 'verify_email', email: user.email, salt, hash: sha256(`${salt}:${userId}:${code}`), expiresAt, attemptsLeft: CODE_TRIES, sentAt: this.iso() });
    });
    const result = await this.mailer.send(verificationEmail({ to: user.email, firstName: user.firstName, code, expiresAt, now: this.now() }));
    if (!result.sent) this.log(`verification email for ${user.id} not sent: ${result.reason ?? 'unknown'}`);
    return { sent: result.sent, ...(result.reason ? { reason: result.reason } : {}), expiresAt, resendAfterSeconds: RESEND_SECONDS, email: user.email, mailer: this.mailer.kind };
  }

  /** Check a six-digit code. A wrong code costs a try; five wrong tries kills it. */
  verifyEmail(userId: string, rawCode: unknown): User {
    const user = this.store.users.require(userId, 'User');
    if (user.emailVerifiedAt) return user;
    const code = typeof rawCode === 'string' ? rawCode.replace(/\s+/g, '') : '';
    if (!/^\d{6}$/.test(code)) throw badRequest('Enter the 6-digit code.', { field: 'code' });
    const live = this.store.emailCodes.where((c) => c.userId === userId && c.purpose === 'verify_email' && !c.usedAt && c.email === user.email).sort((a, b) => b.sentAt.localeCompare(a.sentAt))[0];
    if (!live) throw new ApiError(400, 'code_invalid', 'That code isn’t valid any more. Ask for a new one.', { attemptsLeft: 0 });
    if (Date.parse(live.expiresAt) <= this.now().getTime()) throw new ApiError(400, 'code_expired', 'That code has expired. Ask for a new one.', { attemptsLeft: 0 });
    const ok = safeEqual(sha256(`${live.salt}:${userId}:${code}`), live.hash);
    if (!ok) {
      const left = Math.max(0, live.attemptsLeft - 1);
      this.store.tx(() => this.store.emailCodes.put({ ...live, attemptsLeft: left, ...(left === 0 ? { usedAt: this.iso() } : {}) }));
      throw new ApiError(400, 'code_wrong', left > 0 ? `That code didn’t match. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'That code didn’t match and has been cancelled. Ask for a new one.', { attemptsLeft: left });
    }
    return this.store.tx(() => {
      this.store.emailCodes.put({ ...live, usedAt: this.iso() });
      return this.store.users.put({ ...user, emailVerifiedAt: this.iso() });
    });
  }

  /** "Wrong email? Change it": before verification only, and the earlier address's codes stop working. */
  async changeEmail(userId: string, rawEmail: unknown): Promise<SendOutcome> {
    const user = this.store.users.require(userId, 'User');
    if (user.emailVerifiedAt) throw conflict('already_verified', 'A verified email can’t be changed here.');
    const email = normalizeEmail(rawEmail);
    const taken = this.findByEmail(email);
    if (taken && taken.id !== userId && taken.emailVerifiedAt) throw conflict('account_exists', 'An account with that email already exists. Log in instead.');
    this.store.tx(() => {
      this.store.users.put({ ...user, email });
      // A new address starts a new code, so the resend gap does not carry over.
      for (const c of this.store.emailCodes.where((x) => x.userId === userId)) this.store.emailCodes.delete(c.id);
    });
    return this.sendCode(userId);
  }

  // ------------------------------------------------------------------ login and sessions

  private tooManyFailures(key: string): number {
    const f = this.failures.get(key);
    const nowMs = this.now().getTime();
    if (!f || nowMs - f.first > LOGIN_WINDOW_MS) return 0;
    return f.count >= LOGIN_FAILURES ? Math.ceil((f.first + LOGIN_WINDOW_MS - nowMs) / 1000) : 0;
  }

  private noteFailure(key: string): void {
    const nowMs = this.now().getTime();
    const f = this.failures.get(key);
    if (!f || nowMs - f.first > LOGIN_WINDOW_MS) this.failures.set(key, { count: 1, first: nowMs });
    else f.count += 1;
  }

  async login(rawEmail: unknown, password: unknown): Promise<{ user: User; token: string }> {
    const email = normalizeEmail(rawEmail);
    const wait = this.tooManyFailures(email);
    if (wait) throw new ApiError(429, 'too_many_attempts', `Too many attempts. Try again in ${Math.ceil(wait / 60)} minutes.`, { retryAfterSeconds: wait });
    const user = this.findByEmail(email);
    // The same message and the same work whether or not the account exists.
    const ok = await verifyPassword(typeof password === 'string' ? password : '', user?.passwordHash);
    if (!user || !ok) {
      this.noteFailure(email);
      throw unauthorized('That email and password don’t match.');
    }
    this.failures.delete(email);
    return { user, token: this.createSession(user.id) };
  }

  createSession(userId: string, meta: { ip?: string; userAgent?: string } = {}): string {
    const token = newSecret('tsess');
    const at = this.iso();
    this.store.tx(() => {
      this.store.sessions.put({ id: newId('ses'), userId, hash: sha256(token), createdAt: at, lastSeenAt: at, expiresAt: new Date(this.now().getTime() + SESSION_DAYS * 86_400_000).toISOString(), ...(meta.ip ? { ip: meta.ip } : {}), ...(meta.userAgent ? { userAgent: meta.userAgent.slice(0, 200) } : {}) });
    });
    return token;
  }

  /** The user behind a session token, or null. Stays signed in until sign out, so expiry slides forward when used. */
  resolveSession(token: string): { user: User; session: Session } | null {
    const hash = sha256(token);
    const session = this.store.sessions.where((s) => s.hash === hash)[0];
    if (!session) return null;
    const nowMs = this.now().getTime();
    if (Date.parse(session.expiresAt) <= nowMs) return null;
    const user = this.store.users.get(session.userId);
    if (!user) return null;
    // Write at most daily, so reading a page is not a write.
    if (nowMs - Date.parse(session.lastSeenAt) > 86_400_000) {
      this.store.tx(() => this.store.sessions.put({ ...session, lastSeenAt: this.iso(), expiresAt: new Date(nowMs + SESSION_DAYS * 86_400_000).toISOString() }));
    }
    return { user, session };
  }

  destroySession(token: string): void {
    const hash = sha256(token);
    const s = this.store.sessions.where((x) => x.hash === hash)[0];
    if (s) this.store.tx(() => this.store.sessions.delete(s.id));
  }

  // ------------------------------------------------------------------ the builder's saved state

  saveSetup(userId: string, draft: { industry?: string; answers: Record<string, unknown>; step: string }): User {
    const user = this.store.users.require(userId, 'User');
    return this.store.tx(() => this.store.users.put({ ...user, setup: { ...draft, updatedAt: this.iso() } }));
  }

  attachCompany(userId: string, companyId: string): User {
    const user = this.store.users.require(userId, 'User');
    return this.store.tx(() => this.store.users.put({ ...user, companyId }));
  }
}

export interface SendOutcome {
  sent: boolean;
  reason?: string;
  expiresAt: string;
  resendAfterSeconds: number;
  email: string;
  mailer: 'resend' | 'outbox';
}
