import { parseAchFile } from './nacha.ts';
import type { AchSubmitter, SubmitInput, SubmitResult } from './submitter.ts';

/**
 * A simulated bank for development and tests. It parses and checks every file
 * it receives the way a bank's ACH processor would (structure and control
 * totals), accepts or rejects it, and can build the return file a receiving
 * bank would send. It moves no money and talks to no network. It must never
 * be used in production: it will tell Totali a file was accepted when no bank
 * has seen it.
 */
export class SandboxBank implements AchSubmitter {
  readonly name = 'sandbox';
  readonly received: SubmitInput[] = [];
  /** Set to make the next file be rejected, as a bank would for a bad file. */
  rejectNext: string | null = null;
  /** Set to leave files 'queued' (not yet acknowledged), as an outbox would. */
  holdAcknowledgement = false;
  private n = 0;

  async submit(f: SubmitInput): Promise<SubmitResult> {
    this.received.push(f);
    const parsed = parseAchFile(f.content);
    if (parsed.errors.length > 0) return { status: 'rejected', message: `Sandbox bank rejected the file: ${parsed.errors.join('; ')}` };
    if (this.rejectNext) {
      const why = this.rejectNext;
      this.rejectNext = null;
      return { status: 'rejected', message: `Sandbox bank rejected the file: ${why}` };
    }
    if (this.holdAcknowledgement) return { status: 'queued', message: 'Sandbox bank has the file but has not acknowledged it yet.' };
    this.n += 1;
    return { status: 'accepted', reference: `SANDBOX-${this.n}`, message: 'Sandbox bank accepted the file.' };
  }

  /** The file a receiving bank would send back for these entries. */
  static returnFile(items: Array<{ trace: string; code: string; amountCents: number }>, opts: { odfiRoutingNumber?: string } = {}): string {
    const rtn = opts.odfiRoutingNumber ?? '021000021';
    const odfi8 = rtn.slice(0, 8);
    const pad = (s: string, n: number) => s.padEnd(n, ' ').slice(0, n);
    const z = (n: number, w: number) => String(n).padStart(w, '0');
    const recs: string[] = [];
    let hash = 0;
    let credits = 0;
    recs.push('1' + '01' + ` ${rtn}` + ' 123456789' + '260612' + '0900' + 'A' + '094' + '10' + '1' + pad('SANDBOX BANK', 23) + pad('TOTALI', 23) + pad('', 8));
    recs.push('5' + '220' + pad('RETURNS', 16) + pad('', 20) + pad('1123456789', 10) + 'PPD' + pad('PAYROLL', 10) + '260612' + '260612' + '   ' + '1' + odfi8 + z(1, 7));
    items.forEach((it, i) => {
      hash += 11000000;
      credits += it.amountCents;
      recs.push('6' + '22' + '11000000' + '0' + pad('000123456789', 17) + z(it.amountCents, 10) + pad('RETURN', 15) + pad('RETURNED ENTRY', 22) + '  ' + '1' + odfi8 + z(9000 + i, 7));
      recs.push('7' + '99' + it.code + it.trace + '000000' + '11000000' + pad('RETURNED', 44) + odfi8 + z(9000 + i, 7));
    });
    recs.push('8' + '220' + z(items.length * 2, 6) + z(hash % 1e10, 10) + z(0, 12) + z(credits, 12) + pad('1123456789', 10) + pad('', 19) + pad('', 6) + odfi8 + z(1, 7));
    const blocks = Math.ceil((recs.length + 1) / 10);
    recs.push('9' + z(1, 6) + z(blocks, 6) + z(items.length * 2, 8) + z(hash % 1e10, 10) + z(0, 12) + z(credits, 12) + pad('', 39));
    while (recs.length < blocks * 10) recs.push('9'.repeat(94));
    return recs.join('\r\n') + '\r\n';
  }

  /** A notification of change for an entry: the bank tells the originator the details to use next time. */
  static changeNotice(trace: string, changeCode: string, correctedData: string): string {
    const rtn = '021000021';
    const odfi8 = rtn.slice(0, 8);
    const pad = (s: string, n: number) => s.padEnd(n, ' ').slice(0, n);
    const z = (n: number, w: number) => String(n).padStart(w, '0');
    const recs: string[] = [];
    recs.push('1' + '01' + ` ${rtn}` + ' 123456789' + '260612' + '0900' + 'A' + '094' + '10' + '1' + pad('SANDBOX BANK', 23) + pad('TOTALI', 23) + pad('', 8));
    recs.push('5' + '220' + pad('NOTICES', 16) + pad('', 20) + pad('1123456789', 10) + 'COR' + pad('COR', 10) + '260612' + '260612' + '   ' + '1' + odfi8 + z(1, 7));
    recs.push('6' + '21' + '11000000' + '0' + pad('000123456789', 17) + z(0, 10) + pad('NOC', 15) + pad('NOTICE', 22) + '  ' + '1' + odfi8 + z(8000, 7));
    recs.push('7' + '98' + changeCode + trace + '      ' + '11000000' + pad(correctedData, 29) + ' '.repeat(15) + odfi8 + z(8000, 7));
    recs.push('8' + '220' + z(2, 6) + z(11000000, 10) + z(0, 12) + z(0, 12) + pad('1123456789', 10) + pad('', 19) + pad('', 6) + odfi8 + z(1, 7));
    const blocks = Math.ceil((recs.length + 1) / 10);
    recs.push('9' + z(1, 6) + z(blocks, 6) + z(2, 8) + z(11000000, 10) + z(0, 12) + z(0, 12) + pad('', 39));
    while (recs.length < blocks * 10) recs.push('9'.repeat(94));
    return recs.join('\r\n') + '\r\n';
  }
}
