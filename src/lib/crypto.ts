import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Field-level encryption for the one piece of employee PII Totali must keep
 * to file W-2s: the SSN. AES-256-GCM with a random 96-bit IV per value.
 * The key comes from TOTALI_DATA_KEY (32 bytes, base64). Without it Totali
 * refuses to accept an SSN rather than storing one in the clear.
 */
function dataKey(): Buffer {
  const raw = (process.env.TOTALI_DATA_KEY ?? '').trim();
  if (!raw) throw new Error('TOTALI_DATA_KEY is not set; refusing to handle an SSN without an encryption key.');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('TOTALI_DATA_KEY must be 32 bytes, base64-encoded.');
  return key;
}

export function dataKeyConfigured(): boolean {
  try {
    dataKey();
    return true;
  } catch {
    return false;
  }
}

export function encryptField(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dataKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decryptField(blob: string): string {
  const [version, iv, tag, ct] = blob.split(':');
  if (version !== 'v1' || !iv || !tag || !ct) throw new Error('Unrecognised encrypted field format.');
  const decipher = createDecipheriv('aes-256-gcm', dataKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const ab = createHash('sha256').update(a).digest();
  const bb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ab, bb);
}

/** A caller-visible secret, e.g. an API key. Only its sha256 is ever stored. */
export function newSecret(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString('base64url')}`;
}
