import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addBankingDays, bankingDaysBetween, federalReserveHolidays, isBankingDay, onOrAfterBankingDay, onOrBeforeBankingDay } from '../src/lib/bizdays.ts';
import { buildAchFile, parseAchFile, type AchEntry, type Originator } from '../src/ach/nacha.ts';
import { parseReturnFile, RETURN_CODES } from '../src/ach/returns.ts';

const ORIGINATOR: Originator = { odfiRoutingNumber: '021000021', odfiName: 'Test Sponsor Bank', immediateOrigin: '123456789', companyName: 'Totali Payroll', companyId: '1123456789' };
const entry = (over: Partial<AchEntry> = {}): AchEntry => ({ ref: 'leg_1', kind: 'credit', accountType: 'checking', routingNumber: '110000000', accountNumber: '000123456789', amountCents: 123_456, individualId: 'emp_abc', individualName: 'Ana Ruiz', ...over });
const build = (entries: AchEntry[], sec: 'PPD' | 'CCD' = 'PPD', seq = 1) => buildAchFile(ORIGINATOR, { standardEntryClass: sec, entryDescription: 'PAYROLL', effectiveEntryDate: '2026-06-12', entries }, { createdAt: new Date('2026-06-10T14:05:00Z'), firstTraceSequence: seq });

// ---------------------------------------------------------------- banking days

test('Federal Reserve holidays for 2026 follow the Fed rule: Saturday holidays are not moved', () => {
  const h = federalReserveHolidays(2026);
  assert.deepEqual([...h].sort(), ['2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25']);
  assert.equal(h.has('2026-07-03'), false, 'July 4 2026 is a Saturday: banks are open Friday July 3');
  assert.equal(isBankingDay('2026-07-03'), true);
});

test('a holiday on a Sunday is observed the following Monday', () => {
  assert.equal(federalReserveHolidays(2027).has('2027-07-05'), true, 'July 4 2027 is a Sunday');
  assert.equal(federalReserveHolidays(2027).has('2027-07-04'), false);
  assert.equal(federalReserveHolidays(2023).has('2023-01-02'), true, 'New Year 2023 was a Sunday');
});

test('banking day arithmetic skips weekends and holidays', () => {
  assert.equal(addBankingDays('2026-06-18', 1), '2026-06-22', 'Thursday + 1 skips the Juneteenth Friday and the weekend');
  assert.equal(addBankingDays('2026-06-12', 1), '2026-06-15');
  assert.equal(addBankingDays('2026-06-15', -1), '2026-06-12');
  assert.equal(addBankingDays('2026-11-25', 2), '2026-11-30', 'Thanksgiving Thursday and the weekend are skipped');
  assert.equal(onOrAfterBankingDay('2026-06-13'), '2026-06-15');
  assert.equal(onOrBeforeBankingDay('2026-06-13'), '2026-06-12');
  assert.equal(bankingDaysBetween('2026-06-12', '2026-06-16'), 2);
  assert.equal(addBankingDays('2026-06-12', 0), '2026-06-12');
});

// ---------------------------------------------------------------- NACHA

test('a credit file has the NACHA structure: 94-character records, blocked in tens, control totals that tie', () => {
  const f = build([entry(), entry({ ref: 'leg_2', amountCents: 50_000, accountType: 'savings', routingNumber: '021000021', individualName: 'Ben Okafor' })]);
  const lines = f.content.split('\r\n').filter(Boolean);
  assert.equal(lines.length, 10);
  assert.ok(lines.every((l) => l.length === 94));
  assert.equal(lines[0][0], '1');
  assert.equal(lines[1].slice(1, 4), '220', 'credits only');
  assert.equal(lines[1].slice(50, 53), 'PPD');
  assert.equal(lines[2].slice(1, 3), '22', 'checking credit');
  assert.equal(lines[3].slice(1, 3), '32', 'savings credit');
  assert.equal(lines.slice(-4).every((l) => l === '9'.repeat(94)) || lines.at(-1) === '9'.repeat(94), true);
  const p = parseAchFile(f.content);
  assert.deepEqual(p.errors, []);
  assert.equal(p.control.creditCents, 173_456);
  assert.equal(p.control.debitCents, 0);
  assert.equal(p.batches[0].entries[0].amountCents, 123_456);
  assert.equal(f.totals.entryHash, String(11000000 + 2100002).padStart(10, '0'));
});

test('a debit batch is service class 225 with transaction code 27 and the CCD entry class', () => {
  const f = build([entry({ kind: 'debit', ref: 'fund', amountCents: 1_000_000 })], 'CCD');
  const lines = f.content.split('\r\n');
  assert.equal(lines[1].slice(1, 4), '225');
  assert.equal(lines[1].slice(50, 53), 'CCD');
  assert.equal(lines[2].slice(1, 3), '27');
  const p = parseAchFile(f.content);
  assert.deepEqual(p.errors, []);
  assert.equal(p.control.debitCents, 1_000_000);
});

test('a prenote is a zero-dollar entry with the prenote transaction code', () => {
  const f = build([entry({ kind: 'prenote_credit', amountCents: 0 })]);
  assert.equal(f.content.split('\r\n')[2].slice(1, 3), '23');
  assert.throws(() => build([entry({ kind: 'prenote_credit', amountCents: 5 })]), /zero dollars/);
  assert.throws(() => build([entry({ amountCents: 0 })]), /zero dollars/);
});

test('trace numbers are the ODFI prefix plus a sequence, continuing from the caller\'s counter', () => {
  const f = build([entry({ ref: 'a' }), entry({ ref: 'b' })], 'PPD', 41);
  assert.deepEqual(f.entries.map((e) => e.traceNumber), ['02100002' + '0000041', '02100002' + '0000042']);
  const p = parseAchFile(f.content);
  assert.deepEqual(p.batches[0].entries.map((e) => e.traceNumber), f.entries.map((e) => e.traceNumber));
});

test('bad data never reaches a file: routing checksum, account shape, mixed batches, long descriptions', () => {
  assert.throws(() => build([entry({ routingNumber: '110000001' })]), /checksum/);
  assert.throws(() => build([entry({ accountNumber: '12AB' })]), /Account number/);
  assert.throws(() => build([entry(), entry({ kind: 'debit' })]), /separately/);
  assert.throws(() => build([]), /at least one/);
  assert.throws(() => buildAchFile(ORIGINATOR, { standardEntryClass: 'PPD', entryDescription: 'WAY TOO LONG FOR THE FIELD', effectiveEntryDate: '2026-06-12', entries: [entry()] }, { createdAt: new Date(), firstTraceSequence: 1 }), /10 characters/);
  assert.throws(() => buildAchFile({ ...ORIGINATOR, odfiRoutingNumber: '123456789' }, { standardEntryClass: 'PPD', entryDescription: 'PAYROLL', effectiveEntryDate: '2026-06-12', entries: [entry()] }, { createdAt: new Date(), firstTraceSequence: 1 }), /ODFI/);
});

test('names are upper-cased and unsafe characters are stripped; long names are truncated to the field', () => {
  const f = build([entry({ individualName: "José O'Brien-Smythe the Third of Everywhere" })]);
  const line = f.content.split('\r\n')[2];
  assert.equal(line.length, 94);
  assert.equal(line.slice(54, 76), "JOS  O'BRIEN-SMYTHE TH");
});

test('the parser catches a tampered file', () => {
  const f = build([entry(), entry({ ref: 'b' })]);
  const lines = f.content.split('\r\n');
  lines[2] = lines[2].slice(0, 29) + '0000923456' + lines[2].slice(39); // change the first entry's amount only
  const errs = parseAchFile(lines.join('\r\n')).errors;
  assert.ok(errs.some((e) => /credit total/.test(e)), errs.join('; '));
  assert.ok(parseAchFile(f.content.replace(/\r\n9{94}\r\n$/, '\r\n')).errors.length > 0, 'a file not blocked to a multiple of 10 is rejected');
});

// ---------------------------------------------------------------- returns

/** A return file as an RDFI would send it: the returned entry, then a type 99 addenda naming the reason and the original trace. */
function returnFile(items: Array<{ trace: string; code: string; amountCents: number }>): string {
  const odfi8 = '02100002';
  const recs: string[] = [];
  const pad = (s: string, n: number) => s.padEnd(n, ' ').slice(0, n);
  const z = (n: number, w: number) => String(n).padStart(w, '0');
  let hash = 0;
  recs.push('1' + '01' + ' 021000021' + ' 123456789' + '260612' + '0900' + 'A' + '094' + '10' + '1' + pad('TEST BANK', 23) + pad('TOTALI', 23) + pad('', 8));
  recs.push('5' + '220' + pad('RETURNS', 16) + pad('', 20) + pad('1123456789', 10) + 'PPD' + pad('PAYROLL', 10) + '260612' + '260612' + '   ' + '1' + odfi8 + z(1, 7));
  let credits = 0;
  items.forEach((it, i) => {
    hash += 11000000;
    credits += it.amountCents;
    recs.push('6' + '22' + '11000000' + '0' + pad('000123456789', 17) + z(it.amountCents, 10) + pad('emp_abc', 15) + pad('ANA RUIZ', 22) + '  ' + '1' + odfi8 + z(100 + i, 7));
    recs.push('7' + '99' + it.code + it.trace + '000000' + '11000000' + pad('RETURNED', 44) + odfi8 + z(100 + i, 7));
  });
  recs.push('8' + '220' + z(items.length * 2, 6) + z(hash % 1e10, 10) + z(0, 12) + z(credits, 12) + pad('1123456789', 10) + pad('', 19) + pad('', 6) + odfi8 + z(1, 7));
  const blocks = Math.ceil((recs.length + 1) / 10);
  recs.push('9' + z(1, 6) + z(blocks, 6) + z(items.length * 2, 8) + z(hash % 1e10, 10) + z(0, 12) + z(credits, 12) + pad('', 39));
  while (recs.length < blocks * 10) recs.push('9'.repeat(94));
  return recs.join('\r\n') + '\r\n';
}

test('a return file is read: original trace, reason, action', () => {
  const r = parseReturnFile(returnFile([{ trace: '021000020000041', code: 'R02', amountCents: 5000 }, { trace: '021000020000042', code: 'R01', amountCents: 7000 }, { trace: '021000020000043', code: 'R99', amountCents: 1 }]));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.returns.map((x) => [x.originalTrace, x.reasonCode, x.action]), [['021000020000041', 'R02', 'bad_account'], ['021000020000042', 'R01', 'retry_later'], ['021000020000043', 'R99', 'needs_review']]);
  assert.equal(r.returns[0].amountCents, 5000);
  assert.ok(RETURN_CODES.R29.action === 'unauthorized' && RETURN_CODES.R10.action === 'unauthorized');
});
export { returnFile };
