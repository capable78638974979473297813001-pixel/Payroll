import { createHash, randomBytes } from 'node:crypto';
import { ApiError, badRequest, conflict, notFound } from '../lib/errors.ts';
import * as v from '../lib/validate.ts';
import { encryptField, decryptField } from '../lib/crypto.ts';
import { newId } from '../lib/ids.ts';
import type { Store } from '../store/store.ts';
import type { Contractor } from '../domain/types.ts';
import type { Mailer } from '../mail/mailer.ts';
import { w9Email } from '../mail/mailer.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CLASSES = ['Individual or sole proprietor', 'Single-member LLC', 'C corporation', 'S corporation', 'Partnership', 'LLC taxed as a partnership', 'Trust or estate', 'Other'];

/**
 * The amount a business must pay one contractor in a year before it files a 1099-NEC. It was $600 for years through
 * 2025; payments made after 2025 use $2,000 (IRC section 6041(a) as amended by Public Law 119-21). It is only a flag
 * here: the business and its accountant decide what to file.
 */
export const threshold1099Cents = (year: number) => (year >= 2026 ? 200_000 : 60_000);

const clean = (s: unknown, label: string, max = 100) => {
  if (typeof s !== 'string' || s.trim() === '') throw badRequest(`Enter ${label}.`);
  const t = s.trim().replace(/\s+/g, ' ');
  if (t.length > max || /[\u0000-\u001f<>]/.test(t)) throw badRequest(`${label[0]!.toUpperCase()}${label.slice(1)} has characters we can’t accept.`);
  return t;
};

export function contractorView(c: Contractor, year: number) {
  const paid = c.payments.filter((p) => p.date.startsWith(String(year))).reduce((n, p) => n + p.amountCents, 0);
  return {
    id: c.id, name: c.name, businessName: c.businessName ?? '', email: c.email ?? '', w9: !!c.w9At, w9At: c.w9At ?? null, tinLast4: c.tinLast4 ?? null, tinType: c.tinType ?? null,
    classification: c.classification ?? null, address: c.address ?? null, paidCents: paid, needs1099: paid >= threshold1099Cents(year),
    linkOpen: !!c.inviteExpiresAt && Date.parse(c.inviteExpiresAt) > Date.now() && !c.w9At,
    payments: c.payments.filter((p) => p.date.startsWith(String(year))).sort((a, b) => b.date.localeCompare(a.date)),
    archived: !!c.archivedAt,
  };
}

export class ContractorService {
  private store: Store; private mailer: Mailer; private now: () => Date;
  constructor(store: Store, mailer: Mailer, now: () => Date = () => new Date()) { this.store = store; this.mailer = mailer; this.now = now; }

  private mine(companyId: string, id: string): Contractor {
    const c = this.store.contractors.get(id);
    if (!c || c.companyId !== companyId) throw notFound('Contractor');
    return c;
  }

  list(companyId: string, year = this.now().getUTCFullYear()) {
    const rows = this.store.contractors.where((c) => c.companyId === companyId && !c.archivedAt).map((c) => contractorView(c, year)).sort((a, b) => a.name.localeCompare(b.name));
    return { year, thresholdCents: threshold1099Cents(year), contractors: rows, count: rows.length, w9: rows.filter((r) => r.w9).length, paidCents: rows.reduce((n, r) => n + r.paidCents, 0), needs1099: rows.filter((r) => r.needs1099).length };
  }

  add(companyId: string, body: unknown) {
    const o = v.obj(body);
    const email = o.email === undefined || o.email === '' ? undefined : String(o.email).trim().toLowerCase();
    if (email && !EMAIL_RE.test(email)) throw badRequest('Check the email address.', { field: 'email' });
    const c: Contractor = { id: newId('ctr'), companyId, name: clean(o.name, 'their name'), ...(o.businessName ? { businessName: clean(o.businessName, 'the business name') } : {}), ...(email ? { email } : {}), payments: [], createdAt: this.now().toISOString() };
    this.store.tx(() => this.store.contractors.put(c));
    return contractorView(c, this.now().getUTCFullYear());
  }

  update(companyId: string, id: string, body: unknown) {
    const o = v.obj(body); const c = structuredClone(this.mine(companyId, id));
    if (o.name !== undefined) c.name = clean(o.name, 'their name');
    if (o.businessName !== undefined) { if (o.businessName) c.businessName = clean(o.businessName, 'the business name'); else delete c.businessName; }
    if (o.email !== undefined) { const e = String(o.email).trim().toLowerCase(); if (e && !EMAIL_RE.test(e)) throw badRequest('Check the email address.', { field: 'email' }); if (e) c.email = e; else delete c.email; }
    this.store.tx(() => this.store.contractors.put(c));
    return contractorView(c, this.now().getUTCFullYear());
  }

  /** Archived, not deleted: payments are records the 1099 and the accountant may still need. */
  archive(companyId: string, id: string) {
    const c = structuredClone(this.mine(companyId, id)); c.archivedAt = this.now().toISOString();
    this.store.tx(() => this.store.contractors.put(c));
    return { archived: true };
  }

  addPayment(companyId: string, id: string, body: unknown) {
    const o = v.obj(body); const c = structuredClone(this.mine(companyId, id));
    const date = v.date(o, 'date');
    if (date > this.now().toISOString().slice(0, 10)) throw badRequest('That date is in the future.', { field: 'date' });
    const amountCents = v.cents(o, 'amountCents', { min: 1, max: 100_000_000 });
    c.payments.push({ id: newId('pay'), date, amountCents, note: typeof o.note === 'string' ? o.note.trim().slice(0, 120).replace(/[\u0000-\u001f<>]/g, '') : '' });
    this.store.tx(() => this.store.contractors.put(c));
    return contractorView(c, Number(date.slice(0, 4)));
  }

  removePayment(companyId: string, id: string, paymentId: string) {
    const c = structuredClone(this.mine(companyId, id));
    const p = c.payments.find((x) => x.id === paymentId);
    if (!p) throw notFound('Payment');
    c.payments = c.payments.filter((x) => x.id !== paymentId);
    this.store.tx(() => this.store.contractors.put(c));
    return contractorView(c, Number(p.date.slice(0, 4)));
  }

  async requestW9(companyId: string, base: string, id: string) {
    const c = structuredClone(this.mine(companyId, id));
    const company = this.store.companies.require(companyId, 'Company');
    const token = randomBytes(32).toString('base64url');
    c.inviteTokenHash = sha(token); c.inviteExpiresAt = new Date(this.now().getTime() + 30 * 86_400_000).toISOString();
    this.store.tx(() => this.store.contractors.put(c));
    const link = `${base}/w9/${token}`;
    const sent = c.email ? await this.mailer.send(w9Email({ to: c.email, name: c.name, businessName: company.legalName, link })) : { sent: false };
    return { link, emailed: !!sent.sent };
  }

  /** The CSV for a bookkeeper: who was paid how much in a year, and who has a W-9. Full TINs are not exported. */
  exportCsv(companyId: string, year: number) {
    const q = (s: unknown) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const rows = this.list(companyId, year).contractors;
    const lines = [['Name', 'Business', 'TIN type', 'TIN last 4', 'Address', 'Classification', 'W-9 on file', `Paid in ${year}`, 'Over the 1099-NEC threshold'].map(q).join(',')];
    for (const r of rows) lines.push([r.name, r.businessName, r.tinType ?? '', r.tinLast4 ?? '', r.address ? `${r.address.street}, ${r.address.city}, ${r.address.state} ${r.address.zip}` : '', r.classification ?? '', r.w9 ? 'Yes' : 'No', (r.paidCents / 100).toFixed(2), r.needs1099 ? 'Yes' : 'No'].map(q).join(','));
    return { fileName: `contractors-${year}.csv`, content: lines.join('\n') + '\n' };
  }

  // ---------------------------------------------------------------- the contractor's side

  private byToken(token: unknown): Contractor {
    const gone = new ApiError(404, 'link_not_valid', 'This link isn’t valid any more. Ask the business to send you a new one.');
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) throw gone;
    const h = sha(token);
    const c = this.store.contractors.where((x) => x.inviteTokenHash === h)[0];
    if (!c || !c.inviteExpiresAt || Date.parse(c.inviteExpiresAt) < this.now().getTime() || c.archivedAt) throw gone;
    return c;
  }

  w9Status(token: unknown) {
    const c = this.byToken(token);
    const company = this.store.companies.require(c.companyId, 'Company');
    return { business: company.legalName, name: c.name, done: !!c.w9At, classifications: CLASSES };
  }

  submitW9(token: unknown, body: unknown) {
    const c0 = this.byToken(token);
    if (c0.w9At) throw conflict('already_done', 'You’ve already sent your W-9.');
    const o = v.obj(body); const c = structuredClone(c0);
    if (o.certify !== true) throw badRequest('Confirm the details are correct to sign.', { field: 'certify' });
    if (typeof o.signature !== 'string' || o.signature.trim().toLowerCase().replace(/\s+/g, ' ') !== c.name.trim().toLowerCase().replace(/\s+/g, ' ')) throw badRequest(`Type your name, ${c.name}, to sign.`, { field: 'signature' });
    const digits = String(o.tin ?? '').replace(/[\s-]/g, '');
    if (!/^\d{9}$/.test(digits)) throw badRequest('A taxpayer ID has nine digits.', { field: 'tin' });
    const tinType = v.oneOf(o, 'tinType', ['ssn', 'ein'] as const);
    const a = v.obj(o.address, 'address');
    const address = { street: clean(a.street, 'your street address', 120), city: clean(a.city, 'your city', 80), state: clean(a.state, 'your state', 2).toUpperCase(), zip: clean(a.zip, 'your ZIP code', 10) };
    if (!/^\d{5}(-\d{4})?$/.test(address.zip)) throw badRequest('A ZIP code has five digits.', { field: 'zip' });
    c.tinEncrypted = encryptField(digits); c.tinLast4 = digits.slice(-4); c.tinType = tinType;
    c.classification = v.oneOf(o, 'classification', CLASSES as unknown as readonly string[]);
    if (o.businessName) c.businessName = clean(o.businessName, 'your business name');
    c.address = address; c.w9At = this.now().toISOString();
    delete c.inviteTokenHash; delete c.inviteExpiresAt;
    this.store.tx(() => this.store.contractors.put(c));
    return { ok: true };
  }

  /** Kept for the accountant's day: the full number, decrypted, for one contractor. */
  tinOf(companyId: string, id: string): string | null { const c = this.mine(companyId, id); return c.tinEncrypted ? decryptField(c.tinEncrypted) : null; }
}
