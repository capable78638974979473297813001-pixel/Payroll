import { createHash, randomBytes, randomInt } from 'node:crypto';
import { ApiError, badRequest, conflict, notFound } from '../lib/errors.ts';
import * as v from '../lib/validate.ts';
import { newId } from '../lib/ids.ts';
import { decryptField, encryptField } from '../lib/crypto.ts';
import { hashPassword, passwordProblem, verifyPassword } from '../accounts/password.ts';
import type { Store } from '../store/store.ts';
import type { Company, Employee, PayRun } from '../domain/types.ts';
import type { Mailer } from '../mail/mailer.ts';
import { depositChangeEmail } from '../mail/mailer.ts';
import type { BankService } from '../banking/accounts.ts';
import type { DashboardService } from '../dashboard/service.ts';
import { formsOf } from '../dashboard/data.ts';
import { paystub } from '../payroll/paystub.ts';
import { nextPayday } from '../payroll/schedule.ts';
import { daysBetween, eachDay } from '../lib/dates.ts';
import { STATE_FORMS } from '../onboarding/forms.ts';
import { addEmployee } from '../domain/employees.ts';
import { parseI9, parseW4 } from '../onboarding/inputs.ts';
import { stateFacts } from '../builder/facts.ts';
import { validateRoutingNumber } from '../../engine/payroll/directDeposit.ts';
import type { JoinRequest, PortalAccount } from './types.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I: a code read aloud or off a flyer must survive
const CODE_DAYS = 3; const SESSION_DAYS = 30; const RESET_HOURS = 24;
const PAID_STATES = ['approved', 'funding', 'funded', 'disbursing', 'completed'];
const norm = (s: unknown) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const formatJoinCode = (c: string) => `${c.slice(0, 4)}-${c.slice(4)}`;

/**
 * Employees have their own login. The owner gives out a code that works for three days; with it a person makes an
 * account (an email and a password, nothing is emailed to them), fills in a request on their phone, and sends it. The
 * employee is created only when the owner approves. Until then the account can do nothing but wait.
 */
export class PortalService {
  private store: Store; private mailer: Mailer; private banks: BankService; private dashboards: DashboardService; private now: () => Date; private log: (m: string) => void;
  constructor(store: Store, mailer: Mailer, banks: BankService, dashboards: DashboardService, now: () => Date = () => new Date(), log: (m: string) => void = () => {}) {
    this.store = store; this.mailer = mailer; this.banks = banks; this.dashboards = dashboards; this.now = now; this.log = log;
  }
  private iso() { return this.now().toISOString(); }
  private today() { return this.now().toISOString().slice(0, 10); }

  // ------------------------------------------------------------------ the owner's side: the code

  private freshCode(): string {
    const taken = new Set(this.store.companies.all().map((c) => norm(c.joinCode)));
    for (;;) { const c = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(''); if (!taken.has(c)) return c; }
  }
  private withNewCode(c: Company): Company {
    return { ...structuredClone(c), joinCode: formatJoinCode(this.freshCode()), joinCodeExpiresAt: new Date(this.now().getTime() + CODE_DAYS * 86_400_000).toISOString() };
  }

  /** The company's code, made the first time anyone asks. When it runs out the owner asks for a new one; it is never replaced behind their back. */
  access(companyId: string) {
    let c = this.store.companies.require(companyId, 'Company');
    if (!c.joinCode) c = this.store.tx(() => this.store.companies.put(this.withNewCode(c)));
    const expiresAt = c.joinCodeExpiresAt ?? null;
    const left = expiresAt ? Date.parse(expiresAt) - this.now().getTime() : 0;
    const accounts = this.store.portalAccounts.where((a) => a.companyId === companyId);
    return {
      code: c.joinCode!, expiresAt, expired: left <= 0, daysLeft: left > 0 ? Math.ceil(left / 86_400_000) : 0, codeDays: CODE_DAYS,
      requests: accounts.filter((a) => a.status === 'pending').length, resets: accounts.filter((a) => a.status === 'approved' && !!a.resetAskedAt && !this.resetAllowed(a)).length, started: accounts.filter((a) => a.status === 'draft').length, joined: accounts.filter((a) => a.status === 'approved').length,
      signedInRecently: new Set(this.store.portalSessions.where((s) => s.companyId === companyId && Date.parse(s.lastSeenAt) > this.now().getTime() - 30 * 86_400_000).map((s) => s.accountId)).size,
    };
  }

  /** A new code for three more days. The old one stops working at once. People who already made an account are not affected. */
  rotate(companyId: string) {
    this.access(companyId);
    this.store.tx(() => this.store.companies.put(this.withNewCode(this.store.companies.require(companyId, 'Company'))));
    return this.access(companyId);
  }

  // ------------------------------------------------------------------ making an account and signing in

  private startSession(account: PortalAccount, userAgent?: string): string {
    const token = `temp_${randomBytes(32).toString('base64url')}`;
    this.store.portalSessions.put({ id: newId('psn'), accountId: account.id, companyId: account.companyId, hash: sha(token), createdAt: this.iso(), lastSeenAt: this.iso(), expiresAt: new Date(this.now().getTime() + SESSION_DAYS * 86_400_000).toISOString(), ...(userAgent ? { userAgent: userAgent.slice(0, 200) } : {}) });
    return token;
  }

  /** The company's code, an email and a password. Nothing is sent to the email: it is only the name of the login. */
  async signUp(rawCode: unknown, rawEmail: unknown, password: unknown, userAgent?: string): Promise<{ token: string }> {
    const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(email)) throw badRequest('Enter your email address.', { field: 'email' });
    const code = norm(rawCode);
    const company = code.length === 8 ? this.store.companies.all().find((c) => !!c.joinCode && norm(c.joinCode) === code) : undefined;
    if (!company) throw new ApiError(400, 'code_invalid', 'That code isn’t right. Check it with your manager.', { field: 'code' });
    if (!company.joinCodeExpiresAt || Date.parse(company.joinCodeExpiresAt) <= this.now().getTime()) throw new ApiError(400, 'code_expired', 'That code has run out. Ask your manager for a new one.', { field: 'code' });
    const problem = passwordProblem(password, email);
    if (problem) throw badRequest(problem, { field: 'password' });
    const taken = () => this.store.portalAccounts.where((a) => a.email === email).length > 0;
    if (taken()) throw conflict('email_taken', 'There’s already an account with that email. Sign in instead.');
    const passwordHash = await hashPassword(password as string);
    if (taken()) throw conflict('email_taken', 'There’s already an account with that email. Sign in instead.');
    return this.store.tx(() => {
      const account: PortalAccount = { id: newId('pac'), companyId: company.id, email, passwordHash, status: 'draft', createdAt: this.iso() };
      this.store.portalAccounts.put(account);
      return { token: this.startSession(account, userAgent) };
    });
  }

  async signIn(rawEmail: unknown, password: unknown, userAgent?: string): Promise<{ token: string }> {
    const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
    const account = this.store.portalAccounts.where((a) => a.email === email)[0];
    const ok = await verifyPassword(typeof password === 'string' ? password : '', account?.passwordHash);
    if (!account || !ok) throw new ApiError(400, 'sign_in_failed', 'That email and password don’t match.');
    return this.store.tx(() => ({ token: this.startSession(account, userAgent) }));
  }

  /** Who a cookie belongs to. The employee is there once the owner has approved them and until they are let go. */
  resolve(token: string): { account: PortalAccount; employee: Employee | null; ended: boolean } | null {
    const s = this.store.portalSessions.where((x) => x.hash === sha(token))[0];
    if (!s || Date.parse(s.expiresAt) < this.now().getTime()) return null;
    const account = this.store.portalAccounts.get(s.accountId);
    if (!account || !this.store.companies.get(account.companyId)) return null;
    if (Date.parse(s.lastSeenAt) < this.now().getTime() - 3_600_000) this.store.tx(() => this.store.portalSessions.put({ ...s, lastSeenAt: this.iso(), expiresAt: new Date(this.now().getTime() + SESSION_DAYS * 86_400_000).toISOString() }));
    const e = account.employeeId ? this.store.employees.get(account.employeeId) : undefined;
    return { account, employee: e && !e.terminationDate ? e : null, ended: !!e?.terminationDate };
  }

  logout(token: string) { const s = this.store.portalSessions.where((x) => x.hash === sha(token))[0]; if (s) this.store.tx(() => this.store.portalSessions.delete(s.id)); }

  /** What the account's own screens need: where it stands, and what the request form has to ask for. */
  accountView(account: PortalAccount, ended = false) {
    const company = this.store.companies.require(account.companyId, 'Company');
    const cfg = this.dashboards.get(company.id).config;
    const stateName = (() => { try { return stateFacts(company.homeState, this.today()).name; } catch { return company.homeState; } })();
    return {
      email: account.email, status: ended ? 'ended' : account.status,
      name: account.summary ? `${account.summary.firstName} ${account.summary.lastName}` : null,
      firstName: account.summary?.firstName ?? null,
      submittedAt: account.summary?.submittedAt ?? null, declineReason: account.status === 'declined' ? account.declineReason ?? null : null,
      business: company.legalName, brand: cfg.brand, theme: cfg.theme,
      form: { state: company.homeState, stateName, stateForm: STATE_FORMS[company.homeState] ?? null },
    };
  }

  // ------------------------------------------------------------------ forgot password

  private resetAllowed(a: PortalAccount): boolean {
    return !!a.resetAllowedAt && Date.parse(a.resetAllowedAt) + RESET_HOURS * 3_600_000 > this.now().getTime();
  }

  /**
   * Nothing is emailed, so the owner is the check. Until the owner has approved a login it holds nothing worth taking,
   * and the person can set a new password at once. After that it holds pay stubs, so the owner has to allow it first,
   * in the app, and the person then has a day to do it.
   *   none     no login with that email
   *   ready    they can choose a new password now
   *   waiting  the owner has been asked
   */
  resetStart(rawEmail: unknown): { state: 'none' | 'ready' | 'waiting' } {
    const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
    const a = this.store.portalAccounts.where((x) => x.email === email)[0];
    if (!a) return { state: 'none' };
    if (a.status !== 'approved' || this.resetAllowed(a)) return { state: 'ready' };
    const { resetAllowedAt: _stale, ...rest } = a;
    if (!a.resetAskedAt || a.resetAllowedAt) this.store.tx(() => this.store.portalAccounts.put({ ...rest, resetAskedAt: this.iso() }));
    return { state: 'waiting' };
  }

  async resetFinish(rawEmail: unknown, password: unknown, userAgent?: string): Promise<{ token: string }> {
    const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
    const a = this.store.portalAccounts.where((x) => x.email === email)[0];
    if (!a) throw new ApiError(400, 'no_login', 'There’s no login with that email.');
    if (a.status === 'approved' && !this.resetAllowed(a)) throw new ApiError(403, 'reset_not_allowed', 'Your manager hasn’t allowed this yet.');
    const problem = passwordProblem(password, email);
    if (problem) throw badRequest(problem, { field: 'password' });
    const passwordHash = await hashPassword(password as string);
    return this.store.tx(() => {
      const { resetAskedAt: _a, resetAllowedAt: _b, ...rest } = this.store.portalAccounts.require(a.id, 'Login');
      const fresh: PortalAccount = { ...rest, passwordHash };
      this.store.portalAccounts.put(fresh);
      for (const s of this.store.portalSessions.where((x) => x.accountId === a.id)) this.store.portalSessions.delete(s.id);
      return { token: this.startSession(fresh, userAgent) };
    });
  }

  /** The owner lets an approved employee choose a new password. */
  allowReset(companyId: string, accountId: string) {
    const a = this.store.portalAccounts.get(accountId);
    if (!a || a.companyId !== companyId || a.status !== 'approved') throw notFound('Login');
    if (!a.resetAskedAt) throw conflict('not_asked', 'They haven’t asked to reset it.');
    this.store.tx(() => this.store.portalAccounts.put({ ...a, resetAllowedAt: this.iso() }));
    return { ok: true };
  }

  dismissReset(companyId: string, accountId: string) {
    const a = this.store.portalAccounts.get(accountId);
    if (!a || a.companyId !== companyId) throw notFound('Login');
    const { resetAskedAt: _a, resetAllowedAt: _b, ...rest } = a;
    this.store.tx(() => this.store.portalAccounts.put(rest));
    return { ok: true };
  }

  // ------------------------------------------------------------------ the request

  /** Everything the owner needs to put them on the payroll, checked now so approval can't fail on a typo. */
  submitRequest(account: PortalAccount, body: unknown) {
    if (account.status === 'pending') throw conflict('already_sent', 'Your request is already with your manager.');
    if (account.status === 'approved') throw conflict('already_approved', 'You’re already on the team.');
    const company = this.store.companies.require(account.companyId, 'Company');
    const o = v.obj(body);
    const firstName = v.str(o, 'firstName', { max: 60 }); const lastName = v.str(o, 'lastName', { max: 60 });
    const wantsState = !!STATE_FORMS[company.homeState];
    const w = parseW4({ ...v.obj(o.w4, 'w4'), signature: o.signature }, firstName, lastName, wantsState);
    const i = parseI9({ ...v.obj(o.i9, 'i9'), signature: o.signature }, firstName, lastName, this.today());
    let deposit: JoinRequest['deposit'];
    if (o.deposit !== undefined && o.deposit !== null) {
      const d = v.obj(o.deposit, 'deposit');
      if (d.confirm !== true) throw badRequest('Confirm the bank details are yours and correct.', { field: 'confirm' });
      const routing = String(d.routingNumber ?? '').replace(/\D/g, ''); const acct = String(d.accountNumber ?? '').replace(/\D/g, '');
      if (routing.length !== 9 || !validateRoutingNumber(routing)) throw badRequest('That routing number isn’t valid. Check it against your card or bank app.', { field: 'routingNumber' });
      if (acct.length < 4 || acct.length > 17) throw badRequest('The account number should be 4 to 17 digits.', { field: 'accountNumber' });
      if (d.accountType !== 'checking' && d.accountType !== 'savings') throw badRequest('Pick checking or savings.', { field: 'accountType' });
      deposit = { routingNumber: routing, accountNumber: acct, accountType: d.accountType, ...(typeof d.bankName === 'string' && d.bankName.trim() ? { bankName: d.bankName.trim().slice(0, 80) } : {}) };
    }
    const at = this.iso();
    const req: JoinRequest = { firstName, lastName, w4: { federalW4: w.federalW4, exemptions: w.exemptions, signedAt: at }, i9: { legalFirstName: i.legalFirstName, legalLastName: i.legalLastName, dateOfBirth: i.dateOfBirth, status: i.status, ssn: i.ssn, ageAtYearEnd: i.ageAtYearEnd, signedAt: at }, ...(deposit ? { deposit } : {}), submittedAt: at };
    this.store.tx(() => this.store.portalAccounts.put({ ...account, status: 'pending', requestEncrypted: encryptField(JSON.stringify(req)), summary: { firstName, lastName, submittedAt: at, forms: { w4: true, i9: true, deposit: !!deposit } }, declineReason: undefined }));
    return { ok: true };
  }

  /** After a no, the person fixes what was wrong and sends it again. */
  reopen(account: PortalAccount) {
    if (account.status !== 'declined') throw conflict('not_declined', 'There’s nothing to fix.');
    this.store.tx(() => this.store.portalAccounts.put({ ...account, status: 'draft' }));
    return { ok: true };
  }

  // ------------------------------------------------------------------ the owner decides

  requests(companyId: string) {
    const roles = this.store.companies.require(companyId, 'Company').settings.roles;
    const people = this.store.employees.where((e) => e.companyId === companyId && !e.terminationDate);
    const linked = new Set(this.store.portalAccounts.where((a) => a.companyId === companyId && !!a.employeeId).map((a) => a.employeeId!));
    const free = people.filter((e) => !linked.has(e.id));
    const list = this.store.portalAccounts.where((a) => a.companyId === companyId && a.status === 'pending' && !!a.summary).sort((a, b) => a.summary!.submittedAt.localeCompare(b.summary!.submittedAt));
    const resets = this.store.portalAccounts.where((a) => a.companyId === companyId && a.status === 'approved' && !!a.resetAskedAt && !this.resetAllowed(a)).map((a) => {
      const e = a.employeeId ? this.store.employees.get(a.employeeId) : undefined;
      return { accountId: a.id, email: a.email, name: e ? `${e.firstName} ${e.lastName}` : a.email, askedAt: a.resetAskedAt! };
    });
    return {
      resets,
      requests: list.map((a) => ({
        accountId: a.id, email: a.email, name: `${a.summary!.firstName} ${a.summary!.lastName}`, firstName: a.summary!.firstName, submittedAt: a.summary!.submittedAt, forms: a.summary!.forms,
        sameEmail: free.find((e) => e.email?.toLowerCase() === a.email)?.id ?? null,
      })),
      // someone the owner already added by hand can be matched to a request, so they aren't added twice
      unlinked: free.map((e) => ({ id: e.id, name: `${e.firstName} ${e.lastName}`, role: roles.find((r) => r.key === e.roleKey)?.label ?? e.roleKey })),
    };
  }

  /** The owner says yes, and says what the job is. That creates the employee from the request and links the account. */
  approve(companyId: string, accountId: string, body: unknown) {
    const account = this.store.portalAccounts.get(accountId);
    if (!account || account.companyId !== companyId) throw notFound('Request');
    if (account.status !== 'pending') throw conflict('not_pending', 'That request has already been answered.');
    const company = this.store.companies.require(companyId, 'Company');
    const o = v.obj(body);
    let employeeId: string;
    if (o.linkEmployeeId !== undefined && o.linkEmployeeId !== null && o.linkEmployeeId !== '') {
      const e = this.store.employees.get(String(o.linkEmployeeId));
      if (!e || e.companyId !== companyId || e.terminationDate) throw badRequest('Pick someone on your team.', { field: 'linkEmployeeId' });
      if (this.store.portalAccounts.where((a) => a.employeeId === e.id).length) throw conflict('already_linked', `${e.firstName} already has a login.`);
      if (!e.email) this.store.tx(() => this.store.employees.put({ ...e, email: account.email }));
      employeeId = e.id;
    } else {
      const role = company.settings.roles.find((r) => r.key === o.roleKey);
      if (!role) throw badRequest('Pick their role.', { field: 'roleKey' });
      const rateCents = v.cents(o, 'rateCents', { min: 1 });
      const startDate = o.startDate === undefined || o.startDate === '' ? this.today() : v.date(o, 'startDate');
      const req = JSON.parse(decryptField(account.requestEncrypted!)) as JoinRequest;
      const wantsState = !!STATE_FORMS[company.homeState];
      const created = addEmployee(this.store, companyId, {
        firstName: req.firstName, lastName: req.lastName, email: account.email, roleKey: role.key, hireDate: startDate, location: o.location,
        payType: role.pay === 'hourly' ? { kind: 'hourly', rateCents } : { kind: 'salary', annualCents: rateCents },
        ...(role.tipped !== 'never' && o.tipCreditNotice === true ? { tipCreditNoticeDate: startDate } : {}),
      });
      const at = this.iso();
      const fresh = structuredClone(this.store.employees.require(created.id, 'Employee'));
      fresh.federalW4 = req.w4.federalW4;
      if (wantsState && req.w4.exemptions !== null) fresh.workState = { ...fresh.workState, certificate: { ...(fresh.workState.certificate ?? {}), allowances: req.w4.exemptions } as NonNullable<Employee['workState']['certificate']> };
      fresh.ssnEncrypted = encryptField(req.i9.ssn); fresh.ssnLast4 = req.i9.ssn.slice(-4); fresh.ageAtYearEnd = req.i9.ageAtYearEnd;
      fresh.onboarding = {
        invitedAt: req.submittedAt, inviteEmail: account.email, startDate, requested: ['w4', ...(wantsState ? ['stateForm' as const] : []), 'i9', 'deposit'],
        w4: { completedAt: req.w4.signedAt }, ...(wantsState ? { stateForm: { id: STATE_FORMS[company.homeState]!, completedAt: req.w4.signedAt } } : {}),
        i9: { section1At: req.i9.signedAt, detailsEncrypted: encryptField(JSON.stringify({ section1: { legalFirstName: req.i9.legalFirstName, legalLastName: req.i9.legalLastName, dateOfBirth: req.i9.dateOfBirth, status: req.i9.status } })) },
      };
      this.store.tx(() => this.store.employees.put(fresh));
      if (req.deposit) {
        const acct = this.banks.addManualAccount(companyId, { employeeId: created.id, routingNumber: req.deposit.routingNumber, accountNumber: req.deposit.accountNumber, accountType: req.deposit.accountType });
        if (req.deposit.bankName) this.store.tx(() => this.store.bankAccounts.put({ ...acct, institutionName: req.deposit!.bankName }));
        const again = structuredClone(this.store.employees.require(created.id, 'Employee'));
        again.payoutAccounts = [{ bankAccountId: acct.id, allocation: { kind: 'remainder' } }];
        again.onboarding = { ...again.onboarding!, deposit: { completedAt: at } };
        this.store.tx(() => this.store.employees.put(again));
      }
      employeeId = created.id;
    }
    const { requestEncrypted: _drop, ...rest } = account;
    this.store.tx(() => this.store.portalAccounts.put({ ...rest, status: 'approved', employeeId, decidedAt: this.iso() }));
    return { ok: true, employeeId };
  }

  decline(companyId: string, accountId: string, reason: unknown) {
    const account = this.store.portalAccounts.get(accountId);
    if (!account || account.companyId !== companyId) throw notFound('Request');
    if (account.status !== 'pending') throw conflict('not_pending', 'That request has already been answered.');
    const text = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 200) : undefined;
    const { requestEncrypted: _drop, ...rest } = account;
    this.store.tx(() => this.store.portalAccounts.put({ ...rest, status: 'declined', decidedAt: this.iso(), ...(text ? { declineReason: text } : {}) }));
    return { ok: true };
  }

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

