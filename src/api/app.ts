import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ApiError, badRequest, forbidden, notFound, unauthorized } from '../lib/errors.ts';
import * as v from '../lib/validate.ts';
import type { Config } from '../config.ts';
import type { Store } from '../store/store.ts';
import { assertAdmin, assertCompanyAccess, authenticate, type Principal } from '../domain/auth.ts';
import { companyView, createCompany, updateCompany } from '../domain/companies.ts';
import { addEmployee, employeeView, importYtd, requireEmployee, setPayoutAccounts, terminateEmployee, updateEmployee } from '../domain/employees.ts';
import { deleteShift, listShifts, recordHouseDay, recordShift, recordShifts } from '../domain/timekeeping.ts';
import { approvePayRun, draftPayRun, getRun, recalculatePayRun, voidPayRun } from '../payroll/payRuns.ts';
import { paystub } from '../payroll/paystub.ts';
import { AchService } from '../money/ach.ts';
import { BankService, bankAccountView } from '../banking/accounts.ts';
import { DEBIT_AUTHORIZATION_VERSION, debitAuthorizationText, recordDebitAuthorization, setFundingAccount } from '../banking/authorization.ts';
import { ledgerBalances } from '../money/ledger.ts';
import { stripeMode } from '../money/stripe.ts';
import { dataKeyConfigured } from '../lib/crypto.ts';
import { runMasteryTax, type MasteryCommand } from '../tax/masterytax.ts';
import { tipSplit } from '../tax/tipSplit.ts';
import { tipReport } from '../restaurant/reports.ts';
import { suggestPeriods } from '../payroll/schedule.ts';
import { profileView, saveProfile, addDocument, removeDocument } from '../domain/profile.ts';
import { weekSummary, saveWeek } from '../domain/weekEntry.ts';
import { getIndustry, getNiche, listIndustries } from '../industries/index.ts';
import { isIsoDate } from '../lib/dates.ts';
import { newId } from '../lib/ids.ts';
import { RateLimiter } from './ratelimit.ts';
import { rotateDataKey } from '../domain/rotation.ts';
import { paymentSetupView, setPaymentSetup } from '../domain/payment.ts';
import { getProfile, listProfiles } from '../banks/index.ts';
import { API_AUTHORIZATION_VERSION, apiAuthorizationText } from '../bankapi/authorization.ts';
import { AccountService, publicUser } from '../accounts/accounts.ts';
import { OutboxMailer, type Mailer } from '../mail/mailer.ts';
import type { User } from '../accounts/types.ts';
import { SECURITY_HEADERS, serveStatic } from '../web/static.ts';
import { fileURLToPath } from 'node:url';
import { assertIndustry, build, checkAnswer, INDUSTRY_CARDS, normalizeAnswers, questionsFor, TEAM_SIZES } from '../builder/catalog.ts';
import { createCompanyFromSetup } from '../builder/finish.ts';
import { stateFacts } from '../builder/facts.ts';
import { statesWithRuleset } from '../../engine/src/registry.ts';
import { DashboardService } from '../dashboard/service.ts';
import { dashboardData } from '../dashboard/data.ts';

const MAX_BODY = 1_000_000;
/** Failed authentications allowed per client address per minute before everything from it is refused. */
const AUTH_FAILURES_PER_MINUTE = 20;

/** A handler can return a plain-text body instead of JSON. */
class Text {
  text: string;
  filename?: string;
  constructor(text: string, filename?: string) {
    this.text = text;
    this.filename = filename;
  }
}

/** A response with extra headers (a cookie) or a status other than the route's default. */
class Reply {
  body: unknown;
  headers: Record<string, string>;
  status?: number;
  constructor(body: unknown, headers: Record<string, string> = {}, status?: number) {
    this.body = body;
    this.headers = headers;
    if (status !== undefined) this.status = status;
  }
}

const SESSION_COOKIE = 'totali_session';
const DEFAULT_WEB_ROOT = fileURLToPath(new URL('../../web', import.meta.url));

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

interface Ctx {
  req: IncomingMessage;
  user: User | null;
  params: Record<string, string>;
  query: URLSearchParams;
  raw: string;
  principal: Principal | null;
  ip: string;
  json(): Record<string, unknown>;
}

type Handler = (c: Ctx) => unknown | Promise<unknown>;
interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  auth: 'none' | 'admin' | 'company' | 'user';
  handler: Handler;
  status: number;
}

function route(method: string, path: string, auth: Route['auth'], handler: Handler, status = 200): Route {
  const keys: string[] = [];
  const re = new RegExp('^' + path.replace(/:([a-zA-Z]+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
  return { method, re, keys, auth, handler, status };
}

const MASTERY_COMMANDS: readonly MasteryCommand[] = ['validate', 'liabilities', 'deposits', '941', '940', 'w2', 'payments', 'state'];

export interface App {
  server: Server;
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

export function createApp(deps: { store: Store; banks: BankService; ach: AchService; config: Config; log?: (msg: string) => void; now?: () => Date; accounts?: AccountService; mailer?: Mailer }): App {
  const { store, banks, ach, config } = deps;
  const mailer = deps.mailer ?? new OutboxMailer();
  const accounts = deps.accounts ?? new AccountService(store, mailer, { ...(deps.now ? { now: deps.now } : {}), ...(deps.log ? { log: deps.log } : {}) });
  const webRoot = config.webRoot ?? DEFAULT_WEB_ROOT;
  const signups = new RateLimiter(3_600_000);
  const logins = new RateLimiter(3_600_000);
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => new Date());
  const dashboards = new DashboardService(store, now);
  const limiter = new RateLimiter();
  const C = '/v1/companies/:cid';
  const OPS = '/v1/ops';
  const fileMeta = (f: { contentEncrypted: string }) => {
    const { contentEncrypted: _c, ...meta } = f as Record<string, unknown>;
    return meta;
  };

  const publicUserReply = (u: User) => ({ user: publicUser(u) });
  const secureCookies = (req: IncomingMessage) => (config.publicBaseUrl ?? '').startsWith('https://') || (config.trustProxy && req.headers['x-forwarded-proto'] === 'https');
  /** A signed-in cookie lasts until sign out. "Keep me signed in" off makes it a browser-session cookie instead. */
  const sessionCookie = (req: IncomingMessage, token: string, clear = false, remember = true) => `${SESSION_COOKIE}=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Lax${clear ? '; Max-Age=0' : remember ? `; Max-Age=${365 * 86_400}` : ''}${secureCookies(req) ? '; Secure' : ''}`;
  /** A page can only send this header from our own origin, so a request that carries it was not forged from another site. */
  const requireCsrf = (req: IncomingMessage) => {
    if (req.headers['x-totali-csrf'] !== '1') throw forbidden('Missing the same-origin header.');
    const origin = req.headers.origin;
    if (origin && req.headers.host) {
      let host = '';
      try { host = new URL(origin).host; } catch { /* malformed */ }
      if (host !== req.headers.host) throw forbidden('Cross-origin request refused.');
    }
  };

  const routes: Route[] = [
    route('GET', '/health', 'none', () => ({
      ok: true,
      stripe: { mode: stripeMode(), role: 'bank linking only' },
      ach: { mode: config.ach.mode, configured: Boolean(config.ach.config.originator.odfiRoutingNumber && config.ach.config.originator.immediateOrigin && config.ach.config.originator.companyId), holdBankingDays: config.ach.config.holdBankingDays },
      ssnEncryptionConfigured: dataKeyConfigured(),
      persistence: config.dataFile ? 'sqlite' : 'memory',
    })),

    // ---- accounts: signup, email verification, sign in
    route('GET', '/v1/auth/config', 'none', () => ({
      google: false,
      mail: mailer.kind,
      devTools: !!config.devTools,
      stripePublishableKey: (process.env.STRIPE_PUBLISHABLE_KEY ?? '').trim() || null,
      termsVersion: '2026-10-terms-v1',
    })),
    route('GET', '/v1/auth/me', 'none', (c) => ({ user: c.user ? publicUser(c.user) : null })),
    route('POST', '/v1/auth/signup', 'none', async (c) => {
      requireCsrf(c.req);
      const wait = signups.hit(`signup:${c.ip}`, 20, now().getTime());
      if (wait) throw new ApiError(429, 'rate_limited', `Too many signups from here. Try again in ${Math.ceil(wait / 60)} minutes.`, { retryAfterSeconds: wait });
      const r = await accounts.signup(c.json());
      return new Reply({ user: publicUser(r.user), verification: r.sent }, { 'set-cookie': sessionCookie(c.req, r.token) }, 201);
    }),
    route('POST', '/v1/auth/login', 'none', async (c) => {
      requireCsrf(c.req);
      const wait = logins.hit(`login:${c.ip}`, 60, now().getTime());
      if (wait) throw new ApiError(429, 'rate_limited', `Too many attempts from here. Try again in ${Math.ceil(wait / 60)} minutes.`, { retryAfterSeconds: wait });
      const o = c.json();
      const r = await accounts.login(o.email, o.password);
      return new Reply({ user: publicUser(r.user) }, { 'set-cookie': sessionCookie(c.req, r.token, false, o.remember !== false) });
    }),
    route('POST', '/v1/auth/forgot', 'none', async (c) => {
      requireCsrf(c.req);
      const wait = logins.hit(`forgot:${c.ip}`, 20, now().getTime());
      if (wait) throw new ApiError(429, 'rate_limited', `Too many requests from here. Try again in ${Math.ceil(wait / 60)} minutes.`, { retryAfterSeconds: wait });
      await accounts.requestReset(c.json().email);
      return { ok: true, message: 'If that address has an account, we sent a code.' };
    }),
    route('POST', '/v1/auth/reset', 'none', async (c) => {
      requireCsrf(c.req);
      const wait = logins.hit(`reset:${c.ip}`, 30, now().getTime());
      if (wait) throw new ApiError(429, 'rate_limited', `Too many attempts from here. Try again in ${Math.ceil(wait / 60)} minutes.`, { retryAfterSeconds: wait });
      const o = c.json();
      await accounts.resetPassword(o.email, o.code, o.password);
      return { ok: true };
    }),
    route('POST', '/v1/auth/logout', 'none', (c) => {
      requireCsrf(c.req);
      const token = cookieValue(c.req.headers.cookie, SESSION_COOKIE);
      if (token) accounts.destroySession(token);
      return new Reply({ ok: true }, { 'set-cookie': sessionCookie(c.req, '', true) });
    }),
    route('POST', '/v1/auth/verify', 'user', (c) => publicUserReply(accounts.verifyEmail(c.user!.id, c.json().code))),
    route('POST', '/v1/auth/resend', 'user', async (c) => ({ verification: await accounts.sendCode(c.user!.id) })),
    route('POST', '/v1/auth/change-email', 'user', async (c) => ({ verification: await accounts.changeEmail(c.user!.id, c.json().email), user: publicUser(store.users.require(c.user!.id, 'User')) })),
    route('GET', '/v1/dev/outbox', 'none', () => {
      // Only where the operator asked for it: it shows verification codes.
      if (!config.devTools || !(mailer instanceof OutboxMailer)) throw notFound('Route');
      return { messages: mailer.messages.slice(-20) };
    }),

    // ---- the setup builder (a signed-in person who has not built their company yet)
    route('GET', '/v1/builder/industries', 'none', () => {
      const date = now().toISOString().slice(0, 10);
      return {
        industries: INDUSTRY_CARDS.map((c) => ({ ...c, questions: questionsFor(c.id) })),
        teamSizes: TEAM_SIZES,
        states: statesWithRuleset(date).map((code) => ({ code, name: stateFacts(code, date).name })).sort((a, b) => a.name.localeCompare(b.name)),
      };
    }),
    route('POST', '/v1/builder/preview', 'user', (c) => {
      const o = c.json();
      const industry = assertIndustry(o.industry);
      const date = now().toISOString().slice(0, 10);
      const { answers, errors } = normalizeAnswers(industry, o.answers, date);
      return { ...build(industry, answers, date), answers, errors };
    }),
    route('PUT', '/v1/builder/draft', 'user', (c) => {
      const o = c.json();
      const industry = assertIndustry(o.industry);
      const date = now().toISOString().slice(0, 10);
      if (c.user!.companyId) throw new ApiError(409, 'company_exists', 'Your company is already set up.');
      const { answers } = normalizeAnswers(industry, o.answers, date);
      const user = accounts.saveSetup(c.user!.id, { industry, answers: answers as Record<string, unknown>, step: typeof o.step === 'string' ? o.step.slice(0, 40) : 'industry' });
      return { user: publicUser(user), ...build(industry, answers, date) };
    }),
    route('POST', '/v1/builder/check', 'user', (c) => {
      const o = c.json();
      const r = checkAnswer(assertIndustry(o.industry), String(o.question ?? ''), o.value, now().toISOString().slice(0, 10));
      return r.ok ? { ok: true, value: r.value } : { ok: false, error: r.error };
    }),
    route('POST', '/v1/builder/finish', 'user', (c) => {
      const user = c.user!;
      if (!user.emailVerifiedAt) throw forbidden('Verify your email first.');
      const draft = user.setup;
      if (!draft?.industry) throw new ApiError(409, 'setup_incomplete', 'Pick an industry and answer the questions first.');
      const industry = assertIndustry(draft.industry);
      const date = now().toISOString().slice(0, 10);
      const { answers } = normalizeAnswers(industry, draft.answers, date);
      const company = createCompanyFromSetup(store, user, industry, answers, date, now());
      accounts.attachCompany(user.id, company.id);
      dashboards.get(company.id); // the starting dashboard, from what the business said
      return new Reply({ companyId: company.id, user: publicUser(store.users.require(user.id, 'User')) }, {}, 201);
    }),

    // ---- the dashboard: what it shows and how it looks, both the company's to change
    route('GET', `${C}/dashboard`, 'company', (c) => dashboards.describe(c.params.cid)),
    route('PUT', `${C}/dashboard`, 'company', (c) => dashboards.save(c.params.cid, c.json().config, c.json().rev)),
    route('POST', `${C}/dashboard/reset`, 'company', (c) => dashboards.reset(c.params.cid)),
    route('POST', `${C}/dashboard/revert`, 'company', (c) => dashboards.revert(c.params.cid, c.json().rev)),
    route('GET', `${C}/dashboard/data`, 'company', (c) => dashboardData(store, store.companies.require(c.params.cid, 'Company'), now().toISOString().slice(0, 10))),

    // ---- the picker
    route('GET', '/v1/bank-profiles', 'none', () => ({ banks: listProfiles(), note: 'What each bank has published about accepting ACH files, and where Totali read it. Only facts read from the bank are stated as rules; everything else is a question to ask the bank.' })),
    route('GET', '/v1/bank-profiles/:id', 'none', (c) => getProfile(c.params.id)),
    route('GET', '/v1/industries', 'none', () => ({ industries: listIndustries() })),
    route('GET', '/v1/industries/:id', 'none', (c) => {
      const i = getIndustry(c.params.id);
      return { id: i.id, label: i.label, status: i.status, description: i.description, niches: i.niches.map((n) => ({ id: n.id, label: n.label, tagline: n.tagline, description: n.description, features: n.features })) };
    }),
    route('GET', '/v1/industries/:id/niches/:niche', 'none', (c) => getNiche(c.params.id, c.params.niche)),

    // ---- signup
    route('POST', '/v1/companies', 'none', (c) => {
      if (!config.openSignup) {
        if (!c.principal) throw new ApiError(401, 'unauthorized', 'Missing or invalid credentials');
        assertAdmin(c.principal);
      }
      const { company, apiKey } = createCompany(store, c.json());
      return { company: companyView(company), apiKey, note: 'Store this key now. It is shown once.' };
    }, 201),

    // ---- company
    route('GET', C, 'company', (c) => companyView(store.companies.require(c.params.cid, 'Company'))),
    route('PATCH', C, 'company', (c) => companyView(updateCompany(store, c.params.cid, c.json()))),

    // ---- how payments are sent
    route('GET', `${C}/payment-setup`, 'company', (c) => paymentSetupView(store.companies.require(c.params.cid, 'Company'))),
    route('GET', `${C}/payment-setup/api-authorization`, 'company', (c) => {
      const company = store.companies.require(c.params.cid, 'Company');
      const q = c.query;
      const last4 = String(q.get('accountLast4') ?? company.payment.employerBank?.api?.debtorAccountLast4 ?? '').replace(/\D/g, '').slice(-4);
      const cap = Number(q.get('maxFileCents') ?? company.payment.employerBank?.api?.maxFileCents ?? 0);
      if (last4.length !== 4 || !Number.isInteger(cap) || cap <= 0) throw badRequest('Pass accountLast4 and maxFileCents to see the authorization for them');
      return { version: API_AUTHORIZATION_VERSION, text: apiAuthorizationText({ companyName: company.legalName, bankName: getProfile(company.payment.employerBank?.bankProfile ?? 'jpmorgan_commercial').name, accountLast4: last4, maxFileCents: cap }), note: 'Draft wording, not reviewed by a lawyer. Accept it by sending employerBank.api.authorization { accepted: true, acceptedBy } with the setup.' };
    }),
    route('PUT', `${C}/payment-setup`, 'company', (c) => paymentSetupView(setPaymentSetup(store, c.params.cid, c.json(), c.principal?.kind === 'admin' ? 'admin' : 'company'))),

    // ---- employees
    route('POST', `${C}/employees`, 'company', (c) => employeeView(addEmployee(store, c.params.cid, c.json())), 201),
    route('GET', `${C}/employees`, 'company', (c) => ({ employees: store.employees.where((e) => e.companyId === c.params.cid).map(employeeView) })),
    route('GET', `${C}/employees/:eid`, 'company', (c) => employeeView(requireEmployee(store, c.params.cid, c.params.eid))),
    route('PATCH', `${C}/employees/:eid`, 'company', (c) => employeeView(updateEmployee(store, c.params.cid, c.params.eid, c.json()))),
    route('POST', `${C}/employees/:eid/terminate`, 'company', (c) => employeeView(terminateEmployee(store, c.params.cid, c.params.eid, c.json()))),
    route('PUT', `${C}/employees/:eid/payout-accounts`, 'company', (c) => employeeView(setPayoutAccounts(store, c.params.cid, c.params.eid, c.json()))),
    route('POST', `${C}/employees/:eid/ytd-import`, 'company', (c) => employeeView(importYtd(store, c.params.cid, c.params.eid, c.json()))),

    // ---- time, tips, service charges
    route('POST', `${C}/shifts`, 'company', (c) => recordShift(store, c.params.cid, c.json()), 201),
    route('POST', `${C}/shifts/bulk`, 'company', (c) => ({ shifts: recordShifts(store, c.params.cid, c.json()) }), 201),
    route('GET', `${C}/shifts`, 'company', (c) => {
      const from = c.query.get('from') ?? undefined;
      const to = c.query.get('to') ?? undefined;
      for (const d of [from, to]) if (d !== undefined && !isIsoDate(d)) throw badRequest('from and to must be YYYY-MM-DD');
      return { shifts: listShifts(store, c.params.cid, { from, to, employeeId: c.query.get('employeeId') ?? undefined }) };
    }),
    route('GET', `${C}/profile`, 'company', (c) => profileView(store.companies.require(c.params.cid, 'Company'))),
    route('PUT', `${C}/profile`, 'company', (c) => saveProfile(store, c.params.cid, c.json())),
    route('POST', `${C}/profile/documents`, 'company', (c) => addDocument(store, c.params.cid, c.json()), 201),
    route('DELETE', `${C}/profile/documents/:did`, 'company', (c) => removeDocument(store, c.params.cid, c.params.did)),
    route('GET', `${C}/time/week`, 'company', (c) => {
      const from = c.query.get('start'); const to = c.query.get('end');
      if (!isIsoDate(from) || !isIsoDate(to)) throw badRequest('start and end must be YYYY-MM-DD');
      return weekSummary(store, store.companies.require(c.params.cid, 'Company'), from, to);
    }),
    route('PUT', `${C}/time/week`, 'company', (c) => saveWeek(store, store.companies.require(c.params.cid, 'Company'), c.json())),
    route('DELETE', `${C}/shifts/:sid`, 'company', (c) => (deleteShift(store, c.params.cid, c.params.sid), { deleted: true })),
    route('PUT', `${C}/house-days`, 'company', (c) => recordHouseDay(store, c.params.cid, c.json())),

    // ---- pay runs
    route('GET', `${C}/payroll/periods`, 'company', (c) => {
      const company = store.companies.require(c.params.cid, 'Company');
      const today = now().toISOString().slice(0, 10);
      const runs = store.payRuns.where((r) => r.companyId === company.id);
      return { today, periods: suggestPeriods(company, today, runs, 8, `${today.slice(0, 4)}-01-01`) };
    }),
    route('POST', `${C}/pay-runs`, 'company', (c) => draftPayRun(store, c.params.cid, c.json()), 201),
    route('GET', `${C}/pay-runs`, 'company', (c) => ({ payRuns: store.payRuns.where((r) => r.companyId === c.params.cid).sort((a, b) => b.periodStart.localeCompare(a.periodStart)).map(({ paychecks, ...r }) => ({ ...r, paycheckCount: paychecks.length })) })),
    route('GET', `${C}/pay-runs/:rid`, 'company', (c) => getRun(store, c.params.cid, c.params.rid)),
    route('POST', `${C}/pay-runs/:rid/recalculate`, 'company', (c) => recalculatePayRun(store, c.params.cid, c.params.rid)),
    route('POST', `${C}/pay-runs/:rid/approve`, 'company', (c) => approvePayRun(store, c.params.cid, c.params.rid, c.json())),
    route('POST', `${C}/pay-runs/:rid/void`, 'company', (c) => voidPayRun(store, c.params.cid, c.params.rid)),
    route('GET', `${C}/pay-runs/:rid/timeline`, 'company', (c) => ach.timeline(c.params.cid, c.params.rid)),
    route('POST', `${C}/pay-runs/:rid/prepare-payment`, 'company', (c) => {
      const o = c.json();
      return ach.preparePayment(c.params.cid, c.params.rid, { ...(o.effectiveDate !== undefined ? { effectiveDate: v.date(o, 'effectiveDate') } : {}), acceptLate: o.acceptLate === true });
    }),
    route('POST', `${C}/pay-runs/:rid/fund`, 'company', (c) => ach.fundPayRun(c.params.cid, c.params.rid, { acceptLate: c.json().acceptLate === true })),
    route('POST', `${C}/pay-runs/:rid/disburse`, 'company', (c) => ach.disbursePayRun(c.params.cid, c.params.rid)),
    route('GET', `${C}/pay-runs/:rid/legs`, 'company', (c) => (getRun(store, c.params.cid, c.params.rid), { legs: store.legs.where((l) => l.runId === c.params.rid) })),
    route('GET', `${C}/pay-runs/:rid/paychecks/:eid/stub`, 'company', (c) => {
      const run = getRun(store, c.params.cid, c.params.rid);
      const pc = run.paychecks.find((p) => p.employeeId === c.params.eid);
      if (!pc) throw notFound('Paycheck');
      const stub = paystub(store.companies.require(c.params.cid, 'Company'), requireEmployee(store, c.params.cid, c.params.eid), run, pc);
      return c.query.get('format') === 'text' ? new Text(stub.text) : stub;
    }),

    // ---- bank accounts (Stripe connects the bank; Totali holds the numbers)
    route('POST', `${C}/bank-links`, 'company', async (c) => {
      const o = c.json();
      const owner = v.oneOf(o, 'owner', ['company', 'employee'] as const);
      return banks.startLink(c.params.cid, owner === 'company' ? { kind: 'company' } : { kind: 'employee', employeeId: v.str(o, 'employeeId') });
    }, 201),
    route('POST', `${C}/bank-links/complete`, 'company', async (c) => {
      const o = c.json();
      return bankAccountView(await banks.completeLink(c.params.cid, { sessionId: v.str(o, 'sessionId'), ...(o.fcAccountId !== undefined ? { fcAccountId: v.str(o, 'fcAccountId') } : {}), routingNumber: String(o.routingNumber ?? ''), accountNumber: String(o.accountNumber ?? '') }));
    }, 201),
    route('POST', `${C}/bank-accounts/manual`, 'company', (c) => {
      const o = c.json();
      return bankAccountView(banks.addManualAccount(c.params.cid, { employeeId: v.str(o, 'employeeId'), routingNumber: String(o.routingNumber ?? ''), accountNumber: String(o.accountNumber ?? ''), accountType: v.oneOf(o, 'accountType', ['checking', 'savings'] as const) }));
    }, 201),
    route('GET', `${C}/bank-accounts`, 'company', (c) => ({ bankAccounts: store.bankAccounts.where((a) => a.companyId === c.params.cid && (!c.query.get('ownerId') || a.ownerId === c.query.get('ownerId'))).map(bankAccountView) })),
    route('GET', `${C}/bank-accounts/:bid`, 'company', (c) => bankAccountView(banks.require(c.params.cid, c.params.bid))),
    route('POST', `${C}/bank-accounts/:bid/refresh`, 'company', async (c) => bankAccountView(await banks.refreshLink(c.params.cid, c.params.bid))),
    route('POST', `${C}/bank-accounts/:bid/disable`, 'company', (c) => bankAccountView(banks.disable(c.params.cid, c.params.bid, v.str(c.json(), 'reason', { max: 200 })))),
    route('PUT', `${C}/funding/account`, 'company', (c) => companyView(setFundingAccount(store, c.params.cid, v.str(c.json(), 'bankAccountId')))),
    route('GET', `${C}/funding/authorization`, 'company', (c) => {
      const company = store.companies.require(c.params.cid, 'Company');
      const account = company.funding.bankAccountId ? store.bankAccounts.get(company.funding.bankAccountId) : undefined;
      if (!account) throw badRequest('Choose a funding account first (PUT /funding/account).');
      return { version: DEBIT_AUTHORIZATION_VERSION, text: debitAuthorizationText(company, account), bankAccountId: account.id, accepted: company.funding.debitAuthorization ?? null };
    }),
    route('POST', `${C}/funding/authorization`, 'company', (c) => {
      const o = c.json();
      return recordDebitAuthorization(store, c.params.cid, { bankAccountId: v.str(o, 'bankAccountId'), acceptedBy: v.str(o, 'acceptedBy', { max: 120 }), accept: o.accept === true, ip: c.ip, now: now() });
    }, 201),

    // ---- ACH files (read-only for companies; the bank's word is recorded under /v1/ops)
    route('POST', `${C}/ach/files/:fid/deliver`, 'company', async (c) => {
      const f = store.achFiles.require(c.params.fid, 'ACH file');
      if (f.companyId !== c.params.cid) throw notFound('ACH file');
      return fileMeta(await ach.deliverFile(c.params.fid, { force: true }));
    }),
    route('POST', `${C}/ach/files/:fid/released`, 'company', (c) => fileMeta(ach.markReleased(c.params.cid, c.params.fid, v.str(c.json(), 'releasedBy', { max: 120 })))),
    route('POST', `${C}/ach/files/:fid/approve-and-send`, 'company', async (c) => {
      const o = c.json();
      const conf = v.obj(o.confirm, 'confirm');
      return ach.approveAndSend(c.params.cid, c.params.fid, { approvedBy: v.str(o, 'approvedBy', { max: 120 }), confirm: { entryCount: v.int(conf, 'entryCount', 0, 100_000), creditsCents: v.cents(conf, 'creditsCents') } });
    }),
    route('POST', `${C}/ach/files/:fid/api-status`, 'company', (c) => ach.refreshApiStatus(c.params.cid, c.params.fid, { force: c.json().force === true })),
    route('POST', `${C}/ach/files/:fid/entries/:lid/resolve`, 'company', (c) => {
      const o = c.json();
      return ach.resolveApiEntry(c.params.cid, c.params.fid, c.params.lid, { outcome: v.oneOf(o, 'outcome', ['sent', 'not_sent'] as const), resolvedBy: v.str(o, 'resolvedBy', { max: 120 }), ...(o.paymentId !== undefined ? { paymentId: v.str(o, 'paymentId', { max: 64 }) } : {}) });
    }),
    route('POST', `${C}/ach/files/:fid/cancel`, 'company', (c) => fileMeta(ach.cancelFile(c.params.cid, c.params.fid))),
    route('POST', `${C}/ach/returns`, 'company', (c) => ach.ingestReturnFile(c.raw, { companyId: c.params.cid })),
    route('POST', `${C}/ach/prenotes`, 'company', (c) => ach.submitPrenotes(c.params.cid)),
    route('GET', `${C}/ach/files`, 'company', (c) => ({ files: store.achFiles.where((f) => f.companyId === c.params.cid).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(fileMeta) })),
    route('GET', `${C}/ach/files/:fid`, 'company', (c) => {
      const f = store.achFiles.require(c.params.fid, 'ACH file');
      if (f.companyId !== c.params.cid) throw notFound('ACH file');
      return fileMeta(f);
    }),
    route('GET', `${C}/ach/files/:fid/content`, 'company', (c) => {
      const f = ach.fileContent(c.params.cid, c.params.fid);
      return new Text(f.content, f.fileName);
    }),
    route('GET', `${C}/ledger`, 'company', (c) => {
      const runId = c.query.get('runId') ?? undefined;
      return { balances: ledgerBalances(store, c.params.cid, runId), entries: store.ledger.where((e) => e.companyId === c.params.cid && (!runId || e.runId === runId)).sort((a, b) => a.at.localeCompare(b.at)) };
    }),

    // ---- reports and tax
    route('GET', `${C}/reports/tips`, 'company', (c) => {
      const from = c.query.get('from');
      const to = c.query.get('to');
      if (!isIsoDate(from) || !isIsoDate(to)) throw badRequest('from and to are required, as YYYY-MM-DD');
      return tipReport(store, c.params.cid, from, to);
    }),
    route('POST', `${C}/tax/recorded-deposits`, 'company', (c) => {
      const o = c.json();
      store.companies.require(c.params.cid, 'Company');
      return store.tx(() => store.taxDeposits.put({ id: newId('dep'), companyId: c.params.cid, depositGroup: v.str(o, 'depositGroup', { max: 30 }), date: v.date(o, 'date'), amountCents: v.cents(o, 'amountCents', { min: 1 }), reference: v.str(o, 'reference', { max: 60 }), createdAt: new Date().toISOString() }));
    }, 201),
    route('GET', `${C}/tax/recorded-deposits`, 'company', (c) => ({ deposits: store.taxDeposits.where((d) => d.companyId === c.params.cid) })),
    route('GET', `${C}/tax/tip-split`, 'company', (c) => {
      const year = Number(c.query.get('year'));
      const quarter = c.query.get('quarter') === null ? undefined : Number(c.query.get('quarter'));
      if (!Number.isInteger(year) || year < 2000 || year > 2100) throw badRequest('year is required');
      if (quarter !== undefined && ![1, 2, 3, 4].includes(quarter)) throw badRequest('quarter must be 1 to 4');
      store.companies.require(c.params.cid, 'Company');
      const runs = store.payRuns.where((r) => r.companyId === c.params.cid && ['approved', 'funding', 'funded', 'disbursing', 'completed'].includes(r.status));
      return tipSplit(runs, { year, quarter: quarter as 1 | 2 | 3 | 4 | undefined });
    }),
    route('GET', `${C}/tax/:command`, 'company', async (c) => {
      const command = c.params.command as MasteryCommand;
      if (!MASTERY_COMMANDS.includes(command)) throw notFound(`Tax report '${c.params.command}'`);
      const num = (k: string) => (c.query.get(k) === null ? undefined : Number(c.query.get(k)));
      const asOf = c.query.get('asOf') ?? undefined;
      if (asOf !== undefined && !isIsoDate(asOf)) throw badRequest('asOf must be YYYY-MM-DD');
      return runMasteryTax(store, c.params.cid, command, { year: num('year'), quarter: num('quarter'), state: c.query.get('state') ?? undefined, asOf });
    }),

    // ---- ops: what the bank tells Totali. Admin only: a company must never be able to confirm its own funds.
    route('GET', `${OPS}/ach/files`, 'admin', (c) => ({ files: store.achFiles.where((f) => !c.query.get('status') || f.status === c.query.get('status')).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(fileMeta) })),
    route('GET', `${OPS}/ach/files/:fid/content`, 'admin', (c) => {
      const f = ach.fileContent(null, c.params.fid);
      return new Text(f.content, f.fileName);
    }),
    route('POST', `${OPS}/ach/files/:fid/accepted`, 'admin', (c) => fileMeta(ach.markFileAccepted(c.params.fid, c.json().reference === undefined ? undefined : v.str(c.json(), 'reference', { max: 80 })))),
    route('POST', `${OPS}/ach/files/:fid/rejected`, 'admin', (c) => fileMeta(ach.markFileRejected(c.params.fid, v.str(c.json(), 'reason', { max: 300 })))),
    route('POST', `${OPS}/ach/returns`, 'admin', (c) => ach.ingestReturnFile(c.raw)),
    route('POST', `${OPS}/rotate-data-key`, 'admin', () => rotateDataKey(store)),
    route('POST', `${OPS}/ach/advance`, 'admin', () => (ach.advance(), { advanced: true })),
    route('POST', `${OPS}/pay-runs/:rid/funds-received`, 'admin', (c) => {
      const o = c.json();
      return ach.confirmFundsReceived(c.params.rid, { reference: v.str(o, 'reference', { max: 80 }), amountCents: v.cents(o, 'amountCents', { min: 1 }) });
    }),
    route('POST', `${OPS}/companies/:cid/bank-accounts/:bid/activate`, 'admin', (c) => bankAccountView(banks.adminActivate(c.params.cid, c.params.bid, v.str(c.json(), 'reason', { max: 200 })))),
  ];

  async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) throw new ApiError(413, 'payload_too_large', 'Request body is too large');
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  function clientIp(req: IncomingMessage): string {
    if (config.trustProxy) {
      const fwd = req.headers['x-forwarded-for'];
      const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = clientIp(req);
    let principal: Principal | null = null;
    let companyId: string | undefined;
    let status = 500;
    const method = req.method ?? 'GET';
    const send = (code: number, body: unknown, headers: Record<string, string> = {}) => {
      if (body instanceof Reply) {
        headers = { ...body.headers, ...headers };
        code = body.status ?? code;
        body = body.body;
      }
      status = code;
      const isText = body instanceof Text;
      const payload = isText ? (body as Text).text : JSON.stringify(body);
      res.writeHead(code, {
        'content-type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        ...SECURITY_HEADERS,
        ...(isText && (body as Text).filename ? { 'content-disposition': `attachment; filename="${(body as Text).filename}"` } : {}),
        ...headers,
      });
      res.end(payload);
    };
    try {
      const nowMs = now().getTime();
      const wait = limiter.hit(`all:${ip}`, config.rateLimitPerMinute, nowMs) || limiter.blocked(`auth:${ip}`, AUTH_FAILURES_PER_MINUTE, nowMs);
      if (config.rateLimitPerMinute > 0 && wait) throw new ApiError(429, 'rate_limited', `Too many requests. Try again in ${wait} seconds.`, { retryAfterSeconds: wait });

      const url = new URL(req.url ?? '/', 'http://localhost');
      // The app itself: every GET outside the API is a file in web/, or a page the front end routes.
      if ((method === 'GET' || method === 'HEAD') && !url.pathname.startsWith('/v1/') && url.pathname !== '/health') {
        if (serveStatic(webRoot, req, res, url.pathname)) {
          status = 200;
          return;
        }
        throw notFound('Page');
      }
      let matched: { r: Route; params: Record<string, string> } | undefined;
      let pathKnown = false;
      for (const r of routes) {
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        pathKnown = true;
        if (r.method !== method) continue;
        matched = { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
        break;
      }
      if (!matched) {
        if (pathKnown) throw new ApiError(405, 'method_not_allowed', `${method} is not allowed here`);
        throw notFound('Route');
      }
      const { r, params } = matched;
      companyId = params.cid;

      const raw = method === 'GET' || method === 'DELETE' ? '' : await readBody(req);
      let user: User | null = null;
      const sessionToken = req.headers.authorization ? undefined : cookieValue(req.headers.cookie, SESSION_COOKIE);
      if (sessionToken) {
        const found = accounts.resolveSession(sessionToken);
        if (found) {
          user = found.user;
          principal = user.companyId && user.emailVerifiedAt ? { kind: 'company', companyId: user.companyId, via: 'session', userId: user.id } : { kind: 'user', userId: user.id, via: 'session' };
          // A signed-in browser must prove the request came from our own pages.
          if (method !== 'GET' && method !== 'HEAD' && r.auth !== 'none') requireCsrf(req);
        }
      }
      if (r.auth === 'user') {
        if (!user) throw unauthorized('Sign in to continue.');
      } else if (r.auth === 'admin' || r.auth === 'company' || (r.auth === 'none' && req.headers.authorization)) {
        if (!principal || r.auth === 'admin' || req.headers.authorization) {
          try {
            principal = authenticate(store, req.headers.authorization, config.adminToken);
          } catch (e) {
            if (config.rateLimitPerMinute > 0) limiter.hit(`auth:${ip}`, AUTH_FAILURES_PER_MINUTE, nowMs);
            throw e;
          }
        }
      }
      if (r.auth === 'admin') assertAdmin(principal!);
      if (r.auth === 'company') assertCompanyAccess(principal!, params.cid);
      if (r.auth === 'company' && principal!.kind === 'company' && !store.companies.get(params.cid)) throw forbidden();

      let parsed: Record<string, unknown> | undefined;
      const ctx: Ctx = {
        req,
        user,
        params,
        query: url.searchParams,
        raw,
        principal,
        ip,
        json() {
          if (parsed) return parsed;
          if (raw.trim() === '') return (parsed = {});
          try {
            return (parsed = v.obj(JSON.parse(raw)));
          } catch (e) {
            if (e instanceof ApiError) throw e;
            throw badRequest('Request body is not valid JSON');
          }
        },
      };
      send(r.status, await r.handler(ctx));
    } catch (e) {
      if (e instanceof ApiError) send(e.status, { error: { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) } }, e.status === 429 ? { 'retry-after': String((e.details as { retryAfterSeconds?: number })?.retryAfterSeconds ?? 60) } : {});
      else {
        log(`unhandled error on ${req.method} ${req.url}: ${(e as Error).stack ?? e}`);
        send(500, { error: { code: 'internal_error', message: 'Something went wrong on our side. Nothing was changed if this was a write that failed before completing.' } });
      }
    } finally {
      // Who did what. Bodies are never recorded, so no secret or personal data lands here.
      if (method !== 'GET' && principal) {
        try {
          const path = (req.url ?? '').split('?')[0];
          store.tx(() => store.auditLog.put({ id: newId('aud'), at: now().toISOString(), actor: principal!.kind === 'admin' ? 'admin' : principal!.kind === 'company' ? principal!.companyId : principal!.userId, method, path, status, ...(companyId ? { companyId } : {}), ip }));
        } catch (e) {
          log(`audit log write failed: ${(e as Error).message}`);
        }
      }
    }
  }

  const server = createServer((req, res) => void handle(req, res));
  return { server, handle };
}
