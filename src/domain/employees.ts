import { newId } from '../lib/ids.ts';
import { badRequest, conflict } from '../lib/errors.ts';
import { dataKeyConfigured, encryptField } from '../lib/crypto.ts';
import * as v from '../lib/validate.ts';
import { freshYearToDate } from '../../engine/payroll/ytd.ts';
import type { DeductionPlan } from '../../engine/payroll/types.ts';
import type { FederalW4, PretaxCategory, StateWithholding } from '../../engine/src/types.ts';
import type { Store } from '../store/store.ts';
import type { Employee } from './types.ts';

const FILING = ['single', 'married_joint', 'married_separate', 'head_of_household'] as const;
const PRETAX: readonly PretaxCategory[] = ['section125', 'hsa', 'fsa', 'dependent_care', 'deferral_401k', 'deferral_403b', 'deferral_457', 'deferral_simple', 'commuter'];

function w4(raw: unknown): FederalW4 {
  if (raw === undefined || raw === null) {
    return { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 };
  }
  const o = v.obj(raw, 'federalW4');
  return {
    filingStatus: o.filingStatus === undefined ? 'single' : v.oneOf(o, 'filingStatus', FILING),
    multipleJobs: v.bool(o, 'multipleJobs', false),
    dependentCredit: o.dependentCredit === undefined ? 0 : v.cents(o, 'dependentCredit'),
    otherIncome: o.otherIncome === undefined ? 0 : v.cents(o, 'otherIncome'),
    deductions: o.deductions === undefined ? 0 : v.cents(o, 'deductions'),
    extraWithholding: o.extraWithholding === undefined ? 0 : v.cents(o, 'extraWithholding'),
    ...(o.exempt === true ? { exempt: true } : {}),
  };
}

function stateWithholding(o: Record<string, unknown>, key: string, fallback: string): StateWithholding {
  const raw = o[key];
  if (raw === undefined || raw === null) return { code: fallback };
  const s = v.obj(raw, key);
  const out: StateWithholding = { code: v.stateCode(s, 'code') };
  if (s.certificate !== undefined) out.certificate = v.obj(s.certificate, `${key}.certificate`) as StateWithholding['certificate'];
  return out;
}

function deductionPlans(raw: unknown): DeductionPlan[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw badRequest('deductionPlans must be a list');
  return raw.map((p, i) => {
    const o = v.obj(p, `deductionPlans[${i}]`);
    const category = o.category === null ? null : v.oneOf(o, 'category', PRETAX);
    const amount = v.obj(o.amount, `deductionPlans[${i}].amount`);
    const kind = v.oneOf(amount, 'kind', ['flat', 'percentOfGross'] as const);
    return {
      id: newId('ded'),
      code: v.str(o, 'code', { max: 30 }),
      category,
      amount:
        kind === 'flat'
          ? { kind: 'flat', cents: v.cents(amount, 'cents') }
          : { kind: 'percentOfGross', percent: typeof amount.percent === 'number' && amount.percent >= 0 && amount.percent <= 100 ? amount.percent : (() => { throw badRequest('percent must be 0 to 100'); })() },
      active: v.bool(o, 'active', true),
    };
  });
}

/** A location must be one the business named in its setup; a person at a location in another state is taxed there. */
function locationOf(company: { locations?: Array<{ name: string; state: string }> }, raw: unknown): { name: string; state: string } | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') throw badRequest('location must be text');
  const hit = (company.locations ?? []).find((l) => l.name.toLowerCase() === raw.trim().toLowerCase());
  if (!hit) throw badRequest(`'${raw}' is not one of your locations`, { locations: (company.locations ?? []).map((l) => l.name) });
  return hit;
}

function tagsOf(raw: unknown): Employee['tags'] | undefined {
  if (raw === undefined) return undefined;
  const o = v.obj(raw, 'tags');
  const out: NonNullable<Employee['tags']> = {};
  for (const k of ['department', 'crew', 'wcClass'] as const) {
    if (o[k] === undefined || o[k] === '') continue;
    if (typeof o[k] !== 'string' || (o[k] as string).length > 40 || /[<>\u0000-\u001f]/.test(o[k] as string)) throw badRequest(`tags.${k} must be short plain text`);
    out[k] = (o[k] as string).trim();
  }
  return out;
}

function seasonOf(raw: unknown): Employee['season'] | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  const o = v.obj(raw, 'season');
  const start = v.date(o, 'start'); const end = v.date(o, 'end');
  if (end < start) throw badRequest('The season ends before it starts.');
  return { start, end };
}

export function addEmployee(store: Store, companyId: string, body: unknown): Employee {
  const o = v.obj(body);
  const company = store.companies.require(companyId, 'Company');
  const roleKey = v.str(o, 'roleKey');
  const role = company.settings.roles.find((r) => r.key === roleKey);
  if (!role) throw badRequest(`roleKey '${roleKey}' is not a role at this company`, { roles: company.settings.roles.map((r) => r.key) });

  const pay = v.obj(o.payType, 'payType');
  const kind = v.oneOf(pay, 'kind', ['hourly', 'salary'] as const);
  if (kind !== role.pay) throw badRequest(`${role.label} is paid ${role.pay}; payType.kind must be '${role.pay}'`);
  const payType: Employee['payType'] =
    kind === 'hourly' ? { kind, rateCents: v.cents(pay, 'rateCents', { min: 1, max: 100_000 }) } : { kind, annualCents: v.cents(pay, 'annualCents', { min: 1 }) };

  const roleRates: Record<string, number> = {};
  if (o.roleRates !== undefined) {
    for (const [k, val] of Object.entries(v.obj(o.roleRates, 'roleRates'))) {
      if (!company.settings.roles.some((r) => r.key === k)) throw badRequest(`roleRates names unknown role '${k}'`);
      if (typeof val !== 'number' || !Number.isSafeInteger(val) || val < 1 || val > 100_000) throw badRequest(`roleRates.${k} must be cents per hour`);
      roleRates[k] = val;
    }
  }

  const hireDate = v.date(o, 'hireDate');
  const loc = locationOf(company, o.location);
  const workState = stateWithholding(o, 'workState', loc?.state ?? company.homeState);
  const tags = tagsOf(o.tags);
  const employee: Employee = {
    id: newId('emp'),
    companyId,
    firstName: v.str(o, 'firstName', { max: 60 }),
    lastName: v.str(o, 'lastName', { max: 60 }),
    ...(o.email !== undefined ? { email: v.str(o, 'email', { max: 200 }) } : {}),
    roleKey,
    hireDate,
    payType,
    roleRates,
    workState,
    residenceState: stateWithholding(o, 'residenceState', workState.code),
    federalW4: w4(o.federalW4),
    deductionPlans: deductionPlans(o.deductionPlans),
    ...(o.ageAtYearEnd !== undefined ? { ageAtYearEnd: v.int(o, 'ageAtYearEnd', 14, 120) } : {}),
    ...(o.tipCreditNoticeDate !== undefined ? { tipCreditNoticeDate: v.date(o, 'tipCreditNoticeDate') } : {}),
    ...(loc ? { location: loc.name } : {}),
    ...(tags && Object.keys(tags).length ? { tags } : {}),
    ...(() => { const se = seasonOf(o.season); return se ? { season: se } : {}; })(),
    payoutAccounts: [],
    ytd: freshYearToDate(),
    ytdYear: Number(hireDate.slice(0, 4)),
    createdAt: new Date().toISOString(),
  };

  if (o.ssn !== undefined) {
    if (!dataKeyConfigured()) throw conflict('encryption_not_configured', 'TOTALI_DATA_KEY is not set, so this server will not accept an SSN.');
    const ssn = v.ssn(o, 'ssn');
    employee.ssnEncrypted = encryptField(ssn);
    employee.ssnLast4 = ssn.slice(-4);
  }
  return store.tx(() => store.employees.put(employee));
}

/**
 * Change an employee's record: a new W-4, a raise, a bank-independent detail.
 * Changes apply to pay runs drafted after this; an approved run keeps the
 * numbers it was approved with. There is no effective dating inside a period,
 * so a mid-period raise is paid by setting rateCentsPerHour on the affected shifts.
 */
export function updateEmployee(store: Store, companyId: string, employeeId: string, body: unknown): Employee {
  const o = v.obj(body);
  const company = store.companies.require(companyId, 'Company');
  const e = requireEmployee(store, companyId, employeeId);
  const forbidden = ['id', 'companyId', 'hireDate', 'terminationDate', 'ytd', 'ytdYear', 'payoutAccounts', 'stripeCustomerId', 'ssnEncrypted'].filter((k) => o[k] !== undefined);
  if (forbidden.length) throw badRequest(`${forbidden.join(', ')} cannot be changed here`);

  if (o.firstName !== undefined) e.firstName = v.str(o, 'firstName', { max: 60 });
  if (o.lastName !== undefined) e.lastName = v.str(o, 'lastName', { max: 60 });
  if (o.email !== undefined) e.email = v.str(o, 'email', { max: 200 });
  if (o.location !== undefined) { const loc = locationOf(company, o.location); if (loc) e.location = loc.name; else delete e.location; }
  if (o.season !== undefined) { const se = seasonOf(o.season); if (se) e.season = se; else delete e.season; }
  if (o.tags !== undefined) { const t = tagsOf(o.tags); if (t && Object.keys(t).length) e.tags = t; else delete e.tags; }
  if (o.roleKey !== undefined) {
    const roleKey = v.str(o, 'roleKey');
    const role = company.settings.roles.find((r) => r.key === roleKey);
    if (!role) throw badRequest(`roleKey '${roleKey}' is not a role at this company`);
    if (role.pay !== e.payType.kind && o.payType === undefined) throw badRequest(`${role.label} is paid ${role.pay}; send a matching payType too`);
    e.roleKey = roleKey;
  }
  if (o.payType !== undefined) {
    const role = company.settings.roles.find((r) => r.key === e.roleKey)!;
    const pay = v.obj(o.payType, 'payType');
    const kind = v.oneOf(pay, 'kind', ['hourly', 'salary'] as const);
    if (kind !== role.pay) throw badRequest(`${role.label} is paid ${role.pay}; payType.kind must be '${role.pay}'`);
    e.payType = kind === 'hourly' ? { kind, rateCents: v.cents(pay, 'rateCents', { min: 1, max: 100_000 }) } : { kind, annualCents: v.cents(pay, 'annualCents', { min: 1 }) };
  }
  if (o.roleRates !== undefined) {
    e.roleRates = {};
    for (const [k, val] of Object.entries(v.obj(o.roleRates, 'roleRates'))) {
      if (!company.settings.roles.some((r) => r.key === k)) throw badRequest(`roleRates names unknown role '${k}'`);
      if (typeof val !== 'number' || !Number.isSafeInteger(val) || val < 1 || val > 100_000) throw badRequest(`roleRates.${k} must be cents per hour`);
      e.roleRates[k] = val;
    }
  }
  if (o.federalW4 !== undefined) e.federalW4 = w4(o.federalW4);
  if (o.workState !== undefined) e.workState = stateWithholding(o, 'workState', company.homeState);
  if (o.residenceState !== undefined) e.residenceState = stateWithholding(o, 'residenceState', e.workState.code);
  if (o.deductionPlans !== undefined) e.deductionPlans = deductionPlans(o.deductionPlans);
  if (o.ageAtYearEnd !== undefined) e.ageAtYearEnd = v.int(o, 'ageAtYearEnd', 14, 120);
  if (o.tipCreditNoticeDate !== undefined) e.tipCreditNoticeDate = v.date(o, 'tipCreditNoticeDate');
  if (o.ssn !== undefined) {
    if (!dataKeyConfigured()) throw conflict('encryption_not_configured', 'TOTALI_DATA_KEY is not set, so this server will not accept an SSN.');
    const ssn = v.ssn(o, 'ssn');
    e.ssnEncrypted = encryptField(ssn);
    e.ssnLast4 = ssn.slice(-4);
  }
  return store.tx(() => store.employees.put(e));
}

/**
 * Where an employee's net pay goes. One account takes it all; several split
 * it by percent of net or a flat amount, and exactly one is the 'remainder'
 * that takes whatever is left, so no cent of net pay is ever without a place
 * to go. Every account must be this employee's own and not disabled.
 */
export function setPayoutAccounts(store: Store, companyId: string, employeeId: string, body: unknown): Employee {
  const o = v.obj(body);
  const e = requireEmployee(store, companyId, employeeId);
  if (!Array.isArray(o.accounts)) throw badRequest('accounts must be a list');
  const out: Employee['payoutAccounts'] = [];
  const seen = new Set<string>();
  for (const [i, raw] of o.accounts.entries()) {
    const a = v.obj(raw, `accounts[${i}]`);
    const bankAccountId = v.str(a, 'bankAccountId');
    if (seen.has(bankAccountId)) throw badRequest(`accounts[${i}] repeats a bank account`);
    seen.add(bankAccountId);
    const bank = store.bankAccounts.get(bankAccountId);
    if (!bank || bank.companyId !== companyId || bank.ownerKind !== 'employee' || bank.ownerId !== employeeId) throw badRequest(`accounts[${i}] is not one of this employee's own bank accounts`);
    if (bank.status === 'disabled') throw badRequest(`accounts[${i}] is disabled (${bank.disabledReason ?? 'no reason recorded'})`);
    const al = v.obj(a.allocation ?? { kind: 'remainder' }, `accounts[${i}].allocation`);
    const kind = v.oneOf(al, 'kind', ['remainder', 'percent', 'flatAmount'] as const);
    let allocation: Employee['payoutAccounts'][number]['allocation'];
    if (kind === 'remainder') allocation = { kind };
    else if (kind === 'percent') {
      const pct = al.percentOfNet;
      if (typeof pct !== 'number' || !(pct > 0) || pct > 100) throw badRequest(`accounts[${i}].allocation.percentOfNet must be above 0 and at most 100`);
      allocation = { kind, percentOfNet: pct };
    } else allocation = { kind, amount: v.cents(al, 'amount', { min: 1 }) };
    out.push({ bankAccountId, allocation, ...(a.priority !== undefined ? { priority: v.int(a, 'priority', 0, 100) } : {}) });
  }
  if (out.length > 0 && out.filter((x) => x.allocation.kind === 'remainder').length !== 1) {
    throw badRequest("Exactly one account must be the 'remainder', which takes whatever the other accounts do not.");
  }
  e.payoutAccounts = out;
  return store.tx(() => store.employees.put(e));
}

/**
 * Opening year-to-date balances for someone who was paid by another provider
 * earlier this year. They set where the Social Security, Medicare and
 * unemployment wage bases already stand, so caps are not applied again from
 * zero. Allowed only before Totali has paid them anything. It does NOT bring
 * earlier wages into Totali's W-2 or quarterly filings: those need the earlier
 * provider's records.
 */
export function importYtd(store: Store, companyId: string, employeeId: string, body: unknown): Employee {
  const o = v.obj(body);
  const e = requireEmployee(store, companyId, employeeId);
  const asOf = v.date(o, 'asOf');
  if (asOf > new Date().toISOString().slice(0, 10)) throw badRequest('asOf cannot be in the future');
  const paid = store.payRuns.where((r) => r.companyId === companyId && r.status !== 'voided' && r.status !== 'draft' && r.paychecks.some((p) => p.employeeId === employeeId));
  if (paid.length > 0) throw conflict('already_paid', 'This employee has already been paid through Totali, so opening balances can no longer be set.');
  const ytd = freshYearToDate();
  ytd.socialSecurity = v.cents(o, 'socialSecurityWagesCents');
  ytd.medicare = v.cents(o, 'medicareWagesCents');
  ytd.futa = v.cents(o, 'futaWagesCents');
  if (o.supplementalWagesCents !== undefined) ytd.supplemental = v.cents(o, 'supplementalWagesCents');
  if (o.stateUnemploymentWagesCents !== undefined) {
    const su = v.obj(o.stateUnemploymentWagesCents, 'stateUnemploymentWagesCents');
    ytd.stateUnemployment = {};
    for (const [code, val] of Object.entries(su)) {
      if (!/^[A-Z]{2}$/.test(code) || typeof val !== 'number' || !Number.isSafeInteger(val) || val < 0) throw badRequest(`stateUnemploymentWagesCents.${code} must be a non-negative integer of cents`);
      ytd.stateUnemployment[code] = val;
    }
  }
  return store.tx(() => store.employees.put({ ...e, ytd, ytdYear: Number(asOf.slice(0, 4)), ytdImport: { asOf, importedAt: new Date().toISOString() } }));
}

export function terminateEmployee(store: Store, companyId: string, employeeId: string, body: unknown): Employee {
  const o = v.obj(body);
  const e = requireEmployee(store, companyId, employeeId);
  const date = v.date(o, 'terminationDate');
  if (date < e.hireDate) throw badRequest('terminationDate is before the hire date');
  e.terminationDate = date;
  return store.tx(() => store.employees.put(e));
}

export function requireEmployee(store: Store, companyId: string, employeeId: string): Employee {
  const e = store.employees.get(employeeId);
  if (!e || e.companyId !== companyId) throw badRequest(`Employee '${employeeId}' is not at this company`);
  return e;
}

/** Strip anything that must not leave the server. */
export function employeeView(e: Employee) {
  const { ssnEncrypted: _ssn, ...rest } = e;
  return { ...rest, ssnOnFile: Boolean(e.ssnEncrypted) };
}
