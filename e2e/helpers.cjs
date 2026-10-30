// Shared helpers for the browser tests. Playwright and Chromium come pre-installed in this environment.
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/** Start a real Totali server (in-memory data, dev email outbox) and wait until it answers. */
async function startServer(extraEnv = {}) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), TOTALI_DEV: '1', TOTALI_ADMIN_TOKEN: 'admin-e2e-token', TOTALI_DATA_KEY: Buffer.alloc(32, 7).toString('base64'), TOTALI_RATE_LIMIT_PER_MIN: '0', ...extraEnv };
  delete env.NODE_ENV;
  const proc = spawn(process.execPath, ['src/main.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${base}/health`); if (r.ok) return { base, proc, log: () => log, stop: () => proc.kill() }; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error('server did not start: ' + log);
}

async function openBrowser({ width = 1440, height = 900 } = {}) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of (400|401|403|404|409|422|429|503)/.test(m.text())) problems.push(`console: ${m.text()}`); });
  return { browser, context, page, problems };
}

let seq = 0;
/** Sign up and verify through the real screens, using the code the dev outbox holds. */
async function signUpAndVerify(page, base, { business = 'Harbor Street Kitchen' } = {}) {
  const email = `owner${Date.now()}${++seq}@harbor.test`;
  await page.goto(`${base}/signup`);
  await page.fill('input[name=firstName]', 'Sam');
  await page.fill('input[name=lastName]', 'Owner');
  await page.fill('input[name=businessName]', business);
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', 'a-good-password');
  await page.check('input[name=terms]');
  await page.click('form button[type=submit]');
  await page.waitForURL('**/signup/verify');
  const code = (await page.locator('[data-testid=dev-code]').textContent()).match(/\d{6}/)[0];
  await page.locator('.cb-in').first().click();
  await page.keyboard.type(code);
  await page.click('form button[type=submit]');
  await page.waitForURL('**/setup/industry');
  return { email, code };
}

const FULL = { state: 'MI', locations: [{ name: 'Detroit', city: 'Detroit', state: 'MI' }, { name: 'Ferndale', city: 'Ferndale', state: 'MI' }], team: '11-25', tips: { on: true, pool: 'hours' }, frequency: { value: 'weekly', weekday: 'friday' }, contractors: { on: true, count: 2 } };

/** Finish the builder through the API, as the screens would, so a test can start from a built company. */
async function buildCompany(page, base, { industry = 'restaurant', answers = FULL } = {}) {
  await page.evaluate(async ({ industry, answers }) => {
    const call = async (method, path, body) => { const r = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-totali-csrf': '1' }, body: JSON.stringify(body ?? {}) }); if (!r.ok) throw new Error(path + ' ' + r.status + ' ' + (await r.text())); return r.json(); };
    await call('PUT', '/v1/builder/draft', { industry, answers, step: 'review' });
    await call('POST', '/v1/builder/finish');
  }, { industry, answers });
  await page.goto(`${base}/app`);
  await page.waitForSelector('[data-testid=grid]');
}

module.exports = { ROOT, startServer, openBrowser, signUpAndVerify, buildCompany, FULL };
