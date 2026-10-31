import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isProduction, productionProblems } from '../src/production.ts';
import { Store } from '../src/store/store.ts';
import { newCompany } from './helpers.ts';

const GOOD = { NODE_ENV: 'production', TOTALI_DATA_KEY: Buffer.alloc(32, 9).toString('base64'), TOTALI_DATA_FILE: '/var/data/db.sqlite', PUBLIC_BASE_URL: 'https://app.totali.example', RESEND_API_KEY: 're_x', RESEND_FROM: 'Totali <hi@totali.example>', STRIPE_SECRET_KEY: 'sk_live_x', STRIPE_ALLOW_LIVE: '1', STRIPE_WEBHOOK_SECRET: 'whsec_x', STRIPE_PUBLISHABLE_KEY: 'pk_live_x', TOTALI_ADMIN_TOKEN: 'a'.repeat(40) } as NodeJS.ProcessEnv;

test('production starts only when it will not lose data or break sign-in and billing', () => {
  assert.equal(isProduction({ NODE_ENV: 'production' }), true);
  assert.equal(isProduction({ RENDER: 'true' }), true);
  assert.equal(isProduction({}), false);
  assert.deepEqual(productionProblems(GOOD).errors, []);
  const without = (k: string, extra: Record<string, string> = {}) => productionProblems({ ...GOOD, [k]: undefined, ...extra } as NodeJS.ProcessEnv).errors.join(' | ');
  assert.match(without('TOTALI_DATA_KEY'), /TOTALI_DATA_KEY is not set/);
  assert.match(productionProblems({ ...GOOD, TOTALI_DATA_KEY: 'short' }).errors.join(), /32 random bytes/);
  assert.match(without('TOTALI_DATA_FILE'), /lost on every restart/);
  assert.match(without('PUBLIC_BASE_URL'), /PUBLIC_BASE_URL is not set/);
  assert.match(productionProblems({ ...GOOD, PUBLIC_BASE_URL: 'http://totali.example' }).errors.join(), /public https/);
  assert.match(productionProblems({ ...GOOD, PUBLIC_BASE_URL: 'https://localhost:3000' }).errors.join(), /public https/);
  assert.match(without('RESEND_API_KEY'), /RESEND_API_KEY/);
  assert.match(without('STRIPE_WEBHOOK_SECRET'), /STRIPE_WEBHOOK_SECRET/);
  assert.match(productionProblems({ ...GOOD, STRIPE_ALLOW_LIVE: undefined } as NodeJS.ProcessEnv).errors.join(), /live key/);
  assert.match(productionProblems({ ...GOOD, TOTALI_DEV: '1' }).errors.join(), /TOTALI_DEV/);
  assert.match(productionProblems({ ...GOOD, TOTALI_ACH_MODE: 'sandbox' }).errors.join(), /simulated bank/);
  assert.match(productionProblems({ ...GOOD, TOTALI_ADMIN_TOKEN: 'short' }).errors.join(), /too short/);
});

test('missing Stripe is a warning, not a reason to stop, and a test key is called out', () => {
  const noStripe = productionProblems({ ...GOOD, STRIPE_SECRET_KEY: undefined, STRIPE_WEBHOOK_SECRET: undefined, STRIPE_ALLOW_LIVE: undefined } as NodeJS.ProcessEnv);
  assert.deepEqual(noStripe.errors, []);
  assert.ok(noStripe.warnings.some((w) => /nobody can subscribe/.test(w)));
  assert.ok(productionProblems({ ...GOOD, STRIPE_SECRET_KEY: 'sk_test_x' }).warnings.some((w) => /test key/.test(w)));
});

test('a database backup is a consistent copy that can be opened, and only the newest are kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'totali-bk-'));
  const store = new Store(join(dir, 'db.sqlite'));
  const { company } = newCompany(store);
  const out = join(dir, 'backups');
  const files: string[] = [];
  for (let i = 0; i < 5; i++) files.push(store.backup(out, new Date(Date.UTC(2026, 9, 31, i, 0, 0))));
  assert.equal(store.backup(out, new Date(Date.UTC(2026, 9, 31, 0, 0, 0))), files[0], 'the same moment is not written twice');
  assert.equal(readdirSync(out).length, 5);
  store.pruneBackups(out, 2);
  assert.deepEqual(readdirSync(out).sort(), files.slice(3).map((f) => f.split('/').pop()!).sort());
  const copy = new Store(files[4]!);
  assert.equal(copy.companies.get(company.id)!.legalName, company.legalName, 'the copy has the data');
  assert.equal(existsSync(files[0]!), false);
  assert.throws(() => new Store().backup(out, new Date()), /in memory/);
});
