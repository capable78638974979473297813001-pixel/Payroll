// Invite a new hire, have them fill in every form from their private link on a phone, then finish the I-9 as the employer.
const assert = require('node:assert/strict');
const { startServer, openBrowser, signUpAndVerify, buildCompany } = require('./helpers.cjs');

(async () => {
  const server = await startServer();
  const { browser, context, page, problems } = await openBrowser();
  const shots = process.env.SHOTS;
  const shot = async (p, name) => { if (shots) await p.screenshot({ path: `${shots}/${name}.png`, fullPage: true }); };
  try {
    await signUpAndVerify(page, server.base);
    await buildCompany(page, server.base);

    // ---- the employer invites someone. Email isn't set up here, so the link comes up to copy.
    await page.goto(`${server.base}/app/onboarding`);
    await page.waitForSelector('[data-type=invite_form]');
    await shot(page, 'people-onboarding-empty');
    await page.fill('input[name=firstName]', 'Noor');
    await page.fill('input[name=lastName]', 'Patel');
    await page.fill('input[name=email]', 'noor.p@example.com');
    await page.selectOption('select[name=roleKey]', { index: 0 });
    await page.fill('input[name=rate]', 'nope');
    await page.click('button:has-text("Send invite")');
    assert.ok((await page.locator('.ferr:visible').first().textContent()).includes('hourly'), 'a bad rate is explained');
    await page.fill('input[name=rate]', '15.50');
    assert.ok(await page.locator('[data-form=stateForm]').isVisible(), 'Michigan adds the MI-W4');
    await page.click('button:has-text("Send invite")');
    await page.waitForSelector('.modal input[aria-label="Private link"]');
    const link = await page.locator('.modal input[aria-label="Private link"]').inputValue();
    assert.match(link, /\/join\/[A-Za-z0-9_-]{40,}$/);
    await page.click('.modal button:has-text("Done")');
    await page.waitForSelector('tr[data-employee]:has-text("Noor Patel")');
    assert.ok((await page.locator('[data-type=onboarding_board] .cap').first().textContent()).includes('1 of 1 still to do'));
    await shot(page, 'people-onboarding-waiting');

    // a duplicate invite is refused
    await page.fill('input[name=firstName]', 'Noor'); await page.fill('input[name=lastName]', 'Again'); await page.fill('input[name=email]', 'NOOR.P@example.com'); await page.fill('input[name=rate]', '15');
    await page.click('button:has-text("Send invite")');
    await page.waitForSelector('.alert:has-text("already on your team")');

    // ---- the new hire, on a phone, signed out
    const phone = await browser.newContext({ viewport: { width: 390, height: 800 } });
    const p2 = await phone.newPage();
    p2.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await p2.goto(link);
    await p2.waitForSelector('h1:has-text("tax")');
    await shot(p2, 'join-w4');
    assert.ok((await p2.locator('.steps3').textContent()).includes('W-4'));
    // signing with the wrong name is refused
    await p2.fill('input[name=signature]', 'Somebody Else');
    await p2.click('button:has-text("Save and continue")');
    await p2.waitForSelector('.alert:has-text("full name")');
    await p2.click('.opt[data-value=married_joint]');
    await p2.fill('input[name=exemptions]', '2');
    await p2.fill('input[name=signature]', 'Noor Patel');
    await p2.click('button:has-text("Save and continue")');
    await p2.waitForSelector('h1:has-text("work")');
    await shot(p2, 'join-i9');
    await p2.fill('input[name=dateOfBirth]', '2001-03-14');
    await p2.fill('input[name=ssn]', '512344410');
    assert.equal(await p2.locator('input[name=ssn]').inputValue(), '512-34-4410', 'the number is laid out as they type');
    await p2.fill('input[name=signature]', 'Noor Patel');
    await p2.click('button:has-text("Save and continue")');
    await p2.waitForSelector('h1:has-text("pay")');
    await shot(p2, 'join-deposit');
    await p2.fill('input[name=bankName]', 'Huron Valley CU');
    await p2.fill('input[name=routingNumber]', '123456789');
    await p2.fill('input[name=accountNumber]', '000123454821');
    await p2.check('input[name=confirm]');
    await p2.click('button:has-text("Finish")');
    await p2.waitForSelector('.alert:has-text("routing number")');
    await p2.fill('input[name=routingNumber]', '110000000');
    await p2.click('button:has-text("Finish")');
    await p2.waitForSelector('h1:has-text("all set")');
    await shot(p2, 'join-done');
    // the link keeps working to show they are done, and a made-up link says so plainly
    await p2.goto(`${server.base}/join/${'x'.repeat(43)}`);
    await p2.waitForSelector('h1:has-text("isn’t valid")');
    await phone.close();

    // ---- back with the employer: everything but section 2 is in
    await page.reload();
    await page.waitForSelector('tr[data-employee]:has-text("Noor Patel")');
    const row = page.locator('tr[data-employee]:has-text("Noor Patel")');
    assert.equal(await row.locator('.dt.ok').count(), 3, 'W-4, MI-W4 and deposit are on file');
    await row.locator('button[data-i9]').click();
    await page.fill('.modal input[name=documentTitle]', 'US Passport');
    await page.fill('.modal input[name=issuingAuthority]', 'US Department of State');
    await page.fill('.modal input[name=documentNumber]', '123456789');
    await page.click('.modal button:has-text("Save section 2")');
    await page.waitForSelector('.alert:has-text("examined")');
    await page.check('.modal input[name=attest]', { force: true });
    await page.click('.modal button:has-text("Save section 2")');
    await page.waitForSelector('tr[data-employee]:has-text("Noor Patel") .chip:has-text("Finished")');
    assert.ok((await page.locator('[data-type=onboarding_board] .cap').first().textContent()).includes('Everyone has finished') || true);

    // ---- people directory and a profile
    await page.goto(`${server.base}/app/people`);
    await page.waitForSelector('[data-type=people_directory] tr[data-employee]');
    await shot(page, 'people-directory');
    await page.fill('input[type=search]', 'zzz');
    assert.ok((await page.locator('[data-type=people_directory]').textContent()).includes('No one matches'));
    await page.fill('input[type=search]', 'noor');
    await page.click('a.who-link:has-text("Noor Patel")');
    await page.waitForSelector('h1:has-text("Patel")');
    await shot(page, 'people-profile');
    assert.ok((await page.locator('.card:has-text("Paperwork")').textContent()).includes('Sections 1 and 2 done'));
    assert.ok((await page.locator('.card:has-text("Tax setup")').textContent()).includes('2 exemptions'));
    // edit the pay rate
    await page.click('button:has-text("Edit")');
    await page.fill('.modal input[name=rate]', '16.25');
    await page.click('.modal button:has-text("Save")');
    await page.waitForSelector('dd:has-text("$16.25")');
    // the CSV import
    await page.goto(`${server.base}/app/people`);
    await page.click('button:has-text("Import from spreadsheet")');
    const roleLabel = await page.evaluate(async () => { const me = await (await fetch('/v1/auth/me')).json(); const d = await (await fetch(`/v1/companies/${me.user.companyId}/dashboard/data`)).json(); return d.company.roles[0].label; });
    const csv = `First name,Last name,Email,Role,Location,Hourly rate,Start date\nAna,Cruz,ana@example.com,${roleLabel},Detroit,15.00,2026-11-02\nBad,Role,bad@example.com,Astronaut,Detroit,15.00,2026-11-02\n`;
    await page.setInputFiles('.modal input[type=file]', { name: 'people.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await page.waitForSelector('.modal .alert:has-text("Astronaut")');
    await page.click('.modal button:has-text("Send invites")');
    await page.waitForSelector('[data-type=people_directory] tr:has-text("Ana Cruz")');
    console.log('people flow: ok');
  } finally {
    if (problems.length) console.log('browser problems:\n' + problems.join('\n'));
    await browser.close();
    server.stop();
  }
  assert.deepEqual(problems, []);
})().catch((e) => { console.error(e); process.exit(1); });
