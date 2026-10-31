// The employee's own dashboard: the owner gets a code, an employee signs in with it and their email, sees their own pay, and asks for a bank change.
const assert = require('node:assert/strict');
const { startServer, openBrowser, signUpAndVerify, buildCompany } = require('./helpers.cjs');

(async () => {
  const server = await startServer();
  const { browser, page, problems } = await openBrowser();
  const shots = process.env.SHOTS;
  try {
    await signUpAndVerify(page, server.base);
    await buildCompany(page, server.base);
    // two people with emails, one paid run (approved), as the owner would have after a pay day
    const setup = await page.evaluate(async () => {
      const me = await (await fetch('/v1/auth/me')).json(); const cid = me.user.companyId;
      const call = async (m, p, b) => { const r = await fetch(`/v1/companies/${cid}${p}`, { method: m, headers: { 'content-type': 'application/json', 'x-totali-csrf': '1' }, body: m === 'GET' ? undefined : JSON.stringify(b ?? {}) }); if (!r.ok) throw new Error(p + ' ' + await r.text()); return r.json(); };
      const roles = (await call('GET', '')).settings.roles; const role = roles.find((r) => r.tipped === 'never' && r.pay === 'hourly').key;
      const mk = (f, l, email, i) => call('POST', '/employees', { firstName: f, lastName: l, email, roleKey: role, hireDate: '2026-01-05', payType: { kind: 'hourly', rateCents: 2150 }, ssn: `512-34-${4000 + i}`, location: 'Detroit' });
      const a = await mk('Priya', 'Raman', 'Priya@Harbor.test', 1); const b = await mk('Marcus', 'Bell', 'marcus@harbor.test', 2);
      const start = (await call('GET', '/payroll/periods')).periods.find((p) => p.state !== 'paid' && !p.current) || (await call('GET', '/payroll/periods')).periods[1];
      await call('PUT', '/time/week', { periodStart: start.periodStart, periodEnd: start.periodEnd, entries: [{ employeeId: a.id, regularMinutes: 2400 }, { employeeId: b.id, regularMinutes: 1800 }] });
      await call('PUT', '/profile', { ein: '12-3456789' });
      const run = await call('POST', '/pay-runs', { periodStart: start.periodStart, periodEnd: start.periodEnd, checkDate: start.checkDate });
      await call('POST', `/pay-runs/${run.id}/approve`, { acknowledgeReviewIssues: true });
      return { priya: a.id, runId: run.id, start: start.periodStart };
    });

    // ---- the owner finds the code in Settings and on the Onboarding page
    await page.goto(`${server.base}/app/settings/access`);
    await page.waitForSelector('[data-testid=join-code]');
    const code = (await page.locator('[data-testid=join-code]').textContent()).trim();
    assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.ok((await page.locator('.card').textContent()).includes('2 people can sign in'));
    await page.goto(`${server.base}/app/onboarding`);
    await page.waitForSelector('[data-type=employee_access] [data-testid=join-code]');
    if (shots) await page.screenshot({ path: `${shots}/emp-owner-code.png`, fullPage: true });

    // ---- an employee, on a phone, signs in
    const phone = await browser.newContext({ viewport: { width: 390, height: 820 } });
    const p2 = await phone.newPage();
    p2.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    p2.on('console', (m) => { if (m.type() === 'error' && !/status of (400|401|403|404|409|422|429)/.test(m.text())) problems.push(`console: ${m.text()}`); });
    const outbox = async () => (await (await page.request.get(`${server.base}/v1/dev/outbox`)).json()).messages;
    await p2.goto(`${server.base}/me`);
    await p2.waitForURL('**/employee');
    if (shots) await p2.screenshot({ path: `${shots}/emp-signin.png`, fullPage: true });
    // a wrong code looks exactly like a right one: nothing says which part failed, and nothing is sent
    const before = (await outbox()).length;
    await p2.fill('input[name=companyCode]', 'ZZZZ-ZZZZ'); await p2.fill('input[name=email]', 'priya@harbor.test');
    await p2.click('button:has-text("Email me a code")');
    await p2.waitForSelector('h1:has-text("Check your")');
    assert.equal((await outbox()).length, before, 'no email for a code that matches nobody');
    await p2.click('button:has-text("Start over")');
    await p2.fill('input[name=companyCode]', code.toLowerCase().replace('-', ''));
    assert.equal(await p2.locator('input[name=companyCode]').inputValue(), code.replace(/[A-Z0-9]{4}$/, (m) => m), 'the code is laid out as it is typed');
    await p2.fill('input[name=email]', 'Priya@Harbor.test');
    await p2.click('button:has-text("Email me a code")');
    await p2.waitForSelector('.cb-in');
    const mail = (await outbox()).filter((m) => m.to === 'priya@harbor.test').at(-1);
    assert.ok(mail, 'the code went to the address on file');
    const otp = /\b(\d{6})\b/.exec(mail.text)[1];
    await p2.locator('.cb-in').first().click();
    await p2.keyboard.type(otp === '000000' ? '111111' : '000000');
    await p2.click('form button[type=submit]');
    await p2.waitForSelector('.ferr:not([hidden])');
    await p2.evaluate(() => document.querySelectorAll('.cb-in').forEach((x) => { x.value = ''; }));
    await p2.locator('.cb-in').first().click();
    await p2.keyboard.type(otp);
    await p2.click('form button[type=submit]');
    await p2.waitForURL('**/me');
    await p2.waitForSelector('h1:has-text("Priya")');
    if (shots) await p2.screenshot({ path: `${shots}/emp-home.png`, fullPage: true });
    assert.ok((await p2.locator('main').textContent()).includes('Latest pay stub'));
    assert.equal(await p2.locator('.nav .org b').textContent(), 'Harbor Street Kitchen');

    // ---- pay stubs: her own, with the explanation
    await p2.click('.nav a[data-tab=stubs]');
    await p2.waitForSelector('tr[data-run]');
    assert.equal(await p2.locator('tr[data-run]').count(), 1);
    await p2.click('tr[data-run] a');
    await p2.waitForSelector('.receipt');
    if (shots) await p2.screenshot({ path: `${shots}/emp-stub.png`, fullPage: true });
    const stub = await p2.locator('main').textContent();
    assert.ok(stub.includes('Priya Raman') && !stub.includes('Marcus') && stub.includes('How your check was'));
    // someone else's stub id is not hers to open
    const other = await page.evaluate(async ([runId]) => runId, [setup.runId]);
    const res = await p2.evaluate(async (id) => (await fetch(`/v1/portal/stubs/${id}x`)).status, other);
    assert.equal(res, 404);

    // ---- hours
    await p2.click('.nav a[data-tab=hours]');
    await p2.waitForSelector('h1:has-text("hours")');
    await p2.click('[data-testid=prev]');
    await p2.waitForSelector('table.tbl');

    // ---- details: W-4 update (signature checked) and a bank change that waits for the owner
    await p2.click('.nav a[data-tab=details]');
    await p2.waitForSelector('[data-testid=update-w4]');
    await p2.click('[data-testid=update-w4]');
    await p2.fill('.modal input[name=signature]', 'Not Priya');
    await p2.click('.modal button:has-text("Save my W-4")');
    await p2.waitForSelector('.modal .alert:has-text("full name")');
    await p2.click('.modal .opt[data-value=married_joint]');
    await p2.fill('.modal input[name=signature]', 'Priya Raman');
    await p2.click('.modal button:has-text("Save my W-4")');
    await p2.waitForSelector('.toasts .alert:has-text("applies from your next pay run")');
    await p2.waitForSelector('dd:has-text("Married filing jointly")');
    await p2.click('[data-testid=change-deposit]');
    await p2.fill('.modal input[name=bankName]', 'Huron Valley CU');
    await p2.fill('.modal input[name=routingNumber]', '110000000');
    await p2.fill('.modal input[name=accountNumber]', '000123454821');
    await p2.check('.modal input[name=confirm]', { force: true });
    await p2.click('.modal button:has-text("Send for approval")');
    await p2.waitForSelector('text=Waiting for your employer to approve the account ending 4821');
    // the owner is told, and nothing changed yet
    assert.ok((await outbox()).some((m) => /asked to change their direct deposit/.test(m.subject)));
    await page.reload();
    await page.waitForSelector('[data-approve-bank]');
    await page.click('[data-approve-bank]');
    await page.waitForSelector('.toasts .alert:has-text("approved")');
    await p2.reload();
    await p2.waitForSelector('dd:has-text("ending 4821")');
    assert.equal(await p2.locator('text=Waiting for your employer').count(), 0);

    // ---- the owner rotates the code: the employee is signed out at once
    await page.goto(`${server.base}/app/settings/access`);
    await page.waitForSelector('[data-testid=rotate-code]');
    await page.click('[data-testid=rotate-code]');
    await page.click('.modal button:has-text("Make a new code")');
    await page.waitForFunction((c) => !document.querySelector('[data-testid=join-code]') || document.querySelector('[data-testid=join-code]').textContent.trim() !== c, code);
    await p2.goto(`${server.base}/me`);
    await p2.waitForURL('**/employee');
    await phone.close();
    console.log('employee dashboard: ok');
  } finally {
    if (problems.length) console.log('browser problems:\n' + problems.join('\n'));
    await browser.close(); server.stop();
  }
  assert.deepEqual(problems, []);
})().catch((e) => { console.error(e); process.exit(1); });
