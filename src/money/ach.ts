import { newId } from '../lib/ids.ts';
import { badRequest, conflict } from '../lib/errors.ts';
import { decryptField, encryptField } from '../lib/crypto.ts';
import { addBankingDays, isBankingDay, onOrAfterBankingDay, onOrBeforeBankingDay } from '../lib/bizdays.ts';
import { sum } from '../lib/money.ts';
import { allocateNetPay } from '../../engine/payroll/directDeposit.ts';
import { PRENOTE_WAITING_PERIOD_BUSINESS_DAYS } from '../../engine/payroll/directDepositVerification.ts';
import type { DirectDepositAccount } from '../../engine/payroll/types.ts';
import type { Store } from '../store/store.ts';
import type { AchFile, AchFileEntry, ApiEntry, BankAccount, Company, EmployerBankSetup, MoneyLeg, PayRun } from '../domain/types.ts';
import { getProfile } from '../banks/index.ts';
import { BankApiError, type ApiCredentials, type ApiPaymentState, type BankApiAdapter } from '../bankapi/types.ts';
import { JpMorganAdapter } from '../bankapi/jpmorgan.ts';
import { endToEndIdFor } from '../bankapi/jpmorgan.ts';
import { checkFile, errorsOf } from '../banks/checks.ts';
import type { Finding } from '../banks/types.ts';
import { buildAchFile, parseAchFile, type AchEntry, type Originator } from '../ach/nacha.ts';
import type { SubmitEntry, SubmitResult } from '../ach/submitter.ts';
import { parseReturnFile, RETURN_CODES } from '../ach/returns.ts';
import type { AchSubmitter } from '../ach/submitter.ts';
import { fillTemplate, SftpDelivery } from '../ach/sftp.ts';
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

export interface EmployerTimeline {
  mode: 'employer_bank';
  today: string;
  checkDate: string;
  targetCreditDate: string;
  earliestCreditEffectiveDate: string;
  onTime: boolean;
  note: string;
}

/** Minutes to wait after a failed SFTP delivery before the reconcile loop tries again. */
const SFTP_RETRY_MINUTES = 15;
const EXTERNAL_POLL_MINUTES = 15;

const OPEN: ReadonlyArray<MoneyLeg['status']> = ['pending', 'queued', 'submitted'];
const LIVE: ReadonlyArray<MoneyLeg['status']> = ['pending', 'queued', 'submitted', 'settled'];

export class AchService {
  private readonly store: Store;
  private readonly banks: BankService;
  private readonly submitter: AchSubmitter;
  private readonly cfg: AchConfig;
  private readonly now: () => Date;
  private readonly inflight = new Set<string>();
  private readonly sftp: SftpDelivery;
  private readonly bankApis: Record<string, BankApiAdapter>;

  constructor(store: Store, banks: BankService, submitter: AchSubmitter, cfg: AchConfig, opts: { now?: () => Date; sftp?: SftpDelivery; bankApis?: Record<string, BankApiAdapter> } = {}) {
    this.sftp = opts.sftp ?? new SftpDelivery();
    this.bankApis = opts.bankApis ?? { jpmorgan: new JpMorganAdapter(opts.now ? { now: opts.now } : {}) };
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
  private createFile(p: { companyId: string; runId?: string; kind: AchFile['kind']; effectiveDate: string; entries: Array<AchEntry & { legId?: string; bankAccountId?: string }>; sec: 'PPD' | 'CCD'; description: string; originator?: Originator; rail?: 'totali' | 'employer'; fileNameTemplate?: string }): AchFile {
    const seqStart = this.store.nextCounter('ach_trace', 1);
    for (let i = 1; i < p.entries.length; i++) this.store.nextCounter('ach_trace', 1);
    if (seqStart + p.entries.length > 9_999_999) throw new Error('The ACH trace number sequence is exhausted. Totali staff must reset it with the bank.');
    const fileNo = this.store.nextCounter('ach_file', 1);
    const dayCount = this.store.achFiles.where((f) => f.createdAt.slice(0, 10) === this.today()).length;
    const modifier = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[dayCount];
    if (!modifier) throw new Error('More than 36 ACH files today; the file ID modifier is exhausted.');
    const originator = p.originator ?? this.cfg.originator;
    const built = buildAchFile(originator, { standardEntryClass: p.sec, entryDescription: p.description, effectiveEntryDate: p.effectiveDate, entries: p.entries }, { createdAt: this.now(), firstTraceSequence: seqStart, fileIdModifier: modifier });
    const entries: AchFileEntry[] = built.entries.map((b, i) => ({ ref: b.ref, traceNumber: b.traceNumber, kind: b.kind, amountCents: b.amountCents, ...(p.entries[i].legId ? { legId: p.entries[i].legId } : {}), ...(p.entries[i].bankAccountId ? { bankAccountId: p.entries[i].bankAccountId } : {}) }));
    const at = this.now().toISOString();
    const file: AchFile = {
      id: newId('ach'),
      companyId: p.companyId,
      ...(p.runId ? { runId: p.runId } : {}),
      kind: p.kind,
      fileName: p.fileNameTemplate
        ? fillTemplate(p.fileNameTemplate, { date: this.now().toISOString().slice(0, 10).replace(/-/g, ''), time: this.now().toISOString().slice(11, 16).replace(':', ''), seq: String(fileNo).padStart(5, '0'), routing: originator.odfiRoutingNumber, companyId: originator.companyId })
        : `TOTALI_${p.kind.toUpperCase()}_${p.effectiveDate.replace(/-/g, '')}_${String(fileNo).padStart(5, '0')}.ach`,
      rail: p.rail ?? 'totali',
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

  /** The payments in a built file, read back from the file itself so a retry sends exactly what the first try did. */
  private submitEntries(file: AchFile, content: string): { description: string; companyName: string; entries: SubmitEntry[] } {
    const parsed = parseAchFile(content);
    if (parsed.errors.length > 0) throw new Error(`File ${file.id} no longer parses: ${parsed.errors.join('; ')}`);
    const entries: SubmitEntry[] = [];
    for (const b of parsed.batches) {
      for (const e of b.entries) {
        const mine = file.entries.find((x) => x.traceNumber === e.traceNumber);
        if (!mine) throw new Error(`File ${file.id} has an entry with trace ${e.traceNumber} that Totali has no record of`);
        entries.push({ ref: mine.ref, traceNumber: e.traceNumber, kind: mine.kind, standardEntryClass: b.standardEntryClass, amountCents: e.amountCents, routingNumber: `${e.rdfi8}${e.checkDigit}`, accountNumber: e.accountNumber, accountType: e.transactionCode[1] === '3' ? 'savings' : 'checking', name: e.individualName, individualId: e.individualId, ...(mine.externalId ? { externalId: mine.externalId } : {}) });
      }
    }
    const first = parsed.batches[0];
    return { description: first?.entryDescription ?? 'PAYROLL', companyName: first?.companyName ?? '', entries };
  }

  /** Hand a built file to the bank. Safe to repeat: a file the bank already has is left alone, and for an API bank only the payments it does not yet have are sent. */
  async submitFile(fileId: string): Promise<AchFile> {
    const file = this.store.achFiles.require(fileId, 'ACH file');
    const again = file.status === 'queued' && file.retryable === true;
    if (file.status !== 'created' && !again) return file;
    if (file.rail === 'employer') return this.deliverFile(fileId);
    const content = decryptField(file.contentEncrypted);
    const result = await this.submitter.submit({ fileId: file.id, fileName: file.fileName, content, kind: file.kind, effectiveDate: file.effectiveDate, entryCount: file.totals.entryCount, totalCents: file.totals.debitCents + file.totals.creditCents, ...this.submitEntries(file, content) });
    return this.store.tx(() => {
      const fresh = this.store.achFiles.require(fileId, 'ACH file');
      if (result.entries) return this.applyEntryResults(fresh, result);
      this.store.achFiles.put({ ...fresh, status: result.status === 'rejected' ? 'rejected' : result.status === 'accepted' ? 'accepted' : 'queued', submitter: this.submitter.name, ...(result.reference ? { reference: result.reference } : {}), message: result.message, updatedAt: this.now().toISOString() });
      if (result.status === 'accepted') this.acceptLegs(fresh);
      if (result.status === 'rejected') this.rejectLegs(fresh, result.message);
      return this.store.achFiles.require(fileId, 'ACH file');
    });
  }

  /** An API bank answered payment by payment: record each, move each payment's leg, and settle the file's own state. Call inside store.tx(). */
  private applyEntryResults(fresh: AchFile, result: SubmitResult): AchFile {
    const at = this.now().toISOString();
    const per = result.entries!;
    const entries = fresh.entries.map((e) => {
      const r = per[e.ref];
      if (!r) return e;
      return { ...e, ...(r.externalId ? { externalId: r.externalId } : {}), ...(r.externalStatus ? { externalStatus: r.externalStatus } : {}), ...(r.traceNumber ? { bankTraceNumber: r.traceNumber } : {}) };
    });
    const next = this.store.achFiles.put({ ...fresh, entries, status: result.status, submitter: this.submitter.name, retryable: result.status === 'queued', message: result.message, updatedAt: at });
    for (const e of entries) {
      const r = per[e.ref];
      if (!r) continue;
      if (r.state === 'accepted' && !fresh.entries.find((x) => x.ref === e.ref)?.externalId) this.acceptEntry(next, e);
      if (r.state === 'rejected') this.rejectLegs({ ...next, entries: [e] }, r.message ?? 'The bank rejected this payment.');
    }
    return this.store.achFiles.require(fresh.id, 'ACH file');
  }

  private acceptEntry(file: AchFile, e: AchFileEntry): void {
    if (e.legId) {
      const leg = this.store.legs.require(e.legId, 'Leg');
      if (leg.status === 'queued') this.store.legs.put({ ...leg, status: 'submitted', traceNumber: e.bankTraceNumber ?? e.traceNumber, updatedAt: this.now().toISOString() });
    } else if (e.bankAccountId && file.kind === 'prenote') {
      const a = this.store.bankAccounts.get(e.bankAccountId);
      if (a && a.verification.method === 'prenote' && a.verification.status === 'pending') this.store.bankAccounts.put({ ...a, verification: { ...a.verification, prenoteSettlementDate: file.effectiveDate } });
    }
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
    // A credit file nobody will send: if no payment for the run is still alive, the run goes back to approved so a new file can be prepared.
    if (file.kind === 'credit' && file.runId) {
      const stillAlive = this.store.legs.where((l) => l.runId === file.runId && l.kind === 'employee_payout' && LIVE.includes(l.status)).length > 0;
      const run = this.store.payRuns.get(file.runId);
      if (!stillAlive && run && run.status === 'disbursing') this.store.payRuns.put({ ...run, status: 'approved' });
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

  timeline(companyId: string, runId: string): Timeline | EmployerTimeline {
    const run = getRun(this.store, companyId, runId);
    if (this.store.companies.require(companyId, 'Company').payment.mode === 'employer_bank') {
      const today = this.today();
      const lead = this.store.companies.require(companyId, 'Company').payment.employerBank?.leadBankingDays ?? this.cfg.creditLeadBankingDays;
      const earliest = addBankingDays(onOrAfterBankingDay(today), lead);
      const target = onOrBeforeBankingDay(run.checkDate);
      return { mode: 'employer_bank', today, checkDate: run.checkDate, targetCreditDate: target, earliestCreditEffectiveDate: earliest, onTime: earliest <= target, note: "The employer's bank sends the money. This is the earliest the file can take effect if it is released at the bank in time for its cutoff." };
    }
    return planTimeline(this.today(), run.checkDate, this.cfg);
  }

  /**
   * Debit the employer for everything the run needs. Returns the plan: when the
   * money lands, the earliest employees can be paid, and whether that makes
   * the check date. If it does not, say so and refuse unless the caller
   * accepts paying late.
   */
  async fundPayRun(companyId: string, runId: string, opts: { acceptLate?: boolean } = {}): Promise<{ run: PayRun; leg: MoneyLeg; file: Omit<AchFile, 'contentEncrypted'> | null; timeline: Timeline; balanceCheck?: { checked: boolean; note: string } }> {
    this.requireMode(companyId, 'totali_ach');
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
    this.requireMode(companyId, 'totali_ach');
    this.requireConfigured();
    const run = getRun(this.store, companyId, runId);
    if (run.status !== 'funded' && run.status !== 'disbursing') throw conflict('not_funded', `Employees are paid only from a funded run; this run is ${run.status}.`);
    const release = this.releaseDate(runId);
    if (!release) throw conflict('not_funded', 'The employer debit has not settled, so nothing can be paid out.');
    if (this.today() < release) throw conflict('funds_on_hold', `The employer's debit can still be returned by their bank. Pay-out opens on ${release}.`, { releaseDate: release });
    if (this.inflight.has(runId)) throw conflict('disbursement_in_progress', 'A disbursement for this run is already running.');
    this.inflight.add(runId);
    try {
      const out = this.store.tx(() => this.buildCredits(companyId, runId, { rail: 'totali', description: 'PAYROLL' }));
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

  // ------------------------------------------------------------------ shared credit planning

  private requireMode(companyId: string, mode: 'employer_bank' | 'totali_ach'): Company {
    const company = this.store.companies.require(companyId, 'Company');
    if (company.payment.mode !== mode) {
      throw conflict('wrong_payment_mode', mode === 'totali_ach'
        ? "This company's payments are sent by the employer's own bank, not by Totali. Use prepare-payment to build the file for them to release."
        : "This company is set up for Totali to send payments through its own bank. Use fund and disburse.");
    }
    return company;
  }

  /**
   * Plan and build the credits for a run: one leg per employee account, never
   * more than each employee's approved net pay, nobody paid twice, employees
   * who are not set up listed as waiting. Call inside store.tx().
   */
  private buildCredits(companyId: string, runId: string, o: { rail: 'totali' | 'employer'; description: string; originator?: Originator; fileNameTemplate?: string; effectiveDate?: string }) {
    const fresh = getRun(this.store, companyId, runId);
    const waiting: Array<{ employeeId: string; amountCents: number; reason: string }> = [];
    const planned: Array<{ leg: MoneyLeg; account: BankAccount; employeeName: string }> = [];
    const at = this.now().toISOString();
    const earliest = addBankingDays(onOrAfterBankingDay(this.today()), this.cfg.creditLeadBankingDays);
    const target = onOrBeforeBankingDay(fresh.checkDate);
    const effectiveDate = o.effectiveDate ?? (target >= earliest ? target : earliest);
    const late = effectiveDate > target;

    for (const pc of fresh.paychecks.filter((x) => x.payableCents > 0)) {
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
      const accounts: DirectDepositAccount[] = employee.payoutAccounts.map((x) => ({ id: x.bankAccountId, routingNumber: '', accountNumber: '', accountType: 'checking', allocation: x.allocation, priority: x.priority }));
      for (const alloc of allocateNetPay(remaining, accounts)) {
        if (alloc.amount <= 0) continue;
        const account = this.store.bankAccounts.require(alloc.accountId, 'Bank account');
        const attempt = mine.filter((l) => l.bankAccountId === account.id).length + 1;
        const leg: MoneyLeg = { id: newId('leg'), companyId, runId, kind: 'employee_payout', rail: o.rail, employeeId: pc.employeeId, bankAccountId: account.id, amountCents: alloc.amount, attempt, status: 'pending', createdAt: at, updatedAt: at };
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
        description: o.description,
        ...(o.originator ? { originator: o.originator } : {}),
        rail: o.rail,
        ...(o.fileNameTemplate ? { fileNameTemplate: o.fileNameTemplate } : {}),
        entries: planned.map(({ leg, account, employeeName }) => {
          const n = numbersFor(account);
          return { ref: leg.id, legId: leg.id, bankAccountId: account.id, kind: 'credit' as const, accountType: account.accountType, routingNumber: n.routingNumber, accountNumber: n.accountNumber, amountCents: leg.amountCents, individualId: leg.employeeId!, individualName: employeeName };
        }),
      });
      if (late) this.alert(runId, 'paid_late', `Employees are being paid on ${effectiveDate}, after the ${target} target. The ACH timeline did not allow earlier.`);
    }
    this.store.payRuns.put({ ...this.store.payRuns.require(runId, 'Pay run'), status: 'disbursing' });
    return { file, planned, waiting, effectiveDate: file ? effectiveDate : null, late: file ? late : false, target };
  }

  // ------------------------------------------------------------------ employer-bank mode

  private requireEmployerBank(company: Company): EmployerBankSetup {
    const eb = company.payment.employerBank;
    if (!eb) throw conflict('payment_setup_incomplete', "Set up the employer's bank first (PUT /payment-setup): its routing number, name, and the ACH ids it assigned.");
    return eb;
  }

  private employerOriginator(company: Company, eb: EmployerBankSetup): Originator {
    return { odfiRoutingNumber: eb.odfiRoutingNumber, odfiName: eb.odfiName, immediateOrigin: eb.immediateOrigin, companyName: company.legalName, companyId: eb.companyId };
  }

  /**
   * Employer-bank mode: write the payment file the employer's own bank will
   * send. Totali debits no one and holds no money. The file carries the
   * employer bank's details in its header, pays net pay only (the employer pays
   * taxes at their own bank), and waits to be released by the employer at their
   * bank. If the bank takes SFTP and it is set up, the file is delivered there.
   */
  async preparePayment(companyId: string, runId: string, opts: { effectiveDate?: string; acceptLate?: boolean } = {}) {
    const company = this.requireMode(companyId, 'employer_bank');
    const eb = this.requireEmployerBank(company);
    const run = getRun(this.store, companyId, runId);
    if (run.status !== 'approved' && run.status !== 'disbursing') throw conflict('not_preparable', `Payment is prepared for an approved run; this run is ${run.status}.`);
    if (this.inflight.has(runId)) throw conflict('preparation_in_progress', 'A payment file for this run is already being prepared.');

    const today = this.today();
    const lead = eb.leadBankingDays ?? this.cfg.creditLeadBankingDays;
    const earliest = addBankingDays(onOrAfterBankingDay(today), lead);
    const target = onOrBeforeBankingDay(run.checkDate);
    if (opts.effectiveDate !== undefined) {
      if (!isBankingDay(opts.effectiveDate)) throw badRequest('effectiveDate must be a banking day');
      if (opts.effectiveDate < earliest) throw badRequest(`effectiveDate cannot be earlier than ${earliest}: your bank needs ${lead} banking day(s) between preparing a payroll file and its effective date.`);
    }
    const effective = opts.effectiveDate ?? (target >= earliest ? target : earliest);
    if (effective > target && !opts.acceptLate) {
      throw conflict('check_date_unreachable', `Employees cannot be paid by ${target}: the earliest the file can take effect is ${earliest}. Prepare with acceptLate: true to proceed, or use a later check date.`, { target, earliest });
    }
    this.inflight.add(runId);
    try {
      let bankChecks: Finding[] = [];
      const out = this.store.tx(() => {
        const built = this.buildCredits(companyId, runId, { rail: 'employer', description: 'PAYROLL', originator: this.employerOriginator(company, eb), fileNameTemplate: eb.fileNameTemplate, effectiveDate: effective });
        if (built.file && eb.bankProfile) {
          // Inside the transaction: a file that breaks the bank's rules is undone, not offered for release.
          bankChecks = this.checkAgainstBank(company, eb, built.file);
          const errs = errorsOf(bankChecks);
          if (errs.length > 0) throw conflict('bank_rule_violation', `This payment file breaks ${getProfile(eb.bankProfile).name}'s rules: ${errs.map((e) => e.message).join(' ')}`, { findings: bankChecks });
        }
        return built;
      });
      if (out.file) await this.deliverFile(out.file.id);
      const file = out.file ? this.store.achFiles.get(out.file.id)! : null;
      const run2 = this.store.payRuns.require(runId, 'Pay run');
      return {
        status: run2.status,
        file: file ? this.fileMeta(file.id) : null,
        paying: out.planned.map(({ leg }) => ({ employeeId: leg.employeeId!, bankAccountId: leg.bankAccountId, amountCents: leg.amountCents })),
        waitingForBankAccount: out.waiting,
        effectiveDate: out.effectiveDate,
        late: out.late,
        bankChecks,
        needsInYourAccountCents: sum(out.planned.map(({ leg }) => leg.amountCents)),
        controlTotals: file ? { entryCount: file.totals.entryCount, creditsCents: file.totals.creditCents, debitsCents: file.totals.debitCents, note: 'Some banks (Truist, KeyBank) will not release a file until you type in these totals. They are the sum of all credits and, separately, of all debits in the file.' } : null,
        youPayYourselfCents: { employeeTaxesWithheld: run2.totals.employeeTaxCents, employerTaxes: run2.totals.employerTaxCents, deductionsHeld: run2.totals.deductionsCents },
        next: file && eb.api ? `Nothing has been sent to your bank. To send it, a named person approves this exact file in Totali: POST /ach/files/${file.id}/approve-and-send with approvedBy and confirm {entryCount: ${file.totals.entryCount}, creditsCents: ${file.totals.creditCents}}.` : file ? (file.delivery?.status === 'sent' ? "The file was delivered to your bank's SFTP server. Approve it in your bank's portal, then confirm here that you released it." : 'Download the file, import it in your bank\'s ACH portal and approve it there, then confirm here that you released it.') : 'Nothing to send: everyone owed is either paid or not set up yet.',
      };
    } finally {
      this.inflight.delete(runId);
    }
  }

  /** The employer's bank's published rules, applied to a file just built. */
  private checkAgainstBank(company: Company, eb: EmployerBankSetup, file: AchFile): Finding[] {
    const profile = getProfile(eb.bankProfile);
    const month = file.effectiveDate.slice(0, 7);
    const monthSoFarCents = sum(this.store.achFiles.where((f) => f.companyId === company.id && f.rail === 'employer' && f.id !== file.id && f.kind === 'credit' && f.status !== 'rejected' && f.effectiveDate.startsWith(month)).map((f) => f.totals.creditCents));
    return checkFile(profile, {
      kind: file.kind === 'prenote' ? 'prenote' : 'credit',
      today: this.today(),
      effectiveDate: file.effectiveDate,
      entryCount: file.totals.entryCount,
      creditsCents: file.totals.creditCents,
      debitsCents: file.totals.debitCents,
      largestEntryCents: Math.max(0, ...file.entries.map((e) => e.amountCents)),
      monthSoFarCents,
      ...(eb.limitsTier !== undefined ? { limitsTier: eb.limitsTier } : {}),
    });
  }

  /** Deliver an employer-bank file to the bank's SFTP server, if one is set up. Delivery is not approval: the file waits for the employer to release it. */
  async deliverFile(fileId: string, opts: { force?: boolean } = {}): Promise<AchFile> {
    const file = this.store.achFiles.require(fileId, 'ACH file');
    if (file.rail !== 'employer') return file;
    if (file.status !== 'created') return file;
    const company = this.store.companies.require(file.companyId, 'Company');
    const sftp = company.payment.employerBank?.sftp;
    const at = this.now().toISOString();
    if (!sftp) {
      if (file.delivery?.channel === 'download') return file; // already marked ready; nothing to rewrite
      return this.store.tx(() => this.store.achFiles.put({ ...file, delivery: { channel: 'download', status: 'none' }, message: 'Ready to download. Import it in your bank\'s ACH portal and release it there.', updatedAt: at }));
    }
    // After a failed delivery wait before trying again, so a wrong key or host cannot hammer the bank's server (or lock the employer out).
    if (!opts.force && file.delivery?.status === 'failed' && file.delivery.at && this.now().getTime() - Date.parse(file.delivery.at) < SFTP_RETRY_MINUTES * 60_000) return file;
    try {
      const { remotePath } = await this.sftp.deliver({ host: sftp.host, port: sftp.port, username: sftp.username, remoteDir: sftp.remoteDir, knownHostsLine: sftp.knownHostsLine, privateKey: decryptField(sftp.privateKeyEncrypted) }, file.fileName, decryptField(file.contentEncrypted));
      return this.store.tx(() => this.store.achFiles.put({ ...this.store.achFiles.require(fileId, 'ACH file'), status: 'queued', submitter: 'sftp', delivery: { channel: 'sftp', status: 'sent', at, remotePath }, message: "Delivered to the bank's SFTP server. It is not sent until the employer releases it at the bank.", updatedAt: at }));
    } catch (e) {
      return this.store.tx(() => this.store.achFiles.put({ ...this.store.achFiles.require(fileId, 'ACH file'), delivery: { channel: 'sftp', status: 'failed', at, message: (e as Error).message }, message: `SFTP delivery failed: ${(e as Error).message}. The file can be downloaded instead.`, updatedAt: at }));
    }
  }

  // ------------------------------------------------------------------ bank API (employer-bank mode)

  private apiFor(company: Company, eb: EmployerBankSetup): { creds: ApiCredentials; adapter: BankApiAdapter } {
    const api = eb.api;
    if (!api) throw conflict('api_not_set_up', "This company has no bank API set up. Use PUT /payment-setup with employerBank.api, or send the file through your bank's portal.");
    const adapter = this.bankApis[api.adapter];
    if (!adapter) throw conflict('api_adapter_missing', `No adapter for '${api.adapter}'.`);
    return {
      adapter,
      creds: {
        clientId: api.clientId,
        certThumbprint: api.certThumbprint,
        privateKeyPem: decryptField(api.privateKeyEncrypted),
        environment: api.environment,
        ...(api.tokenUrl ? { tokenUrl: api.tokenUrl } : {}),
        ...(api.baseUrl ? { baseUrl: api.baseUrl } : {}),
        ...(api.audience ? { audience: api.audience } : {}),
        debtor: { name: api.debtorName, accountNumber: decryptField(api.debtorAccountEncrypted), routingNumber: eb.odfiRoutingNumber, companyId: eb.companyId },
      },
    };
  }

  private setEntry(fileId: string, legId: string, patch: Partial<ApiEntry>, fileStatus?: AchFile['status']): AchFile {
    const f = this.store.achFiles.require(fileId, 'ACH file');
    const d = f.apiDelivery!;
    return this.store.achFiles.put({ ...f, ...(fileStatus ? { status: fileStatus } : {}), apiDelivery: { ...d, entries: { ...d.entries, [legId]: { ...d.entries[legId]!, ...patch } } }, updatedAt: this.now().toISOString() });
  }

  private failApiLeg(file: AchFile, legId: string, message: string): void {
    this.rejectLegs({ ...file, entries: file.entries.filter((e) => e.legId === legId) }, message);
  }

  /**
   * Send an approved payment file through the employer's bank API. This is the
   * one manual step: a named person approves the exact file (its entry count
   * and total, typed back) before anything is sent. Nothing calls the bank
   * before this, and nothing here approves on anyone's behalf.
   *
   * Never pays twice: each payment is marked `sending` before the call. If the
   * answer is lost or unclear it stays `unknown` and is not sent again until a
   * person settles it (resolveApiEntry). Safe to call again to finish a file
   * that stopped part way.
   */
  async approveAndSend(companyId: string, fileId: string, input: { approvedBy: string; confirm: { entryCount: number; creditsCents: number } }) {
    const company = this.requireMode(companyId, 'employer_bank');
    const eb = this.requireEmployerBank(company);
    const { creds, adapter } = this.apiFor(company, eb);
    const by = String(input.approvedBy ?? '').trim();
    if (!by) throw badRequest('approvedBy is required: the name of the person approving this file');
    const file0 = this.store.achFiles.require(fileId, 'ACH file');
    if (file0.companyId !== companyId || file0.rail !== 'employer' || file0.kind !== 'credit') throw badRequest("That is not one of this company's own payroll files");
    if (file0.status === 'rejected') throw conflict('file_cancelled', 'That file was cancelled. Prepare a new one.');
    if (file0.status === 'accepted' && !file0.apiDelivery) throw conflict('already_released', "That file was released at the bank by hand. Sending it again through the API would pay everyone twice.");
    if (input.confirm?.entryCount !== file0.totals.entryCount || input.confirm?.creditsCents !== file0.totals.creditCents) {
      throw badRequest(`The totals do not match this file. It has ${file0.totals.entryCount} entries totalling ${file0.totals.creditCents} cents. Approval means confirming exactly what will be sent.`);
    }
    if (file0.totals.creditCents > eb.api!.maxFileCents) throw conflict('over_file_cap', `This file (${file0.totals.creditCents} cents) is over the ${eb.api!.maxFileCents} cent ceiling set for the bank API. Raise it in the payment setup if that is intended.`);
    const today = this.today();
    if (file0.effectiveDate < today) throw conflict('file_stale', `This file was dated ${file0.effectiveDate}, which has passed. Cancel it and prepare a new one.`);
    if (eb.bankProfile) {
      const errs = errorsOf(this.checkAgainstBank(company, eb, file0));
      if (errs.length > 0) throw conflict('bank_rule_violation', `This file now breaks ${getProfile(eb.bankProfile).name}'s rules: ${errs.map((e) => e.message).join(' ')}`, { findings: errs });
    }
    if (this.inflight.has(fileId)) throw conflict('send_in_progress', 'This file is already being sent.');
    this.inflight.add(fileId);
    try {
      const at0 = this.now().toISOString();
      this.store.tx(() => {
        const f = this.store.achFiles.require(fileId, 'ACH file');
        const entries: Record<string, ApiEntry> = { ...(f.apiDelivery?.entries ?? {}) };
        for (const e of f.entries) if (e.legId && !entries[e.legId]) entries[e.legId] = { endToEndId: endToEndIdFor(e.legId), state: 'pending' };
        // A restart can leave a payment 'sending' with no answer: it may be at the bank, so it needs a person.
        for (const [k, v] of Object.entries(entries)) if (v.state === 'sending') entries[k] = { ...v, state: 'unknown', message: 'Totali stopped before the bank answered. It may have been accepted: check your bank, then resolve it.' };
        this.store.achFiles.put({ ...f, status: f.status === 'created' ? 'queued' : f.status, submitter: adapter.id, delivery: { channel: 'api', status: 'none', at: at0 }, apiDelivery: { adapter: adapter.id, approvals: [...(f.apiDelivery?.approvals ?? []), { at: at0, by, entryCount: f.totals.entryCount, creditsCents: f.totals.creditCents }], entries }, message: `Approved by ${by}. Sending through the bank's API.`, updatedAt: at0 });
      });

      let stopped: string | undefined;
      for (const e of this.store.achFiles.require(fileId, 'ACH file').entries) {
        if (!e.legId) continue;
        const cur = this.store.achFiles.require(fileId, 'ACH file').apiDelivery!.entries[e.legId]!;
        if (cur.state !== 'pending') continue;
        const leg = this.store.legs.require(e.legId, 'Leg');
        if (leg.status !== 'queued') continue;
        const account = this.store.bankAccounts.require(leg.bankAccountId, 'Bank account');
        const employee = this.store.employees.require(leg.employeeId!, 'Employee');
        const n = numbersFor(account);
        this.store.tx(() => this.setEntry(fileId, e.legId!, { state: 'sending' }));
        let result: Awaited<ReturnType<BankApiAdapter['send']>>;
        try {
          result = await adapter.send(creds, { legId: leg.id, amountCents: leg.amountCents, effectiveDate: file0.effectiveDate, recipientName: `${employee.firstName} ${employee.lastName}`, routingNumber: n.routingNumber, accountNumber: n.accountNumber, accountType: account.accountType });
        } catch (err) {
          const outcome = err instanceof BankApiError ? err.outcome : 'unknown';
          const message = err instanceof BankApiError ? err.message : 'Unexpected error while sending; the payment may have been accepted.';
          if (outcome === 'rejected') {
            this.store.tx(() => {
              this.setEntry(fileId, e.legId!, { state: 'rejected', bank: 'rejected', message });
              this.failApiLeg(this.store.achFiles.require(fileId, 'ACH file'), e.legId!, message);
              this.alert(leg.runId, 'api_payment_rejected', `The bank rejected the payment to ${employee.firstName} ${employee.lastName}: ${message}`);
            });
            continue;
          }
          this.store.tx(() => this.setEntry(fileId, e.legId!, outcome === 'not_sent' ? { state: 'pending', message } : { state: 'unknown', message }));
          stopped = message;
          break;
        }
        // A state that needs action (rejected, returned, held) is applied below, so it is not recorded here first.
        const plain = result.state === 'accepted' || result.state === 'processing' || result.state === 'completed';
        this.store.tx(() => {
          this.setEntry(fileId, e.legId!, { state: 'sent', ...(plain ? { bank: result.state } : {}), paymentId: result.paymentId, message: undefined });
          const l = this.store.legs.require(e.legId!, 'Leg');
          if (l.status === 'queued') this.store.legs.put({ ...l, status: 'submitted', updatedAt: this.now().toISOString() });
          if (!plain) this.applyBankState(fileId, e.legId!, result.state, 'Reported by the bank when it took the payment.');
        });
      }

      return this.store.tx(() => {
        const f = this.store.achFiles.require(fileId, 'ACH file');
        const states = Object.values(f.apiDelivery!.entries).map((x) => x.state);
        const count = (k: ApiEntry['state']) => states.filter((x) => x === k).length;
        const done = states.every((x) => x === 'sent' || x === 'rejected');
        const at = this.now().toISOString();
        const status: AchFile['status'] = done ? (count('sent') > 0 ? 'accepted' : 'rejected') : 'queued';
        const message = done ? `${count('sent')} payment(s) sent through the bank's API${count('rejected') ? `, ${count('rejected')} rejected by the bank` : ''}.` : `Stopped: ${stopped ?? 'payments still waiting'}. ${count('sent')} sent, ${count('pending')} not yet sent, ${count('unknown')} need checking at your bank.`;
        this.store.achFiles.put({ ...f, status, ...(done && count('sent') > 0 ? { releasedAt: at, releasedBy: by } : {}), delivery: { channel: 'api', status: done ? 'sent' : 'failed', at, ...(done ? {} : { message }) }, message, updatedAt: at });
        return { file: this.fileMeta(fileId), sent: count('sent'), rejected: count('rejected'), notYetSent: count('pending'), needsChecking: count('unknown'), complete: done, ...(stopped ? { stoppedBecause: stopped } : {}) };
      });
    } finally {
      this.inflight.delete(fileId);
    }
  }

  /** What the bank says about a payment, applied. Call inside store.tx(). */
  private applyBankState(fileId: string, legId: string, state: ApiPaymentState, detail?: string): void {
    const file = this.store.achFiles.require(fileId, 'ACH file');
    const before = file.apiDelivery!.entries[legId]!;
    const leg = this.store.legs.require(legId, 'Leg');
    this.setEntry(fileId, legId, { bank: state, polledAt: this.now().toISOString() });
    if (state === before.bank) return;
    if (state === 'rejected') {
      this.setEntry(fileId, legId, { state: 'rejected', message: detail });
      this.failApiLeg(file, legId, detail ?? 'The bank rejected this payment.');
      this.alert(leg.runId, 'api_payment_rejected', `The bank rejected a payment it had accepted (employee ${leg.employeeId}). ${detail ?? ''}`.trim());
    } else if (state === 'returned') {
      if (leg.status !== 'returned') this.returnPayout(leg, 'API');
    } else if (state === 'held_for_client') {
      this.alert(leg.runId, 'api_payment_held', `Your bank is holding a payment (employee ${leg.employeeId}) until your company takes an action. Check your bank's portal.`);
    }
  }

  /**
   * API-sent files worth asking the bank about: a payment still in flight, dated within the last 30 days, for a
   * company that still has the API set up. Without these limits the timer would ask about an old payment for ever,
   * or log an error every minute after an employer removed their credentials.
   */
  apiFilesToCheck(): AchFile[] {
    const cutoff = new Date(this.now().getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
    return this.store.achFiles.where((f) => {
      if (!f.apiDelivery || f.effectiveDate < cutoff) return false;
      if (!this.store.companies.get(f.companyId)?.payment.employerBank?.api) return false;
      return Object.values(f.apiDelivery.entries).some((e) => e.state === 'sent' && !!e.paymentId && e.bank !== 'completed' && e.bank !== 'rejected' && e.bank !== 'returned');
    });
  }

  /** Ask the bank where each payment from an API-sent file stands. Not more often than every 15 minutes per payment unless forced. */
  async refreshApiStatus(companyId: string, fileId: string, opts: { force?: boolean } = {}) {
    const company = this.requireMode(companyId, 'employer_bank');
    const eb = this.requireEmployerBank(company);
    const file = this.store.achFiles.require(fileId, 'ACH file');
    if (file.companyId !== companyId || !file.apiDelivery) throw badRequest('That file was not sent through the bank API');
    const { creds, adapter } = this.apiFor(company, eb);
    const nowMs = this.now().getTime();
    const checked: string[] = [];
    const failed: Array<{ legId: string; message: string }> = [];
    for (const [legId, entry] of Object.entries(file.apiDelivery.entries)) {
      if (entry.state !== 'sent' || !entry.paymentId || entry.bank === 'rejected' || entry.bank === 'returned' || entry.bank === 'completed') continue;
      if (!opts.force && entry.polledAt && nowMs - Date.parse(entry.polledAt) < SFTP_RETRY_MINUTES * 60_000) continue;
      try {
        const r = await adapter.status(creds, entry.paymentId);
        this.store.tx(() => this.applyBankState(fileId, legId, r.state, r.detail));
        checked.push(legId);
      } catch (err) {
        failed.push({ legId, message: (err as Error).message });
      }
    }
    return { checked: checked.length, failed, entries: this.store.achFiles.require(fileId, 'ACH file').apiDelivery!.entries };
  }

  /** A person settles a payment whose outcome Totali could not tell, after checking at the bank. */
  resolveApiEntry(companyId: string, fileId: string, legId: string, input: { outcome: 'sent' | 'not_sent'; resolvedBy: string; paymentId?: string }) {
    const by = input.resolvedBy.trim();
    if (!by) throw badRequest('resolvedBy is required: the person who checked at the bank');
    return this.store.tx(() => {
      const file = this.store.achFiles.require(fileId, 'ACH file');
      if (file.companyId !== companyId || !file.apiDelivery) throw badRequest('That file was not sent through the bank API');
      const entry = file.apiDelivery.entries[legId];
      if (!entry) throw badRequest('That payment is not in this file');
      if (entry.state !== 'unknown') throw conflict('not_unknown', `That payment is '${entry.state}'; only a payment whose outcome is unknown needs resolving.`);
      if (input.outcome === 'sent') {
        if (!input.paymentId || !/^[A-Za-z0-9-]{8,64}$/.test(input.paymentId)) throw badRequest("paymentId is required to mark it sent: copy it from your bank's portal");
        this.setEntry(fileId, legId, { state: 'sent', paymentId: input.paymentId, bank: 'accepted', message: `Confirmed at the bank by ${by}.` });
        const l = this.store.legs.require(legId, 'Leg');
        if (l.status === 'queued') this.store.legs.put({ ...l, status: 'submitted', updatedAt: this.now().toISOString() });
      } else {
        this.setEntry(fileId, legId, { state: 'pending', message: `Confirmed not at the bank by ${by}. Approve again to send it.` });
      }
      return this.fileMeta(fileId);
    });
  }

  /** The employer says they released this file at their bank. From here the payments take effect on the file's date. */
  markReleased(companyId: string, fileId: string, by: string): AchFile {
    if (!by.trim()) throw badRequest('releasedBy is required: the name of the person who approved it at the bank');
    return this.store.tx(() => {
      const file = this.store.achFiles.require(fileId, 'ACH file');
      if (file.companyId !== companyId || file.rail !== 'employer') throw badRequest('That is not one of this company\'s own payment files');
      if (file.status === 'accepted') return file;
      if (file.status === 'rejected') throw conflict('file_cancelled', 'That file was cancelled. Prepare a new one.');
      // Payments are already going out through the bank's API: marking the file released as well could lead to it being uploaded at the bank too.
      if (file.apiDelivery) throw conflict('sent_by_api', 'Payments from this file are being sent through your bank\'s API. Do not also upload the file at your bank.');
      const at = this.now().toISOString();
      const next = this.store.achFiles.put({ ...file, status: 'accepted', releasedAt: at, releasedBy: by.trim(), message: `The employer reported releasing this file at their bank (${by.trim()}).`, updatedAt: at });
      this.acceptLegs(file);
      return next;
    });
  }

  /** The employer will not release this file (or cancelled it at the bank). Only before release. */
  cancelFile(companyId: string, fileId: string): AchFile {
    return this.store.tx(() => {
      const file = this.store.achFiles.require(fileId, 'ACH file');
      if (file.companyId !== companyId || file.rail !== 'employer') throw badRequest('That is not one of this company\'s own payment files');
      if (file.status === 'rejected') return file;
      if (file.apiDelivery && Object.values(file.apiDelivery.entries).some((e) => e.state !== 'pending')) throw conflict('already_sent_by_api', 'Some payments from this file were already sent to your bank through its API. Ask the bank to recall them if they are wrong.');
      if (file.status === 'accepted') throw conflict('already_released', 'That file was already released at the bank. If a payment is wrong, ask the bank to recall it; anything that fails will come back as a return.');
      const next = this.store.achFiles.put({ ...file, status: 'rejected', message: 'Cancelled by the employer before release.', updatedAt: this.now().toISOString() });
      this.rejectLegs(file, 'Cancelled by the employer before release.');
      return next;
    });
  }

  // ------------------------------------------------------------------ prenotes

  /** Send a zero-dollar prenote for every employee account that is waiting to be verified. */
  async submitPrenotes(companyId: string): Promise<{ file: Omit<AchFile, 'contentEncrypted'> | null; accounts: string[] }> {
    const company = this.store.companies.require(companyId, 'Company');
    const employerRail = company.payment.mode === 'employer_bank';
    const eb = employerRail ? this.requireEmployerBank(company) : undefined;
    if (!employerRail) this.requireConfigured();
    const created = this.store.tx(() => {
      const pending = this.store.bankAccounts.where((a) => a.companyId === companyId && a.ownerKind === 'employee' && a.status === 'pending' && a.verification.method === 'prenote' && a.verification.status === 'pending' && !a.verification.prenoteFileId);
      if (pending.length === 0) return null;
      const effectiveDate = addBankingDays(onOrAfterBankingDay(this.today()), eb?.leadBankingDays ?? this.cfg.creditLeadBankingDays);
      const file = this.createFile({
        companyId,
        kind: 'prenote',
        effectiveDate,
        sec: 'PPD',
        description: 'PRENOTE',
        ...(eb ? { originator: this.employerOriginator(company, eb), rail: 'employer' as const, fileNameTemplate: eb.fileNameTemplate } : {}),
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
          if (leg.rail !== 'employer') postEntry(this.store, { companyId: leg.companyId, runId: leg.runId, legId: leg.id, memo: `Net pay sent to ${employee ? `${employee.firstName} ${employee.lastName}` : leg.employeeId}`, lines: [{ account: 'employee_net_pay', debitCents: leg.amountCents }, { account: 'bank_cash', creditCents: leg.amountCents }] });
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

  // ------------------------------------------------------------------ API banks: asking where payments stand

  /**
   * For a bank reached by API: ask where each payment stands and apply the answer. Settlement of the employer's
   * debit confirms the funds (what Totali staff would otherwise record by hand); a return undoes that payment the
   * same way a return file would; a cancelled payment fails. In-flight payments are asked about every 15 minutes,
   * settled ones daily until their return window has passed.
   */
  async syncExternal(): Promise<{ asked: number; applied: string[]; failed: string[] }> {
    const out = { asked: 0, applied: [] as string[], failed: [] as string[] };
    const status = this.submitter.status?.bind(this.submitter);
    if (!status) return out;
    const nowMs = this.now().getTime();
    for (const file of this.store.achFiles.where((f) => f.rail === 'totali' && f.entries.some((e) => !!e.externalId && !e.externalDone))) {
      for (const e of file.entries) {
        if (!e.externalId || e.externalDone) continue;
        const every = e.externalState === 'settled' ? 24 * 60 : EXTERNAL_POLL_MINUTES;
        if (e.externalPolledAt && nowMs - Date.parse(e.externalPolledAt) < every * 60_000) continue;
        let st: Awaited<ReturnType<NonNullable<AchSubmitter['status']>>>;
        try {
          st = await status(e.externalId);
          out.asked += 1;
        } catch (err) {
          out.failed.push(`${e.ref}: ${(err as Error).message}`);
          continue;
        }
        const confirm = this.store.tx(() => this.applyExternalStatus(file.id, e.ref, st));
        out.applied.push(`${e.ref}: ${st.detail}`);
        if (confirm) {
          // Outside the transaction: refusing (for example, the debit's date has not come) must not undo what was recorded above.
          try { this.confirmFundsReceived(confirm.runId, { reference: confirm.reference, amountCents: confirm.amountCents }); } catch (err) { out.failed.push(`${e.ref}: ${(err as Error).message}`); }
        }
      }
    }
    return out;
  }

  /** Record one payment's status. Returns a funds confirmation to make, when this payment is a settled employer debit. Call inside store.tx(). */
  private applyExternalStatus(fileId: string, ref: string, st: { state: NonNullable<AchFileEntry['externalState']>; detail: string; returnCode?: string; traceNumber?: string; amountCents?: number }): { runId: string; reference: string; amountCents: number } | undefined {
    const file = this.store.achFiles.require(fileId, 'ACH file');
    const entry = file.entries.find((x) => x.ref === ref)!;
    const at = this.now().toISOString();
    const changed = entry.externalState !== st.state;
    const leg = entry.legId ? this.store.legs.get(entry.legId) : undefined;
    // A payment stays interesting until its return window has passed: 60 days for an employer debit, 10 for a credit.
    const window = new Date(`${file.effectiveDate}T00:00:00Z`).getTime() + (leg?.kind === 'funding' ? 60 : 10) * 86_400_000;
    const done = st.state === 'returned' || st.state === 'cancelled' || (st.state === 'settled' && this.now().getTime() > window);
    const patch: Partial<AchFileEntry> = { externalStatus: st.detail, externalState: st.state, externalPolledAt: at, ...(done ? { externalDone: true } : {}), ...(st.traceNumber ? { bankTraceNumber: st.traceNumber } : {}) };
    this.store.achFiles.put({ ...file, entries: file.entries.map((x) => (x.ref === ref ? { ...x, ...patch } : x)), updatedAt: at });
    if (leg && st.traceNumber && leg.traceNumber !== st.traceNumber) this.store.legs.put({ ...leg, traceNumber: st.traceNumber });

    if (st.state === 'returned') {
      const code = st.returnCode ?? 'R99';
      this.applyReturn({ ...entry }, code, RETURN_CODES[code]?.meaning ?? 'Returned by the receiving bank');
    } else if (st.state === 'cancelled') {
      this.rejectLegs({ ...file, entries: [entry] }, 'The transfer was cancelled at the bank.');
    } else if ((st.state === 'held' || st.state === 'needs_review') && changed && leg) {
      this.alert(leg.runId, `bank_transfer_${st.state}`, `The bank has a payment ${st.state === 'held' ? 'on hold' : 'that needs review'} (${st.detail}). Check the bank's dashboard.`);
    } else if (st.state === 'settled' && leg?.kind === 'funding' && leg.status === 'submitted') {
      return { runId: leg.runId, reference: entry.externalId!, amountCents: st.amountCents ?? leg.amountCents };
    }
    return undefined;
  }

  // ------------------------------------------------------------------ returns

  private findEntry(trace: string, companyId?: string): { file: AchFile; entry: AchFileEntry } | undefined {
    for (const file of this.store.achFiles.all()) {
      if (companyId && file.companyId !== companyId) continue;
      const entry = file.entries.find((e) => e.traceNumber === trace || e.bankTraceNumber === trace);
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
  ingestReturnFile(text: string, opts: { companyId?: string } = {}): { applied: Array<{ trace: string; code: string; what: string }>; alreadyApplied: string[]; unmatched: string[]; changeNotices: Array<{ trace: string; changeCode: string; bankAccountId?: string }> } {
    const parsed = parseReturnFile(text);
    if (parsed.errors.length > 0) throw conflict('bad_return_file', `The return file is malformed: ${parsed.errors.join('; ')}`);
    const applied: Array<{ trace: string; code: string; what: string }> = [];
    const alreadyApplied: string[] = [];
    const unmatched: string[] = [];
    const changeNotices: Array<{ trace: string; changeCode: string; bankAccountId?: string }> = [];

    this.store.tx(() => {
      for (const r of parsed.returns) {
        const hit = this.findEntry(r.originalTrace, opts.companyId);
        if (!hit) {
          unmatched.push(r.originalTrace);
          continue;
        }
        const res = this.applyReturn(hit.entry, r.reasonCode, r.meaning);
        if (res === 'already') alreadyApplied.push(r.originalTrace);
        else applied.push({ trace: r.originalTrace, code: r.reasonCode, what: res });
      }
      for (const c of parsed.changes) {
        const hit = this.findEntry(c.originalTrace, opts.companyId);
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

  /** Undo one returned entry, whether it came in a return file or from an API bank. Call inside store.tx(). */
  private applyReturn(entry: AchFileEntry, code: string, meaning: string): string {
    if (entry.legId) {
      const leg = this.store.legs.require(entry.legId, 'Leg');
      if (leg.status === 'returned') return 'already';
      return leg.kind === 'funding' ? this.returnFunding(leg, code) : this.returnPayout(leg, code);
    }
    const a = this.store.bankAccounts.require(entry.bankAccountId!, 'Bank account');
    if (a.status === 'disabled') return 'already';
    this.store.bankAccounts.put({ ...a, status: 'disabled', disabledReason: `Prenote returned ${code}: ${meaning}`, verification: { ...a.verification, status: 'failed', reason: `${code}: ${meaning}` } });
    return 'prenote returned; account disabled';
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
    if (wasSettled && leg.rail !== 'employer') postEntry(this.store, { companyId: leg.companyId, runId: leg.runId, legId: leg.id, memo: `Net pay returned (${code})`, lines: [{ account: 'bank_cash', debitCents: leg.amountCents }, { account: 'employee_net_pay', creditCents: leg.amountCents }] });
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
  for (const f of store.achFiles.where((x) => x.status === 'created' || (x.status === 'queued' && x.retryable === true))) {
    try {
      await ach.submitFile(f.id);
    } catch (e) {
      log(`reconcile submit ${f.id}: ${(e as Error).message}`);
    }
  }
  try {
    const r = await ach.syncExternal();
    for (const m of r.failed) log(`reconcile bank status: ${m}`);
  } catch (e) {
    log(`reconcile bank status: ${(e as Error).message}`);
  }
  for (const f of ach.apiFilesToCheck()) {
    try {
      await ach.refreshApiStatus(f.companyId, f.id);
    } catch (e) {
      log(`reconcile api status ${f.id}: ${(e as Error).message}`);
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
