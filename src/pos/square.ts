import type { PosAdapter, PosPerson, PosShift } from './types.ts';
import { arr, getJson, num, obj, str, PosError, type Fetch } from './http.ts';
import { localDate } from './zone.ts';

/**
 * Square, with an access token from the owner's own Square developer account (or an OAuth token).
 * Needs permission to read EMPLOYEES, TIMECARDS and PAYMENTS.
 *   POST /v2/team-members/search      staff (EMPLOYEES_READ)
 *   POST /v2/labor/timecards/search   clocked shifts and declared cash tips (TIMECARDS_READ)
 *   GET  /v2/payments                 card tips, which belong to the team member on the payment (PAYMENTS_READ)
 *   GET  /v2/locations                which restaurant this token can see (MERCHANT_PROFILE_READ)
 *
 * PAYMENTS_READ is required for tips. A timecard carries declared cash tips only. Card tips live on the payment.
 */
export const SQUARE_HOSTS = { production: 'https://connect.squareup.com', sandbox: 'https://connect.squareupsandbox.com' } as const;
export const SQUARE_VERSION = '2026-09-16';
/** Read-only. PAYMENTS_READ is how card tips are attributed to the person who rang the sale. */
export const SQUARE_OAUTH_SCOPES = ['EMPLOYEES_READ', 'TIMECARDS_READ', 'MERCHANT_PROFILE_READ', 'PAYMENTS_READ'] as const;
/** OAuth state is single-use and dies after this. Short on purpose. */
export const SQUARE_OAUTH_STATE_MS = 10 * 60_000;
const WHO = 'Square';

/** Sandbox OAuth tokens never call Square production, even if a dev host override points there. */
export function squareApiHost(creds: Record<string, string>, hostOverride?: string): string {
  if (creds.environment === 'sandbox') {
    if (hostOverride === SQUARE_HOSTS.production) throw new PosError('Square sandbox connections cannot call Square production.');
    return hostOverride ?? SQUARE_HOSTS.sandbox;
  }
  return hostOverride ?? SQUARE_HOSTS.production;
}

export function squareAdapter(creds: Record<string, string>, f: Fetch, hostOverride?: string): PosAdapter {
  const host = squareApiHost(creds, hostOverride);
  const headers = { authorization: `Bearer ${creds.accessToken}`, 'square-version': SQUARE_VERSION, 'content-type': 'application/json' };
  let locationId = creds.locationId ?? '';
  const call = (method: 'GET' | 'POST', path: string, body?: unknown) => getJson(f, WHO, `${host}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const location = async () => {
    if (locationId) return locationId;
    const locs = arr((await call('GET', '/v2/locations')).locations).filter((l) => str(l.status) !== 'INACTIVE');
    if (locs.length === 1) { locationId = str(locs[0]!.id); return locationId; }
    throw new PosError(locs.length ? 'You have more than one Square location. Enter the Location ID of this restaurant.' : 'That Square account has no locations.');
  };
  async function* pages(path: string, body: Record<string, unknown>, key: string) {
    let cursor = '';
    for (let n = 0; n < 50; n++) {
      const r = await call('POST', path, { ...body, ...(cursor ? { cursor } : {}) });
      yield* arr(r[key]);
      cursor = str(r.cursor);
      if (!cursor) return;
    }
  }
  return {
    async check() {
      const id = await location();
      const name = str(arr((await call('GET', '/v2/locations')).locations).find((l) => str(l.id) === id)?.name);
      return { label: name ? `Square: ${name}` : 'Square', creds: { ...creds, locationId: id } };
    },
    async people() {
      const loc = await location();
      const out: PosPerson[] = [];
      for await (const m of pages('/v2/team-members/search', { query: { filter: { status: 'ACTIVE', location_ids: [loc] } }, limit: 200 }, 'team_members')) {
        out.push({ externalId: str(m.id), firstName: str(m.given_name), lastName: str(m.family_name), ...(str(m.email_address) ? { email: str(m.email_address).toLowerCase() } : {}) });
      }
      return out.filter((p) => p.externalId);
    },
    async shifts(from, to, timezone) {
      const loc = await location();
      const notes: string[] = [];
      const cards: Array<{ s: PosShift; start: number; end: number }> = [];
      for await (const t of pages('/v2/labor/timecards/search', { query: { filter: { location_ids: [loc], status: 'CLOSED', workday: { date_range: { start_date: from, end_date: to }, match_timecards_by: 'START_AT', default_timezone: timezone } } }, limit: 200 }, 'timecards')) {
        const a = Date.parse(str(t.start_at)); const b = Date.parse(str(t.end_at));
        if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue;
        const unpaid = arr(t.breaks).filter((x) => x.is_paid === false).reduce((n, x) => { const s = Date.parse(str(x.start_at)); const e = Date.parse(str(x.end_at)); return n + (Number.isFinite(s) && Number.isFinite(e) && e > s ? e - s : 0); }, 0);
        const minutes = Math.round((b - a - unpaid) / 60_000);
        const person = str(t.team_member_id);
        if (minutes < 1 || !person) continue;
        const tz = str(t.timezone) || timezone;
        cards.push({ start: a, end: b, s: { externalId: str(t.id), personId: person, workDate: localDate(str(t.start_at), tz), clockIn: str(t.start_at), clockOut: str(t.end_at), minutes, cardTipsCents: 0, cashTipsCents: Math.round(num(obj(t.declared_cash_tip_money).amount)) } });
      }
      // Card tips sit on the payments. They go to the shift the payment was taken during, by the team member on the payment.
      let unplaced = 0; let unattributed = 0;
      if (cards.length) {
        const begin = new Date(Date.parse(`${from}T00:00:00Z`) - 86_400_000).toISOString(); const end = new Date(Date.parse(`${to}T00:00:00Z`) + 2 * 86_400_000).toISOString();
        let cursor = '';
        for (let n = 0; n < 200; n++) {
          const r = await call('GET', `/v2/payments?begin_time=${encodeURIComponent(begin)}&end_time=${encodeURIComponent(end)}&location_id=${encodeURIComponent(loc)}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
          for (const p of arr(r.payments)) {
            const tip = Math.round(num(obj(p.tip_money).amount));
            if (tip <= 0 || str(p.status) !== 'COMPLETED' || str(p.source_type) !== 'CARD') continue;
            const who = str(p.team_member_id);
            if (!who) { unattributed += tip; continue; }
            const at = Date.parse(str(p.created_at));
            const hit = cards.find((c) => c.s.personId === who && at >= c.start - 3_600_000 && at <= c.end + 2 * 3_600_000);
            if (hit) hit.s.cardTipsCents += tip; else unplaced += tip;
          }
          cursor = str(r.cursor);
          if (!cursor) break;
        }
      }
      if (unattributed) notes.push(`${(unattributed / 100).toFixed(2)} dollars of card tips in Square had no team member on the payment, so they could not be given to anyone.`);
      if (unplaced) notes.push(`${(unplaced / 100).toFixed(2)} dollars of card tips were taken when the server had no clocked shift, so they were left out.`);
      return { shifts: cards.map((c) => c.s), notes };
    },
  };
}
