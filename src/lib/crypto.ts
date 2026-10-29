import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Field-level encryption for the sensitive values Totali must keep: SSNs (for
 * W-2s), bank account numbers (to originate ACH), and ACH files (which hold
 * account numbers). AES-256-GCM with a random 96-bit IV per value.
 *
 * The key is TOTALI_DATA_KEY (32 bytes, base64). Every ciphertext records the
 * id of the key that made it (the first 8 hex of its SHA-256), so a key can be
 * rotated: set the new key as TOTALI_DATA_KEY and keep the old one in
 * TOTALI_DATA_KEY_PREVIOUS (comma-separated, if there are several), then run
 * the rotation (POST /v1/ops/rotate-data-key) to re-encrypt everything under the
 * new key. Only after that may the old key be removed. Without a key Totali
 * refuses to accept an SSN or a bank account number rather than keep one in
 * the clear.
 */

function parseKey(raw: string, label: string): Buffer {
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== 32) throw new Error(`${label} must be 32 bytes, base64-encoded.`);
  return key;
}

const keyId = (key: Buffer): string => createHash('sha256').update(key).digest('hex').slice(0, 8);

function currentKey(): Buffer {
  const raw = (process.env.TOTALI_DATA_KEY ?? '').trim();
  if (!raw) throw new Error('TOTALI_DATA_KEY is not set; refusing to handle sensitive data without an encryption key.');
  return parseKey(raw, 'TOTALI_DATA_KEY');
}

function previousKeys(): Buffer[] {
  return (process.env.TOTALI_DATA_KEY_PREVIOUS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseKey(s, 'TOTALI_DATA_KEY_PREVIOUS'));
}

export function dataKeyConfigured(): boolean {
  try {
    currentKey();
    return true;
  } catch {
    return false;
  }
}

export function encryptField(plain: string): string {
  const key = currentKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v2', keyId(key), iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

function open(key: Buffer, iv: string, tag: string, ct: string): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

export function decryptField(blob: string): string {
  const parts = blob.split(':');
  const keys = [currentKey(), ...previousKeys()];
  if (parts[0] === 'v2' && parts.length === 5) {
    const key = keys.find((k) => keyId(k) === parts[1]);
    if (!key) throw new Error(`No key with id ${parts[1]} is configured (TOTALI_DATA_KEY or TOTALI_DATA_KEY_PREVIOUS).`);
    return open(key, parts[2], parts[3], parts[4]);
  }
  if (parts[0] === 'v1' && parts.length === 4) {
    // Before key ids: try each configured key; GCM authentication fails on the wrong one.
    for (const key of keys) {
      try {
        return open(key, parts[1], parts[2], parts[3]);
      } catch {
        // wrong key
      }
    }
    throw new Error('No configured key can decrypt this value.');
  }
  throw new Error('Unrecognised encrypted field format.');
}

/** True when the value was made with anything but the current key. */
export function needsRotation(blob: string): boolean {
  const parts = blob.split(':');
  return !(parts[0] === 'v2' && parts[1] === keyId(currentKey()));
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
