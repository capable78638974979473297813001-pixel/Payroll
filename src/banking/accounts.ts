import { newId } from '../lib/ids.ts';
import { badRequest, conflict, forbidden } from '../lib/errors.ts';
import { decryptField, encryptField } from '../lib/crypto.ts';
import { validateRoutingNumber } from '../../engine/payroll/directDeposit.ts';
import type { Store } from '../store/store.ts';
import type { BankAccount, BankLink, Company, Employee } from '../domain/types.ts';
import { StripeError, type FcAccount, type FcPermission, type StripeApi } from '../money/stripe.ts';
import { ownerNamesMatch } from './names.ts';

/**
 * Bank accounts: linking, verifying, and keeping the numbers.
 *
 * Stripe Financial Connections proves the account holder can log in to the
 * bank and reports the account's last four digits, its owners and its
 * balance. Totali then holds the full account number (encrypted) and
 * originates the ACH itself, so the number is entered by the account holder
 * and accepted only if it agrees with what Stripe confirmed:
 *
 *   - the session was started by Totali for this owner, and not used before
 *   - the linked account belongs to that owner's Stripe customer
 *   - it is an active checking or savings account
 *   - the number's last four digits equal the account's last four digits
 *   - the routing number passes its checksum
 *   - the bank's reported owners match the expected name (company or employee)
 *
 * An employee who has no bank login to link can enter an account manually.
 * It is held until a zero-dollar prenote has gone through the ACH network
 * and come back clean.
 */

export interface BankOptions {
  now?: () => Date;
  /** Hours a balance from the bank stays usable for the pre-debit check. */
  maxBalanceAgeHours?: number;
}

function digits(label: string, v: unknown, min: number, max: number): string {
  if (typeof v !== 'string' || !new RegExp(`^\\d{${min},${max}}$`).test(v)) throw badRequest(`${label} must be ${min === max ? min : `${min} to ${max}`} digits`);
  return v;
}

export function bankAccountView(a: BankAccount) {
  const { accountNumberEncrypted: _n, ...rest } = a;
  return rest;
}

export function numbersFor(a: BankAccount): { routingNumber: string; accountNumber: string } {
  return { routingNumber: a.routingNumber, accountNumber: decryptField(a.accountNumberEncrypted) };
}

/** Is this employee ready to be paid by direct deposit? Every account their split uses must be active. */
export function payoutReadiness(store: Store, employee: Employee): { ready: boolean; reason?: string } {
  if (employee.payoutAccounts.length === 0) return { ready: false, reason: 'no bank account on file' };
  for (const p of employee.payoutAccounts) {
    const a = store.bankAccounts.get(p.bankAccountId);
    if (!a) return { ready: false, reason: 'a bank account on file no longer exists' };
    if (a.status !== 'active') return { ready: false, reason: `a bank account ending ${a.last4} is ${a.status}${a.disabledReason ? ` (${a.disabledReason})` : ''}` };
  }
  return { ready: true };
}

export class BankService {
  private readonly store: Store;
  private readonly stripe: StripeApi;
  private readonly now: () => Date;
  private readonly maxBalanceAgeHours: number;

  constructor(store: Store, stripe: StripeApi, opts: BankOptions = {}) {
    this.store = store;
    this.stripe = stripe;
    this.now = opts.now ?? (() => new Date());
    this.maxBalanceAgeHours = opts.maxBalanceAgeHours ?? 24;
  }

  private ownerOf(companyId: string, owner: { kind: 'company' } | { kind: 'employee'; employeeId: string }): { id: string; name: string; customerId?: string; save: (customerId: string) => void } {
    const company = this.store.companies.require(companyId, 'Company');
    if (owner.kind === 'company') {
      return { id: company.id, name: company.legalName, customerId: company.stripeCustomerId, save: (customerId) => this.store.tx(() => this.store.companies.put({ ...this.store.companies.require(companyId, 'Company'), stripeCustomerId: customerId })) };
    }
    const e = this.store.employees.get(owner.employeeId);
    if (!e || e.companyId !== companyId) throw badRequest('Employee is not at this company');
    return { id: e.id, name: `${e.firstName} ${e.lastName}`, customerId: e.stripeCustomerId, save: (customerId) => this.store.tx(() => this.store.employees.put({ ...this.store.employees.require(owner.employeeId, 'Employee'), stripeCustomerId: customerId })) };
  }

  /** Start a Stripe bank-link session. The returned client secret is handed to Stripe.js in the browser. */
  async startLink(companyId: string, owner: { kind: 'company' } | { kind: 'employee'; employeeId: string }): Promise<{ sessionId: string; clientSecret: string; permissions: FcPermission[] }> {
    const o = this.ownerOf(companyId, owner);
    let customerId = o.customerId;
    if (!customerId) {
      customerId = (await this.stripe.createCustomer({ name: o.name, metadata: { totali_owner: o.id, totali_company: companyId } }, `totali_cus_${o.id}`)).id;
      o.save(customerId);
    }
    // The company's funding account also asks for its balance, so a debit that would bounce can be caught first. Everyone is asked for ownership.
    const permissions: FcPermission[] = owner.kind === 'company' ? ['balances', 'ownership'] : ['ownership'];
    const session = await this.stripe.createFcSession({ customer: customerId, permissions, prefetch: permissions as Array<'balances' | 'ownership'> }, `totali_fcs_${o.id}_${newId("n")}`);
    const link: BankLink = { id: session.id, companyId, ownerKind: owner.kind, ownerId: o.id, customerId, permissions, createdAt: this.now().toISOString() };
    this.store.tx(() => this.store.bankLinks.put(link));
    return { sessionId: session.id, clientSecret: session.client_secret, permissions };
  }

  /** Read who the bank says owns the account, asking Stripe to refresh when nothing is there yet. A re-check (force) asks again unless a refresh is already running. */
  private async readOwnership(fc: FcAccount, permissions: string[], force = false): Promise<{ names: string[]; account: FcAccount }> {
    let account = await this.stripe.retrieveFcAccount(fc.id, { expandOwnership: true });
    const owners = (a: FcAccount) => (typeof a.ownership === 'object' && a.ownership?.owners?.data ? a.ownership.owners.data.map((o) => o.name ?? '').filter(Boolean) : []);
    let names = owners(account);
    if (names.length === 0 && permissions.includes('ownership') && (force ? account.ownership_refresh?.status !== 'pending' : !account.ownership_refresh)) {
      try {
        await this.stripe.refreshFcAccount(fc.id, ['ownership']);
        account = await this.stripe.retrieveFcAccount(fc.id, { expandOwnership: true });
        names = owners(account);
      } catch (e) {
        if (!(e instanceof StripeError)) throw e; // Stripe could not refresh now; ownership stays unavailable and can be re-checked
      }
    }
    return { names, account };
  }

  /** Apply the activation policy to the facts. */
  private decide(ownerKind: 'company' | 'employee', ownership: 'match' | 'mismatch' | 'unavailable'): Pick<BankAccount, 'verification' | 'status'> {
    const at = this.now().toISOString();
    if (ownership === 'match') return { verification: { method: 'bank_link', status: 'verified', verifiedAt: at }, status: 'active' };
    if (ownership === 'mismatch') return { verification: { method: 'bank_link', status: 'failed', reason: 'The bank reports owners whose names do not match.' }, status: 'pending' };
    if (ownerKind === 'employee') return { verification: { method: 'prenote', status: 'pending', reason: 'The bank did not report the account owners; a zero-dollar prenote will verify the account.' }, status: 'pending' };
    return { verification: { method: 'bank_link', status: 'pending', reason: 'The bank did not report the account owners yet. Re-check the link, or have Totali staff verify the account.' }, status: 'pending' };
  }

  async completeLink(companyId: string, input: { sessionId: string; fcAccountId?: string; routingNumber: string; accountNumber: string }): Promise<BankAccount> {
    const routing = digits('routingNumber', input.routingNumber, 9, 9);
    if (!validateRoutingNumber(routing)) throw badRequest('That routing number is not valid (its check digit fails). Check it and try again.');
    const account = digits('accountNumber', input.accountNumber, 4, 17);

    const link = this.store.bankLinks.get(input.sessionId);
    if (!link || link.companyId !== companyId) throw badRequest('Unknown bank-link session');
    if (link.completedAt) throw conflict('link_already_used', 'That bank-link session has already been used.');

    const session = await this.stripe.retrieveFcSession(link.id);
    const accounts = session.accounts?.data ?? [];
    if (accounts.length === 0) throw conflict('link_not_finished', 'No account has been linked in this session yet.');
    let fc: FcAccount | undefined;
    if (input.fcAccountId) fc = accounts.find((a) => a.id === input.fcAccountId);
    else if (accounts.length === 1) fc = accounts[0];
    else throw badRequest('Several accounts were linked. Say which one with fcAccountId.', { accounts: accounts.map((a) => ({ id: a.id, last4: a.last4, institution: a.institution_name, type: a.subcategory })) });
    if (!fc) throw badRequest('That account was not linked in this session');

    if (fc.status !== 'active') throw conflict('link_inactive', `The linked account is ${fc.status}. Link it again.`);
    if (fc.category !== 'cash' || (fc.subcategory !== 'checking' && fc.subcategory !== 'savings')) throw badRequest('Only checking and savings accounts can be used for payroll.');
    if (fc.account_holder?.customer && fc.account_holder.customer !== link.customerId) throw forbidden('That linked account belongs to someone else.');
    if (!fc.last4) throw conflict('last4_unavailable', 'The bank did not report the last four digits, so the account number cannot be checked.');
    if (fc.last4 !== account.slice(-4)) throw badRequest('The account number you entered does not end in the same four digits as the account you linked.');
    if (this.store.bankAccounts.where((a) => a.link?.fcAccountId === fc!.id && a.status !== 'disabled').length > 0) throw conflict('account_exists', 'That bank account is already set up.');

    const { names, account: fcFull } = await this.readOwnership(fc, link.permissions);
    const expected = link.ownerKind === 'company' ? this.store.companies.require(companyId, 'Company').legalName : (() => { const e = this.store.employees.require(link.ownerId, 'Employee'); return `${e.firstName} ${e.lastName}`; })();
    const ownership = ownerNamesMatch(expected, names);

    let balanceCents: number | undefined;
    let balanceAsOf: string | undefined;
    if (link.ownerKind === 'company' && link.permissions.includes('balances')) {
      let acct = fcFull;
      if (!acct.balance) {
        try {
          acct = await this.stripe.refreshFcAccount(fc.id, ['balance']);
        } catch (e) {
          if (!(e instanceof StripeError)) throw e;
        }
      }
      const cents = acct.balance?.cash?.available?.usd ?? acct.balance?.current?.usd;
      if (cents !== undefined && acct.balance?.as_of) {
        balanceCents = cents;
        balanceAsOf = new Date(acct.balance.as_of * 1000).toISOString();
      }
    }

    const numberType = fcFull.account_numbers?.[0]?.identifier_type;
    const decided = this.decide(link.ownerKind, ownership);
    const created: BankAccount = {
      id: newId('bank'),
      companyId,
      ownerKind: link.ownerKind,
      ownerId: link.ownerId,
      holderType: link.ownerKind === 'company' ? 'business' : 'individual',
      accountType: fc.subcategory as 'checking' | 'savings',
      routingNumber: routing,
      accountNumberEncrypted: encryptField(account),
      last4: account.slice(-4),
      ...(fc.institution_name ? { institutionName: fc.institution_name } : {}),
      link: {
        provider: 'stripe_financial_connections',
        sessionId: link.id,
        fcAccountId: fc.id,
        linkedAt: this.now().toISOString(),
        ownerNames: names,
        ownership,
        stripeNumberType: numberType === 'account_number' ? 'permanent' : numberType === 'tokenized_account_number' ? 'tokenized' : 'none',
        ...(balanceCents !== undefined ? { balanceCents, balanceAsOf } : {}),
      },
      ...decided,
      createdAt: this.now().toISOString(),
    };
    this.store.tx(() => {
      this.store.bankAccounts.put(created);
      this.store.bankLinks.put({ ...link, completedAt: this.now().toISOString() });
    });
    return created;
  }

  /** An employee's account entered without a bank login. Held until a prenote clears. */
  addManualAccount(companyId: string, input: { employeeId: string; routingNumber: string; accountNumber: string; accountType: 'checking' | 'savings' }): BankAccount {
    const routing = digits('routingNumber', input.routingNumber, 9, 9);
    if (!validateRoutingNumber(routing)) throw badRequest('That routing number is not valid (its check digit fails). Check it and try again.');
    const account = digits('accountNumber', input.accountNumber, 4, 17);
    const e = this.store.employees.get(input.employeeId);
    if (!e || e.companyId !== companyId) throw badRequest('Employee is not at this company');
    if (input.accountType !== 'checking' && input.accountType !== 'savings') throw badRequest('accountType must be checking or savings');
    const created: BankAccount = {
      id: newId('bank'),
      companyId,
      ownerKind: 'employee',
      ownerId: e.id,
      holderType: 'individual',
      accountType: input.accountType,
      routingNumber: routing,
      accountNumberEncrypted: encryptField(account),
      last4: account.slice(-4),
      verification: { method: 'prenote', status: 'pending', reason: 'Entered without a bank login; a zero-dollar prenote will verify the account.' },
      status: 'pending',
      createdAt: this.now().toISOString(),
    };
    return this.store.tx(() => this.store.bankAccounts.put(created));
  }

  /** Ask the bank again who owns the account and what it holds, and re-apply the activation policy. */
  async refreshLink(companyId: string, bankAccountId: string): Promise<BankAccount> {
    const acct = this.require(companyId, bankAccountId);
    if (!acct.link) throw badRequest('This account was not linked through a bank login');
    const permissions = ['ownership', ...(acct.ownerKind === 'company' ? ['balances'] : [])];
    const { names, account: fc } = await this.readOwnership({ id: acct.link.fcAccountId } as FcAccount, permissions, true);
    const expected = acct.ownerKind === 'company' ? this.store.companies.require(companyId, 'Company').legalName : (() => { const e = this.store.employees.require(acct.ownerId, 'Employee'); return `${e.firstName} ${e.lastName}`; })();
    const ownership = names.length ? ownerNamesMatch(expected, names) : acct.link.ownership;
    const next: BankAccount = { ...acct, link: { ...acct.link, ownerNames: names.length ? names : acct.link.ownerNames, ownership } };
    if (fc.status !== 'active' && next.status === 'active') {
      next.status = 'disabled';
      next.disabledReason = `The bank link is ${fc.status}`;
    }
    const cents = fc.balance?.cash?.available?.usd ?? fc.balance?.current?.usd;
    if (cents !== undefined && fc.balance?.as_of) next.link = { ...next.link!, balanceCents: cents, balanceAsOf: new Date(fc.balance.as_of * 1000).toISOString() };
    if (acct.status === 'pending' && acct.verification.method === 'bank_link') Object.assign(next, this.decide(acct.ownerKind, ownership));
    return this.store.tx(() => this.store.bankAccounts.put(next));
  }

  disable(companyId: string, bankAccountId: string, reason: string): BankAccount {
    const acct = this.require(companyId, bankAccountId);
    return this.store.tx(() => this.store.bankAccounts.put({ ...acct, status: 'disabled', disabledReason: reason }));
  }

  /** Totali staff verified the account some other way (for example by calling the owner). Always leaves a reason on the record. */
  adminActivate(companyId: string, bankAccountId: string, reason: string): BankAccount {
    if (!reason.trim()) throw badRequest('A reason is required');
    const acct = this.require(companyId, bankAccountId);
    return this.store.tx(() => this.store.bankAccounts.put({ ...acct, status: 'active', disabledReason: undefined, verification: { ...acct.verification, status: 'verified', verifiedAt: this.now().toISOString(), reason: `Verified by Totali staff: ${reason.trim()}` } }));
  }

  require(companyId: string, bankAccountId: string): BankAccount {
    const a = this.store.bankAccounts.get(bankAccountId);
    if (!a || a.companyId !== companyId) throw badRequest('Bank account is not at this company');
    return a;
  }

  /**
   * Before debiting the employer, look at the balance the bank last reported.
   * A fresh balance below the debit blocks it. A stale or missing balance does
   * not: the check says so, and the debit goes ahead unchecked.
   */
  async checkBalance(account: BankAccount, amountCents: number): Promise<{ checked: boolean; balanceCents?: number; note: string }> {
    if (!account.link || !account.link.fcAccountId) return { checked: false, note: 'The account has no bank link, so its balance cannot be read.' };
    let fc: FcAccount;
    try {
      fc = await this.stripe.retrieveFcAccount(account.link.fcAccountId);
    } catch (e) {
      if (e instanceof StripeError) return { checked: false, note: `The balance could not be read from Stripe: ${e.message}` };
      throw e;
    }
    const cents = fc.balance?.cash?.available?.usd ?? fc.balance?.current?.usd;
    const asOfMs = fc.balance?.as_of ? fc.balance.as_of * 1000 : undefined;
    const fresh = asOfMs !== undefined && this.now().getTime() - asOfMs <= this.maxBalanceAgeHours * 3_600_000;
    if (cents === undefined || !fresh) {
      try {
        await this.stripe.refreshFcAccount(account.link.fcAccountId, ['balance']);
      } catch (e) {
        if (!(e instanceof StripeError)) throw e;
      }
      return { checked: false, note: 'No recent balance is available from the bank. A refresh was requested. The debit was not balance-checked.' };
    }
    if (cents < amountCents) throw conflict('insufficient_employer_balance', `The employer's bank account shows ${cents}¢ available (as of ${new Date(asOfMs).toISOString()}), less than the ${amountCents}¢ this payroll needs. Nothing was debited.`, { balanceCents: cents, neededCents: amountCents });
    return { checked: true, balanceCents: cents, note: `The bank showed ${cents}¢ available as of ${new Date(asOfMs).toISOString()}.` };
  }
}

export type { Company, Employee };
