import { newId } from '../lib/ids.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import * as v from '../lib/validate.ts';
import { decryptField, encryptField } from '../lib/crypto.ts';
import type { Store } from '../store/store.ts';
import type { Company, CompanyProfile } from './types.ts';

/** Prefixes the IRS has never assigned. An EIN that starts with one of these is a typo. */
const UNASSIGNED = new Set(['00', '07', '08', '09', '17', '18', '19', '28', '29', '49', '69', '70', '78', '79', '89', '96', '97']);
export const ENTITY_TYPES = ['Sole proprietor', 'LLC', 'S corporation', 'C corporation', 'Partnership', 'Nonprofit'];
const DOC_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg']);
export const MAX_DOC_BYTES = 600_000;

export function normalizeEin(raw: unknown): string {
  if (typeof raw !== 'string') throw badRequest('Enter your EIN, like 12-3456789.', { field: 'ein' });
  const digits = raw.replace(/[\s-]/g, '');
  if (!/^\d{9}$/.test(digits)) throw badRequest('An EIN has nine digits, like 12-3456789.', { field: 'ein' });
  if (UNASSIGNED.has(digits.slice(0, 2)) || /^(\d)\1{8}$/.test(digits)) throw badRequest('That EIN doesn’t look right. Check it against your IRS letter (CP 575).', { field: 'ein' });
  return `${digits.slice(0, 2)}-${digits.slice(2)}`;
}
const mask = (ein: string) => (ein ? `••-•••${ein.slice(-4)}` : '');

const blank = (): CompanyProfile => ({ owners: [], documents: [] });

export function profileView(company: Company) {
  const p = company.profile ?? blank();
  const sections = {
    business: !!(company.ein && p.entityType),
    owners: p.owners.length > 0 && p.owners.some((o) => o.runsBusiness),
    address: !!p.addressParts,
    documents: p.documents.length > 0,
    review: !!p.submittedAt,
  };
  return {
    legalName: company.legalName,
    dba: p.dba ?? '',
    entityType: p.entityType ?? '',
    stateFormed: p.stateFormed ?? company.homeState,
    ein: mask(company.ein), hasEin: !!company.ein,
    address: p.addressParts ?? null,
    owners: p.owners,
    documents: p.documents.map(({ contentEncrypted, ...d }) => d),
    sections, done: Object.values(sections).filter(Boolean).length, total: 5, submittedAt: p.submittedAt ?? null,
    entityTypes: ENTITY_TYPES,
  };
}

/** Save one section of Company setup. The EIN can be set once; changing a filed EIN is a conversation with support, not a form. */
export function saveProfile(store: Store, companyId: string, body: unknown) {
  const o = v.obj(body);
  const company = structuredClone(store.companies.require(companyId, 'Company'));
  const p: CompanyProfile = company.profile ?? blank();
  if (o.legalName !== undefined) company.legalName = v.str(o, 'legalName', { max: 120 });
  if (o.dba !== undefined) p.dba = typeof o.dba === 'string' ? o.dba.trim().slice(0, 120).replace(/[\u0000-\u001f<>]/g, '') : '';
  if (o.entityType !== undefined) p.entityType = v.oneOf(o, 'entityType', ENTITY_TYPES as unknown as readonly string[]);
  if (o.stateFormed !== undefined) p.stateFormed = v.str(o, 'stateFormed', { max: 2 }).toUpperCase();
  if (o.ein !== undefined) {
    const ein = normalizeEin(o.ein);
    if (company.ein && company.ein !== ein) throw conflict('ein_locked', 'The EIN on file can’t be changed here. Email support if it’s wrong.');
    company.ein = ein;
    const dup = store.companies.all().find((c) => c.id !== company.id && c.ein === ein);
    if (dup) throw conflict('ein_in_use', 'That EIN is already on another Totali account.');
  }
  if (o.address !== undefined) {
    const a = v.obj(o.address, 'address');
    p.addressParts = { street: v.str(a, 'street', { max: 120 }), city: v.str(a, 'city', { max: 80 }), state: v.str(a, 'state', { max: 2 }).toUpperCase(), zip: v.str(a, 'zip', { max: 10 }) };
    if (!/^\d{5}(-\d{4})?$/.test(p.addressParts.zip)) throw badRequest('A ZIP code has five digits.', { field: 'zip' });
    company.address = `${p.addressParts.street}, ${p.addressParts.city}, ${p.addressParts.state} ${p.addressParts.zip}`;
  }
  if (o.owners !== undefined) {
    if (!Array.isArray(o.owners) || o.owners.length > 10) throw badRequest('List up to 10 owners.');
    p.owners = o.owners.map((raw, i) => {
      const w = v.obj(raw, `owners[${i}]`);
      const percent = v.int(w, 'percent', 0, 100);
      return { id: typeof w.id === 'string' && /^own_/.test(w.id) ? w.id : newId('own'), name: v.str(w, 'name', { max: 100 }), percent, runsBusiness: v.bool(w, 'runsBusiness', false) };
    });
    if (p.owners.filter((x) => x.runsBusiness).length > 1) throw badRequest('Name one person who runs the business.');
    if (p.owners.reduce((n, x) => n + x.percent, 0) > 100) throw badRequest('Ownership adds up to more than 100%.');
  }
  if (o.submit === true) {
    const view = profileView({ ...company, profile: p });
    const missing = Object.entries(view.sections).filter(([k, ok]) => k !== 'review' && !ok).map(([k]) => k);
    if (missing.length) throw badRequest(`Finish these first: ${missing.join(', ')}.`, { missing });
    p.submittedAt = new Date().toISOString();
  }
  company.profile = p;
  store.tx(() => store.companies.put(company));
  return profileView(company);
}

export function addDocument(store: Store, companyId: string, body: unknown) {
  const o = v.obj(body);
  const company = structuredClone(store.companies.require(companyId, 'Company'));
  const name = v.str(o, 'name', { max: 120 }).replace(/[\\/\u0000-\u001f]/g, '_');
  const type = v.str(o, 'type', { max: 40 });
  if (!DOC_TYPES.has(type)) throw badRequest('Upload a PDF, PNG or JPG.');
  const b64 = v.str(o, 'contentBase64', { max: 1_000_000 });
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_DOC_BYTES) throw badRequest(`Files can be up to ${Math.floor(MAX_DOC_BYTES / 1000)} KB. Try a smaller scan or photo.`);
  const p = company.profile ?? blank();
  if (p.documents.length >= 10) throw badRequest('Up to 10 documents.');
  p.documents.push({ id: newId('doc'), name, type, size: bytes.length, addedAt: new Date().toISOString(), contentEncrypted: encryptField(b64) });
  company.profile = p;
  store.tx(() => store.companies.put(company));
  return profileView(company);
}

/** Kept for the day a download is needed; documents are stored encrypted. */
export function readDocument(store: Store, companyId: string, docId: string) {
  const company = store.companies.require(companyId, 'Company');
  const d = company.profile?.documents.find((x) => x.id === docId);
  if (!d) throw notFound('Document');
  return { name: d.name, type: d.type, bytes: Buffer.from(decryptField(d.contentEncrypted), 'base64') };
}

export function removeDocument(store: Store, companyId: string, docId: string) {
  const company = structuredClone(store.companies.require(companyId, 'Company'));
  if (!company.profile?.documents.some((d) => d.id === docId)) throw notFound('Document');
  company.profile.documents = company.profile.documents.filter((d) => d.id !== docId);
  store.tx(() => store.companies.put(company));
  return profileView(company);
}
