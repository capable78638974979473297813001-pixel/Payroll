import { randomBytes } from 'node:crypto';

/** Prefixed, unguessable ids: `emp_3f9a...`. The prefix makes a pasted id self-describing in logs and support tickets. */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(10).toString('hex')}`;
}
