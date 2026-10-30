import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.ts';
import { addDocument, normalizeEin, profileView, readDocument, removeDocument, saveProfile } from '../src/domain/profile.ts';
import { ApiError } from '../src/lib/errors.ts';
import { createCompanyFromSetup } from '../src/builder/finish.ts';
import type { User } from '../src/accounts/types.ts';
import { newCompany } from './helpers.ts';

// A company made by the builder has no EIN until Company setup.
let n = 0;
const builtCompany = (store: Store) => createCompanyFromSetup(store, { id: `usr_${++n}`, businessName: `Harbor ${n}` } as User, 'restaurant', { state: 'MI', locations: [{ name: 'Detroit', city: 'Detroit', state: 'MI' }], team: '1-10', tips: { on: true, pool: 'hours' }, frequency: { value: 'weekly', weekday: 'friday' }, contractors: { on: false } }, '2026-10-30', new Date('2026-10-30T15:00:00Z'));

const refused = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: unknown) => e instanceof ApiError && re.test(`${e.code} ${e.message}`), String(re));

test('an EIN is nine digits, written 12-3456789, and obvious typos are refused', () => {
  assert.equal(normalizeEin('123456789'), '12-3456789');
  assert.equal(normalizeEin(' 12 3456789 '), '12-3456789');
  for (const bad of ['12-345678', 'abcdefghi', '00-1234567', '99-9999999', '', 5]) assert.throws(() => normalizeEin(bad), ApiError, String(bad));
});

test('company setup fills in section by section, and the EIN is shown masked and cannot be changed', () => {
  const store = new Store();
  const company = builtCompany(store);
  assert.equal(profileView(store.companies.get(company.id)!).done, 0);
  const a = saveProfile(store, company.id, { ein: '12-3456789', entityType: 'LLC', stateFormed: 'mi', dba: 'Harbor Street Kitchen' });
  assert.equal(a.ein, '••-•••6789');
  assert.equal(a.sections.business, true);
  assert.equal(store.companies.get(company.id)!.ein, '12-3456789');
  refused(() => saveProfile(store, company.id, { ein: '98-7654321' }), /ein_locked/);
  saveProfile(store, company.id, { ein: '12-3456789' }); // the same one again is fine
  const b = saveProfile(store, company.id, { address: { street: '1412 Harbor St', city: 'Detroit', state: 'mi', zip: '48207' }, owners: [{ name: 'Scott Holdan', percent: 60, runsBusiness: false }, { name: 'Maya Brandt', percent: 40, runsBusiness: true }] });
  assert.equal(b.sections.address && b.sections.owners, true);
  assert.equal(store.companies.get(company.id)!.address, '1412 Harbor St, Detroit, MI 48207');
  refused(() => saveProfile(store, company.id, { address: { street: 'x', city: 'y', state: 'MI', zip: '123' } }), /ZIP/);
  refused(() => saveProfile(store, company.id, { owners: [{ name: 'A', percent: 70 }, { name: 'B', percent: 40 }] }), /more than 100/);
  refused(() => saveProfile(store, company.id, { owners: [{ name: 'A', percent: 50, runsBusiness: true }, { name: 'B', percent: 50, runsBusiness: true }] }), /one person/);
});

test('submitting needs every section, and two accounts cannot share an EIN', () => {
  const store = new Store();
  const company = builtCompany(store);
  const other = newCompany(store, { ein: '55-1234567', legalName: 'Other LLC' }).company;
  refused(() => saveProfile(store, company.id, { ein: '55-1234567' }), /ein_in_use/);
  saveProfile(store, company.id, { ein: '12-3456789', entityType: 'LLC', address: { street: '1 Main', city: 'Detroit', state: 'MI', zip: '48207' }, owners: [{ name: 'Sam', percent: 100, runsBusiness: true }] });
  refused(() => saveProfile(store, company.id, { submit: true }), /documents/);
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  const v1 = addDocument(store, company.id, { name: 'EIN letter.png', type: 'image/png', contentBase64: png });
  assert.equal(v1.documents.length, 1);
  assert.equal((v1.documents[0] as Record<string, unknown>).contentEncrypted, undefined, 'the stored content is never in the view');
  assert.equal(readDocument(store, company.id, v1.documents[0]!.id).bytes.toString('hex'), '89504e470d0a1a0a');
  assert.equal(saveProfile(store, company.id, { submit: true }).sections.review, true);
  refused(() => addDocument(store, company.id, { name: 'x.exe', type: 'application/x-msdownload', contentBase64: png }), /PDF, PNG or JPG/);
  refused(() => addDocument(store, company.id, { name: 'big.pdf', type: 'application/pdf', contentBase64: Buffer.alloc(700_000).toString('base64') }), /up to 600 KB/);
  assert.equal(removeDocument(store, company.id, v1.documents[0]!.id).documents.length, 0);
  void other;
});
