// Point of sale: connect a time clock, match people, pull hours and tips, and see them on Run payroll.
// The other system is a small fake server here, speaking 7shifts' documented API.
const assert = require('node:assert/strict');
const http = require('node:http');
const { startServer, openBrowser, signUpAndVerify, buildCompany } = require('./helpers.cjs');

const fake = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('content-type', 'application/json');
  if (req.headers.authorization !== 'Bearer good-token') { res.statusCode = 401; return res.end('{}'); }
  if (u.pathname === '/v2/companies') return res.end(JSON.stringify({ data: [{ id: 555 }] }));
  if (u.pathname === '/v2/company/555/users') return res.end(JSON.stringify({ data: [{ id: 11, first_name: 'Ana', last_name: 'Cruz', email: 'ana@harbor.test' }, { id: 12, first_name: 'Ben', last_name: 'Ode' }, { id: 13, first_name: 'Zed', last_name: 'Nobody' }], meta: { cursor: { next: null } } }));
  if (u.pathname === '/v2/company/555/time_punches') {
    const d = u.searchParams.get('business_date_start');
    const at = (h, m = 0) => `${d}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;
    return res.end(JSON.stringify({ data: [
      { id: 1, user_id: 11, clocked_in: at(15), clocked_out: at(21, 30), tips: 1500, breaks: [] },
      { id: 2, user_id: 12, clocked_in: at(15), clocked_out: at(23), tips: 0, breaks: [] },
      { id: 3, user_id: 13, clocked_in: at(15), clocked_out: at(19), tips: 0, breaks: [] },
    ], meta: { cursor: { next: null } } }));
  }
  res.statusCode = 404; res.end('{}');
});

(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const server = await startServer({ TOTALI_DEV_POS_HOSTS: JSON.stringify({ sevenshifts: `http://127.0.0.1:${fake.address().port}` }) });
  const { browser, page, problems } = await openBrowser();
  const shots = process.env.SHOTS;
  try {
    await signUpAndVerify(page, server.base);
    await buildCompany(page, server.base);
    await page.evaluate(async () => {
      const me = await (await fetch('/v1/auth/me')).json(); const cid = me.user.companyId;
      const roles = (await (await fetch(`/v1/companies/${cid}`)).json()).settings.roles;
      const role = roles.find((r) => r.tipped !== 'never' && r.pay === 'hourly').key;
      const mk = async (f, l, email, i) => { const r = await fetch(`/v1/companies/${cid}/employees`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-totali-csrf': '1' }, body: JSON.stringify({ firstName: f, lastName: l, ...(email ? { email } : {}), roleKey: role, hireDate: '2026-01-05', payType: { kind: 'hourly', rateCents: 1500 }, ssn: `512-34-${5000 + i}`, location: 'Detroit' }) }); if (!r.ok) throw new Error(await r.text()); };
      await mk('Ana', 'Cruz', 'ana@harbor.test', 1); await mk('Ben', 'Ode', undefined, 2);
    });

    // the home suggests connecting, and Settings has the section
    await page.goto(`${server.base}/app`);
    await page.waitForSelector('[data-type=todo_list]');
    assert.ok((await page.locator('[data-type=todo_list]').textContent()).includes('Connect your point of sale'));
    assert.ok((await page.locator('[data-testid=pos-none]').textContent()).includes('entered by hand'), 'the dashboard says hours are typed in until a system is connected');
    await page.goto(`${server.base}/app/settings/pos`);
    await page.waitForSelector('[data-provider=toast]');
    assert.deepEqual(await page.locator('[data-provider]').evaluateAll((x) => x.map((y) => y.dataset.provider)), ['toast', 'square', 'clover', 'sevenshifts']);
    assert.ok((await page.locator('main').textContent()).includes('doesn’t ring up sales'));
    if (shots) await page.screenshot({ path: `${shots}/pos-connect.png`, fullPage: true });

    // wrong details are refused and nothing is kept; the right ones connect
    await page.click('[data-provider=sevenshifts]');
    await page.fill('input[name=accessToken]', 'bad-token');
    await page.click('[data-testid=pos-connect]');
    await page.waitForSelector('.alert:has-text("refused those details")');
    await page.fill('input[name=accessToken]', 'good-token');
    await page.click('[data-testid=pos-connect]');
    await page.waitForSelector('[data-testid=pos-pull]');
    // Ana is matched by her email; Ben by name is offered
    await page.waitForSelector('[data-pos-person="11"]');
    assert.equal(await page.locator('[data-person="11"]').evaluate((s) => s.selectedOptions[0].textContent), 'Ana Cruz (suggested)');
    assert.equal(await page.locator('[data-person="12"]').evaluate((s) => s.selectedOptions[0].textContent), 'Ben Ode (suggested)');
    assert.equal(await page.locator('[data-person="13"]').evaluate((s) => s.selectedOptions[0].textContent), 'Not matched yet');

    // pull: Ana (email) is in, Ben and Zed are left out until someone matches them
    await page.click('[data-testid=pos-pull]');
    await page.waitForSelector('[data-testid=pos-summary]');
    const s1 = await page.locator('[data-testid=pos-summary]').textContent();
    assert.ok(s1.includes('1 shift for 1 person') && s1.includes('6.5 hours') && s1.includes('$15.00 in tips'), s1);
    assert.ok(s1.includes('2 people left out') && s1.includes('Ben Ode') && s1.includes('Zed Nobody'), s1);
    if (shots) await page.screenshot({ path: `${shots}/pos-pulled.png`, fullPage: true });

    // match Ben, leave Zed out, pull again: Ben arrives, Ana is not paid twice
    await page.selectOption('[data-person="12"]', { label: 'Ben Ode (suggested)' });
    await page.waitForSelector('.toasts .alert:has-text("Saved")');
    await page.selectOption('[data-person="13"]', { label: 'Not on my payroll' });
    await page.waitForTimeout(8500);
    await page.click('[data-testid=pos-pull]');
    await page.waitForFunction(() => /2 shifts for 2 people/.test((document.querySelector('[data-testid=pos-summary]') || {}).textContent || ''));
    assert.ok(!(await page.locator('[data-testid=pos-summary]').textContent()).includes('left out'));

    // the dashboard now says where hours come from, and the Time and tips list says they are automatic
    await page.goto(`${server.base}/app`);
    await page.waitForSelector('[data-testid=pos-live]');
    const live = await page.locator('[data-testid=pos-live]').textContent();
    assert.ok(live.includes('7shifts') && live.includes('last pulled today') && live.includes('2 shifts for 2 people'), live);
    assert.ok((await page.locator('[data-module=hours_tips] [data-item=hours_entry]').textContent()).includes('From 7shifts'));
    if (shots) await page.screenshot({ path: `${shots}/pos-dashboard.png`, fullPage: true });

    // Run payroll reads the same hours, and has its own button
    await page.goto(`${server.base}/app/payroll/run`);
    await page.waitForSelector('[data-period]');
    await page.click('.card .btn:has-text("Continue")');
    await page.waitForSelector('table.tbl input');
    await page.waitForSelector('[data-testid=pull-hours]');
    const ana = page.locator('tbody tr', { hasText: 'Ana' }).locator('input[data-key=reg]');
    assert.notEqual(await ana.inputValue(), '', 'her pulled hours are in the grid');
    if (shots) await page.screenshot({ path: `${shots}/pos-run.png`, fullPage: true });

    // disconnect
    await page.goto(`${server.base}/app/settings/pos`);
    await page.click('[data-testid=pos-disconnect]');
    await page.click('.modal button:has-text("Disconnect")');
    await page.waitForSelector('[data-provider=toast]');
    console.log('point of sale: ok');
  } finally {
    if (problems.length) console.log('browser problems:\n' + problems.join('\n'));
    await browser.close(); server.stop(); fake.close();
  }
  assert.deepEqual(problems.filter((p) => !/status of (400|401|502)/.test(p)), []);
})().catch((e) => { console.error(e); process.exit(1); });
