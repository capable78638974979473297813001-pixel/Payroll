import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ApiError, badRequest, forbidden, notFound } from '../lib/errors.ts';
import * as v from '../lib/validate.ts';
import type { Config } from '../config.ts';
import type { Store } from '../store/store.ts';
import { assertAdmin, assertCompanyAccess, authenticate, type Principal } from '../domain/auth.ts';
import { companyView, createCompany, updateCompany } from '../domain/companies.ts';
import { addEmployee, employeeView, requireEmployee, terminateEmployee, updateEmployee } from '../domain/employees.ts';
import { deleteShift, listShifts, recordHouseDay, recordShift } from '../domain/timekeeping.ts';
import { approvePayRun, draftPayRun, getRun, recalculatePayRun, voidPayRun } from '../payroll/payRuns.ts';
import { MoneyService } from '../money/service.ts';
import { ledgerBalances } from '../money/ledger.ts';
import { stripeMode } from '../money/stripe.ts';
import { constructEvent } from '../money/webhooks.ts';
import { dataKeyConfigured } from '../lib/crypto.ts';
import { runMasteryTax, type MasteryCommand } from '../tax/masterytax.ts';
import { tipReport } from '../restaurant/reports.ts';
import { getIndustry, getNiche, listIndustries } from '../industries/index.ts';
import { isIsoDate } from '../lib/dates.ts';
import { newId } from '../lib/ids.ts';

const MAX_BODY = 1_000_000;

interface Ctx {
  req: IncomingMessage;
  params: Record<string, string>;
  query: URLSearchParams;
  raw: string;
  principal: Principal | null;
  json(): Record<string, unknown>;
}

type Handler = (c: Ctx) => unknown | Promise<unknown>;
interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  auth: 'none' | 'admin' | 'company' | 'signature';
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

export function createApp(deps: { store: Store; money: MoneyService; config: Config; log?: (msg: string) => void }): App {
  const { store, money, config } = deps;
  const log = deps.log ?? (() => {});
  const C = '/v1/companies/:cid';

  const routes: Route[] = [
    route('GET', '/health', 'none', () => ({
      ok: true,
      stripe: { mode: stripeMode(), webhookSecretConfigured: config.webhookSecrets.length > 0 },
      ssnEncryptionConfigured: dataKeyConfigured(),
      persistence: config.dataFile ? 'file' : 'memory',
      achReturnHoldHours: config.holdHours,
    })),

    // ---- the picker
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

    // ---- employees
    route('POST', `${C}/employees`, 'company', (c) => employeeView(addEmployee(store, c.params.cid, c.json())), 201),
    route('GET', `${C}/employees`, 'company', (c) => ({ employees: store.employees.where((e) => e.companyId === c.params.cid).map(employeeView) })),
    route('GET', `${C}/employees/:eid`, 'company', (c) => employeeView(requireEmployee(store, c.params.cid, c.params.eid))),
    route('PATCH', `${C}/employees/:eid`, 'company', (c) => employeeView(updateEmployee(store, c.params.cid, c.params.eid, c.json()))),
    route('POST', `${C}/employees/:eid/terminate`, 'company', (c) => employeeView(terminateEmployee(store, c.params.cid, c.params.eid, c.json()))),
    route('POST', `${C}/employees/:eid/payout/onboarding`, 'company', (c) => {
      const o = c.json();
      return money.startEmployeePayoutOnboarding(c.params.cid, c.params.eid, { returnUrl: v.str(o, 'returnUrl', { max: 500 }), refreshUrl: v.str(o, 'refreshUrl', { max: 500 }) });
    }),

    // ---- time, tips, service charges
    route('POST', `${C}/shifts`, 'company', (c) => recordShift(store, c.params.cid, c.json()), 201),
    route('GET', `${C}/shifts`, 'company', (c) => {
      const from = c.query.get('from') ?? undefined;
      const to = c.query.get('to') ?? undefined;
      for (const d of [from, to]) if (d !== undefined && !isIsoDate(d)) throw badRequest('from and to must be YYYY-MM-DD');
      return { shifts: listShifts(store, c.params.cid, { from, to, employeeId: c.query.get('employeeId') ?? undefined }) };
    }),
    route('DELETE', `${C}/shifts/:sid`, 'company', (c) => (deleteShift(store, c.params.cid, c.params.sid), { deleted: true })),
    route('PUT', `${C}/house-days`, 'company', (c) => recordHouseDay(store, c.params.cid, c.json())),

    // ---- pay runs
    route('POST', `${C}/pay-runs`, 'company', (c) => draftPayRun(store, c.params.cid, c.json()), 201),
    route('GET', `${C}/pay-runs`, 'company', (c) => ({ payRuns: store.payRuns.where((r) => r.companyId === c.params.cid).sort((a, b) => b.periodStart.localeCompare(a.periodStart)).map(({ paychecks, ...r }) => ({ ...r, paycheckCount: paychecks.length })) })),
    route('GET', `${C}/pay-runs/:rid`, 'company', (c) => getRun(store, c.params.cid, c.params.rid)),
    route('POST', `${C}/pay-runs/:rid/recalculate`, 'company', (c) => recalculatePayRun(store, c.params.cid, c.params.rid)),
    route('POST', `${C}/pay-runs/:rid/approve`, 'company', (c) => approvePayRun(store, c.params.cid, c.params.rid, c.json())),
    route('POST', `${C}/pay-runs/:rid/void`, 'company', (c) => voidPayRun(store, c.params.cid, c.params.rid)),
    route('POST', `${C}/pay-runs/:rid/fund`, 'company', (c) => money.fundPayRun(c.params.cid, c.params.rid)),
    route('POST', `${C}/pay-runs/:rid/disburse`, 'company', (c) => money.disbursePayRun(c.params.cid, c.params.rid)),
    route('GET', `${C}/pay-runs/:rid/legs`, 'company', (c) => (getRun(store, c.params.cid, c.params.rid), { legs: store.legs.where((l) => l.runId === c.params.rid) })),

    // ---- money
    route('POST', `${C}/funding/setup`, 'company', (c) => money.setupCompanyFunding(c.params.cid)),
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
    route('GET', `${C}/tax/:command`, 'company', async (c) => {
      const command = c.params.command as MasteryCommand;
      if (!MASTERY_COMMANDS.includes(command)) throw notFound(`Tax report '${c.params.command}'`);
      const num = (k: string) => (c.query.get(k) === null ? undefined : Number(c.query.get(k)));
      const asOf = c.query.get('asOf') ?? undefined;
      if (asOf !== undefined && !isIsoDate(asOf)) throw badRequest('asOf must be YYYY-MM-DD');
      return runMasteryTax(store, c.params.cid, command, { year: num('year'), quarter: num('quarter'), state: c.query.get('state') ?? undefined, asOf });
    }),

    // ---- Stripe
    route('POST', '/v1/webhooks/stripe', 'signature', async (c) => {
      const event = constructEvent(c.raw, c.req.headers['stripe-signature'] as string | undefined, config.webhookSecrets);
      const r = await money.handleEvent(event);
      return { received: true, ...r };
    }),
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

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(text);
    };
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
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

      const raw = method === 'GET' || method === 'DELETE' ? '' : await readBody(req);
      let principal: Principal | null = null;
      if (r.auth === 'admin' || r.auth === 'company' || (r.auth === 'none' && req.headers.authorization)) {
        principal = authenticate(store, req.headers.authorization, config.adminToken);
      }
      if (r.auth === 'admin') assertAdmin(principal!);
      if (r.auth === 'company') assertCompanyAccess(principal!, params.cid);
      if (r.auth === 'company' && principal!.kind === 'company' && !store.companies.get(params.cid)) throw forbidden();

      let parsed: Record<string, unknown> | undefined;
      const ctx: Ctx = {
        req,
        params,
        query: url.searchParams,
        raw,
        principal,
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
      const result = await r.handler(ctx);
      send(r.status, result);
    } catch (e) {
      if (e instanceof ApiError) return send(e.status, { error: { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) } });
      log(`unhandled error on ${req.method} ${req.url}: ${(e as Error).stack ?? e}`);
      send(500, { error: { code: 'internal_error', message: 'Something went wrong on our side. Nothing was changed if this was a write that failed before completing.' } });
    }
  }

  const server = createServer((req, res) => void handle(req, res));
  return { server, handle };
}
