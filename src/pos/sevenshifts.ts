import type { PosAdapter, PosPerson, PosShift } from './types.ts';
import { arr, getJson, num, obj, str, PosError, type Fetch } from './http.ts';
import { localDate } from './zone.ts';

/**
 * 7shifts, with an access token the owner makes in Company Settings, Developer Tools. 7shifts holds the time clock for
 * many restaurants whatever their POS is, so it is the way in for a lot of them.
 *   GET /v2/company/{id}/users
 *   GET /v2/company/{id}/time_punches   (business_date_start / business_date_end)
 */
const WHO = '7shifts';
const HOST = 'https://api.7shifts.com';
const VERSION = '2026-01-01';

export function sevenShiftsAdapter(creds: Record<string, string>, f: Fetch, hostOverride?: string): PosAdapter {
  const host = hostOverride ?? HOST;
  const headers = { authorization: `Bearer ${creds.accessToken}`, 'x-api-version': VERSION };
  let company = (creds.companyId ?? '').trim();
  const get = (path: string) => getJson(f, WHO, `${host}${path}`, { headers });
  const companyId = async () => {
    if (company) return company;
    const list = arr((await get('/v2/companies')).data);
    if (list.length === 1) { company = str(list[0]!.id) || str(obj(list[0]!.company).id); if (company) return company; }
    throw new PosError(list.length ? 'That 7shifts token reaches more than one company. Enter the Company ID.' : 'That 7shifts token reaches no company.');
  };
  async function* pages(path: string) {
    let cursor = '';
    for (let n = 0; n < 100; n++) {
      const r = await get(`${path}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      yield* arr(r.data);
      cursor = str(obj(obj(r.meta).cursor).next);
      if (!cursor) return;
    }
  }
  return {
    async check() { const id = await companyId(); return { label: '7shifts', creds: { ...creds, companyId: id } }; },
    async people() {
      const id = await companyId();
      const out: PosPerson[] = [];
      for await (const u of pages(`/v2/company/${id}/users?status=active&limit=500`)) out.push({ externalId: str(u.id), firstName: str(u.first_name), lastName: str(u.last_name), ...(str(u.email) ? { email: str(u.email).toLowerCase() } : {}) });
      return out.filter((p) => p.externalId);
    },
    async shifts(from, to, timezone) {
      const id = await companyId();
      const notes: string[] = [];
      const out: PosShift[] = [];
      for await (const p of pages(`/v2/company/${id}/time_punches?business_date_start=${from}&business_date_end=${to}&deleted=false&limit=100`)) {
        const a = Date.parse(str(p.clocked_in)); const b = Date.parse(str(p.clocked_out));
        if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue; // still clocked in
        const unpaid = arr(p.breaks).filter((x) => x.paid === false).reduce((n, x) => { const s = Date.parse(str(x.in)); const e = Date.parse(str(x.out)); return n + (Number.isFinite(s) && Number.isFinite(e) && e > s ? e - s : 0); }, 0);
        const minutes = Math.round((b - a - unpaid) / 60_000);
        if (minutes < 1) continue;
        out.push({ externalId: str(p.id), personId: str(p.user_id), workDate: localDate(str(p.clocked_in), timezone), clockIn: str(p.clocked_in), clockOut: str(p.clocked_out), minutes, cardTipsCents: Math.round(num(p.tips)), cashTipsCents: 0 });
      }
      if (out.some((s) => s.cardTipsCents > 0)) notes.push('7shifts does not say whether its tips are card or cash, so they are counted as card tips.');
      return { shifts: out.filter((s) => s.personId), notes };
    },
  };
}
