import { createHash, randomBytes } from 'node:crypto';
import { ApiError, badRequest, conflict, notFound } from '../lib/errors.ts';
import * as v from '../lib/validate.ts';
import { decryptField, encryptField } from '../lib/crypto.ts';
import { addEmployee, employeeView } from '../domain/employees.ts';
import type { Store } from '../store/store.ts';
import type { Company, Employee, EmployeeOnboarding } from '../domain/types.ts';
import type { Mailer } from '../mail/mailer.ts';
import { inviteEmail, reminderEmail } from '../mail/mailer.ts';
import type { BankService } from '../banking/accounts.ts';
import { formsOf } from '../dashboard/data.ts';

type Form = NonNullable<EmployeeOnboarding['requested']>[number];
const FORM_LABEL: Record<Form, string> = { w4: 'W-4', i9: 'I-9', deposit: 'Direct deposit', stateForm: 'State withholding form' };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const INVITE_DAYS = 14;
const REMIND_GAP_MS = 3_600_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

import { STATE_FORMS } from './forms.ts';
import { stateFacts } from '../builder/facts.ts';

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export class OnboardingService {
  private store: Store;
  private mailer: Mailer;
  private banks: BankService;
  private now: () => Date;
  private log: (m: string) => void;
  constructor(store: Store, mailer: Mailer, banks: BankService, now: () => Date = () => new Date(), log: (m: string) => void = () => {}) {
    this.store = store; this.mailer = mailer; this.banks = banks; this.now = now; this.log = log;
  }

  private iso() { return this.now().toISOString(); }

  private requested(company: Company, wanted: unknown): Form[] {
    const all: Form[] = ['w4', 'i9', 'deposit'];
    if (STATE_FORMS[company.homeState]) all.splice(1, 0, 'stateForm');
    if (wanted === undefined) return all;
    if (!Array.isArray(wanted)) throw badRequest('forms must be a list');
    const picked = all.filter((f) => wanted.includes(f));
    if (picked.length === 0) throw badRequest('Pick at least one form for them to fill in.');
    // A state form is part of the W-4 step: it only makes sense with a W-4.
    return picked.includes('stateForm') && !picked.includes('w4') ? picked.filter((f) => f !== 'stateForm') : picked;
  }

  // ------------------------------------------------------------------ the employer's side

  /** Add a new hire and email them a private link to their forms. The link is also returned, in case the email does not arrive. */
  async invite(companyId: string, base: string, body: unknown) {
    const o = v.obj(body);
    const company = this.store.companies.require(companyId, 'Company');
    const email = typeof o.email === 'string' ? o.email.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(email)) throw badRequest('Enter their email address.', { field: 'email' });
    if (this.store.employees.where((e) => e.companyId === companyId && e.email?.toLowerCase() === email && !e.terminationDate).length) throw conflict('already_invited', 'Someone with that email is already on your team.');
    const forms = this.requested(company, o.forms);
    const startDate = o.startDate === undefined ? this.now().toISOString().slice(0, 10) : v.date(o, 'startDate');
    const role = company.settings.roles.find((r) => r.key === o.roleKey);
    if (!role) throw badRequest('Pick their role.', { field: 'roleKey' });
    const pay = role.pay === 'hourly' ? { kind: 'hourly', rateCents: o.rateCents } : { kind: 'salary', annualCents: o.rateCents };
    let employee = addEmployee(this.store, companyId, {
      firstName: o.firstName, lastName: o.lastName, email, roleKey: role.key, hireDate: startDate, payType: pay, location: o.location, ...(o.tags !== undefined ? { tags: o.tags } : {}),
      ...(role.tipped !== 'never' && o.tipCreditNotice === true ? { tipCreditNoticeDate: startDate } : {}),
    });
    const token = randomBytes(32).toString('base64url');
    employee = this.save(employee, { invitedAt: this.iso(), inviteEmail: email, inviteTokenHash: sha(token), inviteExpiresAt: new Date(this.now().getTime() + INVITE_DAYS * 86_400_000).toISOString(), requested: forms, startDate, reminders: [] });
    const link = `${base}/join/${token}`;
    const sent = await this.mailer.send(inviteEmail({ to: email, firstName: employee.firstName, businessName: company.legalName, link, forms: forms.map((f) => this.formName(f, company)) }));
    if (!sent.sent) this.log(`invite for ${employee.id} not sent: ${sent.reason ?? 'unknown'}`);
    return { employee: employeeView(employee), link, emailed: sent.sent };
  }

  /** Invite up to 100 people at once (a spreadsheet). Each row succeeds or fails on its own, and the answer says which. */
  async inviteMany(companyId: string, base: string, body: unknown) {
    const o = v.obj(body);
    if (!Array.isArray(o.people) || o.people.length === 0) throw badRequest('Add at least one person.');
    if (o.people.length > 100) throw badRequest('At most 100 people at a time.');
    const results: Array<{ row: number; ok: boolean; name: string; error?: string; emailed?: boolean }> = [];
    for (const [i, raw] of o.people.entries()) {
      const p = (raw ?? {}) as Record<string, unknown>;
      const name = `${String(p.firstName ?? '').trim()} ${String(p.lastName ?? '').trim()}`.trim() || `Row ${i + 1}`;
      try { const r = await this.invite(companyId, base, p); results.push({ row: i + 1, ok: true, name, emailed: r.emailed }); }
      catch (e) { results.push({ row: i + 1, ok: false, name, error: e instanceof Error ? e.message : 'Could not invite' }); }
    }
    return { invited: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
  }

  /** A fresh link and a reminder of what is missing. At most one an hour per person. */
  async remind(companyId: string, base: string, employeeId: string) {
    const company = this.store.companies.require(companyId, 'Company');
    const e = this.store.employees.get(employeeId);
    if (!e || e.companyId !== companyId) throw notFound('Employee');
    if (!e.onboarding?.requested) throw conflict('not_onboarding', 'This person wasn’t invited through Totali.');
    const missing = this.missing(e, company);
    if (missing.length === 0) throw conflict('all_done', `${e.firstName} has finished every form.`);
    if (!e.email) throw badRequest('Add their email address first.');
    const last = e.onboarding.reminders?.at(-1);
    if (last && Date.parse(last.at) + REMIND_GAP_MS > this.now().getTime()) throw new ApiError(429, 'remind_too_soon', `A reminder went to ${e.firstName} less than an hour ago.`);
    const token = randomBytes(32).toString('base64url');
    const updated = this.save(e, { inviteTokenHash: sha(token), inviteExpiresAt: new Date(this.now().getTime() + INVITE_DAYS * 86_400_000).toISOString(), reminders: [...(e.onboarding.reminders ?? []), { at: this.iso() }] });
    const link = `${base}/join/${token}`;
    const sent = await this.mailer.send(reminderEmail({ to: e.email, firstName: e.firstName, businessName: company.legalName, link, missing: missing.map((f) => this.formName(f, company)) }));
    return { employee: employeeView(updated), link, emailed: sent.sent };
  }

  /** Who has finished what, with the people still to do first. */
  overview(companyId: string) {
    const company = this.store.companies.require(companyId, 'Company');
    const wants = !!STATE_FORMS[company.homeState];
    const roles = new Map(company.settings.roles.map((r) => [r.key, r.label]));
    const rows = this.store.employees.where((x) => x.companyId === companyId && !x.terminationDate).map((e) => {
      const f = formsOf(e, wants && (e.onboarding?.requested ? e.onboarding.requested.includes('stateForm') : true));
      const requested = e.onboarding?.requested;
      return {
        employeeId: e.id, name: `${e.firstName} ${e.lastName}`, role: roles.get(e.roleKey) ?? e.roleKey, location: e.location ?? null,
        pay: e.payType.kind === 'hourly' ? { kind: 'hourly', cents: e.payType.rateCents } : { kind: 'salary', cents: e.payType.annualCents },
        tipped: (company.settings.roles.find((r) => r.key === e.roleKey)?.tipped ?? 'never') !== 'never',
        invitedAt: e.onboarding?.invitedAt ?? null, startDate: e.onboarding?.startDate ?? null, email: e.email ?? null,
        forms: { w4: f.w4, stateForm: requested ? (requested.includes('stateForm') ? !!e.onboarding?.stateForm : null) : null, i9: f.i9, deposit: f.deposit },
        pendingDeposit: !!e.pendingDeposit,
        done: f.done || (requested ? this.missing(e, company).length === 0 : f.done),
        invited: !!requested, canRemind: !!requested && !!e.email && this.missing(e, company).length > 0,
        linkExpired: !!e.onboarding?.inviteExpiresAt && Date.parse(e.onboarding.inviteExpiresAt) < this.now().getTime(),
        i9NeedsSection2: e.onboarding?.i9?.section1At && !e.onboarding.i9.section2At ? true : false,
      };
    });
    rows.sort((a, b) => Number(a.done) - Number(b.done) || a.name.localeCompare(b.name));
    return { total: rows.length, remaining: rows.filter((r) => !r.done).length, people: rows, stateForm: STATE_FORMS[company.homeState] ?? null };
  }

  /** Section 2 of the I-9: the employer looked at the documents. What they saw is kept encrypted; the form itself is not stored. */
  i9Section2(companyId: string, employeeId: string, by: string, body: unknown) {
    const o = v.obj(body);
    const e = this.store.employees.get(employeeId);
    if (!e || e.companyId !== companyId) throw notFound('Employee');
    const i9 = e.onboarding?.i9;
    if (!i9?.section1At) throw conflict('section1_first', `${e.firstName} hasn’t done section 1 yet.`);
    if (i9.section2At) throw conflict('already_done', 'Section 2 is already done.');
    const details = { documentTitle: v.str(o, 'documentTitle', { max: 120 }), issuingAuthority: v.str(o, 'issuingAuthority', { max: 120 }), documentNumber: v.str(o, 'documentNumber', { max: 60 }), expires: o.expires === undefined || o.expires === '' ? null : v.date(o, 'expires'), firstDayOfEmployment: v.date(o, 'firstDayOfEmployment') };
    if (o.attest !== true) throw badRequest('Confirm you examined the original documents.', { field: 'attest' });
    const prev = JSON.parse(decryptField(i9.detailsEncrypted!)) as Record<string, unknown>;
    return employeeView(this.save(e, { i9: { ...i9, section2At: this.iso(), section2By: by, detailsEncrypted: encryptField(JSON.stringify({ ...prev, section2: details })) } }));
  }

  // ------------------------------------------------------------------ the new hire's side (a private link, no account)

  private byToken(token: unknown): { e: Employee; company: Company } {
    const gone = new ApiError(404, 'link_not_valid', 'This link isn’t valid any more. Ask your manager to send you a new one.');
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) throw gone;
    const h = sha(token);
    const e = this.store.employees.where((x) => x.onboarding?.inviteTokenHash === h)[0];
    if (!e || !e.onboarding?.inviteExpiresAt || Date.parse(e.onboarding.inviteExpiresAt) < this.now().getTime() || e.terminationDate) throw gone;
    return { e, company: this.store.companies.require(e.companyId, 'Company') };
  }

  private missing(e: Employee, company: Company): Form[] {
    const o = e.onboarding;
    if (!o?.requested) return [];
    return o.requested.filter((f) => (f === 'w4' ? !o.w4 : f === 'stateForm' ? !o.stateForm : f === 'i9' ? !o.i9?.section1At : !o.deposit)).filter((f) => f !== 'stateForm' || !!STATE_FORMS[company.homeState]);
  }

  private formName(f: Form, company: Company) { return f === 'stateForm' ? (STATE_FORMS[company.homeState] ?? FORM_LABEL.stateForm) : FORM_LABEL[f]; }

  /** What the link's page shows: whose forms, which are done, which comes next. */
  status(token: unknown) {
    const { e, company } = this.byToken(token);
    const o = e.onboarding!;
    const steps = [
      { id: 'w4', label: 'W-4', done: !!o.w4 && (!o.requested!.includes('stateForm') || !!o.stateForm), requested: o.requested!.includes('w4'), state: o.requested!.includes('stateForm') ? this.formName('stateForm', company) : null },
      { id: 'i9', label: 'I-9', done: !!o.i9?.section1At, requested: o.requested!.includes('i9') },
      { id: 'deposit', label: 'Deposit', done: !!o.deposit, requested: o.requested!.includes('deposit') },
    ].filter((s) => s.requested);
    return { business: company.legalName, firstName: e.firstName, lastName: e.lastName, state: company.homeState, stateName: (() => { try { return stateFacts(company.homeState, this.now().toISOString().slice(0, 10)).name; } catch { return company.homeState; } })(), steps, next: steps.find((s) => !s.done)?.id ?? null, complete: steps.every((s) => s.done), sinceMinutes: 6 };
  }

  private signed(e: Employee, signature: unknown) {
    if (typeof signature !== 'string' || norm(signature) !== norm(`${e.firstName} ${e.lastName}`)) throw badRequest(`Type your full name, ${e.firstName} ${e.lastName}, to sign.`, { field: 'signature' });
  }

  submitW4(token: unknown, body: unknown) {
    const { e, company } = this.byToken(token);
    if (!e.onboarding!.requested!.includes('w4')) throw conflict('not_requested', 'No W-4 was asked for.');
    const o = v.obj(body);
    this.signed(e, o.signature);
    const children = o.children === undefined ? 0 : v.int(o, 'children', 0, 20);
    const others = o.otherDependents === undefined ? 0 : v.int(o, 'otherDependents', 0, 20);
    const federalW4 = {
      filingStatus: v.oneOf(o, 'filingStatus', ['single', 'married_joint', 'head_of_household'] as const),
      multipleJobs: v.bool(o, 'multipleJobs', false),
      dependentCredit: children * 200_000 + others * 50_000,
      otherIncome: 0, deductions: 0, extraWithholding: 0,
    };
    const patch: Partial<Employee> = { federalW4 };
    const wantsState = e.onboarding!.requested!.includes('stateForm') && !!STATE_FORMS[company.homeState];
    if (wantsState) {
      const n = o.exemptions === undefined ? 1 : v.int(o, 'exemptions', 0, 30);
      patch.workState = { ...e.workState, certificate: { ...(e.workState.certificate ?? {}), allowances: n } as NonNullable<Employee['workState']['certificate']> };
    }
    const at = this.iso();
    const next = this.save({ ...e, ...patch }, { w4: { completedAt: at }, ...(wantsState ? { stateForm: { id: STATE_FORMS[company.homeState]!, completedAt: at } } : {}) });
    return { ok: true, next: this.statusOf(next, company) };
  }

  private statusOf(e: Employee, company: Company) {
    const m = this.missing(e, company);
    return m.length ? (m[0] === 'stateForm' ? 'w4' : m[0]) : null;
  }

  submitI9(token: unknown, body: unknown) {
    const { e, company } = this.byToken(token);
    if (!e.onboarding!.requested!.includes('i9')) throw conflict('not_requested', 'No I-9 was asked for.');
    const o = v.obj(body);
    this.signed(e, o.signature);
    const first = v.str(o, 'legalFirstName', { max: 60 }); const last = v.str(o, 'legalLastName', { max: 60 });
    const dob = v.date(o, 'dateOfBirth');
    const age = this.now().getUTCFullYear() - Number(dob.slice(0, 4));
    if (dob > this.now().toISOString().slice(0, 10) || age > 110) throw badRequest('Check the date of birth.', { field: 'dateOfBirth' });
    const status = v.oneOf(o, 'status', ['citizen', 'noncitizen_national', 'permanent_resident', 'authorized_to_work'] as const);
    const ssn = v.ssn(o, 'ssn');
    const patch: Partial<Employee> = { ssnEncrypted: encryptField(ssn), ssnLast4: ssn.slice(-4), ageAtYearEnd: Math.max(14, age) };
    const prev = e.onboarding!.i9?.detailsEncrypted ? (JSON.parse(decryptField(e.onboarding!.i9.detailsEncrypted)) as Record<string, unknown>) : {};
    const next = this.save({ ...e, ...patch }, { i9: { ...(e.onboarding!.i9 ?? {}), section1At: this.iso(), detailsEncrypted: encryptField(JSON.stringify({ ...prev, section1: { legalFirstName: first, legalLastName: last, dateOfBirth: dob, status } })) } });
    return { ok: true, next: this.statusOf(next, company) };
  }

  /** The bank details go to the employer's records. The account is held until a zero-dollar test payment clears. */
  submitDeposit(token: unknown, body: unknown) {
    const { e, company } = this.byToken(token);
    if (!e.onboarding!.requested!.includes('deposit')) throw conflict('not_requested', 'Direct deposit wasn’t asked for.');
    const o = v.obj(body);
    if (o.confirm !== true) throw badRequest('Confirm the details are yours and correct.', { field: 'confirm' });
    const account = this.banks.addManualAccount(company.id, { employeeId: e.id, routingNumber: String(o.routingNumber ?? ''), accountNumber: String(o.accountNumber ?? ''), accountType: o.accountType as 'checking' | 'savings' });
    if (typeof o.bankName === 'string' && o.bankName.trim()) account.institutionName = o.bankName.trim().slice(0, 80);
    this.store.tx(() => this.store.bankAccounts.put(account));
    const fresh = this.store.employees.get(e.id)!;
    this.store.tx(() => this.store.employees.put({ ...fresh, payoutAccounts: [{ bankAccountId: account.id, allocation: { kind: 'remainder' } }] }));
    const next = this.save(this.store.employees.get(e.id)!, { deposit: { completedAt: this.iso() } });
    return { ok: true, next: this.statusOf(next, company) };
  }

  /** Update the onboarding record and keep the rest of the employee as it stands. */
  private save(e: Employee, patch: Partial<EmployeeOnboarding>): Employee {
    const fresh = { ...e, onboarding: { ...(e.onboarding ?? {}), ...patch } };
    return this.store.tx(() => this.store.employees.put(fresh));
  }
}
