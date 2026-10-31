/**
 * What has to be true before Totali runs for real customers. It runs when the server starts in production and refuses to
 * start if something that would lose or leak data, or break sign-in or billing, is missing. A warning is something to know
 * about but not a reason to stop.
 */
import { publicBaseUrl } from './publicUrl.ts';

export interface Problems { errors: string[]; warnings: string[] }

export const isProduction = (env: NodeJS.ProcessEnv) => env.NODE_ENV === 'production' || Boolean((env.RENDER ?? '').trim());

export function productionProblems(env: NodeJS.ProcessEnv): Problems {
  const errors: string[] = []; const warnings: string[] = [];
  const has = (k: string) => Boolean((env[k] ?? '').trim());
  const key = (env.TOTALI_DATA_KEY ?? '').trim();
  if (!key) errors.push('TOTALI_DATA_KEY is not set: Social Security numbers and bank details cannot be stored. Make one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))" and keep a copy somewhere other than the server.');
  else if (Buffer.from(key, 'base64').length !== 32) errors.push('TOTALI_DATA_KEY must be 32 random bytes, base64-encoded.');
  if (!has('TOTALI_DATA_FILE')) errors.push('TOTALI_DATA_FILE is not set: data would live in memory and be lost on every restart.');
  const base = publicBaseUrl(env);
  if (!base) errors.push('PUBLIC_BASE_URL is not set: emails, sign-in and payment pages need to know the site address. On Render, RENDER_EXTERNAL_URL can provide it automatically.');
  else if (!/^https:\/\//.test(base) || /localhost|127\.0\.0\.1|\[::1\]/.test(base)) errors.push('PUBLIC_BASE_URL must be a public https address.');
  if (!has('RESEND_API_KEY') || !has('RESEND_FROM')) errors.push('RESEND_API_KEY and RESEND_FROM are not both set: nobody could verify their email, and new hires would get no link.');
  if (env.TOTALI_DEV === '1') errors.push('TOTALI_DEV=1 is set. It shows verification codes in the browser and must never be on in production.');
  if ((env.TOTALI_ACH_MODE ?? '') === 'sandbox') errors.push('TOTALI_ACH_MODE=sandbox is a simulated bank. Do not run real payroll on it.');
  const admin = (env.TOTALI_ADMIN_TOKEN ?? '').trim();
  if (admin && admin.length < 32) errors.push('TOTALI_ADMIN_TOKEN is too short to be safe. Use at least 32 random characters.');

  const sk = (env.STRIPE_SECRET_KEY ?? '').trim();
  if (!sk) warnings.push('STRIPE_SECRET_KEY is not set: nobody can subscribe, so payroll approval is not charged for, and bank linking is off.');
  else {
    if (/^(sk|rk)_live_/.test(sk) && env.STRIPE_ALLOW_LIVE !== '1') errors.push('STRIPE_SECRET_KEY is a live key but STRIPE_ALLOW_LIVE=1 is not set, so Stripe will be refused.');
    if (/^(sk|rk)_test_/.test(sk)) warnings.push('STRIPE_SECRET_KEY is a test key: no real card will be charged.');
    if (!has('STRIPE_WEBHOOK_SECRET')) errors.push('STRIPE_WEBHOOK_SECRET is not set: renewals, failed payments and cancellations would never reach Totali.');
    if (!has('STRIPE_PUBLISHABLE_KEY')) warnings.push('STRIPE_PUBLISHABLE_KEY is not set: owners cannot link a bank account.');
  }
  if (!has('SUPPORT_EMAIL')) warnings.push('SUPPORT_EMAIL is not set: Help messages go to hello@omnia.tax.');
  if (!has('GOOGLE_CLIENT_ID')) warnings.push('Sign in with Google is off (GOOGLE_CLIENT_ID is not set).');
  if (!has('SQUARE_APP_ID')) warnings.push('Sign in with Square is off (SQUARE_APP_ID is not set): owners paste a token instead.');
  if (!has('CLOVER_APP_ID')) warnings.push('Sign in with Clover is off (CLOVER_APP_ID is not set).');
  return { errors, warnings };
}
