import { StripeError, type FcAccount, type FcPermission, type FcSession, type StripeApi } from '../src/money/stripe.ts';

/**
 * An in-memory Stripe Financial Connections. Tests script what a bank link
 * returns: the accounts a user picked, their owners, their balance.
 */
export class FakeStripe implements StripeApi {
  readonly calls: Array<{ op: string; params?: unknown }> = [];
  private readonly byKey = new Map<string, unknown>();
  readonly sessions = new Map<string, { customer: string; permissions: FcPermission[]; accounts: FcAccount[] }>();
  readonly accounts = new Map<string, FcAccount>();
  /** Owners the bank reports, by account id. Missing means ownership data is unavailable. */
  readonly owners = new Map<string, string[]>();
  private seq = 0;

  private id(prefix: string) {
    return `${prefix}_${++this.seq}`;
  }

  private idempotent<T>(op: string, key: string, params: unknown, run: () => T): T {
    this.calls.push({ op, params });
    if (this.byKey.has(key)) return this.byKey.get(key) as T;
    const r = run();
    this.byKey.set(key, r);
    return r;
  }

  async createCustomer(p: { name: string }, key: string) {
    return this.idempotent('createCustomer', key, p, () => ({ id: this.id('cus') }));
  }

  async createFcSession(p: { customer: string; permissions: FcPermission[] }, key: string) {
    return this.idempotent('createFcSession', key, p, () => {
      const id = this.id('fcsess');
      this.sessions.set(id, { customer: p.customer, permissions: p.permissions, accounts: [] });
      return { id, client_secret: `${id}_secret` };
    });
  }

  /** What the user did in Stripe's UI: linked an account at a bank. */
  link(sessionId: string, over: Partial<FcAccount> & { owners?: string[] } = {}): FcAccount {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error('no such fake session');
    const { owners, ...rest } = over;
    const acct: FcAccount = { id: this.id('fca'), status: 'active', category: 'cash', subcategory: 'checking', last4: '6789', institution_name: 'Test Bank', display_name: 'Checking', account_holder: { type: 'customer', customer: s.customer }, permissions: s.permissions, balance: null, balance_refresh: null, ownership: null, ownership_refresh: null, ...rest };
    s.accounts.push(acct);
    this.accounts.set(acct.id, acct);
    if (owners) this.owners.set(acct.id, owners);
    return acct;
  }

  async retrieveFcSession(id: string): Promise<FcSession> {
    this.calls.push({ op: 'retrieveFcSession', params: id });
    const s = this.sessions.get(id);
    if (!s) throw new StripeError('No such session', 404, { type: 'invalid_request_error' });
    return { id, accounts: { data: s.accounts } };
  }

  async retrieveFcAccount(id: string, opts: { expandOwnership?: boolean } = {}): Promise<FcAccount> {
    this.calls.push({ op: 'retrieveFcAccount', params: { id, ...opts } });
    const a = this.accounts.get(id);
    if (!a) throw new StripeError('No such account', 404, { type: 'invalid_request_error' });
    const owners = this.owners.get(id);
    if (opts.expandOwnership && owners && a.ownership_refresh?.status === 'succeeded') {
      return { ...a, ownership: { owners: { data: owners.map((name) => ({ name })) } } };
    }
    return a;
  }

  async refreshFcAccount(id: string, features: Array<'balance' | 'ownership'>): Promise<FcAccount> {
    this.calls.push({ op: 'refreshFcAccount', params: { id, features } });
    const a = this.accounts.get(id);
    if (!a) throw new StripeError('No such account', 404, { type: 'invalid_request_error' });
    if (features.includes('ownership')) a.ownership_refresh = { status: this.owners.has(id) ? 'succeeded' : 'failed' };
    if (features.includes('balance') && a.balance === null) a.balance_refresh = { status: 'pending' };
    return a;
  }
}
