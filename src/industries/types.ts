/**
 * An industry is a catalog entry; a niche is the configured "app" inside it.
 * Choosing Restaurant → Full service at signup applies that niche's profile:
 * the roles you can hire into, how tips are shared, the compliance checklist,
 * and the pay rules the pay run enforces. Everything in a profile is a
 * starting point the company can edit; nothing here is a legal conclusion.
 */

/** DOL's test: does the occupation customarily and regularly receive tips? Drives tip-pool eligibility when a tip credit is taken. */
export type TippedStatus = 'customarily' | 'sometimes' | 'never';

export interface RoleTemplate {
  key: string;
  label: string;
  tipped: TippedStatus;
  /** Meets the FLSA executive-duties test in the usual case. A manager or supervisor never shares in a tip pool. */
  manager: boolean;
  pay: 'hourly' | 'salary';
  /** Relative weight when the tip pool shares by points instead of hours. */
  poolPoints: number;
  /** Delivery roles: vehicle costs are reimbursed, never netted out of wages. */
  reimbursesVehicleExpenses?: boolean;
  /** Workers' compensation class suggestion. The insurer assigns the real one. */
  workersCompHint?: string;
}

/** A mandatory tip-out: part of one role's tips (or sales) is passed to another role's staff on the same day. */
export interface TipOutRule {
  id: string;
  fromRole: string;
  toRole: string;
  basis: 'percent_of_tips' | 'percent_of_sales';
  /** Basis points: 150 = 1.5%. */
  bps: number;
}

export type TipPoolBasis = 'hours' | 'points';

export interface TipPolicy {
  /** Pay the tipped cash wage and count tips toward minimum wage. Only takes effect where the state allows a tip credit. */
  takesTipCredit: boolean;
  pool: { enabled: boolean; roles: string[]; basis: TipPoolBasis };
  tipOuts: TipOutRule[];
  /** A mandatory service charge is wages, not a tip (IRS Rev. Rul. 2012-18). */
  serviceCharge: 'none' | 'distribute_to_staff' | 'house_revenue';
  serviceChargeRoles: string[];
  /**
   * Pass the card-processing fee on to employees pro rata, in basis points of
   * charged tips. Whether that is lawful depends on the state, so it is off
   * unless the company turns it on.
   */
  cardFeeDeductionBps: number | null;
}

export type ChecklistWhen = 'onboarding' | 'each_pay_run' | 'quarterly' | 'annual' | 'ongoing';

export interface ChecklistItem {
  id: string;
  title: string;
  detail: string;
  when: ChecklistWhen;
  /** Limit to these states. Absent means every state. */
  states?: string[];
  /** The engine or Totali module that covers it, when one does. Absent means Totali only reminds. */
  coveredBy?: string;
  /** Totali does not compute or enforce this; the company has to. */
  notModelled?: boolean;
}

export interface NicheProfile {
  id: string;
  industry: string;
  label: string;
  tagline: string;
  description: string;
  roles: RoleTemplate[];
  policy: TipPolicy;
  payFrequency: 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';
  /** First day of the FLSA workweek, 0 = Sunday. */
  workweekStartDay: number;
  features: string[];
  checklist: ChecklistItem[];
  reports: string[];
}

export interface IndustryDef {
  id: string;
  label: string;
  /** `planned` industries are in the picker but cannot be selected yet. */
  status: 'available' | 'planned';
  description: string;
  niches: NicheProfile[];
}

/** The settings a company runs on: the niche profile copied at signup, then edited by the company. */
export interface CompanySettings {
  roles: RoleTemplate[];
  policy: TipPolicy;
  workweekStartDay: number;
  /** Local minimum-wage jurisdiction id from the engine (e.g. 'seattle'). Without it only federal and state floors apply. */
  locality?: string;
  /** New York's downstate/upstate style sub-region, where the state ruleset has one. */
  region?: string;
}
