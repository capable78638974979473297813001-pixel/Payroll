import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { decryptField, encryptField, needsRotation } from '../src/lib/crypto.ts';
import { rotateDataKey } from '../src/domain/rotation.ts';
import { Store } from '../src/store/store.ts';
import { bankAccount, hire, newCompany } from './helpers.ts';
import { createCipheriv, randomBytes } from 'node:crypto';

const keyA = Buffer.alloc(32, 1).toString('base64');
const keyB = Buffer.alloc(32, 2).toString('base64');
let saved: { cur?: string; prev?: string };
beforeEach(() => {
  saved = { cur: process.env.TOTALI_DATA_KEY, prev: process.env.TOTALI_DATA_KEY_PREVIOUS };
  process.env.TOTALI_DATA_KEY = keyA;
  delete process.env.TOTALI_DATA_KEY_PREVIOUS;
});
afterEach(() => {
  if (saved.cur === undefined) delete process.env.TOTALI_DATA_KEY;
  else process.env.TOTALI_DATA_KEY = saved.cur;
  if (saved.prev === undefined) delete process.env.TOTALI_DATA_KEY_PREVIOUS;
  else process.env.TOTALI_DATA_KEY_PREVIOUS = saved.prev;
});

test('values round-trip, are random each time, and record which key made them', () => {
  const a = encryptField('512-34-1001');
  const b = encryptField('512-34-1001');
  assert.notEqual(a, b);
  assert.match(a, /^v2:[0-9a-f]{8}:/);
  assert.equal(decryptField(a), '512-34-1001');
  assert.equal(needsRotation(a), false);
  assert.ok(!a.includes('512-34-1001'));
});

test('a tampered value fails to decrypt rather than returning garbage', () => {
  const parts = encryptField('secret').split(':');
  parts[4] = Buffer.from('tampered!').toString('base64');
  assert.throws(() => decryptField(parts.join(':')));
});

test('after a key change the old value still decrypts only while the old key is kept', () => {
  const old = encryptField('000123456789');
  process.env.TOTALI_DATA_KEY = keyB;
  assert.throws(() => decryptField(old), /No key with id/);
  process.env.TOTALI_DATA_KEY_PREVIOUS = keyA;
  assert.equal(decryptField(old), '000123456789');
  assert.equal(needsRotation(old), true);
  assert.equal(needsRotation(encryptField('x')), false);
});

test('values from before key ids (v1) still decrypt with any configured key', () => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', Buffer.from(keyA, 'base64'), iv);
  const ct = Buffer.concat([c.update('legacy', 'utf8'), c.final()]);
  const v1 = ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
  assert.equal(decryptField(v1), 'legacy');
  assert.equal(needsRotation(v1), true);
  process.env.TOTALI_DATA_KEY = keyB;
  process.env.TOTALI_DATA_KEY_PREVIOUS = keyA;
  assert.equal(decryptField(v1), 'legacy');
});

test('rotation re-encrypts SSNs, bank numbers and ACH files under the new key, after which the old key can go', () => {
  const store = new Store();
  const { company } = newCompany(store);
  const e = hire(store, company.id, { ssn: '512-34-7777' });
  const acct = bankAccount(store, { companyId: company.id, ownerKind: 'company', ownerId: company.id, accountNumber: '000555444333' });
  store.tx(() =>
    store.achFiles.put({ id: 'ach_1', companyId: company.id, kind: 'debit', fileName: 'f.ach', contentEncrypted: encryptField('FILE WITH 000555444333'), effectiveDate: '2026-06-09', entries: [], totals: { entryCount: 1, debitCents: 1, creditCents: 0 }, status: 'accepted', createdAt: 'x', updatedAt: 'x' }),
  );

  process.env.TOTALI_DATA_KEY = keyB;
  process.env.TOTALI_DATA_KEY_PREVIOUS = keyA;
  const first = rotateDataKey(store);
  assert.deepEqual(first, { employees: 1, bankAccounts: 1, achFiles: 1 });
  assert.deepEqual(rotateDataKey(store), { employees: 0, bankAccounts: 0, achFiles: 0 }, 'idempotent');

  delete process.env.TOTALI_DATA_KEY_PREVIOUS; // the old key is retired
  assert.equal(decryptField(store.employees.get(e.id)!.ssnEncrypted!), '512-34-7777');
  assert.equal(decryptField(store.bankAccounts.get(acct.id)!.accountNumberEncrypted), '000555444333');
  assert.equal(decryptField(store.achFiles.get('ach_1')!.contentEncrypted), 'FILE WITH 000555444333');
});

test('rotation is all or nothing: a value no configured key can open aborts it without changing anything', () => {
  const store = new Store();
  const { company } = newCompany(store);
  const e = hire(store, company.id, { ssn: '512-34-8888' });
  const before = store.employees.get(e.id)!.ssnEncrypted;
  process.env.TOTALI_DATA_KEY = keyB; // the old key was dropped too early
  assert.throws(() => rotateDataKey(store), /No key with id/);
  assert.equal(store.employees.get(e.id)!.ssnEncrypted, before);
});
