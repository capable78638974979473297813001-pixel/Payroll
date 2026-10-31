import { createHash } from 'node:crypto';
import type { PosShift } from './types.ts';

/**
 * A time clock report from any system. Every point of sale can export one, and none of them agree on what to call the
 * columns, so the columns are found by what they are called, shown to the owner, and can be corrected before anything
 * is saved.
 */
export const FIELDS = ['name', 'first', 'last', 'email', 'date', 'clockIn', 'clockOut', 'hours', 'breakMinutes', 'cardTips', 'cashTips', 'tips'] as const;
export type Field = (typeof FIELDS)[number];
export type Mapping = Partial<Record<Field, number>>;

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
/** What a column might be called, most likely first. An exact name beats a name that merely contains one of these. */
const NAMES: Record<Field, string[]> = {
  name: ['employee', 'employeename', 'name', 'staff', 'staffmember', 'teammember', 'fullname', 'worker'],
  first: ['firstname', 'first', 'givenname'],
  last: ['lastname', 'last', 'surname', 'familyname'],
  email: ['email', 'emailaddress'],
  date: ['date', 'workdate', 'businessdate', 'day', 'shiftdate', 'indate', 'clockindate'],
  clockIn: ['clockin', 'in', 'timein', 'intime', 'start', 'starttime', 'clockedin', 'punchin', 'shiftstart', 'indatetime'],
  clockOut: ['clockout', 'out', 'timeout', 'outtime', 'end', 'endtime', 'clockedout', 'punchout', 'shiftend', 'outdatetime'],
  hours: ['paidhours', 'totalhours', 'hoursworked', 'hours', 'totalpaidhours', 'regularhours', 'workedhours', 'payablehours', 'duration'],
  breakMinutes: ['breakminutes', 'unpaidbreak', 'unpaidbreakminutes', 'breaks', 'break', 'breaktime'],
  cardTips: ['credittips', 'cardtips', 'chargedtips', 'noncashtips', 'tipscredit', 'creditcardtips', 'electronictips'],
  cashTips: ['cashtips', 'declaredtips', 'declaredcashtips', 'tipscash', 'tipsdeclared'],
  tips: ['tips', 'totaltips', 'tipamount', 'tip', 'gratuity'],
};

export function detectColumns(headers: string[]): Mapping {
  const keys = headers.map(key);
  const out: Mapping = {};
  const used = new Set<number>();
  for (const f of FIELDS) {
    for (const want of NAMES[f]) {
      const i = keys.findIndex((k, ix) => k === want && !used.has(ix));
      if (i >= 0) { out[f] = i; used.add(i); break; }
    }
  }
  // "Clock In Time" and similar: contains the name, and no exact name was found
  for (const f of ['clockIn', 'clockOut', 'hours', 'date', 'cardTips', 'cashTips'] as Field[]) {
    if (out[f] !== undefined) continue;
    for (const want of NAMES[f].filter((w) => w.length >= 5)) {
      const i = keys.findIndex((k, ix) => k.includes(want) && !used.has(ix));
      if (i >= 0) { out[f] = i; used.add(i); break; }
    }
  }
  // one name column beats a first and last pair that came from the same thing
  if (out.first !== undefined && out.last !== undefined && out.name !== undefined && keys[out.name] === 'employee') delete out.name;
  return out;
}

// ---------------------------------------------------------------- reading values

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${pad(m)}-${pad(d)}` : null);

/** A calendar date in any of the ways a report writes one. Day first is not guessed: a US restaurant's reports are month first. */
export function readDate(raw: string): string | null {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return ymd(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s);
  if (m) { const y = +m[3]!; return ymd(y < 100 ? 2000 + y : y, +m[1]!, +m[2]!); }
  m = /^(\d{1,2})-(\d{1,2})-(\d{4})/.exec(s);
  if (m) return ymd(+m[3]!, +m[1]!, +m[2]!);
  m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(s);
  if (m) { const mo = MONTHS.indexOf(m[1]!.toLowerCase()); return mo >= 0 ? ymd(+m[3]!, mo + 1, +m[2]!) : null; }
  m = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})/.exec(s);
  if (m) { const mo = MONTHS.indexOf(m[2]!.toLowerCase()); return mo >= 0 ? ymd(+m[3]!, mo + 1, +m[1]!) : null; }
  return null;
}

/** A time of day as minutes after midnight: 5:30 PM, 17:30, 5pm, 1730 is not accepted (too easy to misread). */
export function readClock(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  const m = /(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm|a|p)?\b/.exec(s) ?? /\b(\d{1,2})()\s*(am|pm)\b/.exec(s);
  if (!m) return null;
  let h = +m[1]!; const min = m[2] ? +m[2] : 0; const ap = m[3];
  if (min > 59 || h > 24) return null;
  if (ap) { if (h < 1 || h > 12) return null; if (ap.startsWith('p') && h < 12) h += 12; if (ap.startsWith('a') && h === 12) h = 0; }
  return h * 60 + min;
}

/** How long: 6.5, 6:30, 6h 30m, 6 hrs 30 min. Returns minutes. */
export function readDuration(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  let m = /^(\d+):(\d{2})(?::\d{2})?$/.exec(s);
  if (m) return +m[1]! * 60 + +m[2]!;
  m = /^(?:(\d+(?:\.\d+)?)\s*h[a-z]*)?\s*(?:(\d+)\s*m[a-z]*)?$/.exec(s);
  if (m && (m[1] || m[2])) return Math.round(+(m[1] ?? 0) * 60) + +(m[2] ?? 0);
  m = /^\d+(?:\.\d+)?$/.exec(s);
  return m ? Math.round(parseFloat(s) * 60) : null;
}

/** An unpaid break: 30, 0:30, or 0.5. A bare number up to 3 with a decimal point is hours; any other bare number is minutes. */
export function readBreak(raw: string): number {
  const s = raw.trim();
  if (/^\d+\.\d+$/.test(s) && +s <= 3) return Math.round(+s * 60);
  if (/^\d+$/.test(s)) return +s;
  return readDuration(s) ?? 0;
}

export function readMoney(raw: string): number {
  const s = raw.trim();
  if (!s || /^\(.*\)$/.test(s) || s.startsWith('-')) return 0;
  const n = parseFloat(s.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
}

/** "Last, First" and "First Last" both become First Last. */
export function readName(raw: string): { first: string; last: string; full: string } {
  const s = raw.trim().replace(/\s+/g, ' ');
  const comma = /^([^,]+),\s*(.+)$/.exec(s);
  const [first, last] = comma ? [comma[2]!, comma[1]!] : (() => { const parts = s.split(' '); return [parts.slice(0, -1).join(' '), parts.at(-1) ?? '']; })();
  return { first, last, full: `${first} ${last}`.trim() };
}

export interface ParsedRow { row: number; person: string; name: string; email?: string; shift: Omit<PosShift, 'personId'> }
export interface Report { rows: ParsedRow[]; problems: string[]; skipped: number }

const SKIP_NAME = /^(total|totals|grand total|subtotal|summary|all employees)\b/i;

export function parseReport(data: string[][], map: Mapping): Report {
  const rows: ParsedRow[] = []; const problems: string[] = []; let skipped = 0;
  const cell = (r: string[], f: Field) => (map[f] === undefined ? '' : (r[map[f]!] ?? '').trim());
  for (const [i, r] of data.entries()) {
    const n = i + 2; // the sheet's own row number, header being row 1
    if (r.every((c) => !c.trim())) continue;
    const nm = map.name !== undefined ? cell(r, 'name') : `${cell(r, 'first')} ${cell(r, 'last')}`.trim();
    if (!nm || SKIP_NAME.test(nm)) { skipped++; continue; }
    const person = map.name !== undefined || (map.first === undefined && map.last === undefined) ? readName(nm) : { first: cell(r, 'first'), last: cell(r, 'last'), full: nm };
    // the day, and when they clocked
    const dateCell = cell(r, 'date'); const inCell = cell(r, 'clockIn'); const outCell = cell(r, 'clockOut');
    let workDate = readDate(dateCell) ?? readDate(inCell);
    let minutes: number | null = null; let clockIn = ''; let clockOut = '';
    const inClock = readClock(inCell); const outClock = readClock(outCell);
    const outDate = readDate(outCell);
    if (workDate && inClock !== null && outClock !== null) {
      const startMin = inClock; let endMin = outClock;
      let days = 0;
      if (outDate && outDate > workDate) days = Math.round((Date.parse(outDate) - Date.parse(workDate)) / 86_400_000);
      else if (endMin <= startMin) days = 1; // overnight: out is earlier than in
      endMin += days * 1440;
      const span = endMin - startMin;
      minutes = span - readBreak(cell(r, 'breakMinutes'));
      const at = (d: string, m: number) => new Date(Date.parse(`${d}T00:00:00Z`) + m * 60_000).toISOString().replace('.000Z', 'Z');
      clockIn = at(workDate, startMin); clockOut = at(workDate, endMin);
    }
    const paid = map.hours === undefined ? null : readDuration(cell(r, 'hours'));
    if (paid !== null && paid > 0) minutes = paid; // a column of paid hours is the answer the system itself gave
    if (!workDate) { problems.push(`Row ${n}: no date I can read (${dateCell || inCell || 'blank'}).`); continue; }
    if (minutes === null || minutes < 1) { problems.push(`Row ${n}: ${person.full} has no hours I can read.`); continue; }
    if (minutes > 1440) { problems.push(`Row ${n}: ${person.full} has more than 24 hours in a day.`); continue; }
    if (!clockIn) { clockIn = `${workDate}T12:00:00Z`; clockOut = new Date(Date.parse(clockIn) + minutes * 60_000).toISOString().replace('.000Z', 'Z'); }
    const card = readMoney(cell(r, 'cardTips')); const cash = readMoney(cell(r, 'cashTips')); const total = readMoney(cell(r, 'tips'));
    const email = cell(r, 'email').toLowerCase();
    const hash = createHash('sha256').update(`${person.full.toLowerCase()}|${workDate}|${clockIn}|${minutes}`).digest('hex').slice(0, 24);
    rows.push({ row: n, person: email ? `email:${email}` : `name:${person.full.toLowerCase()}`, name: person.full, ...(email ? { email } : {}), shift: { externalId: hash, workDate, clockIn, clockOut, minutes, cardTipsCents: map.cardTips !== undefined || map.cashTips !== undefined ? card : total, cashTipsCents: cash } });
  }
  return { rows, problems, skipped };
}
