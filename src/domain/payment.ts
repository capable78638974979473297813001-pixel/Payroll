import { badRequest, forbidden } from '../lib/errors.ts';
import { encryptField } from '../lib/crypto.ts';
import { validateRoutingNumber } from '../../engine/payroll/directDeposit.ts';
import { validateSftp, validateTemplate } from '../ach/sftp.ts';
import * as v from '../lib/validate.ts';
import type { Store } from '../store/store.ts';
import type { Company, EmployerBankSetup, PaymentSetup } from './types.ts';

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
  const leadBankingDays = b.leadBankingDays === undefined ? undefined : v.int(b, 'leadBankingDays', 0, 10);

  const existing = company.payment.employerBank;
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

  const employerBank: EmployerBankSetup = {
    odfiRoutingNumber,
    odfiName: v.str(b, 'odfiName', { max: 60 }),
    immediateOrigin,
    companyId: companyIdValue,
    fileNameTemplate,
    ...(leadBankingDays !== undefined ? { leadBankingDays } : {}),
    ...(sftp ? { sftp } : {}),
  };
  return store.tx(() => store.companies.put({ ...company, payment: { mode, employerBank } }));
}

/** What a caller may see: never the private key. */
export function paymentSetupView(company: Company) {
  const eb = company.payment.employerBank;
  if (!eb) return { mode: company.payment.mode };
  const { sftp, ...rest } = eb;
  return { mode: company.payment.mode, employerBank: { ...rest, ...(sftp ? { sftp: { host: sftp.host, port: sftp.port, username: sftp.username, remoteDir: sftp.remoteDir, knownHostsLine: sftp.knownHostsLine, hasPrivateKey: true } } : {}) } };
}
