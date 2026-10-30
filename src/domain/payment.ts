import { badRequest, forbidden } from '../lib/errors.ts';
import { encryptField } from '../lib/crypto.ts';
import { createPrivateKey } from 'node:crypto';
import { validateRoutingNumber } from '../../engine/payroll/directDeposit.ts';
import { validateSftp, validateTemplate } from '../ach/sftp.ts';
import * as v from '../lib/validate.ts';
import { getProfile, PROFILE_IDS } from '../banks/index.ts';
import { checkSetup, errorsOf } from '../banks/checks.ts';
import type { Finding } from '../banks/types.ts';
import type { Store } from '../store/store.ts';
import { API_AUTHORIZATION_VERSION } from '../bankapi/authorization.ts';
import type { BankApiSetup, Company, EmployerBankSetup, PaymentSetup } from './types.ts';

/** Totali only calls a bank at the bank's own hosts, so a company key cannot point it, and the account numbers it sends, somewhere else. */
export function bankApiUrl(value: string, field: string): string {
  let u: URL;
  try { u = new URL(value); } catch { throw badRequest(`${field} is not a URL`); }
  const ok = u.protocol === 'https:' && !u.username && !u.password && !u.port && (u.hostname.endsWith('.jpmorgan.com') || u.hostname.endsWith('.jpmorganchase.com'));
  if (!ok) throw badRequest(`${field} must be an https address at the bank's own domain (jpmorgan.com)`);
  return u.toString().replace(/\/$/, '');
}

export const DEFAULT_FILE_NAME_TEMPLATE = 'TOTALI_{date}_{seq}.ach';

/**
 * How a company's payments are sent.
 *
 * employer_bank (the default): the employer's own bank sends the money. The
 * employer gives Totali their bank's routing number and name and the two ids
 * the bank assigned them for ACH (the file header's immediate origin, and the
 * 10-character company id). Totali writes the file; the employer releases it at
 * their bank. If the bank takes SFTP, the connection details go here too.
 *
 * totali_ach: Totali sends through its own sponsoring bank. That needs an
 * arrangement a company cannot create for itself, so only an admin may select it.
 */
export function setPaymentSetup(store: Store, companyId: string, body: unknown, actor: 'admin' | 'company'): Company {
  const o = v.obj(body);
  const company = store.companies.require(companyId, 'Company');
  const mode = v.oneOf(o, 'mode', ['employer_bank', 'totali_ach'] as const);
  if (mode === 'totali_ach' && actor !== 'admin') throw forbidden('Only Totali staff can switch a company to Totali-sent payments. It needs a sponsoring bank arrangement.');

  if (store.payRuns.where((r) => r.companyId === companyId && ['funding', 'funded', 'disbursing'].includes(r.status)).length > 0 && mode !== company.payment.mode) {
    throw badRequest('Payment mode cannot change while a pay run is in motion.');
  }

  if (mode === 'totali_ach') {
    const next: PaymentSetup = { mode, ...(company.payment.employerBank ? { employerBank: company.payment.employerBank } : {}) };
    return store.tx(() => store.companies.put({ ...company, payment: next }));
  }

  const b = v.obj(o.employerBank, 'employerBank');
  const odfiRoutingNumber = v.str(b, 'odfiRoutingNumber', { max: 40 });
  if (!validateRoutingNumber(odfiRoutingNumber)) throw badRequest("employerBank.odfiRoutingNumber is not a valid routing number (its check digit fails). It is your bank's ACH routing number.");
  const companyIdValue = v.str(b, 'companyId', { max: 40 });
  if (!/^[A-Za-z0-9 ]{1,10}$/.test(companyIdValue)) throw badRequest('employerBank.companyId is at most 10 letters and digits: the id your bank assigned you for ACH');
  const immediateOrigin = v.str(b, 'immediateOrigin', { max: 40 });
  if (!/^[A-Za-z0-9]{1,10}$/.test(immediateOrigin)) throw badRequest('employerBank.immediateOrigin is at most 10 letters and digits');
  const fileNameTemplate = b.fileNameTemplate === undefined ? DEFAULT_FILE_NAME_TEMPLATE : v.str(b, 'fileNameTemplate', { max: 100 });
  validateTemplate(fileNameTemplate);
  const bankProfile = b.bankProfile === undefined ? undefined : v.oneOf(b, 'bankProfile', PROFILE_IDS);
  const profile = bankProfile ? getProfile(bankProfile) : undefined;
  const limitsTier = b.limitsTier === undefined ? undefined : v.str(b, 'limitsTier', { max: 60 });
  // A bank's own lead time is the default; the employer can set more, or less if the bank's rule is only our reading of it.
  const leadGiven = b.leadBankingDays === undefined ? undefined : v.int(b, 'leadBankingDays', 0, 10);
  const leadBankingDays = leadGiven ?? profile?.rules.defaultLeadBankingDays?.days;

  const existing = company.payment.employerBank;
  let api: BankApiSetup | undefined;
  if (b.api !== undefined && b.api !== null) {
    if (b.sftp !== undefined && b.sftp !== null) throw badRequest('Choose one: SFTP file delivery or the bank API, not both.');
    api = parseApiSetup(b.api, existing?.api, bankProfile, companyIdValue);
  }
  let sftp: EmployerBankSetup['sftp'];
  if (b.sftp === undefined || b.sftp === null) sftp = undefined;
  else {
    const s = v.obj(b.sftp, 'employerBank.sftp');
    const host = v.str(s, 'host', { max: 253 });
    const port = s.port === undefined ? 22 : v.int(s, 'port', 1, 65535);
    const username = v.str(s, 'username', { max: 64 });
    const remoteDir = s.remoteDir === undefined ? '' : String(s.remoteDir);
    const knownHostsLine = v.str(s, 'knownHostsLine', { max: 800 }).trim();
    const privateKey = s.privateKey === undefined ? undefined : v.str(s, 'privateKey', { max: 20_000 });
    validateSftp({ host, port, username, remoteDir, knownHostsLine, privateKey });
    const keyEncrypted = privateKey ? encryptField(privateKey) : existing?.sftp?.privateKeyEncrypted;
    if (!keyEncrypted) throw badRequest('employerBank.sftp.privateKey is required the first time SFTP is set up');
    sftp = { host, port, username, remoteDir, knownHostsLine, privateKeyEncrypted: keyEncrypted };
  }

  if (profile) {
    const findings = checkSetup(profile, { odfiRoutingNumber, immediateOrigin, ...(leadBankingDays !== undefined ? { leadBankingDays } : {}), ...(limitsTier !== undefined ? { limitsTier } : {}), ...(sftp ? { sftp: { host: sftp.host, port: sftp.port } } : {}) });
    const errs = errorsOf(findings);
    if (errs.length > 0) throw badRequest(errs.map((e) => e.message).join(' '), { findings });
  } else if (limitsTier !== undefined) {
    throw badRequest('employerBank.limitsTier needs employerBank.bankProfile');
  }

  const employerBank: EmployerBankSetup = {
    odfiRoutingNumber,
    odfiName: v.str(b, 'odfiName', { max: 60 }),
    immediateOrigin,
    companyId: companyIdValue,
    fileNameTemplate,
    ...(leadBankingDays !== undefined ? { leadBankingDays } : {}),
    ...(bankProfile ? { bankProfile } : {}),
    ...(limitsTier !== undefined ? { limitsTier } : {}),
    ...(sftp ? { sftp } : {}),
    ...(api ? { api } : {}),
  };
  return store.tx(() => store.companies.put({ ...company, payment: { mode, employerBank } }));
}

function parseApiSetup(raw: unknown, existing: BankApiSetup | undefined, bankProfile: string | undefined, companyId: string): BankApiSetup {
  const a = v.obj(raw, 'employerBank.api');
  const adapter = v.oneOf(a, 'adapter', ['jpmorgan'] as const);
  if (bankProfile !== 'jpmorgan_commercial') throw badRequest("employerBank.api: the J.P. Morgan API needs employerBank.bankProfile 'jpmorgan_commercial'");
  if (companyId.length !== 10) throw badRequest('employerBank.companyId must be exactly 10 characters for the API (the bank requires 10)');
  const environment = v.oneOf(a, 'environment', ['client_testing', 'production'] as const);
  const clientId = v.str(a, 'clientId', { max: 200 });
  const certThumbprint = v.str(a, 'certThumbprint', { max: 200 });
  const debtorAccountNumber = v.str(a, 'debtorAccountNumber', { max: 17 });
  if (!/^\d{4,17}$/.test(debtorAccountNumber)) throw badRequest('employerBank.api.debtorAccountNumber is the 4 to 17 digit number of the account the payroll is paid from');
  const debtorName = v.str(a, 'debtorName', { max: 16 });
  const maxFileCents = v.cents(a, 'maxFileCents', { min: 1 });
  const privateKey = a.privateKey === undefined ? undefined : v.str(a, 'privateKey', { max: 20_000 });
  if (privateKey) {
    try {
      const k = createPrivateKey(privateKey);
      if (k.asymmetricKeyType !== 'rsa' || (k.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error('weak');
    } catch { throw badRequest('employerBank.api.privateKey must be an RSA private key of at least 2048 bits, in PEM form'); }
  }
  const keyEncrypted = privateKey ? encryptField(privateKey) : existing?.privateKeyEncrypted;
  if (!keyEncrypted) throw badRequest('employerBank.api.privateKey is required the first time the API is set up');
  const auth = v.obj(a.authorization, 'employerBank.api.authorization');
  if (auth.accepted !== true) throw badRequest('employerBank.api.authorization.accepted must be true: the employer has to accept the written authorization (GET /payment-setup/api-authorization) before Totali may use their bank credentials');
  const acceptedBy = v.str(auth, 'acceptedBy', { max: 120 });
  if (a.environment === 'client_testing' && a.baseUrl === undefined) throw badRequest('employerBank.api.baseUrl is required for client_testing: it is given to you by J.P. Morgan');
  return {
    adapter,
    environment,
    clientId,
    certThumbprint,
    privateKeyEncrypted: keyEncrypted,
    debtorAccountEncrypted: encryptField(debtorAccountNumber),
    debtorAccountLast4: debtorAccountNumber.slice(-4),
    debtorName,
    maxFileCents,
    ...(a.tokenUrl !== undefined ? { tokenUrl: bankApiUrl(v.str(a, 'tokenUrl', { max: 300 }), 'employerBank.api.tokenUrl') } : {}),
    ...(a.baseUrl !== undefined ? { baseUrl: bankApiUrl(v.str(a, 'baseUrl', { max: 300 }), 'employerBank.api.baseUrl') } : {}),
    ...(a.audience !== undefined ? { audience: v.str(a, 'audience', { max: 200 }) } : {}),
    authorization: { acceptedAt: new Date().toISOString(), acceptedBy, textVersion: API_AUTHORIZATION_VERSION },
  };
}

/** What a caller may see: never the private key. */
export interface PaymentSetupView {
  mode: PaymentSetup['mode'];
  employerBank?: Omit<EmployerBankSetup, 'sftp' | 'api'> & {
    api?: { adapter: string; environment: string; clientId: string; certThumbprint: string; debtorAccountLast4: string; debtorName: string; maxFileCents: number; baseUrl?: string; tokenUrl?: string; audience?: string; hasPrivateKey: true; authorization: BankApiSetup['authorization'] }; sftp?: { host: string; port: number; username: string; remoteDir: string; knownHostsLine: string; hasPrivateKey: true } };
  bank?: { id: string; name: string; guidance: string[]; askYourBank: string[]; findings: Finding[] };
}

export function paymentSetupView(company: Company): PaymentSetupView {
  const eb = company.payment.employerBank;
  if (!eb) return { mode: company.payment.mode };
  const { sftp, api, ...rest } = eb;
  const profile = eb.bankProfile ? getProfile(eb.bankProfile) : undefined;
  const bank = profile
    ? {
        id: profile.id,
        name: profile.name,
        guidance: profile.guidance,
        askYourBank: profile.askBank,
        findings: checkSetup(profile, { odfiRoutingNumber: eb.odfiRoutingNumber, immediateOrigin: eb.immediateOrigin, ...(eb.leadBankingDays !== undefined ? { leadBankingDays: eb.leadBankingDays } : {}), ...(eb.limitsTier !== undefined ? { limitsTier: eb.limitsTier } : {}), ...(sftp ? { sftp: { host: sftp.host, port: sftp.port } } : {}) }),
      }
    : undefined;
  return { mode: company.payment.mode, employerBank: { ...rest, ...(api ? { api: { adapter: api.adapter, environment: api.environment, clientId: api.clientId, certThumbprint: api.certThumbprint, debtorAccountLast4: api.debtorAccountLast4, debtorName: api.debtorName, maxFileCents: api.maxFileCents, ...(api.baseUrl ? { baseUrl: api.baseUrl } : {}), ...(api.tokenUrl ? { tokenUrl: api.tokenUrl } : {}), ...(api.audience ? { audience: api.audience } : {}), hasPrivateKey: true as const, authorization: api.authorization } } : {}), ...(sftp ? { sftp: { host: sftp.host, port: sftp.port, username: sftp.username, remoteDir: sftp.remoteDir, knownHostsLine: sftp.knownHostsLine, hasPrivateKey: true } } : {}) }, ...(bank ? { bank } : {}) };
}
