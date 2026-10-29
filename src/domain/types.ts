import type { Cents } from '../lib/money.ts';
import type { Issue } from '../lib/issues.ts';
import type { CompanySettings } from '../industries/types.ts';
import type { DeductionPlan, ExtendedYearToDate } from '../../engine/payroll/types.ts';
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
  /** The employer's bank, held at Stripe. Totali never sees or stores the account number. */
  funding: {
    status: 'none' | 'pending' | 'ready';
    stripeCustomerId?: string;
    paymentMethodId?: string;
    bankLast4?: string;
  };
  createdAt: string;
}

export interface PayoutAccount {
  status: 'none' | 'onboarding' | 'ready' | 'restricted';
  /** A Stripe connected account that receives this employee's pay. Totali never sees or stores the bank account number. */
  stripeAccountId?: string;
  bankLast4?: string;
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
  payout: PayoutAccount;
  ytd: ExtendedYearToDate;
  ytdYear: number;
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

/** One movement of money through Stripe. Created before the Stripe call so a crash can resume, never double-pay. */
export interface MoneyLeg {
  id: string;
  companyId: string;
  runId: string;
  kind: 'funding' | 'employee_payout';
  employeeId?: string;
  amountCents: Cents;
  /** Stable per-leg idempotency key sent to Stripe. */
  idempotencyKey: string;
  /** Bumped when a failed leg is retried, because Stripe replays the stored result for a reused idempotency key. */
  attempt: number;
  status: 'pending' | 'created' | 'processing' | 'succeeded' | 'failed' | 'reversed' | 'canceled';
  stripeObjectId?: string;
  stripeChargeId?: string;
  failureMessage?: string;
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
 *   stripe_cash         the platform's Stripe balance (an asset: debits increase it)
 *   employee_net_pay    owed to employees until their transfer succeeds
 *   tax_withheld        employee taxes held for the agencies
 *   tax_employer        employer taxes held for the agencies
 *   deductions_held     benefit contributions, garnishments and the like held for their payees
 * The last four are liabilities: credits increase them.
 */
export type LedgerAccount = 'stripe_cash' | 'employee_net_pay' | 'tax_withheld' | 'tax_employer' | 'deductions_held';

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

export interface WebhookEvent {
  id: string;
  type: string;
  receivedAt: string;
}
