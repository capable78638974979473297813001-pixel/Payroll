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
  const workState = stateWithholding(o, 'workState', company.homeState);
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
    payout: { status: 'none' },
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
  const forbidden = ['id', 'companyId', 'hireDate', 'terminationDate', 'ytd', 'ytdYear', 'payout', 'ssnEncrypted'].filter((k) => o[k] !== undefined);
  if (forbidden.length) throw badRequest(`${forbidden.join(', ')} cannot be changed here`);

  if (o.firstName !== undefined) e.firstName = v.str(o, 'firstName', { max: 60 });
  if (o.lastName !== undefined) e.lastName = v.str(o, 'lastName', { max: 60 });
  if (o.email !== undefined) e.email = v.str(o, 'email', { max: 200 });
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
