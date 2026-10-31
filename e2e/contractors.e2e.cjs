// Contractors: add one, record payments, collect a W-9 from a private link, export for the accountant.
const assert = require('node:assert/strict');
const { startServer, openBrowser, signUpAndVerify, buildCompany } = require('./helpers.cjs');

(async () => {
  const server = await startServer();
  const { browser, page, problems } = await openBrowser();
  const shots = process.env.SHOTS;
  try {
    await signUpAndVerify(page, server.base);
    await buildCompany(page, server.base);
    // the dashboard card leads here
    await page.goto(`${server.base}/app`);
    await page.waitForSelector('[data-module=contractors]');
    assert.ok((await page.locator('[data-module=contractors]').textContent()).includes('No contractors yet'));
    await page.click('[data-module=contractors] a:has-text("Add a contractor")');
    await page.waitForSelector('h1:has-text("Contractors")');
    await page.click('[data-testid=add-contractor]');
    await page.fill('.modal input[name=name]', 'Sal Pipes');
    await page.fill('.modal input[name=businessName]', 'Pipes Plumbing');
    await page.fill('.modal input[name=email]', 'sal@pipes.test');
    await page.click('.modal button:has-text("Add contractor")');
    await page.waitForSelector('tr[data-contractor]:has-text("Sal Pipes")');

    await page.click('[data-payments]');
    await page.fill('.modal input[name=amount]', 'lots');
    await page.click('.modal button:has-text("Add payment")');
    await page.waitForSelector('.modal .ferr:not([hidden])');
    await page.fill('.modal input[name=amount]', '2,500.00');
    await page.fill('.modal input[name=note]', 'Water heater');
    await page.click('.modal button:has-text("Add payment")');
    await page.waitForSelector('tr[data-contractor]:has-text("1099 needed")');
    assert.ok((await page.locator('.stats').textContent()).includes('$2,500.00'));
    if (shots) await page.screenshot({ path: `${shots}/contractors.png`, fullPage: true });

    // W-9 by private link, on a phone
    await page.click('[data-w9]');
    await page.waitForSelector('.modal input[aria-label="Private link"]');
    const link = await page.locator('.modal input[aria-label="Private link"]').inputValue();
    assert.match(link, /\/w9\/[A-Za-z0-9_-]{40,}$/);
    await page.click('.modal button:has-text("Done")');
    const phone = await browser.newContext({ viewport: { width: 390, height: 800 } });
    const p2 = await phone.newPage();
    p2.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await p2.goto(link);
    await p2.waitForSelector('h1:has-text("W-9")');
    if (shots) await p2.screenshot({ path: `${shots}/w9.png`, fullPage: true });
    await p2.fill('input[name=tin]', '123');
    await p2.fill('input[name=street]', '9 Pine St'); await p2.fill('input[name=city]', 'Detroit'); await p2.fill('input[name=zip]', '48207');
    await p2.fill('input[name=signature]', 'Sal Pipes'); await p2.check('input[name=certify]', { force: true });
    await p2.click('button:has-text("Send my W-9")');
    await p2.waitForSelector('.ferr:has-text("nine digits")');
    await p2.fill('input[name=tin]', '512-34-9901');
    await p2.click('button:has-text("Send my W-9")');
    await p2.waitForSelector('h1:has-text("Thank")');
    await p2.goto(link);
    await p2.waitForSelector('h1:has-text("isn’t valid")');
    await phone.close();

    await page.reload();
    await page.waitForSelector('tr[data-contractor]');
    assert.ok((await page.locator('tr[data-contractor]').textContent()).includes('···9901'));
    assert.equal(await page.locator('[data-w9]').count(), 0);
    assert.ok((await page.locator('.stats').textContent()).includes('1 of 1'));
    // the export
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("for your accountant")')]);
    assert.equal(download.suggestedFilename(), `contractors-${new Date().getFullYear()}.csv`);
    // the card now shows real numbers
    await page.goto(`${server.base}/app`);
    await page.waitForSelector('[data-module=contractors]');
    const card = await page.locator('[data-module=contractors]').textContent();
    assert.ok(card.includes('1 contractor') && card.includes('1 of 1 W-9s'), card);
    console.log('contractors: ok');
  } finally {
    if (problems.length) console.log('browser problems:\n' + problems.join('\n'));
    await browser.close(); server.stop();
  }
  assert.deepEqual(problems, []);
})().catch((e) => { console.error(e); process.exit(1); });
