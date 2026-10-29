import { newId } from '../lib/ids.ts';
import { badRequest, conflict } from '../lib/errors.ts';
import * as v from '../lib/validate.ts';
import { assertSettingsConsistent, getNiche, settingsFromProfile, checklistFor } from '../industries/index.ts';
import type { CompanySettings } from '../industries/types.ts';
import { hasStateRuleset } from '../../engine/src/registry.ts';
import type { Store } from '../store/store.ts';
import type { Company, PayFrequency } from './types.ts';
import { mintApiKey } from './auth.ts';

const FREQUENCIES: readonly PayFrequency[] = ['weekly', 'biweekly', 'semimonthly', 'monthly'];

function employerContext(raw: unknown): Company['employerContext'] {
  if (raw === undefined || raw === null) return undefined;
  const o = v.obj(raw, 'employerContext');
  const rates = o.stateUnemploymentRate;
  if (rates === undefined) return {};
  const r = v.obj(rates, 'employerContext.stateUnemploymentRate');
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(r)) {
    if (!/^[A-Z]{2}$/.test(k) || typeof val !== 'number' || val < 0 || val > 0.2) {
      throw badRequest(`employerContext.stateUnemploymentRate.${k} must be a rate like 0.031 (3.1%)`);
    }
    out[k] = val;
  }
  return { stateUnemploymentRate: out };
}

function taxAccounts(raw: unknown): Company['taxAccounts'] {
  if (raw === undefined || raw === null) return undefined;
  const o = v.obj(raw, 'taxAccounts');
  const out: NonNullable<Company['taxAccounts']> = {};
  if (o.federalSchedule !== undefined) out.federalSchedule = v.oneOf(o, 'federalSchedule', ['monthly', 'semiweekly'] as const);
  if (o.lookback941LiabilityDollars !== undefined) out.lookback941LiabilityDollars = v.int(o, 'lookback941LiabilityDollars', 0, 1_000_000_000);
  if (o.state !== undefined) {
    const st = v.obj(o.state, 'taxAccounts.state');
    out.state = {};
    for (const [code, acct] of Object.entries(st)) {
      const a = v.obj(acct, `taxAccounts.state.${code}`);
      out.state[code] = {
        ...(a.account !== undefined ? { account: v.str(a, 'account', { max: 40 }) } : {}),
        ...(a.suiRate !== undefined ? { suiRate: typeof a.suiRate === 'number' && a.suiRate >= 0 && a.suiRate <= 0.2 ? a.suiRate : (() => { throw badRequest(`taxAccounts.state.${code}.suiRate must be a rate like 0.031`); })() } : {}),
      };
    }
  }
  return out;
}

/**
 * The employer facts the tax engine reads. A company's state unemployment rate
 * is entered once, in taxAccounts.state[code].suiRate (it comes off the state's
 * rate notice), and this is the only place it becomes engine input, so the pay
 * run and MasteryTax can never disagree about it. A rate given in both places
 * that does not match is refused when the company is saved.
 */
export function employerContextFor(company: Pick<Company, 'employerContext' | 'taxAccounts'>): Company['employerContext'] {
  const fromNotices: Record<string, number> = {};
  for (const [code, a] of Object.entries(company.taxAccounts?.state ?? {})) if (a.suiRate !== undefined) fromNotices[code] = a.suiRate;
  const merged = { ...(company.employerContext?.stateUnemploymentRate ?? {}), ...fromNotices };
  if (Object.keys(merged).length === 0 && !company.employerContext) return undefined;
  return { ...(company.employerContext ?? {}), ...(Object.keys(merged).length ? { stateUnemploymentRate: merged } : {}) };
}

function assertRatesAgree(company: Pick<Company, 'employerContext' | 'taxAccounts'>): void {
  for (const [code, a] of Object.entries(company.taxAccounts?.state ?? {})) {
    const other = company.employerContext?.stateUnemploymentRate?.[code];
    if (a.suiRate !== undefined && other !== undefined && other !== a.suiRate) {
      throw badRequest(`${code} unemployment rate is ${a.suiRate} in taxAccounts and ${other} in employerContext. Send it once, in taxAccounts.state.${code}.suiRate.`);
    }
  }
}

export function createCompany(store: Store, body: unknown): { company: Company; apiKey: string } {
  const o = v.obj(body);
  const industry = v.str(o, 'industry');
  const niche = v.str(o, 'niche');
  const profile = getNiche(industry, niche); // 404 for an unknown niche, 409 for a planned industry
  const homeState = v.stateCode(o, 'homeState');
  const today = new Date().toISOString().slice(0, 10);
  if (!hasStateRuleset(homeState, today)) {
    throw conflict('state_not_supported', `The tax engine has no ${today.slice(0, 4)} ruleset for ${homeState}, so payroll cannot be run there.`);
  }
  const frequency = o.payFrequency === undefined ? profile.payFrequency : v.oneOf(o, 'payFrequency', FREQUENCIES);
  const einValue = v.ein(o, 'ein');
  if (store.companies.where((c) => c.ein === einValue).length > 0) throw conflict('company_exists', 'A company with that EIN is already set up.');

  const company: Company = {
    id: newId('co'),
    legalName: v.str(o, 'legalName'),
    ein: einValue,
    industry,
    niche,
    homeState,
    ...(o.address !== undefined ? { address: v.str(o, 'address', { max: 300 }) } : {}),
    paySchedule: { frequency, checkDateLagDays: o.checkDateLagDays === undefined ? 5 : v.int(o, 'checkDateLagDays', 0, 30) },
    settings: settingsFromProfile(profile),
    employerContext: employerContext(o.employerContext),
    ...(o.typicalDailyEmployees !== undefined ? { typicalDailyEmployees: v.int(o, 'typicalDailyEmployees', 0, 100_000) } : {}),
    taxAccounts: taxAccounts(o.taxAccounts),
    funding: {},
    createdAt: new Date().toISOString(),
  };
  assertRatesAgree(company);
  const apiKey = store.tx(() => {
    store.companies.put(company);
    return mintApiKey(store, company.id, 'default');
  });
  return { company, apiKey };
}

/** What a caller may change after signup. The industry and niche are fixed: switching them means a different app, so it is a new company. */
export function updateCompany(store: Store, companyId: string, body: unknown): Company {
  const o = v.obj(body);
  const company = store.companies.require(companyId, 'Company');
  if (o.industry !== undefined || o.niche !== undefined || o.ein !== undefined || o.homeState !== undefined) {
    throw badRequest('industry, niche, ein and homeState cannot be changed after signup');
  }
  if (o.legalName !== undefined) company.legalName = v.str(o, 'legalName');
  if (o.address !== undefined) company.address = v.str(o, 'address', { max: 300 });
  if (o.payFrequency !== undefined) company.paySchedule.frequency = v.oneOf(o, 'payFrequency', FREQUENCIES);
  if (o.checkDateLagDays !== undefined) company.paySchedule.checkDateLagDays = v.int(o, 'checkDateLagDays', 0, 30);
  if (o.typicalDailyEmployees !== undefined) company.typicalDailyEmployees = v.int(o, 'typicalDailyEmployees', 0, 100_000);
  if (o.employerContext !== undefined) company.employerContext = employerContext(o.employerContext);
  if (o.taxAccounts !== undefined) company.taxAccounts = taxAccounts(o.taxAccounts);
  if (o.settings !== undefined) company.settings = parseSettings(o.settings);
  assertRatesAgree(company);
  return store.tx(() => store.companies.put(company));
}

/** The whole settings document is replaced, so the caller sends back what they edited. It must be internally consistent. */
function parseSettings(raw: unknown): CompanySettings {
  const o = v.obj(raw, 'settings');
  const settings = structuredClone(o) as unknown as CompanySettings;
  if (!Array.isArray(settings.roles) || typeof settings.policy !== 'object' || settings.policy === null) {
    throw badRequest('settings must include roles and policy');
  }
  for (const r of settings.roles) {
    if (typeof r.key !== 'string' || !/^[a-z][a-z0-9_]{1,40}$/.test(r.key)) throw badRequest(`role key '${r.key}' must be lowercase letters, digits and underscores`);
    if (!['customarily', 'sometimes', 'never'].includes(r.tipped)) throw badRequest(`role '${r.key}' tipped must be customarily, sometimes or never`);
    if (!['hourly', 'salary'].includes(r.pay)) throw badRequest(`role '${r.key}' pay must be hourly or salary`);
    if (typeof r.manager !== 'boolean') throw badRequest(`role '${r.key}' manager must be true or false`);
    if (typeof r.poolPoints !== 'number' || r.poolPoints < 0) throw badRequest(`role '${r.key}' poolPoints must be a non-negative number`);
  }
  const p = settings.policy;
  if (typeof p.takesTipCredit !== 'boolean' || typeof p.pool !== 'object' || !Array.isArray(p.pool?.roles) || !Array.isArray(p.tipOuts) || !Array.isArray(p.serviceChargeRoles)) {
    throw badRequest('settings.policy is incomplete');
  }
  if (!['hours', 'points'].includes(p.pool.basis)) throw badRequest('policy.pool.basis must be hours or points');
  if (!['none', 'distribute_to_staff', 'house_revenue'].includes(p.serviceCharge)) throw badRequest('policy.serviceCharge is not recognised');
  if (p.cardFeeDeductionBps === undefined) p.cardFeeDeductionBps = null;
  assertSettingsConsistent(settings);
  return settings;
}

export function companyView(company: Company) {
  const profile = getNiche(company.industry, company.niche);
  return {
    ...company,
    niche: { id: profile.id, label: profile.label, tagline: profile.tagline, features: profile.features, reports: profile.reports },
    checklist: checklistFor(profile, company.homeState),
  };
}
