import { parseAchFile } from './nacha.ts';

/**
 * ACH returns and notifications of change. A returned entry arrives in a
 * return file as an ordinary entry followed by a type 99 addenda that names
 * the reason and the trace number of the entry being returned. A
 * notification of change is a type 98 addenda telling the originator the
 * account details to use next time.
 *
 * Reason codes are from the NACHA Operating Rules. The table holds the codes
 * a payroll originator meets most; an unlisted code is surfaced as
 * 'unknown' and treated as needing a person, never silently ignored.
 */

export type ReturnAction =
  | 'retry_later' // the account is fine; try again once funds are there
  | 'bad_account' // the account cannot receive or send: stop using it
  | 'unauthorized' // the account holder says they did not authorise the entry
  | 'needs_review';

export const RETURN_CODES: Record<string, { meaning: string; action: ReturnAction }> = {
  R01: { meaning: 'Insufficient funds', action: 'retry_later' },
  R02: { meaning: 'Account closed', action: 'bad_account' },
  R03: { meaning: 'No account / unable to locate account', action: 'bad_account' },
  R04: { meaning: 'Invalid account number structure', action: 'bad_account' },
  R05: { meaning: 'Unauthorized debit to a consumer account using a corporate SEC code', action: 'unauthorized' },
  R06: { meaning: 'Returned per ODFI request', action: 'needs_review' },
  R07: { meaning: 'Authorization revoked by customer', action: 'unauthorized' },
  R08: { meaning: 'Payment stopped', action: 'unauthorized' },
  R09: { meaning: 'Uncollected funds', action: 'retry_later' },
  R10: { meaning: 'Customer advises not authorized, improper or ineligible', action: 'unauthorized' },
  R11: { meaning: 'Customer advises entry not in accordance with the authorization', action: 'unauthorized' },
  R12: { meaning: 'Branch sold to another RDFI', action: 'bad_account' },
  R13: { meaning: 'Invalid ACH routing number', action: 'bad_account' },
  R14: { meaning: 'Representative payee deceased or unable to continue', action: 'bad_account' },
  R15: { meaning: 'Beneficiary or account holder deceased', action: 'bad_account' },
  R16: { meaning: 'Account frozen', action: 'bad_account' },
  R17: { meaning: 'File record edit criteria', action: 'needs_review' },
  R20: { meaning: 'Non-transaction account', action: 'bad_account' },
  R23: { meaning: 'Credit refused by receiver', action: 'bad_account' },
  R24: { meaning: 'Duplicate entry', action: 'needs_review' },
  R29: { meaning: 'Corporate customer advises not authorized', action: 'unauthorized' },
  R31: { meaning: 'Permissible return entry (CCD/CTX)', action: 'needs_review' },
  R33: { meaning: 'Return of XCK entry', action: 'needs_review' },
};

export interface ReturnedEntry {
  /** The trace number of the entry that was returned. */
  originalTrace: string;
  reasonCode: string;
  meaning: string;
  action: ReturnAction;
  amountCents: number;
  addendaInformation: string;
}

export interface ChangeNotice {
  originalTrace: string;
  changeCode: string;
  correctedData: string;
}

export interface ParsedReturns {
  returns: ReturnedEntry[];
  changes: ChangeNotice[];
  errors: string[];
}

export function parseReturnFile(text: string): ParsedReturns {
  const parsed = parseAchFile(text);
  const returns: ReturnedEntry[] = [];
  const changes: ChangeNotice[] = [];
  for (const batch of parsed.batches) {
    for (const entry of batch.entries) {
      for (const a of entry.addenda) {
        if (a.type === '99') {
          const reasonCode = a.raw.slice(3, 6);
          const known = RETURN_CODES[reasonCode];
          returns.push({ originalTrace: a.raw.slice(6, 21), reasonCode, meaning: known?.meaning ?? 'Unrecognised return reason', action: known?.action ?? 'needs_review', amountCents: entry.amountCents, addendaInformation: a.raw.slice(35, 79).trim() });
        } else if (a.type === '98') {
          changes.push({ originalTrace: a.raw.slice(6, 21), changeCode: a.raw.slice(3, 6), correctedData: a.raw.slice(35, 64).trim() });
        }
      }
    }
  }
  return { returns, changes, errors: parsed.errors };
}
