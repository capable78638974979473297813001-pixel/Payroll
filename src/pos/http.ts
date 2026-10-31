import { ApiError } from '../lib/errors.ts';

export type Fetch = typeof fetch;

/** The other system said no, or could not be reached. The message is safe to show: it never contains the credentials. */
export class PosError extends ApiError {
  constructor(message: string) { super(502, 'pos_error', message); }
}

export async function getJson(f: Fetch, who: string, url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await f(url, { ...init, signal: AbortSignal.timeout(25_000) });
  } catch {
    throw new PosError(`Couldn’t reach ${who}. Try again in a minute.`);
  }
  if (res.status === 401 || res.status === 403) throw new PosError(`${who} refused those details. Check them, and that the access you gave covers staff, time clock and tips.`);
  if (res.status === 429) throw new PosError(`${who} says too many requests. Wait a minute and try again.`);
  if (!res.ok) throw new PosError(`${who} answered with an error (${res.status}). Try again later.`);
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
