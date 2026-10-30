/**
 * Account passwords: scrypt (node:crypto, no dependency), a fresh random salt per password, stored as one string
 *
 *   scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>
 *
 * so the cost can be raised later and old hashes still verify. Hashing is asynchronous so a sign-in never blocks
 * the event loop. Ported from the earlier Omnia.tax site, with the minimum length set to the Totali signup rule.
 */
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/** OWASP Password Storage Cheat Sheet scrypt parameters: N=2^17, r=8, p=1. Tests lower N through setPasswordCost. */
let N = 131072;
const R = 8;
const P = 1;
const KEYLEN = 32;
const MIN_N = 1024;
const MAX_N = 131072;

export const MIN_PASSWORD = 10;
/** Upper bound so a huge password cannot be used to burn CPU. */
export const MAX_PASSWORD = 200;

/** For tests only: a lower cost makes hashing fast. Refuses anything outside what verifyPassword accepts. */
export function setPasswordCost(n: number): void {
  if (!Number.isInteger(n) || n < MIN_N || n > MAX_N || (n & (n - 1)) !== 0) throw new Error('cost must be a power of two between 1024 and 131072');
  N = n;
}

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  const opts: ScryptOptions = { N: n, r, p, maxmem: 128 * n * r * 2 };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEYLEN, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const parts = (stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    // Burn the same time as a real check so a missing or malformed hash is not distinguishable from a wrong password.
    await derive(password, Buffer.alloc(16), N, R, P);
    return false;
  }
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  // A stored cost above the maximum is rejected so a tampered row cannot pin the event loop.
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) || r !== R || p < 1 || p > 4 || n < MIN_N || n > MAX_N || (n & (n - 1)) !== 0) {
    await derive(password, Buffer.alloc(16), N, R, P);
    return false;
  }
  const salt = Buffer.from(parts[4]!, 'base64');
  const want = Buffer.from(parts[5]!, 'base64');
  const got = await derive(password, salt, n, r, p);
  return got.length === want.length && timingSafeEqual(got, want);
}

const WEAK = new Set(['password12', 'password123', 'password1234', 'passwordpassword', '1234567890', '12345678901', 'qwertyuiop', 'iloveyou12', 'administrator', 'letmein1234', 'welcome123', 'changeme123']);

/** Null when acceptable, otherwise a message the form can show as is. */
export function passwordProblem(password: unknown, email?: string): string | null {
  if (typeof password !== 'string') return 'Enter a password.';
  if (password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (password.length > MAX_PASSWORD) return `Use at most ${MAX_PASSWORD} characters.`;
  const lower = password.toLowerCase();
  if (new Set(lower).size < 4) return 'That password is too repetitive. Mix in more different characters.';
  if (WEAK.has(lower)) return 'That password is too common. Pick something less guessable.';
  const local = email ? email.toLowerCase().split('@')[0]! : '';
  if (email && (lower === email.toLowerCase() || (local.length >= 6 && lower.includes(local)))) return 'Don’t use your email address in your password.';
  return null;
}
