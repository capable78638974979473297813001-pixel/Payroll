// Sign in with Google against a stand-in Google server: the real redirect, PKCE and id-token checks, no real Google.
const assert = require('node:assert/strict');
const http = require('node:http');
const { startServer, openBrowser } = require('./helpers.cjs');

function fakeGoogle(clientId, profile) {
  const nonces = new Map();
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/auth') {
      const code = `code-${Math.random().toString(36).slice(2)}`;
      nonces.set(code, { nonce: u.searchParams.get('nonce'), challenge: u.searchParams.get('code_challenge') });
      const back = new URL(u.searchParams.get('redirect_uri')); back.searchParams.set('code', code); back.searchParams.set('state', u.searchParams.get('state'));
      res.writeHead(302, { location: back.toString() }); return res.end();
    }
    if (u.pathname === '/token') {
      let body = ''; for await (const c of req) body += c;
      const f = new URLSearchParams(body); const n = nonces.get(f.get('code'));
      const ok = n && f.get('client_secret') === 'sek' && require('node:crypto').createHash('sha256').update(f.get('code_verifier')).digest('base64url') === n.challenge;
      if (!ok) { res.writeHead(400); return res.end('{}'); }
      const claims = { aud: clientId, iss: 'https://accounts.google.com', exp: Math.floor(Date.now() / 1000) + 600, nonce: n.nonce, email: profile.email, email_verified: true, sub: 'g-1', given_name: profile.given, family_name: profile.family };
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id_token: `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y` }));
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` })));
}

(async () => {
  const clientId = 'e2e.apps.googleusercontent.com';
  const g = await fakeGoogle(clientId, { email: `scott${Date.now()}@harbor.test`, given: 'Scott', family: 'Holdan' });
  const server = await startServer({ GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: 'sek', GOOGLE_AUTH_URL: `${g.base}/auth`, GOOGLE_TOKEN_URL: `${g.base}/token` });
  const { browser, page, problems } = await openBrowser();
  const shots = process.env.SHOTS;
  try {
    await page.goto(`${server.base}/signup`);
    await page.waitForSelector('[data-testid=google]');
    if (shots) await page.screenshot({ path: `${shots}/signup-google.png` });
    await page.click('[data-testid=google]');
    // Google sends them back signed in; there is no password and no email code, only the business name and terms
    await page.waitForURL('**/signup/business');
    await page.waitForSelector('h1:has-text("One more thing, Scott")');
    assert.ok(await page.locator('.btn:has-text("Continue")').isDisabled());
    await page.fill('input[name=businessName]', 'Harbor Street Kitchen');
    await page.check('input[name=terms]', { force: true });
    await page.click('button:has-text("Continue")');
    await page.waitForURL('**/setup/industry');
    // the industry flow works for a Google user, and settings explains there is no password
    await page.evaluate(async () => {
      const call = async (method, path, body) => { const r = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-totali-csrf': '1' }, body: JSON.stringify(body ?? {}) }); if (!r.ok) throw new Error(path + ' ' + await r.text()); return r.json(); };
      await call('PUT', '/v1/builder/draft', { industry: 'restaurant', answers: { state: 'MI', locations: [{ name: 'Detroit', city: 'Detroit', state: 'MI' }], team: '1-10', tips: { on: true, pool: 'hours' }, frequency: { value: 'weekly', weekday: 'friday' }, contractors: { on: false } }, step: 'review' });
      await call('POST', '/v1/builder/finish');
    });
    await page.goto(`${server.base}/app/settings/account`);
    await page.waitForSelector('text=you sign in with Google', { timeout: 5000 }).catch(() => {});
    assert.ok((await page.locator('main').textContent()).includes('sign in with Google'));
    // signing out and back in with Google goes straight to the dashboard
    await page.click('[data-testid=account-menu]'); await page.click('[data-testid=sign-out]');
    await page.goto(`${server.base}/login`);
    await page.click('[data-testid=google]');
    await page.waitForURL('**/app');
    await page.waitForSelector('.nav');
    // a failed handshake comes back to the login page with a message instead of a blank screen
    await page.click('[data-testid=account-menu]'); await page.click('[data-testid=sign-out]');
    const bad = await page.request.get(`${server.base}/v1/auth/google/callback?code=x&state=y`, { maxRedirects: 0 });
    assert.equal(bad.status(), 302);
    assert.match(bad.headers().location, /\/login\?google_error=/);
    console.log('google sign-in: ok');
  } finally {
    if (problems.length) console.log('browser problems:\n' + problems.join('\n'));
    await browser.close(); server.stop(); g.srv.close();
  }
  assert.deepEqual(problems, []);
})().catch((e) => { console.error(e); process.exit(1); });
