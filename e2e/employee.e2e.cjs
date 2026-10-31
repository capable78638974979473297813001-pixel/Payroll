// The employee's own dashboard: the owner gives out a code, the employee makes an account and sends their details, the owner approves, and then they see their own pay.
const assert = require('node:assert/strict');
const { startServer, openBrowser, signUpAndVerify, buildCompany } = require('./helpers.cjs');

(async () => {
  const server = await startServer();
  const { browser, page, problems } = await openBrowser();
  const shots = process.env.SHOTS;
  try {
    await signUpAndVerify(page, server.base);
    await buildCompany(page, server.base);
    // one existing employee, so we can check an employee only ever sees their own pay
    const call = (m, path, b) => page.evaluate(async ([m, path, b]) => {
      const me = await (await fetch('/v1/auth/me')).json(); const cid = me.user.companyId;
      const r = await fetch(`/v1/companies/${cid}${path}`, { method: m, headers: { 'content-type': 'application/json', 'x-totali-csrf': '1' }, body: m === 'GET' ? undefined : JSON.stringify(b ?? {}) });
      if (!r.ok) throw new Error(`${m} ${path} ${r.status} ${await r.text()}`); return r.json();
    }, [m, path, b]);
    const roles = (await call('GET', '')).settings.roles; const role = roles.find((r) => r.tipped === 'never' && r.pay === 'hourly').key;
    const marcus = await call('POST', '/employees', { firstName: 'Marcus', lastName: 'Bell', email: 'marcus@harbor.test', roleKey: role, hireDate: '2026-01-05', payType: { kind: 'hourly', rateCents: 2150 }, ssn: '512-34-4002', location: 'Detroit' });

    // ---- the owner sees the code on the Onboarding page, good for three days
    await page.goto(`${server.base}/app/onboarding`);
    await page.waitForSelector('[data-type=employee_access] [data-testid=join-code]');
    const code = (await page.locator('[data-testid=join-code]').textContent()).trim();
    assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.match(await page.locator('[data-testid=code-life]').textContent(), /3 days left/);
    assert.ok((await page.locator('[data-type=join_requests]').textContent()).includes('Nobody is waiting'));
    if (shots) await page.screenshot({ path: `${shots}/emp-owner-code.png`, fullPage: true });

    // ---- an employee, on a phone, makes an account
    const phone = await browser.newContext({ viewport: { width: 390, height: 820 } });
    const p2 = await phone.newPage();
    p2.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    p2.on('console', (m) => { if (m.type() === 'error' && !/status of (400|401|403|404|409|422|429)/.test(m.text())) problems.push(`console: ${m.text()}`); });
    const outbox = async () => (await (await page.request.get(`${server.base}/v1/dev/outbox`)).json()).messages;
    const mailBefore = (await outbox()).length;
    await p2.goto(`${server.base}/me`);
    await p2.waitForURL('**/employee');
    await p2.waitForSelector('h1:has-text("Create your login")');
    if (shots) await p2.screenshot({ path: `${shots}/emp-signup.png`, fullPage: true });
    // a wrong code is refused with a plain message
    await p2.fill('input[name=companyCode]', 'ZZZZ-ZZZZ'); await p2.fill('input[name=email]', 'Priya@Harbor.test'); await p2.fill('input[name=password]', 'correct horse battery');
    await p2.click('[data-testid=emp-create]');
    await p2.waitForSelector('.ferr:not([hidden]):has-text("isn’t right")');
    await p2.fill('input[name=companyCode]', code.toLowerCase().replace('-', ''));
    assert.equal(await p2.locator('input[name=companyCode]').inputValue(), code, 'the code is laid out as it is typed');
    await p2.click('[data-testid=emp-create]');
    await p2.waitForURL('**/me/join');
    await p2.waitForSelector('[data-testid=join-draft]');
    // not on the team yet: the dashboard is closed to them
    await p2.goto(`${server.base}/me`);
    await p2.waitForURL('**/me/join');
    // a bad signature is refused; nothing is saved
    await p2.fill('input[name=firstName]', 'Priya'); await p2.fill('input[name=lastName]', 'Raman');
    await p2.fill('input[name=dateOfBirth]', '1996-04-12'); await p2.fill('input[name=ssn]', '512349001');
    assert.equal(await p2.locator('input[name=ssn]').inputValue(), '512-34-9001');
    await p2.fill('input[name=routingNumber]', '110000000'); await p2.fill('input[name=accountNumber]', '000123454821');
    await p2.check('input[name=confirm]', { force: true });
    await p2.fill('input[name=signature]', 'Not Priya');
    await p2.click('[data-testid=emp-send]');
    await p2.waitForSelector('.alert:has-text("full name")');
    if (shots) await p2.screenshot({ path: `${shots}/emp-request.png`, fullPage: true });
    await p2.fill('input[name=signature]', 'Priya Raman');
    await p2.click('[data-testid=emp-send]');
    await p2.waitForSelector('[data-testid=join-pending]');
    assert.equal((await outbox()).length, mailBefore, 'no email is sent to the employee');
    // back at Totali, their name is at the top and the button waits for approval
    await p2.goto(`${server.base}/`);
    await p2.waitForSelector('[data-testid=emp-name]');
    assert.equal(await p2.locator('[data-testid=emp-name]').textContent(), 'Priya Raman');
    assert.equal(await p2.locator('[data-testid=emp-open]').textContent(), 'See your request');

    // ---- the owner sees the request and approves it, and says what the job is
    await page.goto(`${server.base}/app`);
    await page.waitForSelector('[data-type=todo_list]');
    assert.ok((await page.locator('[data-type=todo_list]').textContent()).includes('asked to join your team'), 'the home says someone is waiting');
    await page.goto(`${server.base}/app/onboarding`);
    await page.waitForSelector('[data-request]:has-text("Priya Raman")');
    await page.click('[data-testid=review-request]');
    await page.selectOption('.modal select[name=roleKey]', role);
    await page.fill('.modal input[name=rate]', '21.50');
    await page.fill('.modal input[name=startDate]', '2026-01-05');
    if (shots) await page.screenshot({ path: `${shots}/emp-approve.png` });
    await page.click('[data-testid=approve-go]');
    await page.waitForSelector('.toasts .alert:has-text("Priya is on your team")');
    await page.waitForSelector('[data-type=join_requests] .empty');
    await page.goto(`${server.base}/app/people`);
    await page.waitForSelector('tr[data-employee]:has-text("Priya Raman")');

    // a paid run for both, as the owner would have after a pay day
    const priya = (await call('GET', '/employees')).employees.find((e) => e.email === 'priya@harbor.test');
    assert.ok(priya, 'approval made the employee');
    const periods = (await call('GET', '/payroll/periods')).periods;
    const start = periods.find((p) => p.state !== 'paid' && !p.current) || periods[1];
    await call('PUT', '/time/week', { periodStart: start.periodStart, periodEnd: start.periodEnd, entries: [{ employeeId: priya.id, regularMinutes: 2400 }, { employeeId: marcus.id, regularMinutes: 1800 }] });
    await call('PUT', '/profile', { ein: '12-3456789' });
    const run = await call('POST', '/pay-runs', { periodStart: start.periodStart, periodEnd: start.periodEnd, checkDate: start.checkDate });
    await call('POST', `/pay-runs/${run.id}/approve`, { acknowledgeReviewIssues: true });
    const setup = { runId: run.id, start: start.periodStart };

    // ---- back at Totali, Priya's name is at the top and one click opens her dashboard
    await p2.goto(`${server.base}/`);
    await p2.waitForSelector('[data-testid=emp-open]:has-text("Open your dashboard")');
    if (shots) await p2.screenshot({ path: `${shots}/emp-landing.png` });
    await p2.click('[data-testid=emp-open]');
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
    await page.goto(`${server.base}/app/onboarding`);
    await page.waitForSelector('[data-approve-bank]');
    await page.click('[data-approve-bank]');
    await page.waitForSelector('.toasts .alert:has-text("approved")');
    await p2.reload();
    await p2.waitForSelector('dd:has-text("ending 4821")');
    assert.equal(await p2.locator('text=Waiting for your employer').count(), 0);

    // ---- the owner makes a new code: Priya stays signed in, and the old code no longer lets anyone make an account
    await page.goto(`${server.base}/app/settings/access`);
    await page.waitForSelector('[data-testid=rotate-code]');
    await page.click('[data-testid=rotate-code]');
    await page.click('[data-testid=confirm-new-code]');
    await page.waitForFunction((c) => document.querySelector('[data-testid=join-code]') && document.querySelector('[data-testid=join-code]').textContent.trim() !== c, code);
    await p2.goto(`${server.base}/me`);
    await p2.waitForSelector('h1:has-text("Priya")');
    const old = await p2.evaluate(async (c) => (await fetch('/v1/portal/signup', { method: 'POST', headers: { 'content-type': 'application/json', 'x-totali-csrf': '1' }, body: JSON.stringify({ code: c, email: 'late@harbor.test', password: 'correct horse battery' }) })).status, code);
    assert.equal(old, 400);

    // ---- signing out and back in with the email and password
    await p2.click('[data-testid=emp-sign-out]');
    await p2.waitForURL('**/employee');
    await p2.click('[data-testid=emp-switch]');
    await p2.fill('input[name=email]', 'priya@harbor.test'); await p2.fill('input[name=password]', 'wrong password here');
    await p2.click('[data-testid=emp-signin]');
    await p2.waitForSelector('.alert:has-text("don’t match")');
    await p2.fill('input[name=password]', 'correct horse battery');
    await p2.click('[data-testid=emp-signin]');
    await p2.waitForURL('**/me');
    await p2.waitForSelector('h1:has-text("Priya")');

    // ---- a forgotten password: nothing is emailed, so the owner allows it in the app
    await p2.click('[data-testid=emp-sign-out]');
    await p2.waitForURL('**/employee');
    await p2.click('[data-testid=emp-switch]');
    await p2.click('[data-testid=emp-forgot]');
    await p2.fill('input[name=email]', 'nobody@harbor.test');
    await p2.click('[data-testid=emp-reset-go]');
    await p2.waitForSelector('.alert:has-text("no login with that email")');
    await p2.fill('input[name=email]', 'priya@harbor.test');
    await p2.click('[data-testid=emp-reset-go]');
    await p2.waitForSelector('.alert:has-text("Your manager has been asked")');
    assert.equal((await outbox()).length, mailBefore + 1, 'only the owner\'s bank-change notice was sent; the employee gets no email');
    await page.goto(`${server.base}/app/onboarding`);
    await page.waitForSelector('[data-reset]:has-text("Priya Raman")');
    await page.click('[data-testid=allow-reset]');
    await page.waitForSelector('.toasts .alert:has-text("Allowed")');
    await p2.click('[data-testid=emp-reset-go]');
    await p2.waitForSelector('input[name=password]:visible');
    await p2.fill('input[name=password]', 'a brand new passphrase');
    await p2.click('[data-testid=emp-reset-go]');
    await p2.waitForURL('**/me');
    await p2.waitForSelector('h1:has-text("Priya")');
    await phone.close();
    console.log('employee dashboard: ok');
  } finally {
    if (problems.length) console.log('browser problems:\n' + problems.join('\n'));
    await browser.close(); server.stop();
  }
  assert.deepEqual(problems, []);
})().catch((e) => { console.error(e); process.exit(1); });
