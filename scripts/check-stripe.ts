/**
 * Read-only Stripe preflight. It creates and changes nothing: it only reads,
 * and tells you what is not ready for Totali to move money.
 *
 *   STRIPE_SECRET_KEY=sk_test_... STRIPE_WEBHOOK_SECRET=whsec_... npm run check:stripe
 */
import { StripeError, stripeKeyRefused, stripeMode } from '../src/money/stripe.ts';

const problems: string[] = [];
const ok = (m: string) => console.log(`  ok    ${m}`);
const bad = (m: string) => {
  problems.push(m);
  console.log(`  FAIL  ${m}`);
};

async function get(path: string): Promise<any> {
  const base = (process.env.STRIPE_API_BASE ?? 'https://api.stripe.com').replace(/\/+$/, '');
  const res = await fetch(base + path, { headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` }, signal: AbortSignal.timeout(20_000) });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new StripeError(body?.error?.message ?? `HTTP ${res.status}`, res.status, { type: body?.error?.type, code: body?.error?.code });
  return body;
}

console.log(`Totali Stripe preflight (mode: ${stripeMode()})`);
const refused = stripeKeyRefused();
if (stripeMode() === 'unconfigured') {
  bad('STRIPE_SECRET_KEY is not set.');
} else if (refused) {
  bad(refused);
} else {
  ok(`secret key present (${stripeMode()} mode)`);
  try {
    const acct = await get('/v1/account');
    ok(`account ${acct.id} reachable`);
    if (stripeMode() === 'live' && !acct.charges_enabled) bad('This live account cannot take charges yet. Finish Stripe activation.');
  } catch (e) {
    bad(`Could not read the account: ${(e as Error).message}`);
  }
  try {
    const bal = await get('/v1/balance');
    ok(`available balance: ${bal.available.map((b: any) => `${(b.amount / 100).toFixed(2)} ${b.currency}`).join(', ') || 'none'}`);
  } catch (e) {
    bad(`Could not read the balance: ${(e as Error).message}`);
  }
  try {
    await get('/v1/accounts?limit=1');
    ok('Stripe Connect is enabled (connected accounts can be listed)');
  } catch (e) {
    bad(`Stripe Connect is not usable on this account: ${(e as Error).message}. Employees are paid to connected accounts, so Connect must be enabled.`);
  }
  console.log('  note  ACH Direct Debit (us_bank_account) and Connect transfers must be enabled for this account in the Dashboard; this script cannot test them without moving money.');
}
if (!process.env.STRIPE_WEBHOOK_SECRET) bad('STRIPE_WEBHOOK_SECRET is not set. Without it, webhooks are rejected and debits can never confirm.');
else ok('STRIPE_WEBHOOK_SECRET is set');
if (!process.env.TOTALI_ADMIN_TOKEN) bad('TOTALI_ADMIN_TOKEN is not set; no company can be created.');
if (!process.env.TOTALI_DATA_KEY) bad('TOTALI_DATA_KEY is not set; SSNs will be refused.');

console.log(problems.length ? `\n${problems.length} problem(s) to fix.` : '\nReady.');
process.exit(problems.length ? 1 : 0);
