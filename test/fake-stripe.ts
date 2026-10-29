import { StripeError, type StripeAccount, type StripeApi, type StripePaymentIntent, type StripeTransfer } from '../src/money/stripe.ts';

/**
 * An in-memory Stripe. It honours idempotency keys the way Stripe does (the
 * first result for a key is replayed, success or failure) so tests can prove
 * a retry never moves money twice.
 */
export class FakeStripe implements StripeApi {
  balanceCents = 10_000_000;
  /** What a new bank debit does: sit in processing, succeed at once, or be declined. */
  debitOutcome: 'processing' | 'succeeded' | 'declined' = 'processing';
  /** Destinations whose transfer Stripe rejects (a restricted account). */
  rejectTransfersTo = new Set<string>();
  /** The next N transfer calls fail with an unknown outcome, as a dropped connection would. */
  dropNextTransfers = 0;
  /** Set when a dropped call should still have been executed by Stripe (the realistic worst case). */
  dropAfterExecuting = false;

  readonly calls: Array<{ op: string; key?: string; params?: unknown }> = [];
  private readonly byKey = new Map<string, { result?: unknown; error?: StripeError }>();
  readonly transfers: StripeTransfer[] = [];
  readonly intents = new Map<string, StripePaymentIntent>();
  private seq = 0;

  private id(prefix: string) {
    return `${prefix}_${++this.seq}`;
  }

  private idempotent<T>(op: string, key: string, params: unknown, run: () => T): T {
    this.calls.push({ op, key, params });
    const seen = this.byKey.get(key);
    if (seen) {
      if (seen.error) throw seen.error;
      return seen.result as T;
    }
    try {
      const result = run();
      this.byKey.set(key, { result });
      return result;
    } catch (e) {
      if (e instanceof StripeError && e.definitive) this.byKey.set(key, { error: e });
      throw e;
    }
  }

  async createCustomer(p: { name: string }, key: string) {
    return this.idempotent('createCustomer', key, p, () => ({ id: this.id('cus') }));
  }

  async createSetupIntent(p: { customer: string }, key: string) {
    return this.idempotent('createSetupIntent', key, p, () => ({ id: this.id('seti'), client_secret: `seti_secret_${this.seq}` }));
  }

  async retrievePaymentMethod(id: string) {
    this.calls.push({ op: 'retrievePaymentMethod', params: id });
    return { id, us_bank_account: { last4: '6789', bank_name: 'STRIPE TEST BANK' } };
  }

  async createPaymentIntent(p: { amount: number }, key: string) {
    return this.idempotent('createPaymentIntent', key, p, () => {
      if (this.debitOutcome === 'declined') throw new StripeError('Your account has insufficient funds.', 402, { type: 'card_error', code: 'payment_intent_payment_attempt_failed' });
      const pi: StripePaymentIntent = { id: this.id('pi'), status: this.debitOutcome, amount: p.amount, latest_charge: this.id('ch') };
      this.intents.set(pi.id, pi);
      return pi;
    });
  }

  async retrievePaymentIntent(id: string) {
    this.calls.push({ op: 'retrievePaymentIntent', params: id });
    const pi = this.intents.get(id);
    if (!pi) throw new StripeError('No such payment_intent', 404, { type: 'invalid_request_error' });
    return pi;
  }

  /** Settle a processing debit, as the bank would days later. */
  settle(id: string): StripePaymentIntent {
    const pi = this.intents.get(id)!;
    pi.status = 'succeeded';
    return pi;
  }

  async createAccount(p: { metadata: Record<string, string> }, key: string) {
    return this.idempotent('createAccount', key, p, (): StripeAccount => ({ id: this.id('acct') }));
  }

  async createAccountLink(p: { account: string }) {
    this.calls.push({ op: 'createAccountLink', params: p });
    return { url: `https://connect.stripe.test/setup/${p.account}` };
  }

  async retrieveAccount(id: string): Promise<StripeAccount> {
    return { id, payouts_enabled: true, details_submitted: true };
  }

  async createTransfer(p: { amount: number; destination: string }, key: string) {
    if (this.dropNextTransfers > 0 && !this.byKey.has(key)) {
      this.dropNextTransfers -= 1;
      if (this.dropAfterExecuting) this.idempotent('createTransfer', key, p, () => this.executeTransfer(p));
      throw new StripeError('Could not reach Stripe: socket hang up', 0, { type: 'network_error', definitive: false });
    }
    return this.idempotent('createTransfer', key, p, () => this.executeTransfer(p));
  }

  private executeTransfer(p: { amount: number; destination: string }): StripeTransfer {
    if (this.rejectTransfersTo.has(p.destination)) throw new StripeError('Your destination account needs to have at least one of the following capabilities enabled: transfers', 400, { type: 'invalid_request_error' });
    if (p.amount > this.balanceCents) throw new StripeError('Insufficient funds in Stripe account.', 400, { type: 'invalid_request_error', code: 'balance_insufficient' });
    this.balanceCents -= p.amount;
    const t: StripeTransfer = { id: this.id('tr'), amount: p.amount, destination: p.destination };
    this.transfers.push(t);
    return t;
  }

  async availableBalanceCents() {
    this.calls.push({ op: 'availableBalanceCents' });
    return this.balanceCents;
  }
}
