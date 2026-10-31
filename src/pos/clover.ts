import type { PosAdapter, PosPerson, PosShift } from './types.ts';
import { arr, getJson, num, obj, str, type Fetch } from './http.ts';
import { localDate } from './zone.ts';

/**
 * Clover, with a merchant ID and an access token from a Clover app the merchant has installed (read employees, read
 * payments). Production tokens come from the Clover v2 OAuth flow, which needs an app registered with Clover.
 *   GET /v3/merchants/{mId}/employees
 *   GET /v3/merchants/{mId}/shifts      inTime / outTime in epoch milliseconds, cashTipsCollected
 *   GET /v3/merchants/{mId}/payments    tipAmount in cents, employee, createdTime in epoch milliseconds
 * Lists come back as { elements: [...] }, up to 1000 at a time, paged by offset.
 */
export const CLOVER_HOSTS = { na: 'https://api.clover.com', eu: 'https://api.eu.clover.com', la: 'https://api.la.clover.com' } as const;
const WHO = 'Clover';
const PAGE = 1000;

export function cloverAdapter(creds: Record<string, string>, f: Fetch, hostOverride?: string): PosAdapter {
  const host = hostOverride ?? CLOVER_HOSTS[(creds.region as keyof typeof CLOVER_HOSTS) ?? 'na'] ?? CLOVER_HOSTS.na;
  const m = encodeURIComponent(creds.merchantId ?? '');
  const headers = { authorization: `Bearer ${creds.accessToken}`, 'user-agent': 'Totali / 1.0 (payroll)', accept: 'application/json' };
  const get = (path: string) => getJson(f, WHO, `${host}/v3/merchants/${m}${path}`, { headers });
  async function* pages(path: string) {
    for (let offset = 0, n = 0; n < 100; n++, offset += PAGE) {
      const r = await get(`${path}${path.includes('?') ? '&' : '?'}limit=${PAGE}&offset=${offset}`);
      const items = arr(r.elements ?? r.items);
      yield* items;
      if (items.length < PAGE) return;
    }
  }
  return {
    async check() { await get('/employees?limit=1'); return { label: 'Clover' }; },
    async people() {
      const out: PosPerson[] = [];
      for await (const e of pages('/employees')) {
        if (num(e.deletedTime) > 0) continue;
        const nm = str(e.name).trim().split(/\s+/);
        out.push({ externalId: str(e.id), firstName: nm.slice(0, -1).join(' ') || nm[0] || '', lastName: nm.length > 1 ? nm.at(-1)! : '', ...(str(e.email) ? { email: str(e.email).toLowerCase() } : {}) });
      }
      return out.filter((p) => p.externalId);
    },
    async shifts(from, to, timezone) {
      const notes: string[] = [];
      const day = 86_400_000;
      const lo = Date.parse(`${from}T00:00:00Z`) - day; const hi = Date.parse(`${to}T00:00:00Z`) + 2 * day;
      const cards: Array<{ s: PosShift; start: number; end: number }> = [];
      for await (const sh of pages(`/shifts?filter=${encodeURIComponent(`in_time>=${lo}`)}&filter=${encodeURIComponent(`in_time<=${hi}`)}`)) {
        const a = num(sh.overrideInTime) || num(sh.inTime); const b = num(sh.overrideOutTime) || num(sh.outTime);
        const who = str(obj(sh.employee).id);
        if (!a || !b || b <= a || !who) continue; // still clocked in
        const minutes = Math.round((b - a) / 60_000);
        if (minutes < 1) continue;
        const inIso = new Date(a).toISOString(); const workDate = localDate(inIso, timezone);
        if (workDate < from || workDate > to) continue;
        cards.push({ start: a, end: b, s: { externalId: str(sh.id), personId: who, workDate, clockIn: inIso, clockOut: new Date(b).toISOString(), minutes, cardTipsCents: 0, cashTipsCents: Math.round(num(sh.cashTipsCollected)) } });
      }
      // Card tips sit on the payments, with the employee who took them. They go to the shift they were taken during.
      let unplaced = 0; let unattributed = 0;
      if (cards.length) {
        for await (const p of pages(`/payments?filter=${encodeURIComponent(`createdTime>=${lo}`)}&filter=${encodeURIComponent(`createdTime<=${hi}`)}`)) {
          const tip = Math.round(num(p.tipAmount));
          if (tip <= 0 || str(p.result) !== 'SUCCESS') continue;
          const who = str(obj(p.employee).id);
          if (!who) { unattributed += tip; continue; }
          const at = num(p.createdTime);
          const hit = cards.find((c) => c.s.personId === who && at >= c.start - 3_600_000 && at <= c.end + 2 * 3_600_000);
          if (hit) hit.s.cardTipsCents += tip; else unplaced += tip;
        }
      }
      if (unattributed) notes.push(`${(unattributed / 100).toFixed(2)} dollars of tips in Clover had no employee on the payment, so they could not be given to anyone.`);
      if (unplaced) notes.push(`${(unplaced / 100).toFixed(2)} dollars of tips were taken when the server had no clocked shift, so they were left out.`);
      notes.push('Clover counts a cash tip only when the server entered it at clock out.');
      return { shifts: cards.map((c) => c.s), notes };
    },
  };
}
