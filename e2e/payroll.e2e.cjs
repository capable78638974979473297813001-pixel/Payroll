// Run a payroll in a real browser: hours and tips, review, approve, pay stub. People come from the API, as the people screens will.
const assert = require('node:assert/strict');
const { startServer, openBrowser, signUpAndVerify, buildCompany } = require('./helpers.cjs');

(async () => {
  const server = await startServer();
  const { browser, page, problems } = await openBrowser();
  const shots = process.env.SHOTS;
  const shot = async (name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true }); };
  try {
    await signUpAndVerify(page, server.base);
    await buildCompany(page, server.base);
    const people = await page.evaluate(async () => {
      const me = await (await fetch('/v1/auth/me')).json();
      const cid = me.user.companyId;
      const post = async (path, body) => { const r = await fetch(`/v1/companies/${cid}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-totali-csrf': '1' }, body: JSON.stringify(body) }); if (!r.ok) throw new Error(path + ' ' + await r.text()); return r.json(); };
      const list = [['Priya', 'Raman', 'line_cook'], ['Elena', 'Ruiz', 'server'], ['Marcus', 'Bell', 'line_cook']];
      const roles = (await (await fetch(`/v1/companies/${cid}`)).json()).settings.roles.map((r) => r.key);
      const out = [];
      for (const [i, [f, l, role]] of list.entries()) out.push(await post('/employees', { firstName: f, lastName: l, roleKey: roles.includes(role) ? role : roles[0], hireDate: '2026-01-05', payType: { kind: 'hourly', rateCents: 1700 }, ssn: `512-34-${1000 + i}`, location: i === 1 ? 'Ferndale' : 'Detroit', tipCreditNoticeDate: '2026-01-05' }));
      return out.map((e) => e.id);
    });
    assert.equal(people.length, 3);

    // the dashboard's Run payroll button starts at the period picker
    await page.goto(`${server.base}/app/payroll/run`);
    await page.waitForSelector('[data-testid=pay-period]');
    await shot('pay-period-with-hours');
    await page.waitForSelector('table.tbl input');
    await shot('pay-hours');
    assert.equal(await page.locator('tbody tr').count(), 3);

    // a bad cell is refused with the person's name, not a crash
    const row = (name) => page.locator('tbody tr', { hasText: name });
    await row('Priya').locator('input[data-key=reg]').fill('abc');
    await page.click('.btn:has-text("Review payroll")');
    assert.ok((await page.locator('.alert').first().textContent()).includes('Priya'), 'the error names the person');
    await row('Priya').locator('input[data-key=reg]').fill('40');
    await row('Marcus').locator('input[data-key=reg]').fill('46');
    await row('Marcus').locator('input[data-key=reg]').dispatchEvent('change');
    assert.equal(await row('Marcus').locator('input[data-key=reg]').inputValue(), '40', 'overtime is worked out from the total');
    assert.equal(await row('Marcus').locator('input[data-key=ot]').inputValue(), '6');
    assert.ok((await row('Marcus').textContent()).includes('6 hrs overtime'));
    await row('Elena').locator('input[data-key=reg]').fill('32.5');
    await row('Elena').locator('input[data-key=tips]').fill('412.30');
    await row('Elena').locator('input[data-key=cash]').fill('25.00');

    // spreadsheet import
    const csv = 'Employee,Regular hrs,Overtime hrs,Tips\n"Priya Raman",38,0,0\nNobody Here,10,0,0\n';
    await page.setInputFiles('input[type=file]', { name: 'hours.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await page.waitForSelector('.toasts .alert:has-text("Not matched: Nobody Here")');
    assert.equal(await row('Priya').locator('input[data-key=reg]').inputValue(), '38');
    await row('Priya').locator('input[data-key=reg]').fill('40');

    // save, leave, come back: the numbers are kept
    await page.click('.btn:has-text("Save draft")');
    await page.waitForSelector('.toasts .alert:has-text("Saved")');
    await page.reload();
    await page.waitForSelector('table.tbl input');
    assert.equal(await row('Elena').locator('input[data-key=tips]').inputValue(), '412.30');
    assert.equal(await row('Elena').locator('input[data-key=cash]').inputValue(), '25.00');

    // review
    await page.click('.btn:has-text("Review payroll")');
    await page.waitForURL('**/app/payroll/runs/**');
    await page.waitForSelector('h3:has-text("Every paycheck")');
    await shot('pay-review');
    assert.equal(await page.locator('tbody tr[data-employee]').count(), 3);
    assert.ok((await page.locator('.card:has-text("Before you approve")').textContent()).includes('Marcus Bell, 6 overtime hours'));
    // approving without an EIN is refused with a way forward
    await page.click('.btn:has-text("Approve pay run")');
    const ack = page.locator('.modal');
    if (await ack.count()) { await ack.locator('input[type=checkbox]').check(); await ack.locator('.btn:has-text("Approve")').click(); }
    await page.waitForSelector('text=Add your EIN before you approve');
    // add the EIN as Company setup will, then approve
    await page.evaluate(async () => {
      const me = await (await fetch('/v1/auth/me')).json();
      const r = await fetch(`/v1/companies/${me.user.companyId}/profile`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-totali-csrf': '1' }, body: JSON.stringify({ ein: '12-3456789' }) });
      if (!r.ok) throw new Error(await r.text());
    });
    await page.click('.btn:has-text("Approve pay run")');
    if (await page.locator('.modal').count()) { await page.locator('.modal input[type=checkbox]').check(); await page.locator('.modal .btn:has-text("Approve")').click(); }
    await page.waitForSelector('h1:has-text("approved")');
    await shot('pay-approved');
    assert.ok(await page.locator('h3:has-text("Pay your team")').isVisible());

    // a pay stub
    await page.click('tr[data-employee] a.who-link >> nth=0');
    await page.waitForSelector('.receipt');
    await shot('pay-stub');
    assert.ok((await page.locator('.receipt').textContent()).includes('Net pay'));
    assert.ok((await page.locator('.cal').textContent()).includes('Social Security and Medicare'));
    console.log('payroll flow: ok');
  } finally {
    if (problems.length) console.log('browser problems:\n' + problems.join('\n'));
    await browser.close();
    server.stop();
  }
  assert.deepEqual(problems, []);
})().catch((e) => { console.error(e); process.exit(1); });
