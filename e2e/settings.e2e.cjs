// Settings, company setup, billing and help in a real browser.
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

    // ---- the account menu
    await page.click('[data-testid=account-menu]');
    assert.ok(await page.locator('.avmenu').isVisible());
    await page.click('.avmenu a:has-text("Settings")');
    await page.waitForSelector('h1:has-text("Settings")');
    await shot('settings-dashboard');

    // ---- your answers: switch contractors off and see what it removes
    await page.click('[data-edit=contractors]');
    await page.click('.modal .opt[data-value=no]');
    await page.waitForSelector('.modal .adds:has-text("Removes")');
    assert.ok((await page.locator('.modal .adds').textContent()).includes('Contractors'));
    await page.click('.modal button:has-text("Save")');
    await page.waitForSelector('.toasts .alert:has-text("Your dashboard follows")');
    await page.waitForSelector('.card:has-text("Your answers") .row:has-text("Contractors") span[style*="italic"]:has-text("No")');
    await page.goto(`${server.base}/app`);
    await page.waitForSelector('[data-module=pay_run]');
    assert.equal(await page.locator('[data-module=contractors]').count(), 0, 'the Contractors card is gone');
    assert.equal(await page.locator('[data-module=locations]').count(), 1, 'the others stay');
    // the state is fixed
    await page.goto(`${server.base}/app/settings`);
    assert.equal(await page.locator('[data-edit=state]').count(), 0);

    // ---- pay schedule
    await page.goto(`${server.base}/app/settings/schedule`);
    await page.click('button:has-text("Change schedule")');
    await page.click('.modal .opt[data-value=biweekly]');
    await page.click('.modal button:has-text("Save")');
    await page.waitForSelector('.card:has-text("Every other week")');
    await page.waitForSelector('.toasts .alert:has-text("Your dashboard follows")');

    // ---- company setup: the EIN is checked, then locked
    await page.goto(`${server.base}/app/settings/company`);
    await page.waitForSelector('input[name=ein]');
    await shot('settings-company');
    await page.fill('input[name=ein]', '00-1234567');
    await page.click('button:has-text("Save business")');
    await page.waitForSelector('.alert:has-text("doesn’t look right")');
    await page.fill('input[name=ein]', '12-3456789');
    await page.click('button:has-text("Save business")');
    await page.waitForSelector('text=Locked once saved');
    assert.ok((await page.locator('.in.fill').first().textContent()).includes('••-•••6789'));
    await page.fill('input[name=ownerName]', 'Scott Holdan');
    await page.fill('input[name=ownerPercent]', '100');
    await page.check('input[name=ownerRuns]', { force: true });
    await page.click('button:has-text("Add owner")');
    await page.click('button:has-text("Save owners")');
    await page.waitForSelector('.row:has-text("Scott Holdan")');
    await page.fill('input[name=street]', '1412 Harbor St');
    await page.fill('input[name=city]', 'Detroit');
    await page.fill('input[name=zip]', '482');
    await page.click('button:has-text("Save address")');
    await page.waitForSelector('.alert:has-text("ZIP")');
    await page.fill('input[name=zip]', '48207');
    await page.click('button:has-text("Save address")');
    await page.waitForSelector('text=3 of 5 sections done');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    await page.setInputFiles('input[aria-label="Choose a document"]', { name: 'EIN letter.png', mimeType: 'image/png', buffer: png });
    await page.waitForSelector('.row:has-text("EIN letter.png")');
    await page.click('button:has-text("Mark company setup complete")');
    await page.waitForSelector('text=5 of 5 sections done');
    await shot('settings-company-done');

    // ---- state accounts
    await page.goto(`${server.base}/app/settings/state`);
    await page.fill('input[name=uia]', '1234567');
    await page.fill('input[name=withholding]', '<b>x</b>');
    await page.click('button:has-text("Save")');
    await page.waitForSelector('.alert:has-text("letters, numbers")');
    await page.fill('input[name=withholding]', 'MI-998877');
    await page.click('button:has-text("Save")');
    await page.waitForSelector('.toasts .alert:has-text("Saved")');
    await page.reload();
    assert.equal(await page.locator('input[name=uia]').inputValue(), '1234567');
    assert.ok(await page.locator('input[name^=city_]').count() >= 1, 'Detroit has a city account field');

    // ---- paying your team: a bad routing number is refused, a good one is kept
    await page.goto(`${server.base}/app/settings/payments`);
    await page.fill('input[name=odfiName]', 'Huron Valley Bank');
    await page.fill('input[name=odfiRoutingNumber]', '123456789');
    await page.fill('input[name=immediateOrigin]', '1234567890');
    await page.fill('input[name=companyId]', 'HARBOR001');
    await page.click('button:has-text("Save")');
    await page.waitForSelector('.alert:has-text("routing number")');
    await page.fill('input[name=odfiRoutingNumber]', '110000000');
    await page.click('button:has-text("Save")');
    await page.waitForSelector('.toasts .alert:has-text("Saved")');
    await shot('settings-payments');

    // ---- account: wrong current password, then the right one
    await page.goto(`${server.base}/app/settings/account`);
    await page.fill('input[name=current]', 'definitely-wrong');
    await page.fill('input[name=password]', 'a-brand-new-password');
    await page.click('button:has-text("Change password")');
    await page.waitForSelector('.ferr:has-text("current password")');
    await page.fill('input[name=current]', 'a-good-password');
    await page.click('button:has-text("Change password")');
    await page.waitForSelector('.toasts .alert:has-text("Password changed")');

    // ---- billing: one flat price, and payments honestly not switched on in this test server
    await page.goto(`${server.base}/app/billing`);
    await page.waitForSelector('h1:has-text("Billing")');
    await shot('billing');
    const billing = await page.locator('main').textContent();
    assert.equal(await page.locator('[data-testid=price]').textContent(), '$20 every 3 months');
    assert.ok(billing.includes('however big your team gets') && !/per employee|per-employee/i.test(billing), 'a flat price, not per employee');
    assert.ok(billing.includes('Payments aren’t switched on'));
    assert.equal(await page.locator('[data-testid=start-subscription]').count(), 0, 'no button that does nothing');
    await page.click('[data-testid=email-button]');
    await page.fill('.modal input[name=billingEmail]', 'not-an-email');
    await page.click('.modal button:has-text("Save")');
    await page.waitForSelector('.modal .ferr');
    await page.fill('.modal input[name=billingEmail]', 'books@harbor.test');
    await page.click('.modal button:has-text("Save")');
    await page.waitForSelector('text=books@harbor.test');

    // ---- help: search, categories, and a message that says plainly when email is off
    await page.goto(`${server.base}/app/help`);
    await page.waitForSelector('.faq-item');
    await shot('help');
    const all = await page.locator('.faq-item').count();
    await page.fill('input[type=search]', 'W-4');
    assert.ok(await page.locator('.faq-item').count() < all);
    await page.fill('input[type=search]', 'zzzzz');
    await page.waitForSelector('text=Nothing matches');
    await page.fill('input[type=search]', '');
    await page.click('.card.cat[data-cat=billing]');
    assert.equal(await page.locator('.faq-item').count(), 2);
    await page.fill('textarea', 'The tips screen looks odd on my phone.');
    await page.click('button:has-text("Message us")');
    await page.waitForSelector('.alert:has-text("couldn’t send")');

    // ---- sign out from the menu
    await page.click('[data-testid=account-menu]');
    await page.click('[data-testid=sign-out]');
    await page.waitForSelector('h1:has-text("Payroll that understands")');
    await page.goto(`${server.base}/app`);
    await page.waitForURL('**/login');
    console.log('settings flow: ok');
  } finally {
    if (problems.length) console.log('browser problems:\n' + problems.join('\n'));
    await browser.close();
    server.stop();
  }
  assert.deepEqual(problems, []);
})().catch((e) => { console.error(e); process.exit(1); });
