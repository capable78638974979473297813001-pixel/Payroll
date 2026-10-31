// Trades: add a job with cost codes and a budget, tag crews and comp classes, log hours, go over budget, export.
const assert = require('node:assert/strict');
const { startServer, openBrowser, signUpAndVerify } = require('./helpers.cjs');

(async () => {
  const server = await startServer();
  const { browser, page, problems } = await openBrowser();
  const shots = process.env.SHOTS;
  try {
    await signUpAndVerify(page, server.base, { business: 'Northgate Electric' });
    await page.evaluate(async () => {
      const call = async (method, path, body) => { const r = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-totali-csrf': '1' }, body: JSON.stringify(body ?? {}) }); if (!r.ok) throw new Error(path + ' ' + await r.text()); return r.json(); };
      await call('PUT', '/v1/builder/draft', { industry: 'construction_trades', answers: { state: 'PA', locations: [{ name: 'Yard', city: 'Pittsburgh', state: 'PA' }], team: '11-25', frequency: { value: 'weekly', weekday: 'friday' }, contractors: { on: false }, jobs: { on: true }, crews: { on: true }, wc: { on: true } }, step: 'review' });
      await call('POST', '/v1/builder/finish');
    });
    await page.goto(`${server.base}/app`);
    await page.waitForSelector('[data-module=job_costing]');
    for (const m of ['job_costing', 'crews', 'workers_comp']) assert.equal(await page.locator(`[data-module=${m}]`).count(), 1, m);
    // two electricians, tagged
    const ids = await page.evaluate(async () => {
      const me = await (await fetch('/v1/auth/me')).json(); const cid = me.user.companyId;
      const call = async (method, path, body) => { const r = await fetch(`/v1/companies/${cid}${path}`, { method, headers: { 'content-type': 'application/json', 'x-totali-csrf': '1' }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) }); if (!r.ok) throw new Error(path + ' ' + await r.text()); return r.json(); };
      const roles = (await call('GET', '')).settings.roles;
      const role = roles.find((r) => r.pay === 'hourly').key;
      const mk = (f, l, rate, i) => call('POST', '/employees', { firstName: f, lastName: l, roleKey: role, hireDate: '2026-01-05', payType: { kind: 'hourly', rateCents: rate }, ssn: `512-34-${3000 + i}`, location: 'Yard', tags: { crew: i === 1 ? 'Red' : 'Blue', wcClass: '5190' } });
      return [(await mk('Ana', 'Cruz', 4500, 1)).id, (await mk('Ben', 'Ode', 5000, 2)).id];
    });
    await page.goto(`${server.base}/app/job-costing`);
    await page.waitForSelector('h1:has-text("Job")');
    assert.ok((await page.locator('.empty').first().textContent()).includes('No jobs yet'));
    await page.click('[data-testid=add-job]');
    await page.fill('.modal input[name=name]', 'Harmon Elementary lighting');
    await page.fill('.modal input[name=budget]', '1,000.00');
    await page.check('.modal input[name=prevailing]', { force: true });
    await page.click('.modal button:has-text("Add a cost code")');
    await page.fill('.modal [data-code-row="0"] input >> nth=0', '01');
    await page.fill('.modal [data-code-row="0"] input >> nth=1', 'Rough-in');
    await page.fill('.modal [data-code-row="0"] input >> nth=2', '600');
    await page.click('.modal button:has-text("Add job")');
    await page.waitForSelector('[data-job]:has-text("Harmon Elementary lighting")');
    // log hours: Ana 8h x $45 = $360, Ben 8h x $50 = $400
    const today = new Date().toISOString().slice(0, 10);
    for (const [i, hours] of [[0, '8'], [1, '8']]) {
      await page.click('[data-testid=log-hours]');
      await page.selectOption('.modal select[name=employeeId]', ids[i]);
      await page.fill('.modal input[name=hours]', hours);
      await page.selectOption('.modal select[name=costCode]', '01');
      await page.click('.modal button:has-text("Save hours")');
      await page.waitForSelector('.toasts .alert:has-text("Saved")');
      await page.waitForFunction(([n]) => document.querySelectorAll('.modal').length === 0, [0]);
    }
    await page.reload();
    await page.waitForSelector('[data-job]');
    const bar = await page.locator('[data-job]').textContent();
    assert.ok(bar.includes('76%') && bar.includes('$760.00'), bar);
    // log two more days to go over
    for (const hours of ['8', '8']) {
      await page.click('[data-testid=log-hours]');
      await page.fill('.modal input[name=date]', new Date(Date.now() - 864e5 * (hours === '8' ? 1 : 2)).toISOString().slice(0, 10));
      await page.fill('.modal input[name=hours]', hours);
      await page.selectOption('.modal select[name=costCode]', '01');
      await page.click('.modal button:has-text("Save hours")');
      await page.waitForSelector('.toasts .alert:has-text("Saved")');
      await page.waitForFunction(() => document.querySelectorAll('.modal').length === 0);
    }
    await page.reload();
    await page.waitForSelector('.alert:has-text("over its labor budget")');
    assert.ok((await page.locator('.stats').textContent()).includes('Over budget1') || (await page.locator('.stats').textContent()).includes('1'));
    assert.ok((await page.locator('table.tbl').textContent()).includes('Over'));
    if (shots) await page.screenshot({ path: `${shots}/job-costing.png`, fullPage: true });
    // the dashboard cards read the same numbers, and the crew card has hours
    await page.goto(`${server.base}/app`);
    await page.waitForSelector('[data-module=crews] .row-list');
    assert.ok((await page.locator('[data-module=crews]').textContent()).includes('Red'));
    assert.ok((await page.locator('[data-module=job_costing]').textContent()).includes('1 over budget'));
    // the insurer's report downloads
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-module=workers_comp] button:has-text("Download payroll by class")')]);
    assert.match(dl.suggestedFilename(), /payroll-by-class-\d{4}\.csv/);
    // the profile editor carries the tags the business uses
    await page.goto(`${server.base}/app/people/${ids[0]}`);
    await page.waitForSelector('h1:has-text("Cruz")');
    assert.ok((await page.locator('.card:has-text("Job and pay")').textContent()).includes('Red'));
    await page.click('button:has-text("Edit")');
    assert.ok(await page.locator('.modal input[name=crew]').isVisible() && await page.locator('.modal input[name=wcClass]').isVisible());
    assert.equal(await page.locator('.modal input[name=department]').count(), 0, 'a trades business has no departments');
    console.log('job costing: ok');
  } finally {
    if (problems.length) console.log('browser problems:\n' + problems.join('\n'));
    await browser.close(); server.stop();
  }
  assert.deepEqual(problems, []);
})().catch((e) => { console.error(e); process.exit(1); });
