import { validateRoutingNumber } from '../../engine/payroll/directDeposit.ts';

/**
 * NACHA ACH files: credits (pay employees), debits (collect from the
 * employer) and zero-dollar prenotes. 94-character fixed-width records,
 * blocked in tens with 9-filled padding, per the NACHA Operating Rules file
 * format. The engine's own writer is credit-only and does not return trace
 * numbers; Totali needs both debits and credits, and needs to know each
 * entry's trace number so a return can be matched back to the payment.
 *
 * Totali writes one batch per file. A batch is credits only (service class
 * 220) or debits only (225). Payroll credits use SEC code PPD; the employer
 * funding debit uses CCD (a corporate account).
 */

export type EntryKind = 'credit' | 'debit' | 'prenote_credit' | 'prenote_debit';

export interface AchEntry {
  /** Totali's own id for what this entry pays, carried so a trace number maps back to it. */
  ref: string;
  kind: EntryKind;
  accountType: 'checking' | 'savings';
  routingNumber: string;
  accountNumber: string;
  amountCents: number;
  /** Up to 15 characters; for payroll, the employee id. Echoed back in returns. */
  individualId: string;
  /** Up to 22 characters. */
  individualName: string;
}

export interface Originator {
  /** Routing number of the bank that receives the file (the ODFI). */
  odfiRoutingNumber: string;
  odfiName: string;
  /** File header Immediate Origin: the 9-digit id the ODFI assigned (often the originator's tax id or the ODFI's routing number). */
  immediateOrigin: string;
  companyName: string;
  /** 10 characters. Conventionally '1' + the 9-digit EIN. */
  companyId: string;
}

export interface BatchSpec {
  standardEntryClass: 'PPD' | 'CCD';
  /** 10 characters shown on the receiver's statement. */
  entryDescription: string;
  effectiveEntryDate: string;
  entries: AchEntry[];
}

export interface BuiltEntry {
  ref: string;
  traceNumber: string;
  kind: EntryKind;
  amountCents: number;
}

export interface BuiltAchFile {
  content: string;
  entries: BuiltEntry[];
  totals: { entryCount: number; debitCents: number; creditCents: number; entryHash: string; blockCount: number };
}

const TX_CODE: Record<EntryKind, Record<'checking' | 'savings', string>> = {
  credit: { checking: '22', savings: '32' },
  debit: { checking: '27', savings: '37' },
  prenote_credit: { checking: '23', savings: '33' },
  prenote_debit: { checking: '28', savings: '38' },
};

const isDebit = (k: EntryKind) => k === 'debit' || k === 'prenote_debit';

/** NACHA fields allow letters, digits, spaces and a small set of punctuation. Anything else is replaced with a space; names are upper-cased. */
export function achText(s: string, width: number): string {
  const clean = s.toUpperCase().replace(/[^A-Z0-9 .,&'/#()*@+_:;=-]/g, ' ');
  return clean.length >= width ? clean.slice(0, width) : clean.padEnd(width, ' ');
}

const num = (v: number | string, width: number) => {
  const s = String(v);
  if (s.length > width) throw new Error(`Number ${s} does not fit in ${width} digits`);
  return s.padStart(width, '0');
};

const yymmdd = (iso: string) => `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}`;
const first8 = (rtn: string) => rtn.slice(0, 8);

export function validateEntry(e: AchEntry): void {
  if (!validateRoutingNumber(e.routingNumber)) throw new Error(`Invalid routing number checksum for ${e.ref}`);
  if (!/^\d{4,17}$/.test(e.accountNumber)) throw new Error(`Account number for ${e.ref} must be 4 to 17 digits`);
  if (!Number.isSafeInteger(e.amountCents) || e.amountCents < 0 || e.amountCents > 9_999_999_999) throw new Error(`Amount for ${e.ref} is out of range`);
  if (e.kind.startsWith('prenote') && e.amountCents !== 0) throw new Error(`A prenote must carry zero dollars (${e.ref})`);
  if (!e.kind.startsWith('prenote') && e.amountCents === 0) throw new Error(`A live entry cannot be zero dollars (${e.ref})`);
}

/**
 * Build one file with one batch. `firstTraceSequence` is the next unused
 * 7-digit trace sequence for this originator; the caller persists the
 * counter. `createdAt` stamps the file header.
 */
export function buildAchFile(originator: Originator, batch: BatchSpec, opts: { createdAt: Date; firstTraceSequence: number; fileIdModifier?: string }): BuiltAchFile {
  if (!validateRoutingNumber(originator.odfiRoutingNumber)) throw new Error('The ODFI routing number fails its checksum');
  if (batch.entries.length === 0) throw new Error('A batch needs at least one entry');
  if (batch.entryDescription.length > 10) throw new Error('entryDescription is at most 10 characters');
  const debits = batch.entries.filter((e) => isDebit(e.kind)).length;
  const credits = batch.entries.length - debits;
  if (debits > 0 && credits > 0) throw new Error('Totali writes debit batches and credit batches separately');
  for (const e of batch.entries) validateEntry(e);

  const serviceClass = debits > 0 ? '225' : '220';
  const odfi8 = first8(originator.odfiRoutingNumber);
  const c = opts.createdAt;
  const fileDate = `${String(c.getUTCFullYear()).slice(2)}${num(c.getUTCMonth() + 1, 2)}${num(c.getUTCDate(), 2)}`;
  const fileTime = `${num(c.getUTCHours(), 2)}${num(c.getUTCMinutes(), 2)}`;

  const header =
    '1' + '01' + ` ${originator.odfiRoutingNumber}` + achText(` ${originator.immediateOrigin}`.slice(-10), 10) + fileDate + fileTime + (opts.fileIdModifier ?? 'A') + '094' + '10' + '1' + achText(originator.odfiName, 23) + achText(originator.companyName, 23) + achText('', 8);

  const batchHeader =
    '5' + serviceClass + achText(originator.companyName, 16) + achText('', 20) + achText(originator.companyId, 10) + batch.standardEntryClass + achText(batch.entryDescription, 10) + achText('', 6) + yymmdd(batch.effectiveEntryDate) + '   ' + '1' + odfi8 + num(1, 7);

  const built: BuiltEntry[] = [];
  const records: string[] = [];
  let hash = 0;
  let debitTotal = 0;
  let creditTotal = 0;
  let seq = opts.firstTraceSequence;
  for (const e of batch.entries) {
    const trace = `${odfi8}${num(seq, 7)}`;
    seq += 1;
    hash += Number(first8(e.routingNumber));
    if (isDebit(e.kind)) debitTotal += e.amountCents;
    else creditTotal += e.amountCents;
    records.push(
      '6' + TX_CODE[e.kind][e.accountType] + first8(e.routingNumber) + e.routingNumber[8] + achText(e.accountNumber, 17) + num(e.amountCents, 10) + achText(e.individualId, 15) + achText(e.individualName, 22) + '  ' + '0' + trace,
    );
    built.push({ ref: e.ref, traceNumber: trace, kind: e.kind, amountCents: e.amountCents });
  }
  const entryHash = num(hash % 10_000_000_000, 10);

  const batchControl = '8' + serviceClass + num(batch.entries.length, 6) + entryHash + num(debitTotal, 12) + num(creditTotal, 12) + achText(originator.companyId, 10) + achText('', 19) + achText('', 6) + odfi8 + num(1, 7);

  const all = [header, batchHeader, ...records, batchControl];
  const blockCount = Math.ceil((all.length + 1) / 10);
  const fileControl = '9' + num(1, 6) + num(blockCount, 6) + num(batch.entries.length, 8) + entryHash + num(debitTotal, 12) + num(creditTotal, 12) + achText('', 39);
  all.push(fileControl);
  while (all.length < blockCount * 10) all.push('9'.repeat(94));

  for (const r of all) if (r.length !== 94) throw new Error(`NACHA record is ${r.length} characters, expected 94`);
  return { content: all.join('\r\n') + '\r\n', entries: built, totals: { entryCount: batch.entries.length, debitCents: debitTotal, creditCents: creditTotal, entryHash, blockCount } };
}

// ---------------------------------------------------------------------------- parsing

export interface ParsedEntry {
  transactionCode: string;
  rdfi8: string;
  checkDigit: string;
  accountNumber: string;
  amountCents: number;
  individualId: string;
  individualName: string;
  traceNumber: string;
  addenda: Array<{ type: string; raw: string }>;
}

export interface ParsedBatch {
  serviceClass: string;
  companyName: string;
  companyId: string;
  standardEntryClass: string;
  entryDescription: string;
  effectiveEntryDate: string;
  entries: ParsedEntry[];
  control: { entryCount: number; entryHash: string; debitCents: number; creditCents: number };
}

export interface ParsedFile {
  immediateDestination: string;
  immediateOrigin: string;
  batches: ParsedBatch[];
  control: { batchCount: number; blockCount: number; entryCount: number; entryHash: string; debitCents: number; creditCents: number };
  errors: string[];
}

/** Parse and check a NACHA file: record widths, blocking, and that every control total matches the entries. */
export function parseAchFile(text: string): ParsedFile {
  const errors: string[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length % 10 !== 0) errors.push(`File has ${lines.length} records; the count must be a multiple of 10`);
  const out: ParsedFile = { immediateDestination: '', immediateOrigin: '', batches: [], control: { batchCount: 0, blockCount: 0, entryCount: 0, entryHash: '', debitCents: 0, creditCents: 0 }, errors };
  let batch: ParsedBatch | null = null;
  let last: ParsedEntry | null = null;

  for (const [i, line] of lines.entries()) {
    if (line.length !== 94) {
      errors.push(`Record ${i + 1} is ${line.length} characters, expected 94`);
      continue;
    }
    switch (line[0]) {
      case '1':
        out.immediateDestination = line.slice(3, 13).trim();
        out.immediateOrigin = line.slice(13, 23).trim();
        break;
      case '5':
        batch = { serviceClass: line.slice(1, 4), companyName: line.slice(4, 20).trim(), companyId: line.slice(40, 50).trim(), standardEntryClass: line.slice(50, 53), entryDescription: line.slice(53, 63).trim(), effectiveEntryDate: line.slice(69, 75), entries: [], control: { entryCount: 0, entryHash: '', debitCents: 0, creditCents: 0 } };
        break;
      case '6':
        if (!batch) {
          errors.push(`Entry at record ${i + 1} is outside a batch`);
          break;
        }
        last = { transactionCode: line.slice(1, 3), rdfi8: line.slice(3, 11), checkDigit: line[11], accountNumber: line.slice(12, 29).trim(), amountCents: Number(line.slice(29, 39)), individualId: line.slice(39, 54).trim(), individualName: line.slice(54, 76).trim(), traceNumber: line.slice(79, 94), addenda: [] };
        batch.entries.push(last);
        break;
      case '7':
        if (last) last.addenda.push({ type: line.slice(1, 3), raw: line });
        else errors.push(`Addenda at record ${i + 1} has no entry`);
        break;
      case '8':
        if (batch) {
          batch.control = { entryCount: Number(line.slice(4, 10)), entryHash: line.slice(10, 20), debitCents: Number(line.slice(20, 32)), creditCents: Number(line.slice(32, 44)) };
          out.batches.push(batch);
          const entries = batch.entries.length + batch.entries.reduce((a, e) => a + e.addenda.length, 0);
          const hash = batch.entries.reduce((a, e) => a + Number(e.rdfi8), 0) % 10_000_000_000;
          const isDeb = (c: string) => ['27', '28', '37', '38'].includes(c);
          const deb = batch.entries.filter((e) => isDeb(e.transactionCode)).reduce((a, e) => a + e.amountCents, 0);
          const cre = batch.entries.filter((e) => !isDeb(e.transactionCode)).reduce((a, e) => a + e.amountCents, 0);
          if (batch.control.entryCount !== entries) errors.push(`Batch control entry count ${batch.control.entryCount} != ${entries}`);
          if (Number(batch.control.entryHash) !== hash) errors.push(`Batch control entry hash ${batch.control.entryHash} != ${hash}`);
          if (batch.control.debitCents !== deb) errors.push(`Batch control debit total ${batch.control.debitCents} != ${deb}`);
          if (batch.control.creditCents !== cre) errors.push(`Batch control credit total ${batch.control.creditCents} != ${cre}`);
          batch = null;
        }
        break;
      case '9':
        if (line === '9'.repeat(94)) break;
        out.control = { batchCount: Number(line.slice(1, 7)), blockCount: Number(line.slice(7, 13)), entryCount: Number(line.slice(13, 21)), entryHash: line.slice(21, 31), debitCents: Number(line.slice(31, 43)), creditCents: Number(line.slice(43, 55)) };
        break;
      default:
        errors.push(`Record ${i + 1} has unknown record type '${line[0]}'`);
    }
  }
  if (out.control.batchCount !== out.batches.length) errors.push(`File control batch count ${out.control.batchCount} != ${out.batches.length}`);
  if (out.control.blockCount !== lines.length / 10) errors.push(`File control block count ${out.control.blockCount} != ${lines.length / 10}`);
  const fileHash = out.batches.reduce((a, b) => a + b.entries.reduce((x, e) => x + Number(e.rdfi8), 0), 0) % 10_000_000_000;
  if (Number(out.control.entryHash) !== fileHash) errors.push(`File control entry hash ${out.control.entryHash} != ${fileHash}`);
  return out;
}
