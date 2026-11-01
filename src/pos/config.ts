import type { OAuthApps } from './service.ts';

/** The route the app already serves. Square must redirect here, not to a path this server does not handle. */
export const SQUARE_CALLBACK_PATH = '/v1/pos/square/callback';
/** Used when SQUARE_REDIRECT_URL is unset. Register this exact URL on the Square sandbox application. */
export const SQUARE_DEFAULT_REDIRECT_URL = 'https://totali.tax/v1/pos/square/callback';

const PROVIDERS = {
  square: { name: 'Square', keys: ['SQUARE_APP_ID', 'SQUARE_APP_SECRET'], aliases: ['SQUARE_APPLICATION_ID', 'SQUARE_APPLICATION_SECRET'], setupUrl: 'https://developer.squareup.com/apps', callback: SQUARE_CALLBACK_PATH },
  clover: { name: 'Clover', keys: ['CLOVER_APP_ID', 'CLOVER_APP_SECRET'], aliases: ['CLOVER_CLIENT_ID', 'CLOVER_CLIENT_SECRET'], setupUrl: 'https://docs.clover.com/dev/docs/creating-a-production-app', callback: '/v1/pos/clover/callback' },
  sevenshifts: { name: '7shifts', keys: ['SEVENSHIFTS_CLIENT_ID', 'SEVENSHIFTS_CLIENT_SECRET'], aliases: [], setupUrl: 'https://developers.7shifts.com/docs/oauth-authentication', callback: '/v1/pos/sevenshifts/callback' },
  toast: { name: 'Toast', keys: ['TOAST_PARTNER_CLIENT_ID', 'TOAST_PARTNER_CLIENT_SECRET', 'TOAST_PARTNER_ENTRY_URL'], aliases: [], setupUrl: 'https://pos.toasttab.com/partners/integration-partner-application', callback: null },
} as const;
export type ApprovalProvider = keyof typeof PROVIDERS;
const value = (env: NodeJS.ProcessEnv, name: string, alias?: string) => env[name]?.trim() || (alias ? env[alias]?.trim() : '') || '';

/**
 * The redirect Square will use. Empty SQUARE_REDIRECT_URL means the Totali production callback.
 * A set but invalid URL disables Connect Square rather than falling back, and the value is never echoed.
 */
export function squareRedirectUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = (env.SQUARE_REDIRECT_URL ?? '').trim();
  const raw = configured || SQUARE_DEFAULT_REDIRECT_URL;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path !== SQUARE_CALLBACK_PATH) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const local = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (url.protocol !== 'https:' && !local) return null;
  return `${url.origin}${SQUARE_CALLBACK_PATH}`;
}

export function loadPosApps(env: NodeJS.ProcessEnv = process.env): OAuthApps {
  const result: OAuthApps = {};
  for (const id of Object.keys(PROVIDERS) as ApprovalProvider[]) {
    const p = PROVIDERS[id];
    const aliases: readonly string[] = p.aliases;
    const appId = value(env, p.keys[0], aliases[0]);
    const secret = value(env, p.keys[1], aliases[1]);
    if (!appId || !secret) continue;
    if (id === 'toast') {
      const entryUrl = value(env, 'TOAST_PARTNER_ENTRY_URL');
      if (entryUrl) result.toast = { appId, secret, entryUrl };
    } else if (id === 'square') {
      const redirectUrl = squareRedirectUrl(env);
      // Sandbox only. Any other SQUARE_ENVIRONMENT, including unset and production, leaves the button off.
      if ((env.SQUARE_ENVIRONMENT ?? '').trim() === 'sandbox' && redirectUrl) result.square = { appId, secret, environment: 'sandbox', redirectUrl };
    } else if (id === 'clover' || id === 'sevenshifts') {
      result[id] = { appId, secret };
    }
  }
  return result;
}

export interface ProviderSetup {
  environmentKeys: string[];
  setupUrl: string;
  callbackPath: string | null;
  requirement: string;
  redirectUrl?: string;
}

/** Deployment instructions only. Never includes configured values or credentials. */
export function providerSetup(id: ApprovalProvider): ProviderSetup {
  const p = PROVIDERS[id];
  const requirement = id === 'toast'
    ? 'An approved Toast partner integration and marketplace listing.'
    : id === 'sevenshifts'
      ? 'A 7shifts partner OAuth client.'
      : id === 'square'
        ? 'A Square sandbox application. Connect Square stays off unless SQUARE_ENVIRONMENT is sandbox.'
        : `A registered production ${p.name} application.`;
  const setup: ProviderSetup = { environmentKeys: [...p.keys], setupUrl: p.setupUrl, callbackPath: p.callback, requirement };
  if (id === 'square') {
    setup.environmentKeys = ['SQUARE_APPLICATION_ID', 'SQUARE_APPLICATION_SECRET', 'SQUARE_ENVIRONMENT', 'SQUARE_REDIRECT_URL'];
    setup.redirectUrl = SQUARE_DEFAULT_REDIRECT_URL;
  }
  return setup;
}

function squareDisabledReason(env: NodeJS.ProcessEnv): string {
  const id = value(env, 'SQUARE_APP_ID', 'SQUARE_APPLICATION_ID');
  const secret = value(env, 'SQUARE_APP_SECRET', 'SQUARE_APPLICATION_SECRET');
  if (!id || !secret) return 'Square connection is off: configure SQUARE_APPLICATION_ID and SQUARE_APPLICATION_SECRET (SQUARE_APP_ID and SQUARE_APP_SECRET are accepted) using sandbox application credentials. SQUARE_ENVIRONMENT must be sandbox. Restaurant approval is unavailable until configured.';
  if ((env.SQUARE_ENVIRONMENT ?? '').trim() !== 'sandbox') return 'Square connection is off: SQUARE_ENVIRONMENT must be sandbox. Any other value disables Connect Square. Restaurant approval is unavailable until configured.';
  return `Square connection is off: SQUARE_REDIRECT_URL must be an https callback whose path is ${SQUARE_CALLBACK_PATH} (default ${SQUARE_DEFAULT_REDIRECT_URL}). Restaurant approval is unavailable until configured.`;
}

export function posSetupWarnings(env: NodeJS.ProcessEnv): string[] {
  const apps = loadPosApps(env);
  const warnings: string[] = [];
  if (!apps.square) warnings.push(squareDisabledReason(env));
  for (const id of ['clover', 'sevenshifts', 'toast'] as const) {
    if (!apps[id]) warnings.push(`${PROVIDERS[id].name} connection is off: configure ${PROVIDERS[id].keys.join(', ')} using provider-issued app credentials. Restaurant approval is unavailable until configured.`);
  }
  return warnings;
}
