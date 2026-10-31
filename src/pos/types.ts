/** The point-of-sale and time-clock systems Totali can read from. */
export type PosProviderId = 'toast' | 'square' | 'clover' | 'sevenshifts' | 'file';

/** Someone on the other system's staff list. */
export interface PosPerson {
  externalId: string;
  firstName: string;
  lastName: string;
  email?: string;
}

/** One clocked shift, already reduced to what payroll needs. Money is in cents, time in minutes. */
export interface PosShift {
  /** The other system's id for this shift, so reading it again replaces it instead of paying it twice. */
  externalId: string;
  personId: string;
  /** The day the shift started, in the restaurant's local calendar. */
  workDate: string;
  clockIn: string;
  clockOut: string;
  /** Paid minutes: the time between clock in and clock out, less unpaid breaks. */
  minutes: number;
  cardTipsCents: number;
  cashTipsCents: number;
}

/** What one connection to a provider does, with the owner's credentials already bound in. */
export interface PosAdapter {
  /** Proves the credentials work, and says which restaurant they open. */
  check(): Promise<{ label: string; creds?: Record<string, string> }>;
  people(): Promise<PosPerson[]>;
  /** Closed shifts that started between two local dates, inclusive. */
  shifts(from: string, to: string, timezone: string): Promise<{ shifts: PosShift[]; notes: string[] }>;
}

export interface PosField { name: string; label: string; secret?: boolean; optional?: boolean; hint?: string; options?: Array<{ value: string; label: string }> }

export interface PosProviderInfo {
  id: PosProviderId;
  name: string;
  /** What it brings in. */
  brings: string[];
  /** Where the owner finds the details to paste in, one step each. */
  steps: string[];
  /** Something the owner should know before relying on it. */
  caution?: string;
  /** The owner can sign in at the other system and approve Totali, instead of pasting a token. */
  signIn?: boolean;
  fields: PosField[];
}

export interface PosSummary {
  at: string;
  from: string;
  to: string;
  shifts: number;
  people: number;
  minutes: number;
  tipsCents: number;
  removed: number;
  unmapped: Array<{ externalId: string; name: string; minutes: number }>;
  problems: string[];
  notes: string[];
}

/** A restaurant's link to one provider. The credentials are stored encrypted and never leave the server. */
export interface PosConnection {
  id: string;
  companyId: string;
  provider: PosProviderId;
  label: string;
  credentialsEncrypted: string;
  /** Their id on the other system -> a Totali employee, or null for "not on my payroll". */
  employeeMap: Record<string, string | null>;
  connectedAt: string;
  lastSyncAt?: string;
  lastError?: string;
  lastSummary?: PosSummary;
}
