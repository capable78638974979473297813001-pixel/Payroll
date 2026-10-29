import type { Cents } from '../src/money.ts';
import type { DirectDepositAccount } from './types.ts';

/**
 * Splitting one employee's net pay across their own bank accounts, and
 * writing the result out as a NACHA ACH file a bank actually accepts —
 * the part of "run payroll" that gets money to move, as opposed to the
 * tax engine's own job of deciding how much there should be.
 *
 * PRODUCTION BOUNDARY, stated plainly rather than left implicit: a real
 * payroll company never holds a raw bank account number in application
 * code the way DirectDepositAccount does here — it goes straight into a
 * tokenizing vault (Plaid, a bank's own onboarding API, or a KMS-encrypted
 * column with column-level access control) the moment it's collected, the
 * same boundary site/lib/store.ts's own header comment draws for card
 * numbers. This module works with account numbers directly because it has
 * no such vault to call — building one is infrastructure, not a payroll
 * calculation, and is out of scope here the same way a live database
 * connection is (see payroll/store.ts's own header comment).
 */

/**
 * ABA routing number check-digit validation (the standard weighted
 * checksum every US bank routing number satisfies): 3(d1+d4+d7) +
 * 7(d2+d5+d8) + 1(d3+d6+d9) must be a multiple of 10. Catches a transposed
 * or mistyped digit before it reaches a NACHA file — a bank's own ACH
 * processor validates this too, but rejecting it here means a bad routing
 * number fails at data entry, not two days later as a returned entry.
 */
export function validateRoutingNumber(routingNumber: string): boolean {
  if (!/^\d{9}$/.test(routingNumber)) return false;
  const d = routingNumber.split('').map(Number);
  const checksum = 3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + 1 * (d[2] + d[5] + d[8]);
  return checksum % 10 === 0;
}

export interface DepositAllocation {
  accountId: string;
  amount: Cents;
}

/**
 * Splits `netPay` across an employee's own accounts. 'flatAmount' and
 * 'percent' accounts are funded in ascending `priority` order (undefined
 * priority sorts last); 'percent' is always a percentage of the FULL net
 * pay, never of what's left after earlier accounts — matching how a real
 * payroll system's split-deposit form is worded ("10% of net pay"), not a
 * cascading percentage of a shrinking pool. Exactly one account may be
 * 'remainder', funded LAST with whatever is left (zero if the fixed/
 * percent accounts already consumed all of it, never negative — a
 * shortfall there is a configuration problem this function reports rather
 * than silently absorbing).
 *
 * An employee with no accounts at all gets an empty array back — this
 * function does not decide that means "pay by paper check," it just
 * doesn't allocate anything, the same "absent input changes nothing"
 * convention the tax engine itself uses throughout.
 */
export function allocateNetPay(netPay: Cents, accounts: readonly DirectDepositAccount[]): DepositAllocation[] {
  if (accounts.length === 0) return [];

  const remainderAccounts = accounts.filter((a) => a.allocation.kind === 'remainder');
  if (remainderAccounts.length > 1) {
    throw new Error('At most one direct deposit account may be the remainder account');
  }

  const fixedAccounts = accounts
    .filter((a) => a.allocation.kind !== 'remainder')
    .slice()
    .sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity));

  const allocations: DepositAllocation[] = [];
  let remaining = netPay;

  for (const account of fixedAccounts) {
    // Narrowed with an explicit if/else-if, not a ternary on `!== 'flatAmount'`
    // — `fixedAccounts` was built with .filter(), which excludes 'remainder'
    // at runtime but doesn't narrow the TYPE of the filtered array, so a
    // ternary branching only on 'flatAmount' would leave the other branch
    // typed as `remainder | percent` with no `percentOfNet` on the first.
    // The trailing throw is a real assertion, not dead code: it's what
    // catches this function's own remainder-exclusion invariant breaking
    // in a future edit, rather than silently computing NaN.
    let requested: Cents;
    if (account.allocation.kind === 'flatAmount') {
      requested = account.allocation.amount;
    } else if (account.allocation.kind === 'percent') {
      requested = Math.round(netPay * (account.allocation.percentOfNet / 100));
    } else {
      throw new Error(`Internal error: a 'remainder' account leaked into fixedAccounts (${account.id})`);
    }
    const amount = Math.max(0, Math.min(requested, remaining));
    allocations.push({ accountId: account.id, amount });
    remaining -= amount;
  }

  if (remainderAccounts.length === 1) {
    allocations.push({ accountId: remainderAccounts[0].id, amount: remaining });
    remaining = 0;
  }

  if (remaining > 0) {
    throw new Error(
      `${remaining} cents of net pay have nowhere to go — this employee's fixed/percent deposit accounts ` +
        `don't add up to their full net pay, and no 'remainder' account is configured to absorb the rest.`,
    );
  }

  return allocations;
}

/** One credit this ACH file will carry — already netted against the employee's own split, so an employee with two accounts contributes two of these. */
export interface AchCredit {
  routingNumber: string;
  accountNumber: string;
  accountType: 'checking' | 'savings';
  amount: Cents;
  /** Employee id, carried into the entry's own Individual Identification Number field — lets a returned entry be traced back without cross-referencing the batch by name alone. */
  individualId: string;
  individualName: string;
  /**
   * 'prenote' emits NACHA's own zero-dollar account-verification entry
   * (transaction code 23 checking / 33 savings) instead of an ordinary
   * live credit (22/32) — see payroll/directDepositVerification.ts,
   * which is the only caller that should ever set this. Defaults to
   * 'live' so every existing payroll-run caller is unaffected.
   */
  entryType?: 'live' | 'prenote';
}

export interface AchFileConfig {
  /**
   * The payroll company's own bank's routing number — the account funds
   * are drawn from. Used both as the file header's Immediate Destination
   * (the point this file is submitted TO, which for a small originator
   * submitting directly to its own bank is that bank's own routing
   * number) and as the 8-digit Originating DFI prefix on every batch,
   * entry and control record. A larger originator submitting through a
   * separate ACH operator would split these into two distinct fields;
   * this module doesn't model that distinction, the same simplification
   * this module's own header comment names for account-number custody.
   */
  originRoutingNumber: string;
  /**
   * The NAME of the bank at `originRoutingNumber` above — not the payroll
   * company's own legal name (see `companyName` below for that). This fills
   * the file header's Immediate DESTINATION Name field, the counterpart to
   * `originRoutingNumber` filling Immediate Destination: together they say
   * who this file is physically being submitted TO. A caller who passes
   * their own company's name here instead of their bank's puts the wrong
   * entity in that field of a real NACHA file — truncated to NACHA's field
   * width, never rejected for being too long.
   */
  originName: string;
  /** Immediate origin id NACHA expects in the file header — conventionally a space followed by a 9-digit id the originating bank assigns; if unknown, pass the company's own EIN digits and this function pads to 10 the same way. */
  immediateOriginId: string;
  /** The payroll company/originator's own legal name — fills the file header's Immediate Origin Name field and the batch header's Company Name field, the actual entity the money is coming from (as opposed to `originName` above, which names the BANK it's being submitted through). */
  companyName: string;
  companyIdentification: string; // e.g. '1' + 9-digit EIN
  effectiveEntryDate: string; // ISO yyyy-mm-dd — the check date
  batchNumber?: number;
  fileIdModifier?: string; // single char, defaults 'A'
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width, ' ');
}

function padNum(value: number | string, width: number): string {
  const s = String(value);
  return s.length >= width ? s.slice(-width) : s.padStart(width, '0');
}

function yymmdd(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${y.slice(2)}${m}${d}`;
}

function firstEight(routingNumber: string): string {
  return routingNumber.slice(0, 8);
}

function checkDigit(routingNumber: string): string {
  return routingNumber.slice(8, 9);
}

/**
 * Builds a complete NACHA-formatted ACH file (PPD — Prearranged Payment and
 * Deposit, the standard entry class for payroll direct deposit) for one
 * batch of credits. 94-character fixed-width records, blocked in groups of
 * 10 with '9'-filler padding, exactly as every US bank's ACH processor
 * expects — this is the file format itself, not a simplification of it.
 *
 * Every routing number is validated before it's allowed into the file:
 * a bad checksum here becomes a same-day rejection instead of a returned
 * entry two days later.
 */
export function buildNachaFile(credits: readonly AchCredit[], config: AchFileConfig): string {
  for (const c of credits) {
    if (!validateRoutingNumber(c.routingNumber)) {
      throw new Error(`Invalid routing number checksum: ${c.routingNumber} (individual ${c.individualId})`);
    }
    if (c.entryType === 'prenote' && c.amount !== 0) {
      throw new Error(`A prenote entry must carry a zero dollar amount, got ${c.amount} cents (individual ${c.individualId})`);
    }
  }
  if (!validateRoutingNumber(config.originRoutingNumber)) {
    throw new Error(`Invalid origin routing number checksum: ${config.originRoutingNumber}`);
  }

  const now = new Date();
  const creationDate = `${String(now.getUTCFullYear()).slice(2)}${padNum(now.getUTCMonth() + 1, 2)}${padNum(now.getUTCDate(), 2)}`;
  const creationTime = `${padNum(now.getUTCHours(), 2)}${padNum(now.getUTCMinutes(), 2)}`;
  const batchNumber = config.batchNumber ?? 1;
  const fileIdModifier = config.fileIdModifier ?? 'A';

  const fileHeader =
    '1' +
    '01' +
    pad(` ${config.originRoutingNumber}`, 10).slice(0, 10) +
    pad(config.immediateOriginId, 10) +
    creationDate +
    creationTime +
    fileIdModifier +
    '094' +
    '10' +
    '1' +
    pad(config.originName, 23) +
    pad(config.companyName, 23) +
    pad('', 8);

  const batchHeader =
    '5' +
    '220' +
    pad(config.companyName, 16) +
    pad('', 20) +
    pad(config.companyIdentification, 10) +
    'PPD' +
    pad('PAYROLL', 10) +
    yymmdd(config.effectiveEntryDate) +
    yymmdd(config.effectiveEntryDate) +
    pad('', 3) +
    '1' +
    firstEight(config.originRoutingNumber) +
    padNum(batchNumber, 7);

  const entries: string[] = [];
  let traceSeq = 1;
  let totalCredits = 0;
  let entryHashAccumulator = 0;

  for (const credit of credits) {
    const transactionCode = credit.entryType === 'prenote'
      ? (credit.accountType === 'checking' ? '23' : '33')
      : (credit.accountType === 'checking' ? '22' : '32');
    entryHashAccumulator += Number(firstEight(credit.routingNumber));
    totalCredits += credit.amount;
    const entry =
      '6' +
      transactionCode +
      firstEight(credit.routingNumber) +
      checkDigit(credit.routingNumber) +
      pad(credit.accountNumber, 17) +
      padNum(credit.amount, 10) +
      pad(credit.individualId, 15) +
      pad(credit.individualName, 22) +
      pad('', 2) +
      '0' +
      firstEight(config.originRoutingNumber) +
      padNum(traceSeq, 7);
    entries.push(entry);
    traceSeq++;
  }

  const entryHash = padNum(entryHashAccumulator % 10_000_000_000, 10);

  const batchControl =
    '8' +
    '220' +
    padNum(entries.length, 6) +
    entryHash +
    padNum(0, 12) +
    padNum(totalCredits, 12) +
    pad(config.companyIdentification, 10) +
    pad('', 19) +
    pad('', 6) +
    firstEight(config.originRoutingNumber) +
    padNum(batchNumber, 7);

  const fileControl =
    '9' +
    padNum(1, 6) + // batch count
    padNum(0, 6) + // block count, filled in below once total record count is known
    padNum(entries.length, 8) +
    entryHash +
    padNum(0, 12) +
    padNum(totalCredits, 12) +
    pad('', 39);

  const records = [fileHeader, batchHeader, ...entries, batchControl, fileControl];
  const blockCount = Math.ceil(records.length / 10);
  const filledFileControl =
    fileControl.slice(0, 7) + padNum(blockCount, 6) + fileControl.slice(13);
  records[records.length - 1] = filledFileControl;

  const paddingNeeded = blockCount * 10 - records.length;
  for (let i = 0; i < paddingNeeded; i++) records.push('9'.repeat(94));

  for (const r of records) {
    if (r.length !== 94) {
      throw new Error(`NACHA record is ${r.length} chars, expected 94: ${JSON.stringify(r)}`);
    }
  }

  return records.join('\r\n') + '\r\n';
}
