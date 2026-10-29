import { badRequest } from './errors.ts';
import { isIsoDate } from './dates.ts';
import { isCents } from './money.ts';

type Obj = Record<string, unknown>;

export function obj(v: unknown, what = 'body'): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw badRequest(`${what} must be a JSON object`);
  return v as Obj;
}

export function str(o: Obj, key: string, opts: { max?: number } = {}): string {
  const v = o[key];
  if (typeof v !== 'string' || v.trim() === '') throw badRequest(`${key} is required`, { field: key });
  if (v.length > (opts.max ?? 200)) throw badRequest(`${key} is too long`, { field: key });
  return v.trim();
}

export function optStr(o: Obj, key: string, opts: { max?: number } = {}): string | undefined {
  return o[key] === undefined || o[key] === null ? undefined : str(o, key, opts);
}

export function oneOf<T extends string>(o: Obj, key: string, allowed: readonly T[]): T {
  const v = o[key];
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw badRequest(`${key} must be one of: ${allowed.join(', ')}`, { field: key });
  }
  return v as T;
}

export function date(o: Obj, key: string): string {
  const v = o[key];
  if (!isIsoDate(v)) throw badRequest(`${key} must be a real calendar date, YYYY-MM-DD`, { field: key });
  return v;
}

export function cents(o: Obj, key: string, opts: { min?: number; max?: number } = {}): number {
  const v = o[key];
  if (!isCents(v)) throw badRequest(`${key} must be an integer number of cents`, { field: key });
  if (v < (opts.min ?? 0)) throw badRequest(`${key} must be at least ${opts.min ?? 0}`, { field: key });
  if (v > (opts.max ?? 1_000_000_000)) throw badRequest(`${key} is unreasonably large`, { field: key });
  return v;
}

export function optCents(o: Obj, key: string, opts: { min?: number; max?: number } = {}): number | undefined {
  return o[key] === undefined || o[key] === null ? undefined : cents(o, key, opts);
}

export function int(o: Obj, key: string, min: number, max: number): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw badRequest(`${key} must be an integer from ${min} to ${max}`, { field: key });
  }
  return v;
}

export function bool(o: Obj, key: string, fallback?: boolean): boolean {
  const v = o[key];
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== 'boolean') throw badRequest(`${key} must be true or false`, { field: key });
  return v;
}

export function stateCode(o: Obj, key: string): string {
  const v = str(o, key, { max: 2 }).toUpperCase();
  if (!/^[A-Z]{2}$/.test(v)) throw badRequest(`${key} must be a two-letter state code`, { field: key });
  return v;
}

export function ein(o: Obj, key: string): string {
  const v = str(o, key, { max: 10 });
  if (!/^\d{2}-\d{7}$/.test(v)) throw badRequest(`${key} must look like 12-3456789`, { field: key });
  return v;
}

/** Same issuability rules MasteryTax applies on import, so an SSN it would hold out is refused at the door. */
export function ssn(o: Obj, key: string): string {
  const v = str(o, key, { max: 11 });
  if (!/^\d{3}-?\d{2}-?\d{4}$/.test(v)) throw badRequest(`${key} must be a 9-digit SSN`, { field: key });
  const d = v.replace(/-/g, '');
  const [area, group, serial] = [d.slice(0, 3), d.slice(3, 5), d.slice(5)];
  if (area === '000' || area === '666' || area.startsWith('9') || group === '00' || serial === '0000') {
    throw badRequest(`${key} is not an issuable SSN`, { field: key });
  }
  return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
}
