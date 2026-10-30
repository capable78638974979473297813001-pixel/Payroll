import type { Cents } from '../lib/money.ts';
import type { Issue } from '../lib/issues.ts';
import type { CompanySettings } from '../industries/types.ts';
import type { DeductionPlan, DirectDepositAccount, ExtendedYearToDate } from '../../engine/payroll/types.ts';
import type { EmployerContext, FederalW4, StateWithholding, TaxLine } from '../../engine/src/types.ts';

export type PayFrequency = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';

export interface Company {
  id: string;
  legalName: string;
  ein: string;
  industry: string;
  niche: string;
  /** The state the establishment is in. Decides whether a tip credit is in effect for pooling rules. */
  homeState: string;
  address?: string;
  paySchedule: { frequency: PayFrequency; checkDateLagDays: number };
  settings: CompanySettings;
  /** The employer's own SUI rates and similar facts only the employer knows. Passed to the tax engine as-is. */
  employerContext?: EmployerContext;
  /** Prior-year typical daily headcount, for the Form 8027 test. */
  typicalDailyEmployees?: number;
  /** MasteryTax inputs: state account numbers, deposit schedule, 941 lookback. */
  taxAccounts?: {
    state?: Record<string, { account?: string; suiRate?: number }>;
    federalSchedule?: 'monthly' | 'semiweekly';
    lookback941LiabilityDollars?: number;
  };
  /**
   * Who sends the money.
   *   employer_bank: the employer's own bank does. Totali writes the payment file; the employer releases it at their bank
   *                  (and Totali can deliver it there by SFTP). Totali never debits anyone or holds money.
   *   totali_ach:    Totali originates through its own sponsoring bank. Requires that arrangement and admin set-up.
   */
  payment: PaymentSetup;
  /** Where the employer's payroll money is debited from, and the authorisation to do it. Used only in totali_ach mode. */
  funding: {
    bankAccountId?: string;
    debitAuthorization?: DebitAuthorization;
  };
  /** The Stripe customer that owns this company's bank links. Stripe is used only to connect to banks. */
  stripeCustomerId?: string;
  createdAt: string;
}

export interface EmployerBankSetup {
  /** Routing number of the employer's bank: the bank that receives the file. */
  odfiRoutingNumber: string;
  odfiName: string;
  /** The immediate-origin id the employer's bank assigned (file header). Often the employer's tax id or the bank's own id. */
  immediateOrigin: string;
  /** The 10-character company id the bank assigned (batch header). */
  companyId: string;
  /** How files are named for the bank. Tokens: {date} {time} {seq} {routing} {companyId}. */
  fileNameTemplate: string;
  /**
   * Banking days a payroll file needs between being prepared and taking effect. Standard ACH is 1. A bank can
   * require more: Chase for Business says payroll must be created at least two business days before the day it
   * debits the employer, which is itself before the effective date. 0 means the bank accepts same-day files.
   */
  leadBankingDays?: number;
  /** Automatic delivery to the bank's SFTP server, when the bank offers it. Delivery is not approval: the employer still releases the file at the bank. */
  sftp?: {
    host: string;
    port: number;
    username: string;
    remoteDir: string;
    /** The bank's SFTP host key, one known_hosts line. The connection is refused if the server does not present it. */
    knownHostsLine: string;
    /** Encrypted at rest; never returned. */
    privateKeyEncrypted: string;
  };
}

export interface PaymentSetup {
  mode: 'employer_bank' | 'totali_ach';
  employerBank?: EmployerBankSetup;
}

/** The employer's written authorisation for Totali to debit their account (NACHA requires one for every debit). */
export interface DebitAuthorization {
  bankAccountId: string;
  acceptedAt: string;
  acceptedBy: string;
  /** The version of the authorisation text shown, so a later change in wording is traceable. */
  textVersion: string;
  ip?: string;
}

/** How one of an employee's bank accounts takes its share of net pay. Exactly one account is the 'remainder'. */
export interface PayoutAccount {
  bankAccountId: string;
  allocation: DirectDepositAccount['allocation'];
  priority?: number;
}

/**
 * A bank account Totali holds the numbers for, encrypted. Stripe Financial
 * Connections proves the person can log in to the bank and reports the
 * last four digits, the account owners and the balance; the full number is
 * entered by the account holder and must agree with those last four digits.
 */
export interface BankAccount {
  id: string;
  companyId: string;
  ownerKind: 'company' | 'employee';
  /** The company id or employee id. */
  ownerId: string;
  holderType: 'business' | 'individual';
  accountType: 'checking' | 'savings';
  routingNumber: string;
  accountNumberEncrypted: string;
  last4: string;
  institutionName?: string;
  link?: {
    provider: 'stripe_financial_connections';
    sessionId: string;
    fcAccountId: string;
    linkedAt: string;
    ownerNames: string[];
    ownership: 'match' | 'mismatch' | 'unavailable';
    /** What kind of account number Stripe holds for this link. Informational: Totali enters its own. */
    stripeNumberType?: 'permanent' | 'tokenized' | 'none';
    balanceCents?: Cents;
    balanceAsOf?: string;
  };
  verification: {
    method: 'bank_link' | 'prenote';
    status: 'pending' | 'verified' | 'failed';
    reason?: string;
    prenoteFileId?: string;
    prenoteSettlementDate?: string;
    verifiedAt?: string;
  };
  status: 'pending' | 'active' | 'disabled' | 'needs_update';
  disabledReason?: string;
  /** A notification of change from the receiving bank: the corrected details to use. The account is held until a person applies it. */
  notificationOfChange?: { changeCode: string; correctedData: string; receivedAt: string };
  createdAt: string;
}

/** A Stripe Financial Connections session Totali started for one owner, so only that owner's accounts can complete it. */
export interface BankLink {
  /** The Stripe session id. */
  id: string;
  companyId: string;
  ownerKind: 'company' | 'employee';
  ownerId: string;
  customerId: string;
  permissions: string[];
  createdAt: string;
  completedAt?: string;
}

export interface AchFileEntry {
  ref: string;
  traceNumber: string;
  kind: 'credit' | 'debit' | 'prenote_credit' | 'prenote_debit';
  amountCents: Cents;
  legId?: string;
  bankAccountId?: string;
}

/** An ACH file Totali built. The content holds full account numbers, so it is stored encrypted. */
export interface AchFile {
  id: string;
  companyId: string;
  runId?: string;
  kind: 'debit' | 'credit' | 'prenote';
  fileName: string;
  contentEncrypted: string;
  effectiveDate: string;
  entries: AchFileEntry[];
  totals: { entryCount: number; debitCents: Cents; creditCents: Cents };
  /** created: built, not yet handed over. queued: handed over (e.g. written to the outbox), waiting for the bank to acknowledge. accepted: the bank has it. rejected: the bank refused it. */
  status: 'created' | 'queued' | 'accepted' | 'rejected';
  /** Who sends it: Totali through its own bank, or the employer through theirs. */
  rail: 'totali' | 'employer';
  submitter?: string;
  reference?: string;
  message?: string;
  /** Employer-bank mode: how the file reached the bank. */
  delivery?: { channel: 'download' | 'sftp'; status: 'none' | 'sent' | 'failed'; at?: string; remotePath?: string; message?: string };
  /** Employer-bank mode: the employer said they released it at their bank. */
  releasedAt?: string;
  releasedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Counter {
  id: string;
  value: number;
}

export interface Employee {
  id: string;
  companyId: string;
  firstName: string;
  lastName: string;
  email?: string;
  roleKey: string;
  hireDate: string;
  terminationDate?: string;
  payType: { kind: 'hourly'; rateCents: Cents } | { kind: 'salary'; annualCents: Cents };
  /** Cash hourly rate by role, for people who work more than one. A role not listed uses payType.rateCents. */
  roleRates: Record<string, Cents>;
  workState: StateWithholding;
  residenceState: StateWithholding;
  federalW4: FederalW4;
  deductionPlans: DeductionPlan[];
  ageAtYearEnd?: number;
  /** AES-256-GCM ciphertext. Never returned by the API. */
  ssnEncrypted?: string;
  ssnLast4?: string;
  /** Date the employee acknowledged the written tip-credit notice. */
  tipCreditNoticeDate?: string;
  /** Where net pay goes. Empty means the employee is not set up for direct deposit. */
  payoutAccounts: PayoutAccount[];
  /** The Stripe customer that owns this employee's bank links. */
  stripeCustomerId?: string;
  ytd: ExtendedYearToDate;
  ytdYear: number;
  /** Set when opening balances were loaded from a previous provider. */
  ytdImport?: { asOf: string; importedAt: string };
  createdAt: string;
}

export interface Shift {
  id: string;
  companyId: string;
  employeeId: string;
  /** The day the shift started, in the restaurant's local calendar. Overnight shifts belong to the day they began. */
  workDate: string;
  roleKey: string;
  minutes: number;
  clockIn?: string;
  clockOut?: string;
  /** A caller's own id (a POS shift id), so re-sending the same shift replaces it instead of paying it twice. */
  externalId?: string;
  rateCentsPerHour?: Cents;
  /** Length of the regularly scheduled shift, when there is one. Caps New York call-in pay. */
  scheduledMinutes?: number;
  chargedTipsCents: Cents;
  cashTipsCents: Cents;
  salesCents: Cents;
  mealBreakViolation: boolean;
  restBreakViolation: boolean;
  lockedByRunId?: string;
  createdAt: string;
}

export interface HouseDay {
  id: string;
  companyId: string;
  date: string;
  houseTipsCents: Cents;
  serviceChargesCents: Cents;
  lockedByRunId?: string;
}

export interface EarningLine {
  code: string;
  category: 'regular' | 'supplemental' | 'reimbursement' | 'imputed' | 'housing_allowance';
  amountCents: Cents;
  minutes?: number;
  detail: string;
  /** Cash tips the employee already holds: taxed here, never paid by payroll. */
  paidByPayroll: boolean;
}

export interface Adjustment {
  employeeId: string;
  code: string;
  label: string;
  category: 'supplemental' | 'reimbursement' | 'regular';
  amountCents: Cents;
}

export interface Paycheck {
  employeeId: string;
  name: string;
  earnings: EarningLine[];
  hours: number;
  /** Cash wages and tips the tax engine taxed (excludes reimbursements). */
  taxableWagesCents: Cents;
  reimbursementCents: Cents;
  cashTipsCents: Cents;
  netPayCents: Cents;
  /** What Totali actually transfers to the employee: net pay less cash tips they already hold. */
  payableCents: Cents;
  employeeTaxCents: Cents;
  employerTaxCents: Cents;
  deductionsCents: Cents;
  deductionLines: Array<{ code: string; category: string | null; amountCents: Cents }>;
  /** Employee taxes on cash tips that payroll could not collect because there was no cash pay left. Reported on the W-2. */
  uncollectedCents: Cents;
  taxLines: TaxLine[];
  electiveDeferrals?: { section402gAggregate?: Cents; deferral457?: Cents; simple?: Cents };
  tips: {
    chargedKeptCents: Cents;
    tipOutReceivedCents: Cents;
    tipOutPaidCents: Cents;
    poolShareCents: Cents;
    cashCents: Cents;
    serviceChargeCents: Cents;
    cardFeeCents: Cents;
  };
  weeks: Array<{ weekStart: string; weekEnd: string; minutes: number; overtimeMinutes: number; doubleTimeMinutes: number; regularRateCentsPerHour: Cents; creditClaimedCents: Cents; tipsReceivedCents: Cents; makeupCents: Cents }>;
}

export type PayRunStatus =
  | 'draft'
  | 'approved'
  | 'funding'
  | 'funded'
  | 'disbursing'
  | 'completed'
  | 'failed'
  | 'voided';

export interface PayRun {
  id: string;
  companyId: string;
  periodStart: string;
  periodEnd: string;
  checkDate: string;
  status: PayRunStatus;
  adjustments: Adjustment[];
  paychecks: Paycheck[];
  issues: Issue[];
  reviewAcknowledgedAt?: string;
  totals: {
    grossCents: Cents;
    payableCents: Cents;
    employeeTaxCents: Cents;
    employerTaxCents: Cents;
    deductionsCents: Cents;
    cashTipsCents: Cents;
    /** Everything the employer must put up: pay out + taxes withheld + employer taxes + deductions held. */
    fundingRequiredCents: Cents;
  };
  /** YTD snapshots, so an approved run that has not moved money can be voided exactly. */
  ytdBefore?: Record<string, { ytd: ExtendedYearToDate; ytdYear: number }>;
  ytdAfter?: Record<string, { ytd: ExtendedYearToDate; ytdYear: number }>;
  createdAt: string;
  approvedAt?: string;
  fundedAt?: string;
  completedAt?: string;
  voidedAt?: string;
  /** Things that went wrong after money started moving and need a person: an ACH return after payout, a reversed transfer. */
  alerts?: Array<{ at: string; code: string; message: string }>;
}

/**
 * One ACH entry's worth of money: the employer debit, or one credit to one of
 * an employee's accounts. Created before the file is built, with the trace
 * number that will come back on any return.
 *
 *   pending    created, not yet in a file
 *   queued     in a file the bank has not acknowledged
 *   submitted  the bank has the file; waiting for the effective date
 *   settled    the effective date has passed (a debit: the bank confirmed the funds arrived) and no return has come
 *   returned   the receiving bank sent it back
 *   failed     the bank rejected the file, or it could not be built
 */
export interface MoneyLeg {
  id: string;
  companyId: string;
  runId: string;
  kind: 'funding' | 'employee_payout';
  /** Which rail carried it. Employer-bank legs never touch Totali's ledger: Totali holds none of that money. */
  rail?: 'totali' | 'employer';
  employeeId?: string;
  bankAccountId: string;
  amountCents: Cents;
  attempt: number;
  status: 'pending' | 'queued' | 'submitted' | 'settled' | 'returned' | 'failed';
  fileId?: string;
  traceNumber?: string;
  effectiveDate?: string;
  settledAt?: string;
  returnCode?: string;
  failureMessage?: string;
  /** Anything the operator should know about how this leg was made, for example that the employer's balance could not be checked. */
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerEntry {
  id: string;
  companyId: string;
  runId?: string;
  at: string;
  /** Always balanced across `lines`: debits equal credits. */
  memo: string;
  lines: Array<{ account: LedgerAccount; debitCents: Cents; creditCents: Cents }>;
  legId?: string;
}

/**
 * Where money sits, from Totali's point of view.
 *   bank_cash           Totali's settlement account at its bank (an asset: debits increase it)
 *   employee_net_pay    owed to employees until their transfer succeeds
 *   tax_withheld        employee taxes held for the agencies
 *   tax_employer        employer taxes held for the agencies
 *   deductions_held     benefit contributions, garnishments and the like held for their payees
 * The last four are liabilities: credits increase them.
 */
export type LedgerAccount = 'bank_cash' | 'employee_net_pay' | 'tax_withheld' | 'tax_employer' | 'deductions_held';

export interface ApiKey {
  id: string;
  /** sha256 of the secret. The secret itself is shown once. */
  hash: string;
  companyId: string;
  label: string;
  createdAt: string;
}

/** A tax deposit the company made (EFTPS, a state portal). Totali does not transmit deposits; this records them so MasteryTax can match them to what was due. */
export interface TaxDeposit {
  id: string;
  companyId: string;
  /** MasteryTax deposit group, e.g. US-941, CA-WH, PA-LOCAL. */
  depositGroup: string;
  date: string;
  amountCents: Cents;
  reference: string;
  createdAt: string;
}

/** Who did what: every write through the API leaves one of these. Bodies are never recorded, so no secrets or PII land here. */
export interface AuditEntry {
  id: string;
  at: string;
  /** 'admin' or the id of the company key's company. */
  actor: string;
  method: string;
  path: string;
  status: number;
  companyId?: string;
  ip?: string;
}
