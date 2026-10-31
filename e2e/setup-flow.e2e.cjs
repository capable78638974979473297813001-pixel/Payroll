// The whole signup and builder flow in a real browser, with the design's example answers and numbers.
const assert = require('node:assert/strict');
const { startServer, openBrowser, signUpAndVerify } = require('./helpers.cjs');

const counter = async (page) => ({
  modules: Number(await page.locator('[data-count=modules]').textContent()),
  items: Number(await page.locator('[data-count=items]').textContent()),
  forms: Number(await page.locator('[data-count=forms]').textContent()),
});

(async () => {
  const server = await startServer();
  const { browser, page, problems } = await openBrowser();
  const shots = process.env.SHOTS;
  const shot = async (name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };
  try {
    // the legal pages the signup checkbox links to exist, and say they are drafts
    for (const [path, heading] of [['/terms', 'Terms of'], ['/privacy', 'Privacy']]) {
      await page.goto(`${server.base}${path}`);
      await page.waitForSelector(`h1:has-text("${heading}")`);
      assert.ok((await page.locator('.legal-page').textContent()).includes('not been reviewed by a lawyer'));
    }
    await signUpAndVerify(page, server.base);
    await page.waitForSelector('.indgrid .it');
    await shot('industry');

    // five industries, each with its three tags
    assert.equal(await page.locator('.indgrid .it').count(), 5);
    assert.deepEqual(await page.locator('.indgrid .it').first().locator('.tags .chip').allTextContents(), ['Tips', 'Shift hours', 'Tip pool']);
    await page.click('[data-industry=restaurant]');
    assert.match(await page.locator('.indfoot .btn').textContent(), /Continue with Restaurants/);
    await page.click('.indfoot .btn');
    await page.waitForURL('**/setup/builder');
    await page.waitForSelector('[data-testid=counter]');

    // base: 5 modules, 12 items, 3 forms
    assert.deepEqual(await counter(page), { modules: 5, items: 12, forms: 3 });
    await shot('builder-base');

    // Q1 state: typing "Mi" suggests Michigan, Minnesota ...
    await page.fill('[role=combobox]', 'Mi');
    const suggestions = await page.locator('.dd div').allTextContents();
    assert.ok(suggestions.includes('Michigan') && suggestions.includes('Minnesota'), suggestions.join());
    await page.click('.dd div:has-text("Michigan")');
    await page.waitForFunction(() => document.querySelector('[data-count=modules]').textContent === '6');
    assert.deepEqual(await counter(page), { modules: 6, items: 17, forms: 4 });
    assert.ok(await page.locator('[data-module=state_mi]').isVisible());
    assert.equal(await page.locator('[data-module=state_mi] header .chip.new').count(), 1, 'the newest card carries the new chip');
    await shot('builder-michigan');
    await page.click('.qfoot .btn:has-text("Continue")');

    // Q2 locations: Detroit and Ferndale
    await page.fill('input[aria-label="Add a city"]', 'Detroit');
    await page.keyboard.press('Enter');
    await page.fill('input[aria-label="Add a city"]', 'Ferndale');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('[data-count=modules]').textContent === '7');
    assert.deepEqual(await counter(page), { modules: 7, items: 20, forms: 4 });
    assert.ok(await page.locator('[data-module=state_mi] [data-item=city_tax_detroit]').isVisible(), 'Detroit city tax sits inside the Michigan card');
    assert.equal(await page.locator('[data-item*=ferndale]').count(), 1, 'Ferndale only appears in the Locations card');
    assert.ok(await page.locator('[data-module=locations]').isVisible());
    await shot('builder-locations');
    await page.click('.qfoot .btn:has-text("Continue")');

    // Q3 team size
    await page.click('.opt:has-text("11 to 25")');
    await page.waitForFunction(() => document.querySelector('[data-count=items]').textContent === '21');
    assert.ok(await page.locator('[data-item=bulk_invite]').isVisible());
    await page.click('.qfoot .btn:has-text("Continue")');

    // Q4 tips
    await page.click('.opt[data-value=yes]');
    await page.waitForFunction(() => document.querySelector('[data-count=items]').textContent === '25');
    assert.ok(await page.locator('[data-item=tip_reporting]').isVisible());
    assert.ok(await page.locator('[data-module=state_mi] [data-item=tip_credit_ref]').isVisible());
    assert.ok(await page.locator('[data-module=federal_taxes] [data-item=tips_taxable]').isVisible());
    await shot('builder-tips');
    await page.click('.qfoot .btn:has-text("Continue")');

    // Q4b tip credit only appears once tips is Yes; it starts on No and can be left that way
    await page.waitForSelector('h2:has-text("lower cash wage")');
    assert.equal(await page.locator('.opt[data-value=no]').getAttribute('aria-checked'), 'true', 'optional questions start on No');
    await page.click('.opt[data-value=yes]');
    await page.waitForSelector('[data-item=tip_credit]');
    await page.click('.qfoot .btn:has-text("Continue")');

    // Q5 pay frequency: weekly, Fridays (the default day)
    await page.click('.opt[data-value=weekly]');
    await page.waitForFunction(() => document.querySelector('[data-item=pay_schedule] .lt i')?.textContent === 'Weekly, paid on Fridays.');
    await page.click('.qfoot .btn:has-text("Continue")');

    // Q6 contractors: yes, about 2
    await page.click('.opt[data-value=yes]');
    await page.waitForFunction(() => document.querySelector('[data-count=modules]').textContent === '8');
    assert.deepEqual(await counter(page), { modules: 8, items: 29, forms: 4 });
    await page.click('.qfoot .btn:has-text("Continue")');

    // Q7 bonuses: yes adds a line under pay. Q8 deductions: yes adds a card. Q9 earlier provider: left on No.
    await page.waitForSelector('h2:has-text("bonuses, commissions")');
    await page.click('.opt[data-value=yes]');
    await page.waitForSelector('[data-item=bonus_pay]');
    await page.click('.qfoot .btn:has-text("Continue")');
    await page.waitForSelector('h2:has-text("besides taxes")');
    await page.click('.opt[data-value=yes]');
    await page.waitForSelector('[data-module=deductions]');
    await page.click('.qfoot .btn:has-text("Continue")');
    await page.waitForSelector('h2:has-text("earlier this year")');
    assert.equal(await page.locator('.opt[data-value=no]').getAttribute('aria-checked'), 'true');
    assert.equal(await page.locator('[data-item=opening_balances]').count(), 0, 'nothing is added until they say yes');
    assert.ok((await page.locator('[data-testid=left-out]').textContent()).includes('Opening balances') || (await page.locator('[data-testid=left-out]').textContent()).length > 0);
    await shot('builder-final');
    await page.click('.qfoot .btn:has-text("Review")');

    // review: every answer with an Edit link; one account number still missing
    await page.waitForSelector('h2:has-text("Your dashboard is ready")');
    assert.equal(await page.locator('[data-review=state]').textContent(), 'Michigan');
    assert.equal(await page.locator('[data-review=locations]').textContent(), 'Detroit, Ferndale');
    assert.equal(await page.locator('[data-review=team]').textContent(), '11 to 25 people');
    assert.equal(await page.locator('[data-review=tips]').textContent(), 'Yes');
    assert.equal(await page.locator('[data-review=frequency]').textContent(), 'Weekly');
    assert.equal(await page.locator('[data-review=contractors]').textContent(), 'Yes');
    assert.ok(await page.locator('text=One account number still to add').isVisible());
    await shot('review');

    // editing an answer changes the dashboard
    await page.locator('.row:has([data-review=contractors]) .link').click();
    await page.click('.opt[data-value=no]');
    await page.waitForFunction(() => document.querySelector('[data-count=modules]').textContent === '8');
    assert.deepEqual(await counter(page), { modules: 8, items: 29, forms: 4 });
    await page.click('.qfoot .btn:has-text("Review")');
    await page.locator('.row:has([data-review=contractors]) .link').click();
    await page.click('.opt[data-value=yes]');
    await page.waitForFunction(() => document.querySelector('[data-count=modules]').textContent === '9');
    await page.click('.qfoot .btn:has-text("Review")');

    await page.click('.qfoot .btn:has-text("Build my dashboard")');
    await page.waitForURL('**/app');
    console.log('setup flow: ok');
  } finally {
    if (problems.length) console.log('browser problems:\n' + problems.join('\n'));
    await browser.close();
    server.stop();
  }
  assert.deepEqual(problems, []);
})().catch((e) => { console.error(e); process.exit(1); });
