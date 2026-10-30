/**
 * A bank profile records what a bank has published about accepting ACH files,
 * so Totali can apply it: defaults when an employer sets up their bank, checks
 * on every payment file before it is offered for release, and the questions an
 * employer still has to ask their bank.
 *
 * Rule of this module: only facts read from the bank's own documents (or, where
 * marked, a search summary of them) go in. A fact that was not found is left
 * out and appears in `askBank`. Nothing is inferred and presented as the bank's
 * rule, except where a field says `derived`.
 */

export type BankProfileId =
  | 'chase_for_business'
  | 'jpmorgan_commercial'
  | 'wells_fargo'
  | 'bank_of_america'
  | 'us_bank'
  | 'pnc'
  | 'truist'
  | 'fifth_third'
  | 'regions'
  | 'keybank'
  | 'first_citizens'
  | 'johnson_financial'
  | 'banner_bank'
  | 'other';

/**
 * supported:        the bank documents SFTP delivery that Totali's key-based SFTP can use
 * unsupported_auth: the bank documents file delivery, but with a login Totali does not support (a password)
 * unconfirmed:      the bank has a file channel but I could not confirm it is SFTP, or how it logs in
 * none_found:       I found no automatic file delivery for this service
 */
export type SftpSupport = 'supported' | 'unsupported_auth' | 'unconfirmed' | 'none_found';

export interface BankSource {
  url: string;
  /** read: the bank's own document was read. search_summary: only a search summary of it was seen (the page would not load). */
  how: 'read' | 'search_summary';
  what: string;
}

export interface Cutoff {
  channel: string;
  /** Eastern time. */
  nextDay?: string;
  sameDay?: string;
}

export interface BankProfile {
  id: BankProfileId;
  name: string;
  coverage: 'large_bank' | 'smaller_bank' | 'generic';
  /** Routing numbers the bank's own file specification shows for the file header. Empty when none was read. */
  knownRoutingNumbers: string[];
  upload: 'yes' | 'unconfirmed';
  sftp: {
    support: SftpSupport;
    host?: string;
    testHost?: string;
    port?: number;
    auth: 'key' | 'key_or_password' | 'password' | 'unknown';
    notes: string[];
  };
  rules: {
    defaultLeadBankingDays?: { days: number; basis: 'documented' | 'derived' };
    sameDay: 'yes' | 'no' | 'unconfirmed';
    /** The file's effective date must be after the day the file is created. */
    effectiveMustFollowCreation?: boolean;
    maxAhead?: { days: number; unit: 'banking' | 'calendar'; applies: string };
    sameDayMaxEntryCents?: number;
    /** Limits that apply only on a named service tier (Regions' Online Banking Business Services). */
    limits?: { tier: string; perBatchCents: number; perMonthCents: number };
    /** The file header's immediate origin must look like this. */
    immediateOrigin?: { pattern: string; description: string };
    controlTotalsRequired?: boolean;
    ipAllowListRequired?: boolean;
    testFileRequired?: boolean;
    pgp: 'none' | 'optional' | 'unconfirmed';
    returnTrace?: string;
    payroll?: { standardEntryClass: 'PPD'; entryDescription?: string };
    notSupported?: string[];
  };
  cutoffsEt: Cutoff[];
  /** Plain-language notes shown to the employer. */
  guidance: string[];
  /** What I could not find and the employer has to ask. */
  askBank: string[];
  sources: BankSource[];
  verifiedOn: string;
}

export interface Finding {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
}
