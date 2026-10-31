import type { PosAdapter, PosPerson, PosShift } from './types.ts';
import { arr, getJson, num, obj, str, PosError, type Fetch } from './http.ts';

/**
 * Toast, through its Labor API with the restaurant's own API credentials (created in Toast Web under standard API
 * access). Time entries carry hours and both kinds of tips, so one call has what a pay run needs.
 *   POST /authentication/v1/authentication/login   -> token.accessToken
 *   GET  /labor/v1/employees                        (header Toast-Restaurant-External-ID)
 *   GET  /labor/v1/timeEntries?startDate&endDate    (up to 30 days at a time)
 */
export const TOAST_HOSTS = { production: 'https://ws-api.toasttab.com', sandbox: 'https://ws-sandbox-api.eng.toasttab.com' } as const;
const WHO = 'Toast';
const cents = (dollars: unknown) => Math.round(num(dollars) * 100);

export function toastAdapter(creds: Record<string, string>, f: Fetch, hostOverride?: string): PosAdapter {
  const host = hostOverride ?? (creds.environment === 'sandbox' ? TOAST_HOSTS.sandbox : TOAST_HOSTS.production);
  let token = '';
  const auth = async () => {
    if (token) return token;
    const r = await getJson(f, WHO, `${host}/authentication/v1/authentication/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId: creds.clientId, clientSecret: creds.clientSecret, userAccessType: 'TOAST_MACHINE_CLIENT' }) });
    token = str(obj(r.token).accessToken);
    if (!token) throw new PosError('Toast refused those details. Check the client ID and secret.');
    return token;
  };
  const get = async (path: string) => getJson(f, WHO, `${host}${path}`, { headers: { authorization: `Bearer ${await auth()}`, 'toast-restaurant-external-id': creds.restaurantGuid ?? '' } });
  const employees = async (): Promise<PosPerson[]> => arr((await get('/labor/v1/employees')).items).filter((e) => e.deleted !== true).map((e) => ({
    externalId: str(e.guid), firstName: str(e.firstName) || str(e.chosenName), lastName: str(e.lastName), ...(str(e.email) ? { email: str(e.email).toLowerCase() } : {}),
  })).filter((p) => p.externalId);
  return {
    async check() { await employees(); return { label: 'Toast' }; },
    people: employees,
    async shifts(from, to) {
      const notes: string[] = [];
      const out: PosShift[] = [];
      // Toast reads up to 30 days per call, by clock time. Reach a day either side so a late shift near the edge is not missed, then keep by business date.
      const day = 86_400_000;
      const start = Date.parse(`${from}T00:00:00Z`) - day; const end = Date.parse(`${to}T00:00:00Z`) + 2 * day;
      for (let a = start; a < end; a += 28 * day) {
        const b = Math.min(a + 28 * day, end);
        const fmt = (t: number) => new Date(t).toISOString().replace('Z', '+0000');
        const r = await get(`/labor/v1/timeEntries?startDate=${encodeURIComponent(fmt(a))}&endDate=${encodeURIComponent(fmt(b))}`);
        for (const t of arr(r.items)) {
          if (t.deleted === true || !str(t.outDate)) continue; // an open shift is not payable yet
          const bd = str(t.businessDate); // "20181115"
          const workDate = /^\d{8}$/.test(bd) ? `${bd.slice(0, 4)}-${bd.slice(4, 6)}-${bd.slice(6)}` : '';
          if (!workDate || workDate < from || workDate > to) continue;
          const minutes = Math.round((num(t.regularHours) + num(t.overtimeHours)) * 60);
          const person = str(obj(t.employeeReference).guid);
          if (minutes < 1 || !person) continue;
          out.push({ externalId: str(t.guid), personId: person, workDate, clockIn: str(t.inDate), clockOut: str(t.outDate), minutes, cardTipsCents: cents(t.nonCashTips), cashTipsCents: cents(t.declaredCashTips) });
        }
      }
      return { shifts: out, notes };
    },
  };
}
