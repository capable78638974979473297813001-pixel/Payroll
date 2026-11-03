// Any point of sale: import an exported time clock report, with the columns found, checked and the people matched.
const assert = require('node:assert/strict');
const { startServer, openBrowser, signUpAndVerify, buildCompany } = require('./helpers.cjs');

const CSV = [
  'Employee,Date,Clock In,Clock Out,Paid Hours,Credit Tips,Cash Tips',
  '"Cruz, Ana",10/27/2026,5:00 PM,11:30 PM,6.5,$84.50,$20.00',
  '"Ode, Ben",10/28/2026,9:00 AM,5:00 PM,7:30,,',
  'Total,,,,14,,',
  'Pat Nobody,10/28/2026,9:00 AM,1:00 PM,4,,',
].join('\n');

(async () => {
  const server = await startServer();
  const { browser, page, problems } = await openBrowser();
  const shots = process.env.SHOTS;
  try {
    await signUpAndVerify(page, server.base);
    await buildCompany(page, server.base);
    const ids = await page.evaluate(async () => {
      const me = await (await fetch('/v1/auth/me')).json(); const cid = me.user.companyId;
      const roles = (await (await fetch(`/v1/companies/${cid}`)).json()).settings.roles;
      const role = roles.find((r) => r.tipped !== 'never' && r.pay === 'hourly').key;
      const mk = async (f, l, i) => { const r = await fetch(`/v1/companies/${cid}/employees`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-totali-csrf': '1' }, body: JSON.stringify({ firstName: f, lastName: l, roleKey: role, hireDate: '2026-01-05', payType: { kind: 'hourly', rateCents: 1500 }, ssn: `512-34-${6000 + i}`, location: 'Detroit' }) }); return (await r.json()).id; };
      return [await mk('Ana', 'Cruz', 1), await mk('Ben', 'Ode', 2)];
    });
    const shifts = () => page.evaluate(async () => { const me = await (await fetch('/v1/auth/me')).json(); return (await (await fetch(`/v1/companies/${me.user.companyId}/shifts?from=2026-10-01&to=2026-11-30`)).json()).shifts; });

    await page.goto(`${server.base}/app/settings/pos`);
    await page.waitForSelector('[data-testid=open-report]');
    await page.click('[data-testid=open-report]');
    await page.setInputFiles('[data-testid=report-file]', { name: 'labor.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
    await page.waitForSelector('[data-testid=report-found]');
    assert.ok((await page.locator('[data-testid=report-found]').textContent()).includes('3 rows'), 'the Total row is not counted');
    // the columns were found without help
    assert.equal(await page.locator('select[data-col=hours]').evaluate((s) => s.selectedOptions[0].textContent), 'Paid Hours');
    assert.equal(await page.locator('select[data-col=cardTips]').evaluate((s) => s.selectedOptions[0].textContent), 'Credit Tips');
    // Ana and Ben are matched by name; Pat is a stranger, and the owner says so
    assert.equal(await page.locator('[data-report-person="name:ana cruz"]').inputValue(), ids[0]);
    assert.equal(await page.locator('[data-report-person="name:pat nobody"]').inputValue(), '');
    await page.selectOption('[data-report-person="name:pat nobody"]', '__none');
    if (shots) await page.screenshot({ path: `${shots}/report-modal.png` });
    await page.click('[data-testid=report-import]');
    await page.waitForSelector('.toasts .alert:has-text("Imported 2 shifts for 2 people")');
    const s = await shifts();
    const row = (x) => [x.employeeId === ids[0] ? 'ana' : 'ben', x.workDate, x.minutes, x.chargedTipsCents, x.cashTipsCents];
    assert.deepEqual(s.map(row).sort(), [['ana', '2026-10-27', 390, 8450, 2000], ['ben', '2026-10-28', 450, 0, 0]]);
    assert.equal(s.length, 2);

    // the settings page now says hours come from spreadsheets, and the same file again changes nothing
    await page.reload();
    await page.waitForSelector('h3:has-text("Spreadsheet imports")');
    await page.click('[data-testid=open-report]');
    await page.setInputFiles('[data-testid=report-file]', { name: 'labor.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
    await page.waitForSelector('[data-testid=report-found]');
    await page.click('[data-testid=report-import]');
    await page.waitForSelector('.toasts .alert:has-text("Imported")');
    assert.equal((await shifts()).length, 2);

    // a report with unfamiliar column names: the owner points at the right ones
    await page.click('[data-testid=open-report]');
    const odd = 'Who,Day worked,Hrs\nAna Cruz,10/29/2026,5\n';
    await page.setInputFiles('[data-testid=report-file]', { name: 'odd.csv', mimeType: 'text/csv', buffer: Buffer.from(odd) });
    await page.waitForSelector('.alert:has-text("I can’t find")');
    assert.equal(await page.locator('[data-testid=report-import]').isDisabled(), true);
    await page.selectOption('select[data-col=name]', '0'); await page.selectOption('select[data-col=date]', '1');
    await page.selectOption('select[data-col=hours]', '2');
    await page.waitForSelector('[data-testid=report-found]');
    await page.click('[data-testid=report-import]');
    await page.waitForSelector('.toasts .alert:has-text("Imported 1 shift")');
    assert.equal((await shifts()).length, 3);

    // Run payroll offers the same import
    await page.goto(`${server.base}/app/payroll/run`);
    await page.waitForSelector('[data-testid=pay-period]');
    await page.waitForSelector('[data-testid=pull-hours]:has-text("Import a report")');
    console.log('report import: ok');
  } finally {
    if (problems.length) console.log('browser problems:\n' + problems.join('\n'));
    await browser.close(); server.stop();
  }
  assert.deepEqual(problems, []);
})().catch((e) => { console.error(e); process.exit(1); });
