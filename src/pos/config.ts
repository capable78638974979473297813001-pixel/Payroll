import type { OAuthApps } from './service.ts';

const PROVIDERS = {
  square: { name: 'Square', keys: ['SQUARE_APP_ID', 'SQUARE_APP_SECRET'], aliases: ['SQUARE_APPLICATION_ID', 'SQUARE_APPLICATION_SECRET'], setupUrl: 'https://developer.squareup.com/apps', callback: '/v1/pos/square/callback' },
  clover: { name: 'Clover', keys: ['CLOVER_APP_ID', 'CLOVER_APP_SECRET'], aliases: ['CLOVER_CLIENT_ID', 'CLOVER_CLIENT_SECRET'], setupUrl: 'https://docs.clover.com/dev/docs/creating-a-production-app', callback: '/v1/pos/clover/callback' },
  sevenshifts: { name: '7shifts', keys: ['SEVENSHIFTS_CLIENT_ID', 'SEVENSHIFTS_CLIENT_SECRET'], aliases: [], setupUrl: 'https://developers.7shifts.com/docs/oauth-authentication', callback: '/v1/pos/sevenshifts/callback' },
  toast: { name: 'Toast', keys: ['TOAST_PARTNER_CLIENT_ID', 'TOAST_PARTNER_CLIENT_SECRET', 'TOAST_PARTNER_ENTRY_URL'], aliases: [], setupUrl: 'https://pos.toasttab.com/partners/integration-partner-application', callback: null },
} as const;
export type ApprovalProvider = keyof typeof PROVIDERS;
const value = (env: NodeJS.ProcessEnv, name: string, alias?: string) => env[name]?.trim() || (alias ? env[alias]?.trim() : '') || '';
export function loadPosApps(env: NodeJS.ProcessEnv = process.env): OAuthApps {
  const result: OAuthApps = {};
  for (const id of Object.keys(PROVIDERS) as ApprovalProvider[]) {
    const p = PROVIDERS[id];
    const aliases: readonly string[] = p.aliases;
    const appId = value(env,p.keys[0],aliases[0]), secret = value(env,p.keys[1],aliases[1]);
    if (!appId || !secret) continue;
    if (id === 'toast') { const entryUrl = value(env,'TOAST_PARTNER_ENTRY_URL'); if (entryUrl) result.toast = { appId, secret, entryUrl }; }
    else result[id] = { appId, secret };
  }
  return result;
}
/** Deployment instructions only. Never includes configured values or credentials. */
export function providerSetup(id: ApprovalProvider) {
  const p = PROVIDERS[id];
  return { environmentKeys: [...p.keys], setupUrl: p.setupUrl, callbackPath: p.callback, requirement: id === 'toast' ? 'An approved Toast partner integration and marketplace listing.' : id === 'sevenshifts' ? 'A 7shifts partner OAuth client.' : `A registered production ${p.name} application.` };
}
export function posSetupWarnings(env: NodeJS.ProcessEnv): string[] {
  const apps = loadPosApps(env);
  return (Object.keys(PROVIDERS) as ApprovalProvider[]).filter(id => !apps[id]).map(id => `${PROVIDERS[id].name} connection is off: configure ${PROVIDERS[id].keys.join(', ')} using provider-issued app credentials. Restaurant approval is unavailable until configured.`);
}
