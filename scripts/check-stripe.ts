/**
 * Read-only preflight. It creates and changes nothing: it only reads, and
 * tells you what is not ready for Totali to link banks and originate ACH.
 *
 *   STRIPE_SECRET_KEY=sk_test_... TOTALI_ODFI_ROUTING=... npm run check:stripe
 *
 * Stripe is used here for bank linking only (Financial Connections). The ACH
 * settings below are what your bank gives you; Stripe has no part in them.
 */
import { StripeError, stripeKeyRefused, stripeMode } from '../src/money/stripe.ts';
import { validateRoutingNumber } from '../engine/payroll/directDeposit.ts';

const problems: string[] = [];
const ok = (m: string) => console.log(`  ok    ${m}`);
const bad = (m: string) => {
  problems.push(m);
  console.log(`  FAIL  ${m}`);
};
const note = (m: string) => console.log(`  note  ${m}`);

async function get(path: string): Promise<any> {
  const base = (process.env.STRIPE_API_BASE ?? 'https://api.stripe.com').replace(/\/+$/, '');
  const res = await fetch(base + path, { headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` }, signal: AbortSignal.timeout(20_000) });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new StripeError(body?.error?.message ?? `HTTP ${res.status}`, res.status, { type: body?.error?.type, code: body?.error?.code });
  return body;
}

console.log(`Stripe (bank linking only), mode: ${stripeMode()}`);
const refused = stripeKeyRefused();
if (stripeMode() === 'unconfigured') bad('STRIPE_SECRET_KEY is not set.');
else if (refused) bad(refused);
else {
  ok(`secret key present (${stripeMode()} mode)`);
  try {
    const acct = await get('/v1/account');
    ok(`account ${acct.id} reachable`);
  } catch (e) {
    bad(`Could not read the Stripe account: ${(e as Error).message}`);
  }
  try {
    await get('/v1/financial_connections/accounts?limit=1');
    ok('Financial Connections is enabled (linked accounts can be listed)');
  } catch (e) {
    bad(`Financial Connections is not usable on this account: ${(e as Error).message}. Enable it in the Stripe Dashboard.`);
  }
  if (stripeMode() === 'live') note('Live mode needs a completed Financial Connections registration in the Stripe Dashboard before balances and ownership are returned.');
  note('Stripe returns tokenized account numbers only. Full numbers for ACH outside Stripe need Stripe\'s approval; until then the account holder types the number and Totali checks its last four digits.');
}

console.log('\nACH origination (from your bank)');
const odfi = process.env.TOTALI_ODFI_ROUTING ?? '';
if (!odfi) bad("TOTALI_ODFI_ROUTING is not set: the routing number of the bank that receives Totali's ACH files.");
else if (!validateRoutingNumber(odfi)) bad('TOTALI_ODFI_ROUTING fails the routing-number checksum.');
else ok('TOTALI_ODFI_ROUTING looks valid');
for (const [name, what] of [['TOTALI_ODFI_NAME', 'the name of that bank'], ['TOTALI_ORIGIN_ID', 'the immediate-origin id the bank assigns (file header)'], ['TOTALI_ORIGINATOR_COMPANY_ID', 'the 10-character company id the bank assigns (batch header)']] as const) {
  if (!process.env[name]) bad(`${name} is not set: ${what}.`);
  else ok(`${name} is set`);
}
const mode = process.env.TOTALI_ACH_MODE ?? 'outbox';
if (mode === 'sandbox') note('TOTALI_ACH_MODE=sandbox is a simulated bank. No money moves.');
else note(`ACH files are written to ${process.env.TOTALI_ACH_OUTBOX ?? './.totali-data/ach-outbox'} for pickup; something has to carry them to your bank, and the bank's acknowledgement has to be recorded (POST /v1/ops/ach/files/:id/accepted).`);

console.log('\nServer');
if (!process.env.TOTALI_ADMIN_TOKEN) bad('TOTALI_ADMIN_TOKEN is not set; no company can be created and the bank cannot be recorded.');
else ok('TOTALI_ADMIN_TOKEN is set');
if (!process.env.TOTALI_DATA_KEY) bad('TOTALI_DATA_KEY is not set; SSNs and bank account numbers will be refused.');
else ok('TOTALI_DATA_KEY is set');
if (!process.env.TOTALI_DATA_FILE) bad('TOTALI_DATA_FILE is not set; data would be lost on restart.');
else ok('TOTALI_DATA_FILE is set');

console.log(problems.length ? `\n${problems.length} problem(s) to fix.` : '\nReady.');
process.exit(problems.length ? 1 : 0);
