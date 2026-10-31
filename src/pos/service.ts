import { ApiError, badRequest, conflict, notFound } from '../lib/errors.ts';
import * as v from '../lib/validate.ts';
import { newId } from '../lib/ids.ts';
import { decryptField, encryptField } from '../lib/crypto.ts';
import { recordShift } from '../domain/timekeeping.ts';
import { daysBetween } from '../lib/dates.ts';
import type { Store } from '../store/store.ts';
import type { Employee } from '../domain/types.ts';
import type { Fetch } from './http.ts';
import { toastAdapter } from './toast.ts';
import { squareAdapter } from './square.ts';
import { sevenShiftsAdapter } from './sevenshifts.ts';
import { cloverAdapter } from './clover.ts';
import { zoneFor } from './zone.ts';
import { detectColumns, parseReport, readName, FIELDS, type Mapping } from './report.ts';
import type { PosAdapter, PosConnection, PosProviderId, PosProviderInfo, PosSummary } from './types.ts';

const ENV = { name: 'environment', label: 'Which Toast or Square', optional: true, options: [{ value: 'production', label: 'My real restaurant' }, { value: 'sandbox', label: 'A test account' }] };

export const PROVIDERS: PosProviderInfo[] = [
  { id: 'toast', name: 'Toast', brings: ['Your staff', 'Hours from the time clock', 'Card tips and declared cash tips'],
    where: 'In Toast Web, make API credentials under standard API access. Toast gives you a client ID and secret, and the restaurant GUID is in the restaurant’s details.',
    fields: [{ name: 'clientId', label: 'Client ID' }, { name: 'clientSecret', label: 'Client secret', secret: true }, { name: 'restaurantGuid', label: 'Restaurant GUID' }, { ...ENV, label: 'Which Toast' }] },
  { id: 'square', name: 'Square', brings: ['Your staff', 'Hours from Square Team timecards', 'Declared cash tips and card tips'],
    where: 'In the Square Developer Dashboard, open your application and copy its access token. It needs permission to read employees, timecards and payments. Card tips only come through when the sale was rung under a team member.',
    fields: [{ name: 'accessToken', label: 'Access token', secret: true }, { name: 'locationId', label: 'Location ID', optional: true, hint: 'Only if you have more than one location.' }, { ...ENV, label: 'Which Square' }] },
  { id: 'clover', name: 'Clover', brings: ['Your staff', 'Hours from Clover shifts', 'Card tips from payments and cash tips entered at clock out'],
    where: 'Clover gives a merchant ID and an access token to an app the restaurant has installed. The app needs permission to read employees and payments.',
    caution: 'Clover only issues production tokens through apps it has approved, so most restaurants can’t get one yet. If you can’t, import Clover’s hours report below.',
    fields: [{ name: 'merchantId', label: 'Merchant ID' }, { name: 'accessToken', label: 'Access token', secret: true }, { name: 'region', label: 'Where is the restaurant', optional: true, options: [{ value: 'na', label: 'United States or Canada' }, { value: 'eu', label: 'Europe' }, { value: 'la', label: 'Latin America' }] }] },
  { id: 'sevenshifts', name: '7shifts', brings: ['Your staff', 'Hours from the time clock', 'Tips on each punch'],
    where: 'In 7shifts, go to Company Settings, Developer Tools, and choose Create Access Token. 7shifts works with most point of sale systems, so this is the way in if yours isn’t listed.',
    fields: [{ name: 'accessToken', label: 'Access token', secret: true }, { name: 'companyId', label: 'Company ID', optional: true, hint: 'Only if the token reaches more than one company.' }] },
];

const SYNC_GAP_MS = 8_000;
const providerName = (id: PosProviderId) => (id === 'file' ? 'Spreadsheet imports' : PROVIDERS.find((p) => p.id === id)?.name ?? id);
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Reads staff, hours and tips from the restaurant's own point of sale or time clock, so nobody types them twice.
 * Totali is not a POS: it only reads. One source at a time, because two would both report the same shift.
 */
export class PosService {
  private store: Store; private now: () => Date; private f: Fetch; private hosts: Partial<Record<PosProviderId, string>>; private lastSync = new Map<string, number>();
  constructor(store: Store, now: () => Date = () => new Date(), f: Fetch = globalThis.fetch, hosts: Partial<Record<PosProviderId, string>> = {}) {
    this.store = store; this.now = now; this.f = f; this.hosts = hosts;
  }
  private iso() { return this.now().toISOString(); }

  private adapter(provider: PosProviderId, creds: Record<string, string>): PosAdapter {
    if (provider === 'file') throw conflict('file_source', 'This restaurant brings hours in from spreadsheets. Import a report instead of pulling.');
    if (provider === 'toast') return toastAdapter(creds, this.f, this.hosts.toast);
    if (provider === 'square') return squareAdapter(creds, this.f, this.hosts.square);
    if (provider === 'clover') return cloverAdapter(creds, this.f, this.hosts.clover);
    return sevenShiftsAdapter(creds, this.f, this.hosts.sevenshifts);
  }
  private connectionOf(companyId: string): PosConnection | undefined { return this.store.posConnections.where((c) => c.companyId === companyId)[0]; }
  private creds(c: PosConnection): Record<string, string> { return JSON.parse(decryptField(c.credentialsEncrypted)) as Record<string, string>; }
  private view(c: PosConnection) {
    const { credentialsEncrypted: _c, employeeMap, ...rest } = c;
    return { ...rest, linked: Object.values(employeeMap).filter((x) => !!x).length, ignored: Object.values(employeeMap).filter((x) => x === null).length };
  }

  catalog(companyId: string) {
    const c = this.connectionOf(companyId);
    return { providers: PROVIDERS, connection: c ? this.view(c) : null };
  }

  /** Check the details against the other system first. Only details that work are kept, and they are kept encrypted. */
  async connect(companyId: string, body: unknown) {
    const o = v.obj(body);
    const provider = o.provider as PosProviderId;
    const info = PROVIDERS.find((p) => p.id === provider);
    if (!info) throw badRequest('Pick the system you use.', { field: 'provider' });
    const existing = this.connectionOf(companyId);
    if (existing) throw conflict('one_source', `Disconnect ${providerName(existing.provider)} first. Two sources would both report the same shift.`);
    const creds: Record<string, string> = {};
    for (const f of info.fields) {
      const val = typeof o[f.name] === 'string' ? (o[f.name] as string).trim() : '';
      if (!val && !f.optional) throw badRequest(`Enter the ${f.label.toLowerCase()}.`, { field: f.name });
      if (val) creds[f.name] = val.slice(0, 500);
    }
    const checked = await this.adapter(provider, creds).check();
    const conn: PosConnection = { id: newId('pos'), companyId, provider, label: checked.label, credentialsEncrypted: encryptField(JSON.stringify(checked.creds ?? creds)), employeeMap: {}, connectedAt: this.iso() };
    this.store.tx(() => this.store.posConnections.put(conn));
    return this.view(conn);
  }

  disconnect(companyId: string) {
    const c = this.connectionOf(companyId);
    if (!c) throw notFound('Connection');
    this.store.tx(() => this.store.posConnections.delete(c.id));
    return { ok: true };
  }

  private require(companyId: string) {
    const c = this.connectionOf(companyId);
    if (!c) throw conflict('not_connected', 'Connect your point of sale first.');
    return c;
  }

  private team(companyId: string) { return this.store.employees.where((e) => e.companyId === companyId && !e.terminationDate); }

  /** The match to offer for someone on the other system: the same email, or failing that one person with the same name. */
  private suggest(team: Employee[], p: { firstName: string; lastName: string; email?: string }, taken: Set<string>): { employeeId: string | null; by: 'email' | 'name' | null } {
    const free = team.filter((e) => !taken.has(e.id));
    const byEmail = p.email ? free.filter((e) => e.email?.toLowerCase() === p.email) : [];
    if (byEmail.length === 1) return { employeeId: byEmail[0]!.id, by: 'email' };
    const full = norm(`${p.firstName} ${p.lastName}`);
    const byName = free.filter((e) => norm(`${e.firstName} ${e.lastName}`) === full);
    if (byName.length === 1) return { employeeId: byName[0]!.id, by: 'name' };
    return { employeeId: null, by: null };
  }


  /**
   * Weekly boxes of hours typed by hand cover a whole pay period. Real shifts replace a box only when they cover all of
   * it; shifts for part of it would be added on top and the person paid twice, so those people are held back and said so.
   */
  private boxes(companyId: string, employeeIds: Set<string>, from: string, to: string) {
    const clear = new Map<string, string[]>(); const blocked = new Map<string, string>();
    for (const id of employeeIds) {
      const groups = new Map<string, Array<{ id: string; workDate: string }>>();
      for (const sh of this.store.shifts.where((x) => x.companyId === companyId && x.employeeId === id && !x.lockedByRunId && (x.externalId ?? '').startsWith('week:'))) {
        const k = (sh.externalId ?? '').split(':').slice(0, 3).join(':');
        groups.set(k, [...(groups.get(k) ?? []), { id: sh.id, workDate: sh.workDate }]);
      }
      for (const g of groups.values()) {
        const dates = g.map((x) => x.workDate).sort(); const lo = dates[0]!; const hi = dates.at(-1)!;
        if (hi < from || lo > to) continue; // another period entirely
        if (lo >= from && hi <= to) clear.set(id, [...(clear.get(id) ?? []), ...g.map((x) => x.id)]);
        else blocked.set(id, `has weekly hours typed in for ${lo} to ${hi}, and this only covers ${from} to ${to}. Clear their weekly hours on Time and tips, or pull the whole period.`);
      }
    }
    return { clear, blocked };
  }

  async people(companyId: string) {
    const c = this.require(companyId);
    if (c.provider === 'file') return { people: [], team: this.team(companyId).map((e) => ({ id: e.id, name: `${e.firstName} ${e.lastName}`, email: e.email ?? null })) };
    const list = await this.adapter(c.provider, this.creds(c)).people();
    const team = this.team(companyId);
    const taken = new Set(Object.values(c.employeeMap).filter((x): x is string => !!x));
    return {
      people: list.map((p) => {
        const name = `${p.firstName} ${p.lastName}`.trim() || p.email || p.externalId;
        const mapped = c.employeeMap[p.externalId];
        const s = mapped === undefined ? this.suggest(team, p, taken) : { employeeId: null, by: null };
        return { externalId: p.externalId, name, firstName: p.firstName, lastName: p.lastName, email: p.email ?? null, linkedTo: mapped === undefined ? null : mapped, status: mapped === undefined ? 'new' : mapped === null ? 'ignored' : 'linked', suggestion: s.employeeId, suggestionBy: s.by };
      }),
      team: team.map((e) => ({ id: e.id, name: `${e.firstName} ${e.lastName}`, email: e.email ?? null })),
    };
  }

  /** employeeId: someone on the team, null for "not on my payroll", or '' to forget the link. */
  link(companyId: string, body: unknown) {
    const c = this.require(companyId);
    const o = v.obj(body);
    const externalId = v.str(o, 'externalId', { max: 100 });
    const map = { ...c.employeeMap };
    if (o.employeeId === '') delete map[externalId];
    else if (o.employeeId === null) map[externalId] = null;
    else {
      const e = this.store.employees.get(v.str(o, 'employeeId'));
      if (!e || e.companyId !== companyId) throw badRequest('Pick someone on your team.', { field: 'employeeId' });
      for (const [k, val] of Object.entries(map)) if (val === e.id && k !== externalId) throw conflict('already_linked', `${e.firstName} is already linked to someone else on ${providerName(c.provider)}.`);
      map[externalId] = e.id;
    }
    this.store.tx(() => this.store.posConnections.put({ ...c, employeeMap: map }));
    return { ok: true };
  }

  /**
   * Read the shifts between two dates and make Totali's match. Shifts are filed under the other system's own id, so
   * reading a day twice replaces it. Shifts that disappeared there disappear here, as long as no pay run has locked
   * them. Someone's weekly box of hours is replaced by their real shifts once those arrive.
   */
  async sync(companyId: string, body: unknown): Promise<PosSummary> {
    const c = this.require(companyId);
    const o = v.obj(body);
    const from = v.date(o, 'from'); const to = v.date(o, 'to');
    if (to < from || daysBetween(from, to) > 62) throw badRequest('Pick a period of up to two months.');
    const last = this.lastSync.get(companyId) ?? 0;
    if (this.now().getTime() - last < SYNC_GAP_MS) throw new ApiError(429, 'too_soon', 'Hold on a few seconds before pulling again.');
    this.lastSync.set(companyId, this.now().getTime());
    const company = this.store.companies.require(companyId, 'Company');
    const adapter = this.adapter(c.provider, this.creds(c));
    let read: Awaited<ReturnType<PosAdapter['shifts']>>; let people: Awaited<ReturnType<PosAdapter['people']>>;
    try {
      [read, people] = await Promise.all([adapter.shifts(from, to, zoneFor(company.homeState)), adapter.people()]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not read from your point of sale.';
      this.store.tx(() => this.store.posConnections.put({ ...c, lastError: msg }));
      throw e;
    }
    // someone with the same email on both sides is linked without asking
    const team = this.team(companyId);
    const map = { ...c.employeeMap };
    const taken = new Set(Object.values(map).filter((x): x is string => !!x));
    for (const p of people) {
      if (map[p.externalId] !== undefined) continue;
      const s = this.suggest(team, p, taken);
      if (s.by === 'email' && s.employeeId) { map[p.externalId] = s.employeeId; taken.add(s.employeeId); }
    }
    const nameOf = (id: string) => { const p = people.find((x) => x.externalId === id); return p ? `${p.firstName} ${p.lastName}`.trim() : id; };
    const prefix = `pos:${c.provider}:`;
    const boxes = this.boxes(companyId, new Set(read.shifts.map((x) => map[x.personId]).filter((x): x is string => !!x)), from, to);
    const told = new Set<string>();
    const problems: string[] = []; const written = new Set<string>(); const attempted = new Set<string>();
    const unmapped = new Map<string, { externalId: string; name: string; minutes: number }>();
    const paid = new Set<string>(); let minutes = 0; let tips = 0;
    for (const s of read.shifts) {
      const emp = map[s.personId];
      if (!emp) {
        if (emp === undefined) { const u = unmapped.get(s.personId) ?? { externalId: s.personId, name: nameOf(s.personId), minutes: 0 }; u.minutes += s.minutes; unmapped.set(s.personId, u); }
        continue;
      }
      if (boxes.blocked.has(emp)) { if (!told.has(emp)) { told.add(emp); problems.push(`${nameOf(s.personId)} ${boxes.blocked.get(emp)}`); } continue; }
      const externalId = `${prefix}${s.externalId}`.slice(0, 100);
      attempted.add(externalId);
      try {
        recordShift(this.store, companyId, { employeeId: emp, workDate: s.workDate, minutes: Math.min(s.minutes, 1440), clockIn: s.clockIn, clockOut: s.clockOut, externalId, chargedTipsCents: s.cardTipsCents, cashTipsCents: s.cashTipsCents });
        written.add(externalId); paid.add(emp); minutes += s.minutes; tips += s.cardTipsCents + s.cashTipsCents;
      } catch (e) {
        // a closed pay period or a shift before someone's start date is reported, not fatal
        problems.push(`${nameOf(s.personId)} on ${s.workDate}: ${e instanceof Error ? e.message : 'could not be saved'}`);
      }
    }
    let removed = 0;
    this.store.tx(() => {
      for (const sh of this.store.shifts.where((x) => x.companyId === companyId && x.workDate >= from && x.workDate <= to && !x.lockedByRunId)) {
        const ext = sh.externalId ?? '';
        const stalePos = ext.startsWith(prefix) && !attempted.has(ext);
        const weekBox = (boxes.clear.get(sh.employeeId) ?? []).includes(sh.id) && paid.has(sh.employeeId);
        if (stalePos || weekBox) { this.store.shifts.delete(sh.id); removed++; }
      }
      const summary: PosSummary = { at: this.iso(), from, to, shifts: written.size, people: paid.size, minutes, tipsCents: tips, removed, unmapped: [...unmapped.values()].slice(0, 50), problems: problems.slice(0, 20), notes: read.notes };
      const { lastError: _e, ...rest } = c;
      this.store.posConnections.put({ ...rest, employeeMap: map, lastSyncAt: summary.at, lastSummary: summary });
    });
    return this.connectionOf(companyId)!.lastSummary!;
  }

  /**
   * Hours and tips from a report exported by any system. With apply false it only reads the report and says what it
   * found: the columns it chose, who it matched, what it could not read. With apply true it saves what it read.
   * Rows are filed by a fingerprint of who, when and how long, so importing the same report twice changes nothing; and
   * importing a corrected one replaces what an earlier file said about those people on those days.
   */
  importReport(companyId: string, body: unknown) {
    const o = v.obj(body);
    if (!Array.isArray(o.headers) || !Array.isArray(o.rows)) throw badRequest('Send the report’s header row and its rows.');
    if (o.rows.length > 5000) throw badRequest('At most 5,000 rows at a time. Split the report by pay period.');
    const headers = (o.headers as unknown[]).map((h) => String(h ?? '').trim());
    const data = (o.rows as unknown[]).map((r) => (Array.isArray(r) ? r.map((x) => String(x ?? '')) : []));
    const detected = detectColumns(headers);
    const given = o.mapping && typeof o.mapping === 'object' ? (o.mapping as Record<string, unknown>) : null;
    const mapping: Mapping = {};
    for (const f of FIELDS) {
      const pick = given ? given[f] : detected[f];
      if (typeof pick === 'number' && Number.isInteger(pick) && pick >= 0 && pick < headers.length) mapping[f] = pick;
    }
    const existing = this.connectionOf(companyId);
    if (existing && existing.provider !== 'file') throw conflict('one_source', `Disconnect ${providerName(existing.provider)} first. Two sources would both report the same shift.`);
    const hasPerson = mapping.name !== undefined || mapping.first !== undefined || mapping.last !== undefined;
    const hasTime = mapping.hours !== undefined || (mapping.clockIn !== undefined && mapping.clockOut !== undefined);
    const missing = [!hasPerson ? 'who worked (an employee name column)' : '', mapping.date === undefined && mapping.clockIn === undefined ? 'the date' : '', !hasTime ? 'the hours (paid hours, or clock in and clock out)' : ''].filter(Boolean);
    const links: Record<string, string | null> = { ...(existing?.employeeMap ?? {}) };
    if (o.links && typeof o.links === 'object') for (const [k, val] of Object.entries(o.links as Record<string, unknown>)) { if (val === '' ) delete links[k]; else if (val === null) links[k] = null; else if (typeof val === 'string') links[k] = val; }
    const team = this.team(companyId);
    const taken = new Set(Object.values(links).filter((x): x is string => !!x));
    const parsed = missing.length ? { rows: [], problems: [], skipped: 0 } : parseReport(data, mapping);
    // who is in the report, and who each is
    const byPerson = new Map<string, { key: string; name: string; email?: string; rows: number; minutes: number }>();
    for (const r of parsed.rows) { const p = byPerson.get(r.person) ?? { key: r.person, name: r.name, ...(r.email ? { email: r.email } : {}), rows: 0, minutes: 0 }; p.rows++; p.minutes += r.shift.minutes; byPerson.set(r.person, p); }
    const people = [...byPerson.values()].map((p) => {
      const linked = links[p.key];
      const s = linked === undefined ? this.suggest(team, { firstName: readName(p.name).first, lastName: readName(p.name).last, ...(p.email ? { email: p.email } : {}) }, taken) : { employeeId: null, by: null };
      const employeeId = linked === undefined ? (s.employeeId && s.by ? s.employeeId : null) : linked;
      return { ...p, status: linked === null ? 'ignored' : employeeId ? 'matched' : 'unmatched', employeeId, suggestionBy: linked === undefined ? s.by : null };
    });
    const dates = parsed.rows.map((r) => r.shift.workDate).sort();
    const analysis = {
      headers, mapping, missing, people, problems: parsed.problems.slice(0, 30), skipped: parsed.skipped,
      rows: parsed.rows.length, minutes: parsed.rows.reduce((n, r) => n + r.shift.minutes, 0), from: dates[0] ?? null, to: dates.at(-1) ?? null,
      preview: parsed.rows.slice(0, 6).map((r) => ({ row: r.row, name: r.name, date: r.shift.workDate, minutes: r.shift.minutes, cardTipsCents: r.shift.cardTipsCents, cashTipsCents: r.shift.cashTipsCents })),
      team: team.map((e) => ({ id: e.id, name: `${e.firstName} ${e.lastName}` })),
    };
    if (o.apply !== true) return { ...analysis, applied: null };
    if (missing.length) throw badRequest(`I can’t find ${missing.join(' or ')} in this report. Pick the column.`);
    if (!parsed.rows.length) throw badRequest('There are no rows with hours I can read.');

    const prefix = 'file:';
    const boxes = this.boxes(companyId, new Set(people.map((p) => p.employeeId).filter((x): x is string => !!x)), analysis.from!, analysis.to!);
    const told = new Set<string>();
    const problems = [...parsed.problems]; const written = new Set<string>(); const attempted = new Set<string>(); const paidEmp = new Set<string>();
    const unmapped = new Map<string, { externalId: string; name: string; minutes: number }>();
    let minutes = 0; let tips = 0;
    const empOf = (key: string) => { const p = people.find((x) => x.key === key); return p?.employeeId ?? null; };
    // the report's range per matched person, so a corrected file replaces the old one's rows for them
    for (const r of parsed.rows) {
      const emp = empOf(r.person);
      const p = people.find((x) => x.key === r.person)!;
      if (!emp) { if (p.status !== 'ignored') { const u = unmapped.get(r.person) ?? { externalId: r.person, name: r.name, minutes: 0 }; u.minutes += r.shift.minutes; unmapped.set(r.person, u); } continue; }
      if (boxes.blocked.has(emp)) { if (!told.has(emp)) { told.add(emp); problems.push(`${r.name} ${boxes.blocked.get(emp)}`); } continue; }
      const externalId = `${prefix}${r.shift.externalId}`;
      attempted.add(externalId);
      try {
        recordShift(this.store, companyId, { employeeId: emp, workDate: r.shift.workDate, minutes: Math.min(r.shift.minutes, 1440), clockIn: r.shift.clockIn, clockOut: r.shift.clockOut, externalId, chargedTipsCents: r.shift.cardTipsCents, cashTipsCents: r.shift.cashTipsCents });
        written.add(externalId); paidEmp.add(emp); minutes += r.shift.minutes; tips += r.shift.cardTipsCents + r.shift.cashTipsCents;
      } catch (e) { problems.push(`Row ${r.row}, ${r.name} on ${r.shift.workDate}: ${e instanceof Error ? e.message : 'could not be saved'}`); }
    }
    const from = analysis.from!; const to = analysis.to!;
    let removed = 0;
    this.store.tx(() => {
      for (const sh of this.store.shifts.where((x) => x.companyId === companyId && x.workDate >= from && x.workDate <= to && !x.lockedByRunId && paidEmp.has(x.employeeId))) {
        const ext = sh.externalId ?? '';
        if ((ext.startsWith(prefix) && !attempted.has(ext)) || (boxes.clear.get(sh.employeeId) ?? []).includes(sh.id)) { this.store.shifts.delete(sh.id); removed++; }
      }
      const summary: PosSummary = { at: this.iso(), from, to, shifts: written.size, people: paidEmp.size, minutes, tipsCents: tips, removed, unmapped: [...unmapped.values()].slice(0, 50), problems: problems.slice(0, 20), notes: [] };
      const map = Object.fromEntries(Object.entries(links).filter(([, val]) => val !== undefined));
      for (const p of people) if (p.employeeId && map[p.key] === undefined) map[p.key] = p.employeeId;
      const conn = this.connectionOf(companyId);
      const base: PosConnection = conn ?? { id: newId('pos'), companyId, provider: 'file', label: 'Spreadsheet imports', credentialsEncrypted: encryptField('{}'), employeeMap: {}, connectedAt: this.iso() };
      this.store.posConnections.put({ ...base, employeeMap: { ...base.employeeMap, ...map }, lastSyncAt: summary.at, lastSummary: summary });
    });
    return { ...analysis, applied: this.connectionOf(companyId)!.lastSummary! };
  }
}
