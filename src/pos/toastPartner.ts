import { arr, getJson, obj, str, PosError, type Fetch } from './http.ts';
import { TOAST_HOSTS } from './toast.ts';

export interface ToastPartner { appId: string; secret: string; entryUrl: string }

export function toastApprovalUrl(url: string): string {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new PosError('Toast marketplace connection is not configured.'); }
  if (parsed.protocol !== 'https:' || !['www.toasttab.com','pos.toasttab.com'].includes(parsed.hostname) || parsed.username || parsed.password || parsed.port) throw new PosError('Toast connection must use an official HTTPS Toast marketplace URL.');
  return parsed.toString();
}

/** Toast is marketplace authorization, not a generic OAuth redirect. Match a one-use location reference, never a caller-supplied restaurant GUID. */
export async function approvedToastLocation(f: Fetch, app: ToastPartner, reference: string, host: string = TOAST_HOSTS.production) {
  const auth = await getJson(f, 'Toast', `${host}/authentication/v1/authentication/login`, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId: app.appId, clientSecret: app.secret, userAccessType: 'TOAST_MACHINE_CLIENT' }) });
  const token = str(obj(auth.token).accessToken);
  if (!token) throw new PosError('Toast partner authentication failed.');
  const result = await getJson(f, 'Toast', `${host}/partners/v1/restaurants`, { headers: { authorization: `Bearer ${token}` }, redirect: 'error' });
  const matches = arr(result.items).filter(r => r.externalRestaurantRef === reference);
  if (matches.length !== 1 || !str(matches[0]!.restaurantGuid)) throw new PosError('Toast approval is not visible yet. Add Totali and the connection reference in Toast, then check again. Access can take 15 minutes or longer.');
  return { restaurantGuid: str(matches[0]!.restaurantGuid), clientId: app.appId, clientSecret: app.secret, environment: 'production', authKind: 'partner', reference };
}
