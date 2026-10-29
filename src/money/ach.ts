import { newId } from '../lib/ids.ts';
import { badRequest, conflict } from '../lib/errors.ts';
import { decryptField, encryptField } from '../lib/crypto.ts';
import { addBankingDays, onOrAfterBankingDay, onOrBeforeBankingDay } from '../lib/bizdays.ts';
import { sum } from '../lib/money.ts';
import { allocateNetPay } from '../../engine/payroll/directDeposit.ts';
import { PRENOTE_WAITING_PERIOD_BUSINESS_DAYS } from '../../engine/payroll/directDepositVerification.ts';
import type { DirectDepositAccount } from '../../engine/payroll/types.ts';
import type { Store } from '../store/store.ts';
import type { AchFile, AchFileEntry, BankAccount, MoneyLeg, PayRun } from '../domain/types.ts';
import { buildAchFile, type AchEntry, type Originator } from '../ach/nacha.ts';
import { parseReturnFile, RETURN_CODES } from '../ach/returns.ts';
import type { AchSubmitter } from '../ach/submitter.ts';
import { numbersFor, payoutReadiness, type BankService } from '../banking/accounts.ts';
import { getRun } from '../payroll/payRuns.ts';
import { postEntry } from './ledger.ts';

/**
 * Money movement by ACH, originated by Totali.
 *
 *   approved --fund--> funding --(bank confirms funds arrived)--> funded --hold--> disburse --> disbursing --> completed
 *
 * One debit pulls everything a run needs from the employer's account into
 * Totali's settlement account. After the funds have settled and the
 * return-risk hold has passed, one credit per employee account sends net
 * pay out. Taxes and deductions stay put and are tracked in the ledger.
 *
 * Rules the code holds to:
 *  - Nothing is paid before the debit has settled AND the bank has confirmed
 *    the funds arrived, then only after a hold counted in banking days.
 *  - A leg is written, with its trace number, in the same transaction as the
 *    file that carries it. A crash before the file is handed over leaves a file
 *    in 'created' that the next reconcile hands over. The same file is never
 *    built twice, so a payment cannot be made twice.
 *  - A file is 'accepted' only when the bank acknowledges it. Bank
 *    acknowledgements, funds confirmations and return files are recorded
 *    through admin-only calls: a company cannot confirm its own funds.
 *  - Returns are matched to the leg by trace number and undo exactly what the
 *    leg did, in the ledger and in the run.
 *  - Every state change that moves a balance posts a balanced ledger entry in
 *    the same transaction.
 */

export interface AchConfig {
  originator: Originator;
  /** Banking days after the debit settles before employees are paid. Covers returns for a business-account debit. */
  holdBankingDays: number;
  /** Banking days between handing over a debit file and its effective date (1 for standard ACH). */
  fundingLeadBankingDays: number;
  /** Banking days between handing over a credit file and its effective date (1 for standard ACH). */
  creditLeadBankingDays: number;
  /** Treat a debit as settled once its effective date passes with no return. Off by default: the bank must confirm. */
  trustSettlementDate: boolean;
}

export interface Timeline {
  today: string;
  checkDate: string;
  debitEffectiveDate: string;
  /** First day employees can be paid: debit settles, then the hold. */
  earliestDisburseDate: string;
  earliestCreditEffectiveDate: string;
  /** The day employees should be paid: the check date, or the banking day before it. */
  targetCreditDate: string;
  onTime: boolean;
  daysLate: number;
}

export function planTimeline(today: string, checkDate: string, cfg: Pick<AchConfig, 'holdBankingDays' | 'fundingLeadBankingDays' | 'creditLeadBankingDays'>): Timeline {
  const start = onOrAfterBankingDay(today);
  const debitEffectiveDate = addBankingDays(start, cfg.fundingLeadBankingDays);
  const earliestDisburseDate = addBankingDays(debitEffectiveDate, cfg.holdBankingDays);
  const earliestCreditEffectiveDate = addBankingDays(earliestDisburseDate, cfg.creditLeadBankingDays);
  const targetCreditDate = onOrBeforeBankingDay(checkDate);
  const onTime = earliestCreditEffectiveDate <= targetCreditDate;
  let daysLate = 0;
  if (!onTime) for (let d = targetCreditDate; d < earliestCreditEffectiveDate; d = addBankingDays(d, 1)) daysLate += 1;
  return { today, checkDate, debitEffectiveDate, earliestDisburseDate, earliestCreditEffectiveDate, targetCreditDate, onTime, daysLate };
}

const OPEN: ReadonlyArray<MoneyLeg['status']> = ['pending', 'queued', 'submitted'];
const LIVE: ReadonlyArray<MoneyLeg['status']> = ['pending', 'queued', 'submitted', 'settled'];

export class AchService {
  private readonly store: Store;
  private readonly banks: BankService;
  private readonly submitter: AchSubmitter;
  private readonly cfg: AchConfig;
  private readonly now: () => Date;
  private readonly inflight = new Set<string>();

  constructor(store: Store, banks: BankService, submitter: AchSubmitter, cfg: AchConfig, opts: { now?: () => Date } = {}) {
    this.store = store;
    this.banks = banks;
    this.submitter = submitter;
    this.cfg = cfg;
    this.now = opts.now ?? (() => new Date());
  }

  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  // ------------------------------------------------------------------ files

  /** Build a file, persist it with its legs' trace numbers. Call inside store.tx(). */
  private createFile(p: { companyId: string; runId?: string; kind: AchFile['kind']; effectiveDate: string; entries: Array<AchEntry & { legId?: string; bankAccountId?: string }>; sec: 'PPD' | 'CCD'; description: string }): AchFile {
    const seqStart = this.store.nextCounter('ach_trace', 1);
    for (let i = 1; i < p.entries.length; i++) this.store.nextCounter('ach_trace', 1);
    if (seqStart + p.entries.length > 9_999_999) throw new Error('The ACH trace number sequence is exhausted. Totali staff must reset it with the bank.');
    const fileNo = this.store.nextCounter('ach_file', 1);
    const dayCount = this.store.achFiles.where((f) => f.createdAt.slice(0, 10) === this.today()).length;
    const modifier = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[dayCount];
    if (!modifier) throw new Error('More than 36 ACH files today; the file ID modifier is exhausted.');
    const built = buildAchFile(this.cfg.originator, { standardEntryClass: p.sec, entryDescription: p.description, effectiveEntryDate: p.effectiveDate, entries: p.entries }, { createdAt: this.now(), firstTraceSequence: seqStart, fileIdModifier: modifier });
    const entries: AchFileEntry[] = built.entries.map((b, i) => ({ ref: b.ref, traceNumber: b.traceNumber, kind: b.kind, amountCents: b.amountCents, ...(p.entries[i].legId ? { legId: p.entries[i].legId } : {}), ...(p.entries[i].bankAccountId ? { bankAccountId: p.entries[i].bankAccountId } : {}) }));
    const at = this.now().toISOString();
    const file: AchFile = {
      id: newId('ach'),
      companyId: p.companyId,
      ...(p.runId ? { runId: p.runId } : {}),
      kind: p.kind,
      fileName: `TOTALI_${p.kind.toUpperCase()}_${p.effectiveDate.replace(/-/g, '')}_${String(fileNo).padStart(5, '0')}.ach`,
      contentEncrypted: encryptField(built.content),
      effectiveDate: p.effectiveDate,
      entries,
      totals: { entryCount: built.totals.entryCount, debitCents: built.totals.debitCents, creditCents: built.totals.creditCents },
      status: 'created',
      createdAt: at,
      updatedAt: at,
    };
    this.store.achFiles.put(file);
    for (const e of entries) {
      if (!e.legId) continue;
      const leg = this.store.legs.require(e.legId, 'Leg');
      this.store.legs.put({ ...leg, status: 'queued', fileId: file.id, traceNumber: e.traceNumber, effectiveDate: p.effectiveDate, updatedAt: at });
    }
    return file;
  }

  /** Hand a built file to the bank. Safe to repeat: a file the bank already has is left alone. */
  async submitFile(fileId: string): Promise<AchFile> {
    const file = this.store.achFiles.require(fileId, 'ACH file');
    if (file.status !== 'created') return file;
    const result = await this.submitter.submit({ fileId: file.id, fileName: file.fileName, content: decryptField(file.contentEncrypted), kind: file.kind, effectiveDate: file.effectiveDate, entryCount: file.totals.entryCount, totalCents: file.totals.debitCents + file.totals.creditCents });
    return this.store.tx(() => {
      const fresh = this.store.achFiles.require(fileId, 'ACH file');
      this.store.achFiles.put({ ...fresh, status: result.status === 'rejected' ? 'rejected' : result.status === 'accepted' ? 'accepted' : 'queued', submitter: this.submitter.name, ...(result.reference ? { reference: result.reference } : {}), message: result.message, updatedAt: this.now().toISOString() });
      if (result.status === 'accepted') this.acceptLegs(fresh);
      if (result.status === 'rejected') this.rejectLegs(fresh, result.message);
      return this.store.achFiles.require(fileId, 'ACH file');
    });
  }

  private acceptLegs(file: AchFile): void {
    for (const e of file.entries) {
      if (e.legId) {
        const leg = this.store.legs.require(e.legId, 'Leg');
        if (leg.status === 'queued') this.store.legs.put({ ...leg, status: 'submitted', updatedAt: this.now().toISOString() });
      } else if (e.bankAccountId && file.kind === 'prenote') {
        const a = this.store.bankAccounts.get(e.bankAccountId);
        if (a && a.verification.method === 'prenote' && a.verification.status === 'pending') {
          this.store.bankAccounts.put({ ...a, verification: { ...a.verification, prenoteSettlementDate: file.effectiveDate } });
        }
      }
    }
  }

  private rejectLegs(file: AchFile, message: string): void {
    for (const e of file.entries) {
      if (e.legId) {
        const leg = this.store.legs.require(e.legId, 'Leg');
        if (leg.status === 'queued' || leg.status === 'submitted') {
          this.store.legs.put({ ...leg, status: 'failed', failureMessage: message, updatedAt: this.now().toISOString() });
          if (leg.kind === 'funding') this.backToApproved(leg.runId);
        }
      } else if (e.bankAccountId && file.kind === 'prenote') {
        const a = this.store.bankAccounts.get(e.bankAccountId);
        if (a && a.verification.prenoteFileId === file.id) this.store.bankAccounts.put({ ...a, verification: { ...a.verification, prenoteFileId: undefined } }); // eligible for a new prenote
      }
    }
  }

  private backToApproved(runId: string): void {
    const run = this.store.payRuns.require(runId, 'Pay run');
    if (run.status === 'funding') this.store.payRuns.put({ ...run, status: 'approved' });
  }

  /** The bank says it has the file. Admin / bank-adapter only. */
  markFileAccepted(fileId: string, reference?: string): AchFile {
    return this.store.tx(() => {
      const file = this.store.achFiles.require(fileId, 'ACH file');
      if (file.status === 'accepted') return file;
      if (file.status === 'rejected') throw conflict('file_rejected', 'That file was rejected; it cannot be accepted. Build a new one.');
      if (file.status === 'created') throw conflict('file_not_handed_over', 'That file has not been handed to the bank yet.');
      const next = this.store.achFiles.put({ ...file, status: 'accepted', ...(reference ? { reference } : {}), message: 'The bank acknowledged the file.', updatedAt: this.now().toISOString() });
      this.acceptLegs(file);
      return next;
    });
  }

  markFileRejected(fileId: string, reason: string): AchFile {
    if (!reason.trim()) throw badRequest('A reason is required');
    return this.store.tx(() => {
      const file = this.store.achFiles.require(fileId, 'ACH file');
      if (file.status === 'rejected') return file;
      if (file.status === 'accepted') throw conflict('file_accepted', 'The bank already accepted that file. If entries are bad, they will come back as returns.');
      const next = this.store.achFiles.put({ ...file, status: 'rejected', message: reason.trim(), updatedAt: this.now().toISOString() });
      this.rejectLegs(file, reason.trim());
      return next;
    });
  }

  fileContent(companyId: string | null, fileId: string): { fileName: string; content: string } {
    const f = this.store.achFiles.require(fileId, 'ACH file');
    if (companyId && f.companyId !== companyId) throw badRequest('That file is not at this company');
    return { fileName: f.fileName, content: decryptField(f.contentEncrypted) };
  }

  // ------------------------------------------------------------------ funding

  private requireConfigured(): void {
    const o = this.cfg.originator;
    if (!o.odfiRoutingNumber || !o.odfiName || !o.immediateOrigin || !o.companyId) {
      throw conflict('ach_not_configured', 'ACH origination is not set up. Set TOTALI_ODFI_ROUTING, TOTALI_ODFI_NAME, TOTALI_ORIGIN_ID and TOTALI_ORIGINATOR_COMPANY_ID once your bank has assigned them.');
    }
  }

  timeline(companyId: string, runId: string): Timeline {
    const run = getRun(this.store, companyId, runId);
    return planTimeline(this.today(), run.checkDate, this.cfg);
  }

  /**
   * Debit the employer for everything the run needs. Returns the plan: when the
   * money lands, the earliest employees can be paid, and whether that makes
   * the check date. If it does not, say so and refuse unless the caller
   * accepts paying late.
   */
  async fundPayRun(companyId: string, runId: string, opts: { acceptLate?: boolean } = {}): Promise<{ run: PayRun; leg: MoneyLeg; file: Omit<AchFile, 'contentEncrypted'> | null; timeline: Timeline; balanceCheck?: { checked: boolean; note: string } }> {
    this.requireConfigured();
    const run = getRun(this.store, companyId, runId);
    const company = this.store.companies.require(companyId, 'Company');
    if (run.status !== 'approved' && run.status !== 'funding') throw conflict('not_fundable', `Only an approved run can be funded; this run is ${run.status}.`);

    const existing = this.store.legs.where((l) => l.runId === runId && l.kind === 'funding').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const timeline = planTimeline(this.today(), run.checkDate, this.cfg);
    if (existing && (OPEN.includes(existing.status) || existing.status === 'settled')) {
      if (existing.fileId) await this.submitFile(existing.fileId); // resume a file that was built but not handed over
      return { run: getRun(this.store, companyId, runId), leg: this.store.legs.require(existing.id, 'Leg'), file: this.fileMeta(existing.fileId), timeline };
    }

    const auth = company.funding.debitAuthorization;
    const account = company.funding.bankAccountId ? this.store.bankAccounts.get(company.funding.bankAccountId) : undefined;
    if (!account) throw conflict('funding_not_ready', "This company has not chosen a bank account to debit. Link one and set it with PUT /funding/account.");
    if (account.status !== 'active') throw conflict('funding_account_not_active', `The funding account ending ${account.last4} is ${account.status}${account.disabledReason ? ` (${account.disabledReason})` : ''}.`);
    if (account.holderType !== 'business') throw conflict('consumer_account', 'Payroll debits are only supported from business accounts.');
    if (!auth || auth.bankAccountId !== account.id) throw conflict('debit_not_authorized', 'The employer has not authorized debits from this account. Show the authorization text and record their acceptance first.');
    if (run.totals.fundingRequiredCents <= 0) throw conflict('nothing_to_fund', 'This run has nothing to fund.');
    if (!timeline.onTime && !opts.acceptLate) {
      throw conflict('check_date_unreachable', `Employees cannot be paid by ${timeline.targetCreditDate}: the debit settles ${timeline.debitEffectiveDate}, the return-risk hold runs to ${timeline.earliestDisburseDate}, and credits land ${timeline.earliestCreditEffectiveDate}. That is ${timeline.daysLate} banking day(s) late. Fund with acceptLate: true to proceed, or void this run and use a later check date.`, { timeline });
    }
    const balanceCheck = await this.banks.checkBalance(account, run.totals.fundingRequiredCents);

    const made = this.store.tx(() => {
      // Re-check inside the transaction: a concurrent request may have created the debit while this one was awaiting the balance check.
      const live = this.store.legs.where((l) => l.runId === runId && l.kind === 'funding' && (OPEN.includes(l.status) || l.status === 'settled'))[0];
      if (live) return { leg: live, file: live.fileId ? this.store.achFiles.get(live.fileId) : undefined, created: false };
      const fresh = getRun(this.store, companyId, runId);
      const prior = this.store.legs.where((l) => l.runId === runId && l.kind === 'funding');
      const at = this.now().toISOString();
      const created: MoneyLeg = { id: newId('leg'), companyId, runId, kind: 'funding', bankAccountId: account.id, amountCents: fresh.totals.fundingRequiredCents, attempt: prior.length + 1, status: 'pending', ...(balanceCheck.checked ? {} : { note: balanceCheck.note }), createdAt: at, updatedAt: at };
      this.store.legs.put(created);
      const { accountNumber, routingNumber } = numbersFor(account);
      const f = this.createFile({
        companyId,
        runId,
        kind: 'debit',
        effectiveDate: timeline.debitEffectiveDate,
        sec: 'CCD',
        description: 'PAYROLLFND',
        entries: [{ ref: created.id, legId: created.id, bankAccountId: account.id, kind: 'debit', accountType: account.accountType, routingNumber, accountNumber, amountCents: created.amountCents, individualId: runId.slice(0, 15), individualName: company.legalName }],
      });
      this.store.payRuns.put({ ...fresh, status: 'funding', ...(timeline.onTime ? {} : { alerts: [...(fresh.alerts ?? []), { at, code: 'will_pay_late', message: `Funding was accepted knowing employees will be paid ${timeline.daysLate} banking day(s) after the check date.` }] }) });
      return { leg: this.store.legs.require(created.id, 'Leg'), file: f, created: true };
    });
    const { leg, file } = made;
    if (!made.created) {
      if (file && file.status === 'created') await this.submitFile(file.id);
      return { run: getRun(this.store, companyId, runId), leg: this.store.legs.require(leg.id, 'Leg'), file: this.fileMeta(file?.id), timeline };
    }
    await this.submitFile(file!.id);
    return { run: getRun(this.store, companyId, runId), leg: this.store.legs.require(leg.id, 'Leg'), file: this.fileMeta(file!.id), timeline, balanceCheck: { checked: balanceCheck.checked, note: balanceCheck.note } };
  }

  private fileMeta(fileId: string | undefined): Omit<AchFile, 'contentEncrypted'> | null {
    if (!fileId) return null;
    const f = this.store.achFiles.get(fileId);
    if (!f) return null;
    const { contentEncrypted: _c, ...meta } = f;
    return meta;
  }

  /**
   * The bank reports the employer's money arrived in the settlement account.
   * Admin / bank-adapter only. This is what opens the run to being paid out,
   * so the amount must match the debit exactly.
   */
  confirmFundsReceived(runId: string, input: { reference: string; amountCents: number }): PayRun {
    if (!input.reference.trim()) throw badRequest('A bank reference is required');
    return this.store.tx(() => {
      const run = this.store.payRuns.require(runId, 'Pay run');
      const leg = this.store.legs.where((l) => l.runId === runId && l.kind === 'funding' && l.status !== 'failed' && l.status !== 'returned').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (!leg) throw conflict('no_funding_leg', 'This run has no debit in progress.');
      if (leg.status === 'settled') return run;
      if (leg.status !== 'submitted') throw conflict('debit_not_submitted', `The debit is ${leg.status}. The bank must have acknowledged the file before funds can be confirmed.`);
      if (leg.effectiveDate && leg.effectiveDate > this.today()) throw conflict('before_effective_date', `The debit is dated ${leg.effectiveDate}; funds cannot have settled yet.`);
      if (input.amountCents !== leg.amountCents) throw conflict('amount_mismatch', `The bank reports ${input.amountCents}¢ but the debit was ${leg.amountCents}¢. Not treated as funded.`);
      return this.settleFunding(leg, `bank reference ${input.reference.trim()}`);
    });
  }

  private settleFunding(leg: MoneyLeg, how: string): PayRun {
    const run = this.store.payRuns.require(leg.runId, 'Pay run');
    const t = run.totals;
    if (t.payableCents + t.employeeTaxCents + t.employerTaxCents + t.deductionsCents !== leg.amountCents) throw new Error(`Run ${run.id} funding ${leg.amountCents} does not equal its obligations`);
    const at = this.now().toISOString();
    this.store.legs.put({ ...leg, status: 'settled', settledAt: at, updatedAt: at });
    postEntry(this.store, {
      companyId: leg.companyId,
      runId: run.id,
      legId: leg.id,
      memo: `Employer debit settled (${how}) for pay run ${run.periodStart} to ${run.periodEnd}`,
      lines: [
        { account: 'bank_cash', debitCents: leg.amountCents },
        { account: 'employee_net_pay', creditCents: t.payableCents },
        { account: 'tax_withheld', creditCents: t.employeeTaxCents },
        { account: 'tax_employer', creditCents: t.employerTaxCents },
        { account: 'deductions_held', creditCents: t.deductionsCents },
      ],
    });
    return this.store.payRuns.put({ ...run, status: run.status === 'completed' ? run.status : 'funded', fundedAt: at });
  }

  // ------------------------------------------------------------------ disbursement

  /** The first day employees can be paid from a funded run. */
  private releaseDate(runId: string): string | null {
    const leg = this.store.legs.where((l) => l.runId === runId && l.kind === 'funding' && l.status === 'settled')[0];
    if (!leg?.effectiveDate) return null;
    return addBankingDays(leg.effectiveDate, this.cfg.holdBankingDays);
  }

  /**
   * Pay each employee by ACH credit. Only from a funded run, and only after the
   * hold. Safe to call again: it pays employees who are now set up, and re-sends
   * legs that came back. It never pays an employee more than their approved net pay.
   */
  async disbursePayRun(companyId: string, runId: string): Promise<{
    status: PayRun['status'];
    file: Omit<AchFile, 'contentEncrypted'> | null;
    paying: Array<{ employeeId: string; bankAccountId: string; amountCents: number }>;
    waitingForBankAccount: Array<{ employeeId: string; amountCents: number; reason: string }>;
    effectiveDate: string | null;
    late: boolean;
  }> {
    this.requireConfigured();
    const run = getRun(this.store, companyId, runId);
    if (run.status !== 'funded' && run.status !== 'disbursing') throw conflict('not_funded', `Employees are paid only from a funded run; this run is ${run.status}.`);
    const release = this.releaseDate(runId);
    if (!release) throw conflict('not_funded', 'The employer debit has not settled, so nothing can be paid out.');
    if (this.today() < release) throw conflict('funds_on_hold', `The employer's debit can still be returned by their bank. Pay-out opens on ${release}.`, { releaseDate: release });
    if (this.inflight.has(runId)) throw conflict('disbursement_in_progress', 'A disbursement for this run is already running.');
    this.inflight.add(runId);
    try {
      const out = this.store.tx(() => {
        const fresh = getRun(this.store, companyId, runId);
        const waiting: Array<{ employeeId: string; amountCents: number; reason: string }> = [];
        const planned: Array<{ leg: MoneyLeg; account: BankAccount; employeeName: string }> = [];
        const at = this.now().toISOString();
        const earliest = addBankingDays(onOrAfterBankingDay(this.today()), this.cfg.creditLeadBankingDays);
        const target = onOrBeforeBankingDay(fresh.checkDate);
        const effectiveDate = target >= earliest ? target : earliest;
        const late = effectiveDate > target;

        for (const pc of fresh.paychecks.filter((p) => p.payableCents > 0)) {
          const employee = this.store.employees.require(pc.employeeId, 'Employee');
          const mine = this.store.legs.where((l) => l.runId === runId && l.kind === 'employee_payout' && l.employeeId === pc.employeeId);
          const alreadyHandled = sum(mine.filter((l) => LIVE.includes(l.status)).map((l) => l.amountCents));
          const remaining = pc.payableCents - alreadyHandled;
          if (remaining <= 0) continue;
          const ready = payoutReadiness(this.store, employee);
          if (!ready.ready) {
            waiting.push({ employeeId: pc.employeeId, amountCents: remaining, reason: ready.reason ?? 'not ready' });
            continue;
          }
          const accounts: DirectDepositAccount[] = employee.payoutAccounts.map((p) => ({ id: p.bankAccountId, routingNumber: '', accountNumber: '', accountType: 'checking', allocation: p.allocation, priority: p.priority }));
          for (const alloc of allocateNetPay(remaining, accounts)) {
            if (alloc.amount <= 0) continue;
            const account = this.store.bankAccounts.require(alloc.accountId, 'Bank account');
            const attempt = mine.filter((l) => l.bankAccountId === account.id).length + 1;
            const leg: MoneyLeg = { id: newId('leg'), companyId, runId, kind: 'employee_payout', employeeId: pc.employeeId, bankAccountId: account.id, amountCents: alloc.amount, attempt, status: 'pending', createdAt: at, updatedAt: at };
            this.store.legs.put(leg);
            planned.push({ leg, account, employeeName: pc.name });
          }
        }

        let file: AchFile | null = null;
        if (planned.length > 0) {
          file = this.createFile({
            companyId,
            runId,
            kind: 'credit',
            effectiveDate,
            sec: 'PPD',
            description: 'PAYROLL',
            entries: planned.map(({ leg, account, employeeName }) => {
              const n = numbersFor(account);
              return { ref: leg.id, legId: leg.id, bankAccountId: account.id, kind: 'credit' as const, accountType: account.accountType, routingNumber: n.routingNumber, accountNumber: n.accountNumber, amountCents: leg.amountCents, individualId: leg.employeeId!, individualName: employeeName };
            }),
          });
          if (late) this.alert(runId, 'paid_late', `Employees are being paid on ${effectiveDate}, after the ${target} target. The ACH timeline did not allow earlier.`);
        }
        this.store.payRuns.put({ ...this.store.payRuns.require(runId, 'Pay run'), status: 'disbursing' });
        return { file, planned, waiting, effectiveDate: file ? effectiveDate : null, late: file ? late : false };
      });
      if (out.file) await this.submitFile(out.file.id);
      this.advance();
      const status = this.store.payRuns.require(runId, 'Pay run').status;
      return {
        status,
        file: out.file ? this.fileMeta(out.file.id) : null,
        paying: out.planned.map(({ leg }) => ({ employeeId: leg.employeeId!, bankAccountId: leg.bankAccountId, amountCents: leg.amountCents })),
        waitingForBankAccount: out.waiting,
        effectiveDate: out.effectiveDate,
        late: out.late,
      };
    } finally {
      this.inflight.delete(runId);
    }
  }

  // ------------------------------------------------------------------ prenotes

  /** Send a zero-dollar prenote for every employee account that is waiting to be verified. */
  async submitPrenotes(companyId: string): Promise<{ file: Omit<AchFile, 'contentEncrypted'> | null; accounts: string[] }> {
    this.requireConfigured();
    const created = this.store.tx(() => {
      const pending = this.store.bankAccounts.where((a) => a.companyId === companyId && a.ownerKind === 'employee' && a.status === 'pending' && a.verification.method === 'prenote' && a.verification.status === 'pending' && !a.verification.prenoteFileId);
      if (pending.length === 0) return null;
      const effectiveDate = addBankingDays(onOrAfterBankingDay(this.today()), this.cfg.creditLeadBankingDays);
      const file = this.createFile({
        companyId,
        kind: 'prenote',
        effectiveDate,
        sec: 'PPD',
        description: 'PRENOTE',
        entries: pending.map((a) => {
          const n = numbersFor(a);
          const e = this.store.employees.require(a.ownerId, 'Employee');
          return { ref: a.id, bankAccountId: a.id, kind: 'prenote_credit' as const, accountType: a.accountType, routingNumber: n.routingNumber, accountNumber: n.accountNumber, amountCents: 0, individualId: e.id, individualName: `${e.firstName} ${e.lastName}` };
        }),
      });
      for (const a of pending) this.store.bankAccounts.put({ ...a, verification: { ...a.verification, prenoteFileId: file.id } });
      return { file, ids: pending.map((a) => a.id) };
    });
    if (!created) return { file: null, accounts: [] };
    await this.submitFile(created.file.id);
    return { file: this.fileMeta(created.file.id), accounts: created.ids };
  }

  // ------------------------------------------------------------------ time-driven progress

  /**
   * Move things forward that only the calendar decides: credits whose effective
   * date has passed are settled, prenotes that waited out the NACHA period with
   * no return verify their account, and (only if configured to trust the
   * calendar) debits settle on their effective date. Idempotent.
   */
  advance(): void {
    const today = this.today();
    this.store.tx(() => {
      for (const leg of this.store.legs.where((l) => l.status === 'submitted' && !!l.effectiveDate && l.effectiveDate <= today)) {
        if (leg.kind === 'employee_payout') {
          const at = this.now().toISOString();
          this.store.legs.put({ ...leg, status: 'settled', settledAt: at, updatedAt: at });
          const employee = this.store.employees.get(leg.employeeId!);
          postEntry(this.store, { companyId: leg.companyId, runId: leg.runId, legId: leg.id, memo: `Net pay sent to ${employee ? `${employee.firstName} ${employee.lastName}` : leg.employeeId}`, lines: [{ account: 'employee_net_pay', debitCents: leg.amountCents }, { account: 'bank_cash', creditCents: leg.amountCents }] });
        } else if (this.cfg.trustSettlementDate) {
          this.settleFunding(leg, 'effective date passed with no return');
        }
      }
      for (const run of this.store.payRuns.where((r) => r.status === 'disbursing')) {
        const owed = run.paychecks.filter((p) => p.payableCents > 0);
        const paid = (employeeId: string, amount: number) => sum(this.store.legs.where((l) => l.runId === run.id && l.kind === 'employee_payout' && l.employeeId === employeeId && l.status === 'settled').map((l) => l.amountCents)) >= amount;
        if (owed.every((p) => paid(p.employeeId, p.payableCents))) this.store.payRuns.put({ ...run, status: 'completed', completedAt: this.now().toISOString() });
      }
      for (const a of this.store.bankAccounts.where((x) => x.status === 'pending' && x.verification.method === 'prenote' && x.verification.status === 'pending' && !!x.verification.prenoteSettlementDate)) {
        if (addBankingDays(a.verification.prenoteSettlementDate!, PRENOTE_WAITING_PERIOD_BUSINESS_DAYS) <= today) {
          this.store.bankAccounts.put({ ...a, status: 'active', verification: { ...a.verification, status: 'verified', verifiedAt: this.now().toISOString() } });
        }
      }
    });
  }

  // ------------------------------------------------------------------ returns

  private findEntry(trace: string): { file: AchFile; entry: AchFileEntry } | undefined {
    for (const file of this.store.achFiles.all()) {
      const entry = file.entries.find((e) => e.traceNumber === trace);
      if (entry) return { file, entry };
    }
    return undefined;
  }

  /**
   * Apply a return file from the bank: each returned entry is matched to its
   * leg by trace number and undone. A bad account is disabled, never reused;
   * an unauthorized-debit return also revokes the employer's authorization.
   * Admin / bank-adapter only.
   */
  ingestReturnFile(text: string): { applied: Array<{ trace: string; code: string; what: string }>; alreadyApplied: string[]; unmatched: string[]; changeNotices: Array<{ trace: string; changeCode: string; bankAccountId?: string }> } {
    const parsed = parseReturnFile(text);
    if (parsed.errors.length > 0) throw conflict('bad_return_file', `The return file is malformed: ${parsed.errors.join('; ')}`);
    const applied: Array<{ trace: string; code: string; what: string }> = [];
    const alreadyApplied: string[] = [];
    const unmatched: string[] = [];
    const changeNotices: Array<{ trace: string; changeCode: string; bankAccountId?: string }> = [];

    this.store.tx(() => {
      for (const r of parsed.returns) {
        const hit = this.findEntry(r.originalTrace);
        if (!hit) {
          unmatched.push(r.originalTrace);
          continue;
        }
        const { entry } = hit;
        if (entry.legId) {
          const leg = this.store.legs.require(entry.legId, 'Leg');
          if (leg.status === 'returned') {
            alreadyApplied.push(r.originalTrace);
            continue;
          }
          applied.push({ trace: r.originalTrace, code: r.reasonCode, what: leg.kind === 'funding' ? this.returnFunding(leg, r.reasonCode) : this.returnPayout(leg, r.reasonCode) });
        } else if (entry.bankAccountId) {
          const a = this.store.bankAccounts.require(entry.bankAccountId, 'Bank account');
          if (a.status === 'disabled') {
            alreadyApplied.push(r.originalTrace);
            continue;
          }
          this.store.bankAccounts.put({ ...a, status: 'disabled', disabledReason: `Prenote returned ${r.reasonCode}: ${r.meaning}`, verification: { ...a.verification, status: 'failed', reason: `${r.reasonCode}: ${r.meaning}` } });
          applied.push({ trace: r.originalTrace, code: r.reasonCode, what: 'prenote returned; account disabled' });
        }
      }
      for (const c of parsed.changes) {
        const hit = this.findEntry(c.originalTrace);
        const accountId = hit?.entry.bankAccountId ?? (hit?.entry.legId ? this.store.legs.get(hit.entry.legId)?.bankAccountId : undefined);
        if (accountId) {
          const a = this.store.bankAccounts.get(accountId);
          if (a) this.store.bankAccounts.put({ ...a, status: 'needs_update', notificationOfChange: { changeCode: c.changeCode, correctedData: c.correctedData, receivedAt: this.now().toISOString() } });
        }
        changeNotices.push({ trace: c.originalTrace, changeCode: c.changeCode, ...(accountId ? { bankAccountId: accountId } : {}) });
      }
    });
    return { applied, alreadyApplied, unmatched, changeNotices };
  }

  /** A returned employer debit. If it had settled, the funding is unwound; if employees were already paid from it, that is an exposure a person must recover. */
  private returnFunding(leg: MoneyLeg, code: string): string {
    const info = RETURN_CODES[code] ?? { meaning: 'Unrecognised return reason', action: 'needs_review' as const };
    const run = this.store.payRuns.require(leg.runId, 'Pay run');
    const wasSettled = leg.status === 'settled';
    this.store.legs.put({ ...leg, status: 'returned', returnCode: code, failureMessage: `${code}: ${info.meaning}`, updatedAt: this.now().toISOString() });
    if (wasSettled) {
      const t = run.totals;
      postEntry(this.store, { companyId: leg.companyId, runId: run.id, legId: leg.id, memo: `Employer debit returned (${code})`, lines: [{ account: 'bank_cash', creditCents: leg.amountCents }, { account: 'employee_net_pay', debitCents: t.payableCents }, { account: 'tax_withheld', debitCents: t.employeeTaxCents }, { account: 'tax_employer', debitCents: t.employerTaxCents }, { account: 'deductions_held', debitCents: t.deductionsCents }] });
    }
    const paidOut = this.store.legs.where((l) => l.runId === run.id && l.kind === 'employee_payout' && (l.status === 'settled' || l.status === 'submitted')).length > 0;
    this.alert(run.id, paidOut ? 'debit_returned_after_payout' : 'debit_returned', `The employer's debit was returned (${code}: ${info.meaning}).${paidOut ? ' Employees had already been paid from it, so Totali is exposed for that amount. See the ledger.' : ' No employees had been paid.'}`);
    if (info.action === 'bad_account' || info.action === 'unauthorized') {
      const a = this.store.bankAccounts.get(leg.bankAccountId);
      if (a) this.store.bankAccounts.put({ ...a, status: 'disabled', disabledReason: `Debit returned ${code}: ${info.meaning}` });
      if (info.action === 'unauthorized') {
        const company = this.store.companies.require(leg.companyId, 'Company');
        this.store.companies.put({ ...company, funding: { ...company.funding, debitAuthorization: undefined } });
      }
    }
    if (!paidOut) this.backToApprovedFrom(run.id);
    return `employer debit returned; ${paidOut ? 'employees already paid: exposure recorded' : 'run returned to approved'}`;
  }

  private backToApprovedFrom(runId: string): void {
    const run = this.store.payRuns.require(runId, 'Pay run');
    if (run.status === 'funding' || run.status === 'funded') this.store.payRuns.put({ ...run, status: 'approved', fundedAt: undefined });
  }

  /** A returned employee credit: their net pay is owed again, and a bad account is disabled so it is never reused. */
  private returnPayout(leg: MoneyLeg, code: string): string {
    const info = RETURN_CODES[code] ?? { meaning: 'Unrecognised return reason', action: 'needs_review' as const };
    const wasSettled = leg.status === 'settled';
    this.store.legs.put({ ...leg, status: 'returned', returnCode: code, failureMessage: `${code}: ${info.meaning}`, updatedAt: this.now().toISOString() });
    if (wasSettled) postEntry(this.store, { companyId: leg.companyId, runId: leg.runId, legId: leg.id, memo: `Net pay returned (${code})`, lines: [{ account: 'bank_cash', debitCents: leg.amountCents }, { account: 'employee_net_pay', creditCents: leg.amountCents }] });
    if (info.action === 'bad_account' || info.action === 'unauthorized' || info.action === 'needs_review') {
      const a = this.store.bankAccounts.get(leg.bankAccountId);
      if (a && a.status === 'active') this.store.bankAccounts.put({ ...a, status: 'disabled', disabledReason: `Payment returned ${code}: ${info.meaning}` });
    }
    const run = this.store.payRuns.require(leg.runId, 'Pay run');
    if (run.status === 'completed') this.store.payRuns.put({ ...run, status: 'disbursing', completedAt: undefined });
    this.alert(leg.runId, 'payout_returned', `A payment to employee ${leg.employeeId} was returned (${code}: ${info.meaning}). Their net pay is owed again. Their bank account was ${info.action === 'retry_later' ? 'kept' : 'disabled'}; they need a working account before they can be paid.`);
    return 'payment returned; net pay owed again';
  }

  private alert(runId: string, code: string, message: string): void {
    const run = this.store.payRuns.require(runId, 'Pay run');
    this.store.payRuns.put({ ...run, alerts: [...(run.alerts ?? []), { at: this.now().toISOString(), code, message }] });
  }
}

/**
 * The routine a timer calls: move calendar-driven things forward, hand over
 * any file that was built but not handed over, and (when asked) pay out runs
 * whose hold has passed. Every step is idempotent.
 */
export async function reconcile(ach: AchService, store: Store, opts: { autoDisburse: boolean; log?: (msg: string) => void }): Promise<void> {
  const log = opts.log ?? (() => {});
  ach.advance();
  for (const f of store.achFiles.where((x) => x.status === 'created')) {
    try {
      await ach.submitFile(f.id);
    } catch (e) {
      log(`reconcile submit ${f.id}: ${(e as Error).message}`);
    }
  }
  if (!opts.autoDisburse) return;
  for (const run of store.payRuns.where((r) => r.status === 'funded' || r.status === 'disbursing')) {
    try {
      await ach.disbursePayRun(run.companyId, run.id);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== 'funds_on_hold' && code !== 'disbursement_in_progress') log(`reconcile disbursing ${run.id}: ${(e as Error).message}`);
    }
  }
}
