import { createHash, randomBytes, randomInt } from 'node:crypto';
import { ApiError, badRequest, conflict, notFound } from '../lib/errors.ts';
import * as v from '../lib/validate.ts';
import { newId } from '../lib/ids.ts';
import { safeEqual } from '../lib/crypto.ts';
import type { Store } from '../store/store.ts';
import type { Company, Employee, PayRun } from '../domain/types.ts';
import type { Mailer } from '../mail/mailer.ts';
import { depositChangeEmail, portalCodeEmail } from '../mail/mailer.ts';
import type { BankService } from '../banking/accounts.ts';
import type { DashboardService } from '../dashboard/service.ts';
import { formsOf } from '../dashboard/data.ts';
import { paystub } from '../payroll/paystub.ts';
import { nextPayday } from '../payroll/schedule.ts';
import { daysBetween, eachDay } from '../lib/dates.ts';
import { STATE_FORMS } from '../onboarding/forms.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I: a code read aloud or off a flyer must survive
const CODE_MINUTES = 15; const TRIES = 5; const RESEND_SECONDS = 60; const PER_HOUR = 6; const SESSION_DAYS = 30;
const PAID_STATES = ['approved', 'funding', 'funded', 'disbursing', 'completed'];
const norm = (s: unknown) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const formatJoinCode = (c: string) => `${c.slice(0, 4)}-${c.slice(4)}`;

/**
 * Employees sign in to their own dashboard with the company's code and their own email address. The code only finds
 * the company; the proof is a six-digit code sent to the email the owner has on file for that person. Whether the code
 * and address match someone is never revealed to the person asking.
 */
export class PortalService {
  private store: Store; private mailer: Mailer; private banks: BankService; private dashboards: DashboardService; private now: () => Date; private log: (m: string) => void;
  constructor(store: Store, mailer: Mailer, banks: BankService, dashboards: DashboardService, now: () => Date = () => new Date(), log: (m: string) => void = () => {}) {
    this.store = store; this.mailer = mailer; this.banks = banks; this.dashboards = dashboards; this.now = now; this.log = log;
  }
  private iso() { return this.now().toISOString(); }

  // ------------------------------------------------------------------ the owner's side: the code

  private freshCode(): string {
    const taken = new Set(this.store.companies.all().map((c) => norm(c.joinCode)));
    for (;;) { const c = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(''); if (!taken.has(c)) return c; }
  }

  /** The company's code, made the first time anyone asks. */
  access(companyId: string) {
    let c = this.store.companies.require(companyId, 'Company');
    if (!c.joinCode) { c = this.store.tx(() => this.store.companies.put({ ...structuredClone(c), joinCode: formatJoinCode(this.freshCode()) })); }
    const people = this.store.employees.where((e) => e.companyId === companyId && !e.terminationDate);
    return { code: c.joinCode!, enabled: !c.joinCodeOff, withEmail: people.filter((e) => !!e.email).length, withoutEmail: people.filter((e) => !e.email).length, signedInRecently: new Set(this.store.portalSessions.where((s) => s.companyId === companyId && Date.parse(s.lastSeenAt) > this.now().getTime() - 30 * 86_400_000).map((s) => s.employeeId)).size };
  }

  /** A new code. The old one stops working at once, and everyone signed in with it is signed out. */
  rotate(companyId: string) {
    const c = structuredClone(this.store.companies.require(companyId, 'Company'));
    c.joinCode = formatJoinCode(this.freshCode());
    this.store.tx(() => { this.store.companies.put(c); for (const s of this.store.portalSessions.where((x) => x.companyId === companyId)) this.store.portalSessions.delete(s.id); });
    return this.access(companyId);
  }

  setEnabled(companyId: string, on: unknown) {
    if (typeof on !== 'boolean') throw badRequest('Say whether employee sign-in is on.');
    this.access(companyId);
    const c = structuredClone(this.store.companies.require(companyId, 'Company'));
    if (on) delete c.joinCodeOff; else c.joinCodeOff = true;
    this.store.tx(() => { this.store.companies.put(c); if (!on) for (const s of this.store.portalSessions.where((x) => x.companyId === companyId)) this.store.portalSessions.delete(s.id); });
    return this.access(companyId);
  }

  // ------------------------------------------------------------------ signing in

  private find(rawCode: unknown, rawEmail: unknown): { company: Company; employee: Employee } | null {
    const code = norm(rawCode); const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
    if (code.length !== 8 || !EMAIL_RE.test(email)) return null;
    const company = this.store.companies.all().find((c) => !c.joinCodeOff && !!c.joinCode && norm(c.joinCode) === code);
    if (!company) return null;
    const employee = this.store.employees.where((e) => e.companyId === company.id && !e.terminationDate && e.email?.toLowerCase() === email)[0];
    return employee ? { company, employee } : null;
  }

  /** Send a sign-in code to the address on file. Says nothing about whether anyone matched. */
  async start(rawCode: unknown, rawEmail: unknown): Promise<void> {
    const hit = this.find(rawCode, rawEmail);
    if (!hit) return;
    const { company, employee } = hit;
    const nowMs = this.now().getTime();
    const recent = this.store.emailCodes.where((c) => c.userId === employee.id && c.purpose === 'employee_login').sort((a, b) => b.sentAt.localeCompare(a.sentAt));
    if (recent[0] && Date.parse(recent[0].sentAt) + RESEND_SECONDS * 1000 > nowMs) return;
    if (recent.filter((c) => Date.parse(c.sentAt) > nowMs - 3_600_000).length >= PER_HOUR) return;
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0'); const salt = randomBytes(12).toString('hex');
    const expiresAt = new Date(nowMs + CODE_MINUTES * 60_000).toISOString();
    this.store.tx(() => {
      for (const c of recent) if (!c.usedAt) this.store.emailCodes.put({ ...c, usedAt: this.iso(), attemptsLeft: 0 });
      this.store.emailCodes.put({ id: newId('code'), userId: employee.id, purpose: 'employee_login', email: employee.email!, salt, hash: sha(`${salt}:${employee.id}:${code}`), expiresAt, attemptsLeft: TRIES, sentAt: this.iso() });
    });
    const r = await this.mailer.send(portalCodeEmail({ to: employee.email!, firstName: employee.firstName, businessName: company.legalName, code, expiresAt, now: this.now() }));
    if (!r.sent) this.log(`portal code for ${employee.id} not sent: ${r.reason ?? 'unknown'}`);
  }

  verify(rawCode: unknown, rawEmail: unknown, rawOtp: unknown, userAgent?: string): { token: string; employee: Employee } {
    const wrong = new ApiError(400, 'code_invalid', 'That code isn’t valid. Ask for a new one.', { attemptsLeft: 0 });
    const otp = typeof rawOtp === 'string' ? rawOtp.replace(/\s+/g, '') : '';
    if (!/^\d{6}$/.test(otp)) throw badRequest('Enter the 6-digit code.', { field: 'code' });
    const hit = this.find(rawCode, rawEmail);
    if (!hit) throw wrong;
    const e = hit.employee;
    const live = this.store.emailCodes.where((c) => c.userId === e.id && c.purpose === 'employee_login' && !c.usedAt).sort((a, b) => b.sentAt.localeCompare(a.sentAt))[0];
    if (!live) throw wrong;
    if (Date.parse(live.expiresAt) <= this.now().getTime()) throw new ApiError(400, 'code_expired', 'That code has expired. Ask for a new one.', { attemptsLeft: 0 });
    if (!safeEqual(sha(`${live.salt}:${e.id}:${otp}`), live.hash)) {
      const left = Math.max(0, live.attemptsLeft - 1);
      this.store.tx(() => this.store.emailCodes.put({ ...live, attemptsLeft: left, ...(left === 0 ? { usedAt: this.iso() } : {}) }));
      throw new ApiError(400, 'code_wrong', left > 0 ? `That code didn’t match. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'That code didn’t match and has been cancelled. Ask for a new one.', { attemptsLeft: left });
    }
    const token = `temp_${randomBytes(32).toString('base64url')}`;
    this.store.tx(() => {
      this.store.emailCodes.put({ ...live, usedAt: this.iso() });
      this.store.portalSessions.put({ id: newId('psn'), employeeId: e.id, companyId: e.companyId, hash: sha(token), createdAt: this.iso(), lastSeenAt: this.iso(), expiresAt: new Date(this.now().getTime() + SESSION_DAYS * 86_400_000).toISOString(), ...(userAgent ? { userAgent: userAgent.slice(0, 200) } : {}) });
    });
    return { token, employee: e };
  }

  resolve(token: string): Employee | null {
    const s = this.store.portalSessions.where((x) => x.hash === sha(token))[0];
    if (!s || Date.parse(s.expiresAt) < this.now().getTime()) return null;
    const e = this.store.employees.get(s.employeeId);
    const c = this.store.companies.get(s.companyId);
    if (!e || !c || e.terminationDate || c.joinCodeOff) return null;
    if (Date.parse(s.lastSeenAt) < this.now().getTime() - 3_600_000) this.store.tx(() => this.store.portalSessions.put({ ...s, lastSeenAt: this.iso(), expiresAt: new Date(this.now().getTime() + SESSION_DAYS * 86_400_000).toISOString() }));
    return e;
  }

  logout(token: string) { const s = this.store.portalSessions.where((x) => x.hash === sha(token))[0]; if (s) this.store.tx(() => this.store.portalSessions.delete(s.id)); }

  // ------------------------------------------------------------------ what an employee sees: only their own

  private runsFor(e: Employee) {
    return this.store.payRuns.where((r) => r.companyId === e.companyId && PAID_STATES.includes(r.status) && r.paychecks.some((p) => p.employeeId === e.id)).sort((a, b) => b.checkDate.localeCompare(a.checkDate));
  }
  private line(run: PayRun, e: Employee) {
    const pc = run.paychecks.find((p) => p.employeeId === e.id)!;
    return { runId: run.id, periodStart: run.periodStart, periodEnd: run.periodEnd, checkDate: run.checkDate, hours: Math.round(pc.hours * 100) / 100, grossCents: pc.taxableWagesCents, taxCents: pc.employeeTaxCents, netCents: pc.netPayCents, paidCents: pc.payableCents };
  }

  me(e: Employee) {
    const company = this.store.companies.require(e.companyId, 'Company');
    const today = this.now().toISOString().slice(0, 10);
    const roles = new Map(company.settings.roles.map((r) => [r.key, r.label]));
    const runs = this.runsFor(e);
    const year = today.slice(0, 4);
    const ytd = runs.filter((r) => r.checkDate.startsWith(year)).map((r) => this.line(r, e)).reduce((a, l) => ({ grossCents: a.grossCents + l.grossCents, taxCents: a.taxCents + l.taxCents, netCents: a.netCents + l.netCents, hours: a.hours + l.hours }), { grossCents: 0, taxCents: 0, netCents: 0, hours: 0 });
    const allRuns = this.store.payRuns.where((r) => r.companyId === company.id);
    const next = nextPayday(company, today, allRuns);
    const cfg = this.dashboards.get(company.id).config;
    const f = formsOf(e, !!STATE_FORMS[company.homeState] && (e.onboarding?.requested ? e.onboarding.requested.includes('stateForm') : true));
    const acct = e.payoutAccounts[0] ? this.store.bankAccounts.get(e.payoutAccounts[0].bankAccountId) : undefined;
    const pending = e.pendingDeposit ? this.store.bankAccounts.get(e.pendingDeposit.bankAccountId) : undefined;
    return {
      employee: { id: e.id, firstName: e.firstName, lastName: e.lastName, email: e.email ?? '', role: roles.get(e.roleKey) ?? e.roleKey, location: e.location ?? null, hireDate: e.hireDate, pay: e.payType.kind === 'hourly' ? { kind: 'hourly', cents: e.payType.rateCents } : { kind: 'salary', cents: e.payType.annualCents } },
      company: { name: company.legalName, state: company.homeState, stateForm: STATE_FORMS[company.homeState] ?? null, schedule: company.paySchedule.frequency },
      brand: cfg.brand, theme: cfg.theme,
      nextPay: { periodStart: next.period.periodStart, periodEnd: next.period.periodEnd, checkDate: next.period.checkDate, daysUntil: daysBetween(today, next.period.checkDate) },
      latest: runs[0] ? this.line(runs[0], e) : null,
      ytd, forms: { w4: f.w4, i9: f.i9, deposit: f.deposit, stateForm: f.stateForm },
      deposit: { last4: acct ? acct.last4 : null, bank: acct ? acct.institutionName ?? null : null, pending: pending ? { last4: pending.last4, requestedAt: e.pendingDeposit!.requestedAt } : null },
      today,
    };
  }

  stubs(e: Employee) { return { stubs: this.runsFor(e).map((r) => this.line(r, e)) }; }

  stub(e: Employee, runId: string) {
    const run = this.runsFor(e).find((r) => r.id === runId);
    if (!run) throw notFound('Pay stub');
    const company = this.store.companies.require(e.companyId, 'Company');
    const pc = run.paychecks.find((p) => p.employeeId === e.id)!;
    const s = paystub(company, e, run, pc);
    return { line: this.line(run, e), stub: s.structured, text: s.text, taxLines: pc.taxLines.filter((t) => t.payer === 'employee' && t.amount > 0).map((t) => ({ id: t.id, name: t.name, jurisdiction: t.jurisdiction, amountCents: t.amount })), earnings: pc.earnings.map((x) => ({ code: x.code, detail: x.detail, minutes: x.minutes ?? null, amountCents: x.amountCents, paidByPayroll: x.paidByPayroll })) };
  }

  /** Their own hours and tips, day by day. */
  hours(e: Employee, from: string, to: string) {
    if (to < from || daysBetween(from, to) > 31) throw badRequest('Check the dates.');
    const shifts = this.store.shifts.where((s) => s.employeeId === e.id && s.workDate >= from && s.workDate <= to);
    const days = eachDay(from, to).map((d) => { const day = shifts.filter((s) => s.workDate === d); return { date: d, minutes: day.reduce((n, s) => n + s.minutes, 0), tipsCents: day.reduce((n, s) => n + s.chargedTipsCents + s.cashTipsCents, 0), paid: day.some((s) => !!s.lockedByRunId) }; });
    return { from, to, days, totalMinutes: days.reduce((n, d) => n + d.minutes, 0), tipsCents: days.reduce((n, d) => n + d.tipsCents, 0) };
  }

  w4(e: Employee) {
    const w = e.federalW4;
    return { filingStatus: w.filingStatus, multipleJobs: w.multipleJobs, dependentCredit: w.dependentCredit, extraWithholdingCents: w.extraWithholding, stateForm: STATE_FORMS[e.workState.code] ?? null, exemptions: e.workState.certificate?.allowances ?? null, signedAt: e.onboarding?.w4?.completedAt ?? null };
  }

  /** A new W-4 takes effect on pay runs drafted after it is saved. Signing is typing your own name. */
  updateW4(e: Employee, body: unknown) {
    const o = v.obj(body);
    if (typeof o.signature !== 'string' || o.signature.trim().toLowerCase().replace(/\s+/g, ' ') !== `${e.firstName} ${e.lastName}`.toLowerCase()) throw badRequest(`Type your full name, ${e.firstName} ${e.lastName}, to sign.`, { field: 'signature' });
    const children = o.children === undefined ? 0 : v.int(o, 'children', 0, 20); const others = o.otherDependents === undefined ? 0 : v.int(o, 'otherDependents', 0, 20);
    const fresh = structuredClone(this.store.employees.require(e.id, 'Employee'));
    fresh.federalW4 = { filingStatus: v.oneOf(o, 'filingStatus', ['single', 'married_joint', 'head_of_household'] as const), multipleJobs: v.bool(o, 'multipleJobs', false), dependentCredit: children * 200_000 + others * 50_000, otherIncome: 0, deductions: 0, extraWithholding: o.extraWithholdingCents === undefined ? 0 : v.cents(o, 'extraWithholdingCents', { max: 10_000_000 }) };
    if (STATE_FORMS[fresh.workState.code] && o.exemptions !== undefined) fresh.workState = { ...fresh.workState, certificate: { ...(fresh.workState.certificate ?? {}), allowances: v.int(o, 'exemptions', 0, 30) } as NonNullable<Employee['workState']['certificate']> };
    const at = this.iso();
    fresh.onboarding = { ...(fresh.onboarding ?? {}), w4: { completedAt: at }, ...(STATE_FORMS[fresh.workState.code] && fresh.onboarding?.requested?.includes('stateForm') ? { stateForm: { id: STATE_FORMS[fresh.workState.code]!, completedAt: at } } : {}) };
    this.store.tx(() => this.store.employees.put(fresh));
    return this.w4(fresh);
  }

  /** A new bank account is only a request. The employer sees it, and it replaces the old one only when they approve. */
  async requestDeposit(e: Employee, base: string, body: unknown) {
    const o = v.obj(body);
    if (o.confirm !== true) throw badRequest('Confirm the details are yours and correct.', { field: 'confirm' });
    if (e.pendingDeposit) throw conflict('change_pending', 'You already have a change waiting for your employer to approve.');
    const company = this.store.companies.require(e.companyId, 'Company');
    const acct = this.banks.addManualAccount(company.id, { employeeId: e.id, routingNumber: String(o.routingNumber ?? ''), accountNumber: String(o.accountNumber ?? ''), accountType: o.accountType as 'checking' | 'savings' });
    if (typeof o.bankName === 'string' && o.bankName.trim()) { acct.institutionName = o.bankName.trim().slice(0, 80); this.store.tx(() => this.store.bankAccounts.put(acct)); }
    const fresh = this.store.employees.require(e.id, 'Employee');
    this.store.tx(() => this.store.employees.put({ ...fresh, pendingDeposit: { bankAccountId: acct.id, requestedAt: this.iso() } }));
    for (const owner of this.store.users.where((u) => u.companyId === company.id && !!u.emailVerifiedAt)) {
      const r = await this.mailer.send(depositChangeEmail({ to: owner.email, ownerName: owner.firstName, employeeName: `${e.firstName} ${e.lastName}`, link: `${base}/app/onboarding` }));
      if (!r.sent) this.log(`deposit-change notice for ${owner.id} not sent: ${r.reason ?? 'unknown'}`);
    }
    return { ok: true, last4: acct.last4 };
  }

  cancelDeposit(e: Employee) {
    if (!e.pendingDeposit) throw conflict('nothing_pending', 'There is no change waiting.');
    this.banks.disable(e.companyId, e.pendingDeposit.bankAccountId, 'Cancelled by the employee');
    const fresh = structuredClone(this.store.employees.require(e.id, 'Employee')); delete fresh.pendingDeposit;
    this.store.tx(() => this.store.employees.put(fresh));
    return { ok: true };
  }

  // ------------------------------------------------------------------ the owner decides

  decideDeposit(companyId: string, employeeId: string, approve: unknown) {
    if (typeof approve !== 'boolean') throw badRequest('Say whether you approve it.');
    const e = this.store.employees.get(employeeId);
    if (!e || e.companyId !== companyId) throw notFound('Employee');
    if (!e.pendingDeposit) throw conflict('nothing_pending', 'There is no change waiting.');
    const fresh = structuredClone(e); const next = e.pendingDeposit.bankAccountId; delete fresh.pendingDeposit;
    if (approve) {
      for (const p of e.payoutAccounts) if (p.bankAccountId !== next) this.banks.disable(companyId, p.bankAccountId, 'Replaced by a new account the employee asked for');
      fresh.payoutAccounts = [{ bankAccountId: next, allocation: { kind: 'remainder' } }];
    } else this.banks.disable(companyId, next, 'Declined by the employer');
    this.store.tx(() => this.store.employees.put(fresh));
    return { ok: true, approved: approve };
  }
}

