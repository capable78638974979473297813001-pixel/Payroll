import { badRequest, conflict } from '../lib/errors.ts';
import type { Store } from '../store/store.ts';
import type { BankAccount, Company, DebitAuthorization } from '../domain/types.ts';

/**
 * The employer's written authorisation for Totali to debit their account.
 * NACHA requires an authorisation, readily provable, for every ACH debit.
 * Totali records who accepted which text, for which account, when and from
 * where. The wording below is a starting draft: have counsel review it, and
 * bump the version whenever it changes.
 */
export const DEBIT_AUTHORIZATION_VERSION = 'draft-1';

export function debitAuthorizationText(company: Pick<Company, 'legalName'>, account: Pick<BankAccount, 'last4' | 'accountType' | 'institutionName'>): string {
  const bank = account.institutionName ? ` at ${account.institutionName}` : '';
  return [
    `${company.legalName} ("you") authorizes Totali to initiate ACH debit entries to your ${account.accountType} account ending ${account.last4}${bank}, and your bank to debit that account, in the amount of each payroll you approve in Totali.`,
    'Each debit covers the net pay, employee tax withholdings, employer payroll taxes and deductions for that payroll, and is shown to you before you approve it.',
    'This authorization stays in effect until you revoke it by written notice to Totali, which must reach Totali early enough for Totali to act on it before the next debit. Revoking it does not cancel a payroll that has already been debited.',
    'If a debit is returned for any reason, you remain responsible for the amount and for any payments Totali has already made to your employees from it.',
    'You confirm you are authorized to bind the business and to authorize debits to this account, and that it is a business account.',
  ].join('\n\n');
}

export function recordDebitAuthorization(store: Store, companyId: string, input: { bankAccountId: string; acceptedBy: string; accept: boolean; ip?: string; now?: Date }): DebitAuthorization {
  if (input.accept !== true) throw badRequest('accept must be true. The authorisation text has to be shown and accepted.');
  if (!input.acceptedBy.trim()) throw badRequest('acceptedBy is required: the name of the person accepting for the business');
  const company = store.companies.require(companyId, 'Company');
  const account = store.bankAccounts.get(input.bankAccountId);
  if (!account || account.companyId !== companyId || account.ownerKind !== 'company') throw badRequest("That is not one of this company's own bank accounts");
  if (account.status !== 'active') throw conflict('bank_account_not_active', `That bank account is ${account.status}. It must be verified before it can be authorized for debits.`);
  if (account.holderType !== 'business') throw conflict('consumer_account', 'Payroll debits are only supported from business accounts.');
  const auth: DebitAuthorization = { bankAccountId: account.id, acceptedAt: (input.now ?? new Date()).toISOString(), acceptedBy: input.acceptedBy.trim(), textVersion: DEBIT_AUTHORIZATION_VERSION, ...(input.ip ? { ip: input.ip } : {}) };
  store.tx(() => store.companies.put({ ...company, funding: { bankAccountId: account.id, debitAuthorization: auth } }));
  return auth;
}

/** Choose the account payroll is debited from. Changing it clears the authorisation: a new account needs its own. */
export function setFundingAccount(store: Store, companyId: string, bankAccountId: string): Company {
  const company = store.companies.require(companyId, 'Company');
  const account = store.bankAccounts.get(bankAccountId);
  if (!account || account.companyId !== companyId || account.ownerKind !== 'company') throw badRequest("That is not one of this company's own bank accounts");
  if (account.holderType !== 'business') throw conflict('consumer_account', 'Payroll debits are only supported from business accounts.');
  const keep = company.funding.bankAccountId === bankAccountId ? company.funding.debitAuthorization : undefined;
  return store.tx(() => store.companies.put({ ...company, funding: { bankAccountId, ...(keep ? { debitAuthorization: keep } : {}) } }));
}
