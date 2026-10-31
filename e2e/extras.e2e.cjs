// The optional questions turn on real screens: a bonus on a pay run, a deduction on a profile, opening balances, the tip credit notice.
const assert = require('node:assert/strict');
const { startServer, openBrowser, signUpAndVerify, buildCompany, FULL } = require('./helpers.cjs');

(async () => {
  const server = await startServer();
  const { browser, page, problems } = await openBrowser();
  try {
    await signUpAndVerify(page, server.base);
    await buildCompany(page, server.base, { answers: { ...FULL, tipcredit: { on: true }, bonuses: { on: true }, deductions: { on: true }, prior: { on: true } } });
    const id = await page.evaluate(async () => {
      const me = await (await fetch('/v1/auth/me')).json(); const cid = me.user.companyId;
      const roles = (await (await fetch(`/v1/companies/${cid}`)).json()).settings.roles;
      const r = await fetch(`/v1/companies/${cid}/employees`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-totali-csrf': '1' }, body: JSON.stringify({ firstName: 'Priya', lastName: 'Raman', roleKey: roles.find((x) => x.pay === 'hourly' && x.tipped === 'never').key, hireDate: '2026-01-05', payType: { kind: 'hourly', rateCents: 2000 }, ssn: '512-34-9001', location: 'Detroit' }) });
      return (await r.json()).id;
    });

    // opening balances and a deduction live on the person's Pay tab
    await page.goto(`${server.base}/app/people/${id}`);
    await page.click('[data-tab-name=Pay]');
    await page.click('[data-testid=ytd-open]');
    await page.fill('.modal input[name=ss]', '18400.00');
    await page.click('.modal button:has-text("Save balances")');
    await page.waitForSelector('[data-card=ytd]:has-text("Opening balances entered")');
    await page.click('[data-testid=add-deduction]');
    await page.fill('.modal input[name=amt]', '5');
    await page.click('.modal button:has-text("Add deduction")');
    await page.waitForSelector('[data-deduction="401(k)"]:has-text("5% of pay")');
    await page.click('[data-deduction="401(k)"] button');
    await page.waitForSelector('[data-card=deductions]:has-text("None.")');

    // a bonus goes on the run and shows in the totals
    await page.goto(`${server.base}/app/payroll/run`);
    await page.waitForSelector('[data-testid=pay-period]');
    await page.waitForSelector('table.tbl input');
    const reg = page.locator('tbody tr', { hasText: 'Priya' }).locator('input[data-key=reg]'); await reg.fill('40'); await reg.dispatchEvent('change');
    await page.click('[data-testid=add-extra]');
    await page.fill('.modal input[name=label]', 'Holiday bonus');
    await page.fill('.modal input[name=amount]', '250.00');
    await page.click('.modal button:has-text("Add")');
    await page.waitForSelector('[data-adjustment="0"]:has-text("Holiday bonus")');
    await page.click('.btn:has-text("Review payroll")');
    await page.waitForURL('**/app/payroll/runs/**');
    await page.waitForSelector('h3:has-text("Every paycheck")');
    const gross = await page.locator('tbody tr[data-employee]').first().textContent();
    assert.ok(gross.includes('1,050.00'), `gross is 40 hours x $20 plus the $250 bonus: ${gross}`);

    // the invite form asks about the tip credit notice only for tipped roles
    await page.goto(`${server.base}/app/onboarding`);
    await page.waitForSelector('[data-widget] form');
    const notice = page.locator('[data-testid=tip-notice]');
    const roles = await page.locator('select[name=roleKey] option').evaluateAll((o) => o.map((x) => x.value));
    assert.ok(roles.length > 1);
    let seen = new Set();
    for (const r of roles) { await page.selectOption('select[name=roleKey]', r); seen.add(await notice.isVisible()); }
    assert.deepEqual([...seen].sort(), [false, true], 'visible for a tipped role, hidden for the rest');
    console.log('extras: ok');
  } finally {
    if (problems.length) console.log('browser problems:\n' + problems.join('\n'));
    await browser.close();
    server.stop();
  }
  assert.deepEqual(problems, []);
})().catch((e) => { console.error(e); process.exit(1); });
