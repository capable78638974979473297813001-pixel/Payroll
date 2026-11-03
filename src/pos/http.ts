import { ApiError } from '../lib/errors.ts';

export type Fetch = typeof fetch;

/**
 * Strip credentials from text that might be shown or logged. Square error bodies sometimes echo the token
 * they were given. Known values are removed even when they do not match a named field.
 */
export function redactSecrets(text: string, known: readonly string[] = []): string {
  let out = text
    .replace(/"(?:access_token|refresh_token|client_secret|refreshToken|accessToken)"\s*:\s*"(?:\\.|[^"\\])*"/gi, (m) => m.replace(/:\s*"(?:\\.|[^"\\])*"/, ': "[redacted]"'))
    .replace(/\b(access_token|refresh_token|client_secret|accessToken|refreshToken)=([^&\s]+)/gi, '$1=[redacted]')
    .replace(/([?&]code=)[^&\s#]+/gi, '$1[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bClient\s+\S+/g, 'Client [redacted]')
    .replace(/\bEAAA[A-Za-z0-9_-]{8,}\b/g, '[redacted]');
  for (const secret of known) {
    if (secret.length >= 6) out = out.split(secret).join('[redacted]');
  }
  return out;
}

/** The other system said no, or could not be reached. The message is safe to show: it never contains the credentials. */
export class PosError extends ApiError {
  httpStatus?: number;
  constructor(message: string, httpStatus?: number) {
    super(502, 'pos_error', redactSecrets(message));
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
  }
}

async function safeDetail(res: Response): Promise<string> {
  try {
    const text = (await res.text()).trim();
    if (!text || text === '{}' || text === '[]') return '';
    const clean = redactSecrets(text).replace(/\s+/g, ' ').slice(0, 160);
    if (/\bEAAA[A-Za-z0-9_-]{8,}\b/.test(clean)) return '';
    return clean ? ` (${clean})` : '';
  } catch {
    return '';
  }
}

export async function getJson(f: Fetch, who: string, url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await f(url, { ...init, signal: AbortSignal.timeout(25_000) });
  } catch {
    throw new PosError(`Couldn’t reach ${who}. Try again in a minute.`);
  }
  if (!res.ok) {
    const detail = await safeDetail(res);
    if (res.status === 401 || res.status === 403) throw new PosError(`${who} refused those details. Check them, and that the access you gave covers staff, time clock and tips.${detail}`, res.status);
    if (res.status === 429) throw new PosError(`${who} says too many requests. Wait a minute and try again.${detail}`, res.status);
    throw new PosError(`${who} answered with an error (${res.status}). Try again later.${detail}`, res.status);
  }
  try {
    const body = (await res.json()) as unknown;
    return Array.isArray(body) ? { items: body } : (body as Record<string, unknown>);
  } catch {
    throw new PosError(`${who} sent something Totali couldn’t read.`);
  }
}

export const str = (x: unknown): string => (typeof x === 'string' ? x : typeof x === 'number' ? String(x) : '');
export const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x)) ? Number(x) : 0);
export const arr = (x: unknown): Array<Record<string, unknown>> => (Array.isArray(x) ? (x.filter((y) => y && typeof y === 'object') as Array<Record<string, unknown>>) : []);
export const obj = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {});
