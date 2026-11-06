import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { encryptField, safeEqual, sha256 } from '../lib/crypto.ts';
import type { Store } from '../store/store.ts';

/**
 * Bank of America CashPro payment-status notifications.
 *
 * CashPro calls us. It does not get a Totali API key. The two URLs we give
 * them are POST /api/bofa/auth and POST /api/bofa/webhook.
 *
 * Read 2026-11-06 from the public CashPro Developer Studio:
 * - OAuth Token Push Notification:
 *   https://developer.bankofamerica.com/CPODevPortal/apidocs/public/#/api/push-notifications/oauth-token-post
 *   https://developer-static-prodb.bankofamerica.com/PHXcms/public/content/apidevhubweb/api-library/swagger/oauth-token-post.json
 * - Payment Status Push Notification:
 *   https://developer.bankofamerica.com/CPODevPortal/apidocs/public/#/api/push-notifications/payment-status-post
 *   https://developer-static-prodb.bankofamerica.com/PHXcms/public/content/apidevhubweb/api-library/swagger/payment-status-post.json
 *
 * The auth schema's secret field is spelled `clientSceret`. That spelling is
 * what the published OpenAPI document requires. `clientSecret` is also
 * accepted, in case the call uses the corrected word. The same auth page says
 * basic authentication is supported; the payment-status schema is the place
 * that names that model's fields, as headers `userId` and `userAuthKey`.
 *
 * A notification is stored and nothing else. It does not settle a payment,
 * post a ledger entry, or count as the employer confirming funds.
 */

/** How long an access token works. The published success body has no expires_in. */
export const BOFA_ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
/** CashPro's accessToken schema says 1 to 550 characters. */
const ACCESS_TOKEN_MAX = 550;

export interface BofaCredentials {
  user: string;
  key: string;
}

export interface BofaNotification {
  id: string;
  receivedAt: string;
  transactionIdentification: string;
  endToEndIdentification: string;
  paymentStatus: string;
  /** The notification JSON, encrypted with TOTALI_DATA_KEY. The full body may contain account numbers. */
  payloadEncrypted: string;
}

export interface BofaResult {
  status: number;
  body: Record<string, unknown>;
  /** A line safe to log: no credentials, no token, no raw body. */
  log: string;
  authFailure: boolean;
}

/** Both values must be set. Blank is the same as missing. */
export function bofaCredentials(env: NodeJS.ProcessEnv): BofaCredentials | undefined {
  const user = (env.BOFA_WEBHOOK_USER ?? '').trim();
  const key = (env.BOFA_WEBHOOK_KEY ?? '').trim();
  if (!user || !key) return undefined;
  return { user, key };
}

function unavailable(kind: 'auth' | 'webhook'): BofaResult {
  const body = kind === 'auth'
    ? { status: 'ERROR', errorCode: '503', reasonDescription: 'Service unavailable' }
    : { status: 'ERROR', reasonCode: '503', reasonDescription: 'Service unavailable' };
  return { status: 503, body, log: `bofa ${kind} refused: not configured`, authFailure: false };
}

function authRejected(why: string): BofaResult {
  return {
    status: 401,
    body: { status: 'ERROR', errorCode: '101', reasonDescription: 'Authentication Failed' },
    log: `bofa auth rejected ${why}`,
    authFailure: true,
  };
}

function webhookRejected(why: string): BofaResult {
  return {
    status: 401,
    body: { status: 'ERROR', reasonCode: '401', reasonDescription: 'Authentication Failed' },
    log: `bofa webhook rejected ${why}`,
    authFailure: true,
  };
}

function badJson(kind: 'auth' | 'webhook'): BofaResult {
  const body = kind === 'auth'
    ? { status: 'ERROR', errorCode: '400', reasonDescription: 'Request body is not valid JSON' }
    : { status: 'ERROR', reasonCode: '903', reasonDescription: 'Request body is not valid JSON' };
  return { status: 400, body, log: `bofa ${kind} rejected invalid-json`, authFailure: false };
}

function headerOne(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

interface ParsedBody {
  ok: true;
  value: Record<string, unknown>;
  empty: boolean;
}

function parseBody(raw: string): ParsedBody | { ok: false } {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: {}, empty: true };
  try {
    const value: unknown = JSON.parse(trimmed);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
    return { ok: true, value: value as Record<string, unknown>, empty: false };
  } catch {
    return { ok: false };
  }
}

/**
 * Credentials CashPro presented. The JSON object wins when it carries a
 * clientID, which is the OAuth model. Otherwise the basic-auth headers.
 * The key is not trimmed: only the configured env value is trimmed.
 */
export function presentedCredentials(body: Record<string, unknown>, headers: IncomingHttpHeaders): BofaCredentials | undefined {
  const clientId = body.clientID;
  if (typeof clientId === 'string' && clientId !== '') {
    const asPublished = typeof body.clientSceret === 'string' ? body.clientSceret : undefined;
    const corrected = typeof body.clientSecret === 'string' ? body.clientSecret : undefined;
    if (asPublished !== undefined && corrected !== undefined && !safeEqual(asPublished, corrected)) return undefined;
    const key = asPublished ?? corrected;
    if (key === undefined || key === '') return undefined;
    return { user: clientId, key };
  }
  const user = headerOne(headers, 'userid');
  const key = headerOne(headers, 'userauthkey');
  if (!user || key === undefined || key === '') return undefined;
  return { user, key };
}

/** Both comparisons always run, so a mismatch does not return early. */
export function credentialsMatch(presented: BofaCredentials, expected: BofaCredentials): boolean {
  const userOk = safeEqual(presented.user, expected.user);
  const keyOk = safeEqual(presented.key, expected.key);
  return userOk && keyOk;
}

function tokenMacKey(secret: string): Buffer {
  return createHash('sha256').update('totali.bofa.access-token.v1\0').update(secret).digest();
}

/** Opaque bearer token, within CashPro's 550-character accessToken limit. */
export function issueAccessToken(secret: string, nowMs: number): string {
  const body = Buffer.from(JSON.stringify({
    v: 1,
    exp: nowMs + BOFA_ACCESS_TOKEN_TTL_MS,
    n: randomBytes(9).toString('base64url'),
  })).toString('base64url');
  const sig = createHmac('sha256', tokenMacKey(secret)).update(body).digest('base64url');
  const token = `${body}.${sig}`;
  if (token.length < 1 || token.length > ACCESS_TOKEN_MAX) throw new Error('CashPro access token length is out of range');
  return token;
}

export function accessTokenStatus(token: string, secret: string, nowMs: number): 'ok' | 'expired' | 'invalid' {
  const dot = token.indexOf('.');
  if (dot <= 0 || token.indexOf('.', dot + 1) !== -1) return 'invalid';
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const want = createHmac('sha256', tokenMacKey(secret)).update(body).digest('base64url');
  const given = Buffer.from(sig);
  const expected = Buffer.from(want);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 'invalid';
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return 'invalid';
  }
  if (!parsed || typeof parsed !== 'object') return 'invalid';
  const rec = parsed as { v?: unknown; exp?: unknown };
  if (rec.v !== 1 || typeof rec.exp !== 'number' || !Number.isFinite(rec.exp)) return 'invalid';
  if (nowMs >= rec.exp) return 'expired';
  return 'ok';
}

function bearer(headers: IncomingHttpHeaders): string | undefined {
  const header = headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : undefined;
}

function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(obj[key])}`).join(',')}}`;
  }
  return 'null';
}

function clip(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** Digit runs long enough to be an account number keep only the last four. */
function maskAccountLike(value: string): string {
  return value.slice(0, 80).replace(/[\r\n]/g, ' ').replace(/\d{8,}/g, (run) => `${'*'.repeat(run.length - 4)}${run.slice(-4)}`);
}

export function notificationLog(payload: Record<string, unknown>, duplicate: boolean): string {
  const txn = maskAccountLike(clip(payload.transactionIdentification, 80));
  const paymentStatus = maskAccountLike(clip(payload.status, 80));
  return `bofa notification ${duplicate ? 'duplicate' : 'stored'} transaction=${txn || 'none'} status=${paymentStatus || 'none'}`;
}

/**
 * Store one notification. The same canonical JSON is the same notification, so
 * a retry does not create a second row. A later status for the same
 * transactionIdentification is a different notification.
 */
export function acceptNotification(store: Store, payload: Record<string, unknown>, atIso: string): { duplicate: boolean } {
  const canonical = canonicalize(payload);
  const id = sha256(canonical);
  return store.tx(() => {
    if (store.bofaNotifications.get(id)) return { duplicate: true };
    store.bofaNotifications.put({
      id,
      receivedAt: atIso,
      transactionIdentification: clip(payload.transactionIdentification, 64),
      endToEndIdentification: clip(payload.endToEndIdentification, 64),
      paymentStatus: clip(payload.status, 80),
      payloadEncrypted: encryptField(canonical),
    });
    return { duplicate: false };
  });
}

export function scrubBofaLog(line: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = line.replace(/[\r\n]/g, ' ').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  for (const name of ['BOFA_WEBHOOK_USER', 'BOFA_WEBHOOK_KEY'] as const) {
    const value = (env[name] ?? '').trim();
    if (value.length >= 8) out = out.split(value).join('[redacted]');
  }
  return out;
}

export function handleBofaAuth(input: { env: NodeJS.ProcessEnv; nowMs: number; raw: string; headers: IncomingHttpHeaders }): BofaResult {
  const expected = bofaCredentials(input.env);
  if (!expected) return unavailable('auth');
  const parsed = parseBody(input.raw);
  if (!parsed.ok) return badJson('auth');
  const presented = presentedCredentials(parsed.value, input.headers);
  if (!presented || !credentialsMatch(presented, expected)) return authRejected(presented ? 'bad-credentials' : 'missing-credentials');
  return {
    status: 200,
    body: { accessToken: issueAccessToken(expected.key, input.nowMs), status: 'SUCCESS' },
    log: 'bofa auth ok',
    authFailure: false,
  };
}

export function handleBofaWebhook(input: { env: NodeJS.ProcessEnv; store: Store; nowMs: number; raw: string; headers: IncomingHttpHeaders }): BofaResult {
  const expected = bofaCredentials(input.env);
  if (!expected) return unavailable('webhook');
  const token = bearer(input.headers);
  if (!token) return webhookRejected('missing-token');
  const verdict = accessTokenStatus(token, expected.key, input.nowMs);
  if (verdict !== 'ok') return webhookRejected(verdict === 'expired' ? 'expired-token' : 'invalid-token');
  const parsed = parseBody(input.raw);
  if (!parsed.ok) return badJson('webhook');
  const saved = acceptNotification(input.store, parsed.value, new Date(input.nowMs).toISOString());
  return { status: 200, body: { status: 'SUCCESS' }, log: notificationLog(parsed.value, saved.duplicate), authFailure: false };
}
