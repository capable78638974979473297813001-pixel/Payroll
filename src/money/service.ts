import { newId } from '../lib/ids.ts';
import { badRequest, conflict } from '../lib/errors.ts';
import type { Store } from '../store/store.ts';
import type { Employee, MoneyLeg, PayRun } from '../domain/types.ts';
import { getRun } from '../payroll/payRuns.ts';
import { postEntry } from './ledger.ts';
import { StripeError, type StripeApi, type StripeAccount, type StripePaymentIntent } from './stripe.ts';

/**
 * Money movement through Stripe, as a state machine:
 *
 *   approved --fund--> funding --(payment_intent.succeeded)--> funded --disburse--> disbursing --> completed
 *
 * Rules the code holds to:
 *  - Nothing is paid out before the employer's debit has SUCCEEDED, and then
 *    only after a hold (ACH debits can still be returned for a short while).
 *  - A leg is written to the store BEFORE its Stripe call, with a stable
 *    idempotency key, so a crash or a retry can never create a second transfer.
 *  - A leg is "succeeded" only when Stripe says so. A network failure leaves it
 *    pending; the next call resumes with the same key.
 *  - Employee transfers are sized by the approved run, never recomputed.
 *  - Every state change that moves a balance posts a balanced ledger entry in the same transaction.
 */

export interface MoneyOptions {
  /** Hours to wait after the debit succeeds before paying employees. Covers ACH returns. */
  holdHours: number;
  now?: () => Date;
}

export interface StripeEvent {
  id: string;
  type: string;
  account?: string;
  data: { object: Record<string, any> };
}

const isOpenLeg = (l: MoneyLeg) => l.status === 'pending' || l.status === 'created' || l.status === 'processing';

export class MoneyService {
  private readonly store: Store;
  private readonly stripe: StripeApi;
  private readonly holdHours: number;
  private readonly now: () => Date;
  private readonly inflight = new Set<string>();

  constructor(store: Store, stripe: StripeApi, opts: MoneyOptions) {
    this.store = store;
    this.stripe = stripe;
    this.holdHours = opts.holdHours;
    this.now = opts.now ?? (() => new Date());
  }

  // ------------------------------------------------------------------ onboarding

  /** Create the Stripe customer and a SetupIntent the front end completes with Stripe.js (Financial Connections) to link the employer's bank. */
  async setupCompanyFunding(companyId: string): Promise<{ customerId: string; setupIntentId: string; clientSecret: string }> {
    const company = this.store.companies.require(companyId, 'Company');
    let customerId = company.funding.stripeCustomerId;
    if (!customerId) {
      const c = await this.stripe.createCustomer({ name: company.legalName, metadata: { company_id: company.id } }, `totali_cus_${company.id}`);
      customerId = c.id;
      this.store.tx(() => this.store.companies.put({ ...company, funding: { ...company.funding, stripeCustomerId: customerId, status: company.funding.status === 'ready' ? 'ready' : 'pending' } }));
    }
    const si = await this.stripe.createSetupIntent({ customer: customerId, metadata: { company_id: company.id } }, `totali_si_${company.id}_${this.now().getTime()}`);
    return { customerId, setupIntentId: si.id, clientSecret: si.client_secret };
  }

  /** Create (once) the employee's Stripe connected account and a hosted onboarding link where they enter their own bank details. Totali never sees them. */
  async startEmployeePayoutOnboarding(companyId: string, employeeId: string, urls: { returnUrl: string; refreshUrl: string }): Promise<{ url: string; accountId: string }> {
    for (const u of [urls.returnUrl, urls.refreshUrl]) {
      let parsed: URL;
      try {
        parsed = new URL(u);
      } catch {
        throw badRequest('returnUrl and refreshUrl must be absolute URLs');
      }
      if (parsed.protocol !== 'https:' && !(parsed.hostname === 'localhost' && !process.env.STRIPE_SECRET_KEY?.startsWith('sk_live_'))) {
        throw badRequest('returnUrl and refreshUrl must be https URLs');
      }
    }
    const employee = this.store.employees.get(employeeId);
    if (!employee || employee.companyId !== companyId) throw badRequest('Employee is not at this company');
    let accountId = employee.payout.stripeAccountId;
    if (!accountId) {
      const acct = await this.stripe.createAccount({ ...(employee.email ? { email: employee.email } : {}), metadata: { company_id: companyId, employee_id: employeeId } }, `totali_acct_${employeeId}`);
      accountId = acct.id;
      this.store.tx(() => this.store.employees.put({ ...employee, payout: { ...employee.payout, stripeAccountId: acct.id, status: 'onboarding' } }));
    }
    const link = await this.stripe.createAccountLink({ account: accountId, returnUrl: urls.returnUrl, refreshUrl: urls.refreshUrl });
    return { url: link.url, accountId };
  }

  // ------------------------------------------------------------------ funding

  /**
   * Debit the employer's linked bank for everything the run needs: net pay,
   * taxes withheld, employer taxes and deductions held. Safe to call again
   * after a crash: it resumes the open leg with the same idempotency key.
   */
  async fundPayRun(companyId: string, runId: string): Promise<{ run: PayRun; leg: MoneyLeg }> {
    const run = getRun(this.store, companyId, runId);
    const company = this.store.companies.require(companyId, 'Company');
    if (run.status !== 'approved' && run.status !== 'funding') throw conflict('not_fundable', `Only an approved run can be funded; this run is ${run.status}.`);
    if (company.funding.status !== 'ready' || !company.funding.paymentMethodId || !company.funding.stripeCustomerId) {
      throw conflict('funding_not_ready', "This company's bank account is not linked yet. Complete funding setup first.");
    }
    const amount = run.totals.fundingRequiredCents;
    if (amount <= 0) throw conflict('nothing_to_fund', 'This run has nothing to fund.');

    const leg = this.store.tx(() => {
      const existing = this.store.legs.where((l) => l.runId === runId && l.kind === 'funding').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (existing && (isOpenLeg(existing) || existing.status === 'succeeded')) return existing;
      const attempt = (existing?.attempt ?? 0) + 1;
      const fresh: MoneyLeg = { id: newId('leg'), companyId, runId, kind: 'funding', amountCents: amount, idempotencyKey: `totali_fund_${runId}_a${attempt}`, attempt, status: 'pending', createdAt: this.now().toISOString(), updatedAt: this.now().toISOString() };
      this.store.legs.put(fresh);
      this.store.payRuns.put({ ...run, status: 'funding' });
      return fresh;
    });
    if (leg.status === 'succeeded') return { run: getRun(this.store, companyId, runId), leg };

    try {
      const pi = leg.stripeObjectId
        ? await this.stripe.retrievePaymentIntent(leg.stripeObjectId)
        : await this.stripe.createPaymentIntent(
            { amount: leg.amountCents, customer: company.funding.stripeCustomerId, paymentMethod: company.funding.paymentMethodId, transferGroup: runId, description: `Totali payroll ${run.periodStart} to ${run.periodEnd}`, metadata: { run_id: runId, leg_id: leg.id, company_id: companyId } },
            leg.idempotencyKey,
          );
      this.applyPaymentIntent(leg.id, pi);
    } catch (e) {
      if (e instanceof StripeError && e.definitive) this.failFundingLeg(leg.id, e.message);
      else throw e; // outcome unknown: the leg stays open and a retry resumes with the same key
    }
    return { run: getRun(this.store, companyId, runId), leg: this.store.legs.require(leg.id, 'Leg') };
  }

  private applyPaymentIntent(legId: string, pi: StripePaymentIntent): void {
    const leg = this.store.legs.require(legId, 'Leg');
    if (pi.amount !== leg.amountCents) {
      this.store.tx(() => {
        this.store.legs.put({ ...leg, status: 'failed', stripeObjectId: pi.id, failureMessage: `Stripe amount ${pi.amount} does not match the run's ${leg.amountCents}`, updatedAt: this.now().toISOString() });
        this.alert(leg.runId, 'funding_amount_mismatch', `Stripe reports ${pi.amount}¢ for a ${leg.amountCents}¢ funding leg. Not treated as funded.`);
      });
      return;
    }
    if (pi.status === 'succeeded') return this.onFundingSucceeded(legId, pi);
    if (pi.status === 'processing' || pi.status === 'requires_capture') {
      this.store.tx(() => this.store.legs.put({ ...leg, status: 'processing', stripeObjectId: pi.id, ...(pi.latest_charge ? { stripeChargeId: pi.latest_charge } : {}), updatedAt: this.now().toISOString() }));
      return;
    }
    if (pi.status === 'canceled' || pi.status === 'requires_payment_method' || pi.status === 'requires_action' || pi.status === 'requires_confirmation') {
      this.failFundingLeg(legId, pi.last_payment_error?.message ?? `The bank debit needs attention (${pi.status}).`, pi.id);
    }
  }

  private onFundingSucceeded(legId: string, pi: StripePaymentIntent): void {
    this.store.tx(() => {
      const leg = this.store.legs.require(legId, 'Leg');
      if (leg.status === 'succeeded') return;
      const run = this.store.payRuns.require(leg.runId, 'Pay run');
      const t = run.totals;
      const sum = t.payableCents + t.employeeTaxCents + t.employerTaxCents + t.deductionsCents;
      if (sum !== leg.amountCents) throw new Error(`Run ${run.id} funding ${leg.amountCents} does not equal its obligations ${sum}`);
      this.store.legs.put({ ...leg, status: 'succeeded', stripeObjectId: pi.id, ...(pi.latest_charge ? { stripeChargeId: pi.latest_charge } : {}), updatedAt: this.now().toISOString() });
      postEntry(this.store, {
        companyId: leg.companyId,
        runId: run.id,
        legId: leg.id,
        memo: `Employer debit collected for pay run ${run.periodStart} to ${run.periodEnd}`,
        lines: [
          { account: 'stripe_cash', debitCents: leg.amountCents },
          { account: 'employee_net_pay', creditCents: t.payableCents },
          { account: 'tax_withheld', creditCents: t.employeeTaxCents },
          { account: 'tax_employer', creditCents: t.employerTaxCents },
          { account: 'deductions_held', creditCents: t.deductionsCents },
        ],
      });
      this.store.payRuns.put({ ...run, status: run.status === 'completed' ? run.status : 'funded', fundedAt: this.now().toISOString() });
    });
  }

  private failFundingLeg(legId: string, message: string, stripeId?: string): void {
    this.store.tx(() => {
      const leg = this.store.legs.require(legId, 'Leg');
      if (leg.status === 'succeeded' || leg.status === 'failed') return;
      this.store.legs.put({ ...leg, status: 'failed', ...(stripeId ? { stripeObjectId: stripeId } : {}), failureMessage: message, updatedAt: this.now().toISOString() });
      const run = this.store.payRuns.require(leg.runId, 'Pay run');
      if (run.status === 'funding') this.store.payRuns.put({ ...run, status: 'approved' }); // back to approved: fix the bank, then fund again
    });
  }

  // ------------------------------------------------------------------ disbursement

  /**
   * Pay each employee by Stripe transfer to their connected account. Only
   * after the debit has succeeded and the hold has passed. Idempotent: call
   * it again to retry failed legs or to pay employees who finished onboarding late.
   */
  async disbursePayRun(companyId: string, runId: string): Promise<{
    status: PayRun['status'];
    paid: Array<{ employeeId: string; amountCents: number }>;
    failed: Array<{ employeeId: string; message: string }>;
    pending: string[];
    waitingForBankAccount: Array<{ employeeId: string; amountCents: number }>;
  }> {
    const run = getRun(this.store, companyId, runId);
    if (run.status !== 'funded' && run.status !== 'disbursing') throw conflict('not_funded', `Employees are paid only from a funded run; this run is ${run.status}.`);
    if (!run.fundedAt) throw conflict('not_funded', 'This run has no recorded funding time, so the payout hold cannot be checked. Nothing was sent.');
    const releaseAt = new Date(Date.parse(run.fundedAt) + this.holdHours * 3_600_000);
    if (this.now() < releaseAt) throw conflict('funds_on_hold', `The employer's debit can still be returned by the bank. Pay-out opens at ${releaseAt.toISOString()}.`, { releaseAt: releaseAt.toISOString() });
    if (this.inflight.has(runId)) throw conflict('disbursement_in_progress', 'A disbursement for this run is already running.');
    this.inflight.add(runId);
    try {
      return await this.disburseLocked(run);
    } finally {
      this.inflight.delete(runId);
    }
  }

  private async disburseLocked(run: PayRun) {
    const waiting: Array<{ employeeId: string; amountCents: number }> = [];
    const legIds: string[] = this.store.tx(() => {
      const ids: string[] = [];
      for (const pc of run.paychecks.filter((p) => p.payableCents > 0)) {
        const employee = this.store.employees.require(pc.employeeId, 'Employee');
        const existing = this.store.legs.where((l) => l.runId === run.id && l.kind === 'employee_payout' && l.employeeId === pc.employeeId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        if (existing?.status === 'succeeded') continue;
        if (existing && isOpenLeg(existing)) {
          ids.push(existing.id);
          continue;
        }
        if (employee.payout.status !== 'ready' || !employee.payout.stripeAccountId) {
          waiting.push({ employeeId: pc.employeeId, amountCents: pc.payableCents });
          continue;
        }
        const attempt = (existing?.attempt ?? 0) + 1;
        const leg: MoneyLeg = { id: newId('leg'), companyId: run.companyId, runId: run.id, kind: 'employee_payout', employeeId: pc.employeeId, amountCents: pc.payableCents, idempotencyKey: `totali_payout_${run.id}_${pc.employeeId}_a${attempt}`, attempt, status: 'pending', createdAt: this.now().toISOString(), updatedAt: this.now().toISOString() };
        this.store.legs.put(leg);
        ids.push(leg.id);
      }
      this.store.payRuns.put({ ...this.store.payRuns.require(run.id, 'Pay run'), status: 'disbursing' });
      return ids;
    });

    const needed = legIds.reduce((a, id) => a + this.store.legs.require(id, 'Leg').amountCents, 0);
    if (needed > 0) {
      const available = await this.stripe.availableBalanceCents();
      if (available < needed) throw conflict('insufficient_stripe_balance', `Stripe's available balance (${available}¢) is below what this disbursement needs (${needed}¢). Nothing was sent.`, { availableCents: available, neededCents: needed });
    }

    const paid: Array<{ employeeId: string; amountCents: number }> = [];
    const failed: Array<{ employeeId: string; message: string }> = [];
    const pending: string[] = [];
    for (const id of legIds) {
      const leg = this.store.legs.require(id, 'Leg');
      const employee = this.store.employees.require(leg.employeeId!, 'Employee');
      try {
        const t = await this.stripe.createTransfer(
          { amount: leg.amountCents, destination: employee.payout.stripeAccountId!, transferGroup: run.id, description: `Payroll ${run.periodStart} to ${run.periodEnd}`, metadata: { run_id: run.id, leg_id: leg.id, employee_id: employee.id } },
          leg.idempotencyKey,
        );
        if (t.amount !== leg.amountCents) throw new Error(`Stripe transferred ${t.amount}¢ for a ${leg.amountCents}¢ leg`);
        this.store.tx(() => {
          const fresh = this.store.legs.require(id, 'Leg');
          if (fresh.status === 'succeeded') return;
          this.store.legs.put({ ...fresh, status: 'succeeded', stripeObjectId: t.id, updatedAt: this.now().toISOString() });
          postEntry(this.store, { companyId: run.companyId, runId: run.id, legId: id, memo: `Net pay transferred to ${employee.firstName} ${employee.lastName}`, lines: [{ account: 'employee_net_pay', debitCents: leg.amountCents }, { account: 'stripe_cash', creditCents: leg.amountCents }] });
        });
        paid.push({ employeeId: employee.id, amountCents: leg.amountCents });
      } catch (e) {
        if (e instanceof StripeError && e.definitive) {
          this.store.tx(() => this.store.legs.put({ ...this.store.legs.require(id, 'Leg'), status: 'failed', failureMessage: e.message, updatedAt: this.now().toISOString() }));
          failed.push({ employeeId: employee.id, message: e.message });
        } else {
          pending.push(employee.id); // outcome unknown: the leg stays open; calling again resumes it with the same key
        }
      }
    }

    const status = this.store.tx(() => {
      const current = this.store.payRuns.require(run.id, 'Pay run');
      const owed = run.paychecks.filter((p) => p.payableCents > 0);
      const done = owed.every((p) => this.store.legs.where((l) => l.runId === run.id && l.kind === 'employee_payout' && l.employeeId === p.employeeId && l.status === 'succeeded').length === 1);
      if (done && current.status === 'disbursing') return this.store.payRuns.put({ ...current, status: 'completed', completedAt: this.now().toISOString() }).status;
      return current.status;
    });
    return { status, paid, failed, pending, waitingForBankAccount: waiting };
  }

  // ------------------------------------------------------------------ webhooks

  async handleEvent(event: StripeEvent): Promise<{ duplicate: boolean; handled: boolean }> {
    if (this.store.webhookEvents.get(event.id)) return { duplicate: true, handled: false };
    const handled = await this.dispatch(event);
    this.store.tx(() => this.store.webhookEvents.put({ id: event.id, type: event.type, receivedAt: this.now().toISOString() }));
    return { duplicate: false, handled };
  }

  private legByStripeId(stripeId: string | undefined, kind: MoneyLeg['kind']): MoneyLeg | undefined {
    if (!stripeId) return undefined;
    return this.store.legs.where((l) => l.kind === kind && l.stripeObjectId === stripeId)[0];
  }

  private async dispatch(event: StripeEvent): Promise<boolean> {
    const obj = event.data.object;
    switch (event.type) {
      case 'payment_intent.processing':
      case 'payment_intent.succeeded':
      case 'payment_intent.payment_failed':
      case 'payment_intent.canceled': {
        const legId = obj.metadata?.leg_id as string | undefined;
        const leg = (legId ? this.store.legs.get(legId) : undefined) ?? this.legByStripeId(obj.id, 'funding');
        if (!leg || leg.kind !== 'funding') return false;
        if (event.type === 'payment_intent.succeeded') this.applyPaymentIntent(leg.id, { id: obj.id, status: 'succeeded', amount: obj.amount, latest_charge: obj.latest_charge });
        else if (event.type === 'payment_intent.processing') this.applyPaymentIntent(leg.id, { id: obj.id, status: 'processing', amount: obj.amount, latest_charge: obj.latest_charge });
        else this.failFundingLeg(leg.id, obj.last_payment_error?.message ?? 'The bank debit failed.', obj.id);
        return true;
      }
      case 'charge.dispute.created': {
        const leg = this.legByStripeId(obj.payment_intent, 'funding');
        if (!leg) return false;
        this.reverseFunding(leg.id, `The employer's bank disputed or returned the debit (${obj.reason ?? 'unknown reason'}).`);
        return true;
      }
      case 'transfer.reversed': {
        const leg = this.legByStripeId(obj.id, 'employee_payout');
        if (!leg) return false;
        this.store.tx(() => {
          this.store.legs.put({ ...this.store.legs.require(leg.id, 'Leg'), status: 'reversed', updatedAt: this.now().toISOString() });
          postEntry(this.store, { companyId: leg.companyId, runId: leg.runId, legId: leg.id, memo: 'Transfer to employee reversed', lines: [{ account: 'stripe_cash', debitCents: leg.amountCents }, { account: 'employee_net_pay', creditCents: leg.amountCents }] });
          this.alert(leg.runId, 'transfer_reversed', `The transfer to employee ${leg.employeeId} was reversed. Their net pay is owed again.`);
        });
        return true;
      }
      case 'setup_intent.succeeded': {
        const companyId = obj.metadata?.company_id as string | undefined;
        const company = companyId ? this.store.companies.get(companyId) : undefined;
        if (!company || !obj.payment_method) return false;
        const pm = await this.stripe.retrievePaymentMethod(obj.payment_method);
        this.store.tx(() => this.store.companies.put({ ...company, funding: { ...company.funding, status: 'ready', paymentMethodId: pm.id, ...(pm.us_bank_account?.last4 ? { bankLast4: pm.us_bank_account.last4 } : {}) } }));
        return true;
      }
      case 'account.updated': {
        const employee = this.store.employees.where((e) => e.payout.stripeAccountId === obj.id)[0];
        if (!employee) return false;
        this.applyAccount(employee, obj as StripeAccount);
        return true;
      }
      case 'payout.failed': {
        const employee = event.account ? this.store.employees.where((e) => e.payout.stripeAccountId === event.account)[0] : undefined;
        if (!employee) return false;
        this.store.tx(() => this.store.employees.put({ ...employee, payout: { ...employee.payout, status: 'restricted' } }));
        return true;
      }
      default:
        return false;
    }
  }

  private applyAccount(employee: Employee, a: StripeAccount): void {
    const ready = a.payouts_enabled === true && a.details_submitted === true;
    const status = ready ? 'ready' : a.requirements?.disabled_reason && a.details_submitted ? 'restricted' : 'onboarding';
    const last4 = a.external_accounts?.data?.[0]?.last4;
    this.store.tx(() => this.store.employees.put({ ...employee, payout: { ...employee.payout, status, ...(last4 ? { bankLast4: last4 } : {}) } }));
  }

  /** A debit that came back after it had succeeded. If employees were already paid, the ledger shows the shortfall and a person has to act. */
  private reverseFunding(legId: string, message: string): void {
    this.store.tx(() => {
      const leg = this.store.legs.require(legId, 'Leg');
      if (leg.status === 'reversed') return;
      const run = this.store.payRuns.require(leg.runId, 'Pay run');
      const wasCollected = leg.status === 'succeeded';
      this.store.legs.put({ ...leg, status: 'reversed', failureMessage: message, updatedAt: this.now().toISOString() });
      if (wasCollected) {
        const t = run.totals;
        postEntry(this.store, { companyId: leg.companyId, runId: run.id, legId: leg.id, memo: 'Employer debit reversed by the bank', lines: [{ account: 'stripe_cash', creditCents: leg.amountCents }, { account: 'employee_net_pay', debitCents: t.payableCents }, { account: 'tax_withheld', debitCents: t.employeeTaxCents }, { account: 'tax_employer', debitCents: t.employerTaxCents }, { account: 'deductions_held', debitCents: t.deductionsCents }] });
      }
      const paidOut = this.store.legs.where((l) => l.runId === run.id && l.kind === 'employee_payout' && l.status === 'succeeded').length > 0;
      this.alert(run.id, paidOut ? 'ach_return_after_payout' : 'ach_return', `${message}${paidOut ? ' Employees were already paid, so the platform is exposed for that amount. See the ledger.' : ' No employees had been paid.'}`);
      if (!paidOut) this.store.payRuns.put({ ...this.store.payRuns.require(run.id, 'Pay run'), status: 'approved' });
    });
  }

  private alert(runId: string, code: string, message: string): void {
    const run = this.store.payRuns.require(runId, 'Pay run');
    this.store.payRuns.put({ ...run, alerts: [...(run.alerts ?? []), { at: this.now().toISOString(), code, message }] });
  }
}

/**
 * Catch up on anything a lost webhook left behind: re-check debits that are
 * still processing, and (when asked) pay employees from runs whose hold has
 * passed. Safe to run on a timer: every step is idempotent.
 */
export async function reconcile(money: MoneyService, store: Store, opts: { autoDisburse: boolean; log?: (msg: string) => void }): Promise<void> {
  const log = opts.log ?? (() => {});
  for (const run of store.payRuns.where((r) => r.status === 'funding')) {
    try {
      await money.fundPayRun(run.companyId, run.id);
    } catch (e) {
      log(`reconcile funding ${run.id}: ${(e as Error).message}`);
    }
  }
  if (!opts.autoDisburse) return;
  for (const run of store.payRuns.where((r) => r.status === 'funded' || r.status === 'disbursing')) {
    try {
      await money.disbursePayRun(run.companyId, run.id);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== 'funds_on_hold') log(`reconcile disbursing ${run.id}: ${(e as Error).message}`);
    }
  }
}
