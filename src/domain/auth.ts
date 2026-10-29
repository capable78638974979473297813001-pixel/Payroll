import { newId } from '../lib/ids.ts';
import { newSecret, safeEqual, sha256 } from '../lib/crypto.ts';
import { forbidden, unauthorized } from '../lib/errors.ts';
import type { Store } from '../store/store.ts';

export type Principal = { kind: 'admin' } | { kind: 'company'; companyId: string };

/** Mint a company API key. The secret is returned once; only its hash is stored. */
export function mintApiKey(store: Store, companyId: string, label: string): string {
  const secret = newSecret('totali_sk');
  store.tx(() => store.apiKeys.put({ id: newId('key'), hash: sha256(secret), companyId, label, createdAt: new Date().toISOString() }));
  return secret;
}

export function authenticate(store: Store, header: string | undefined, adminToken: string | undefined): Principal {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  if (!m) throw unauthorized();
  const token = m[1];
  if (adminToken && safeEqual(token, adminToken)) return { kind: 'admin' };
  const hash = sha256(token);
  const key = store.apiKeys.where((k) => k.hash === hash)[0];
  if (!key) throw unauthorized();
  return { kind: 'company', companyId: key.companyId };
}

/** A company key may touch only its own company; an admin may touch any. */
export function assertCompanyAccess(p: Principal, companyId: string): void {
  if (p.kind === 'admin') return;
  if (p.companyId !== companyId) throw forbidden('This key cannot access that company');
}

export function assertAdmin(p: Principal): void {
  if (p.kind !== 'admin') throw forbidden('Admin credentials required');
}
