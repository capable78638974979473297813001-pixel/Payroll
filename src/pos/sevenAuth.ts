import { getJson, str, num, PosError, type Fetch } from './http.ts';

// https://developers.7shifts.com/docs/oauth-authentication — partner client-credentials grant.
export async function sevenToken(f: Fetch, app: { appId: string; secret: string }, now: number, host = 'https://app.7shifts.com') {
  const response = await getJson(f, '7shifts', `${host}/oauth2/token`, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: app.appId, client_secret: app.secret, scope: 'companies:read users:read time_punches:read locations:read roles:read' }).toString() });
  if (!str(response.access_token) || num(response.expires_in) <= 0) throw new PosError('7shifts did not issue a valid access token.');
  return { accessToken: str(response.access_token), accessExpiresAt: String(Math.floor(now / 1000) + num(response.expires_in)), authKind: 'oauth' };
}
