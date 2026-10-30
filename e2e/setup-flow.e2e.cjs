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
    await signUpAndVerify(page, server.base);
    await page.waitForSelector('.ind-option');
    await shot('industry');

    // five industries, each with its three tags
    assert.equal(await page.locator('.ind-option').count(), 5);
    assert.deepEqual(await page.locator('.ind-option').first().locator('.tags span').allTextContents(), ['Tips', 'Shift hours', 'Tip pool']);
    await page.click('[data-industry=restaurant]');
    assert.match(await page.locator('button:has-text("Continue with")').textContent(), /Continue with Restaurants/);
    await page.click('button:has-text("Continue with Restaurants")');
    await page.waitForURL('**/setup/builder');
    await page.waitForSelector('[data-testid=counter]');

    // base: 5 modules, 12 items, 3 forms
    assert.deepEqual(await counter(page), { modules: 5, items: 12, forms: 3 });
    await shot('builder-base');

    // Q1 state: typing "Mi" suggests Michigan, Minnesota ...
    await page.fill('[role=combobox]', 'Mi');
    const suggestions = await page.locator('.combo-list li b').allTextContents();
    assert.ok(suggestions.includes('Michigan') && suggestions.includes('Minnesota'), suggestions.join());
    await page.click('.combo-list li:has-text("Michigan")');
    await page.waitForFunction(() => document.querySelector('[data-count=modules]').textContent === '6');
    assert.deepEqual(await counter(page), { modules: 6, items: 17, forms: 4 });
    assert.ok(await page.locator('[data-module=state_mi]').isVisible());
    assert.equal(await page.locator('[data-module=state_mi] .new-chip').count(), 1, 'the newest card carries the new chip');
    await shot('builder-michigan');
    await page.click('.q-nav button:has-text("Continue")');

    // Q2 locations: Detroit and Ferndale
    await page.fill('.loc-row >> nth=0 >> input >> nth=0', 'Detroit');
    await page.click('button:has-text("Add a location")');
    await page.fill('.loc-row >> nth=1 >> input >> nth=0', 'Ferndale');
    await page.waitForFunction(() => document.querySelector('[data-count=modules]').textContent === '7');
    assert.deepEqual(await counter(page), { modules: 7, items: 20, forms: 4 });
    assert.ok(await page.locator('[data-module=state_mi] [data-item=city_tax_detroit]').isVisible(), 'Detroit city tax sits inside the Michigan card');
    assert.equal(await page.locator('[data-item*=ferndale]').count(), 1, 'Ferndale only appears in the Locations card');
    assert.ok(await page.locator('[data-module=locations]').isVisible());
    await shot('builder-locations');
    await page.click('.q-nav button:has-text("Continue")');

    // Q3 team size
    await page.click('.choice:has-text("11 to 25")');
    await page.waitForFunction(() => document.querySelector('[data-count=items]').textContent === '21');
    assert.ok(await page.locator('[data-item=bulk_invite]').isVisible());
    await page.click('.q-nav button:has-text("Continue")');

    // Q4 tips
    await page.click('.choice:has-text("Yes, they earn tips")');
    await page.waitForFunction(() => document.querySelector('[data-count=items]').textContent === '25');
    assert.ok(await page.locator('[data-item=tip_reporting]').isVisible());
    assert.ok(await page.locator('[data-module=state_mi] [data-item=tip_credit_ref]').isVisible());
    assert.ok(await page.locator('[data-module=federal_taxes] [data-item=tips_taxable]').isVisible());
    await shot('builder-tips');
    await page.click('.q-nav button:has-text("Continue")');

    // Q5 pay frequency: weekly, Fridays (the default day)
    await page.click('.choice:has-text("Weekly")');
    await page.waitForFunction(() => document.querySelector('[data-item=pay_schedule] small')?.textContent === 'Weekly, paid Fridays');
    await page.click('.q-nav button:has-text("Continue")');

    // Q6 contractors: yes, about 2
    await page.click('.choice:has-text("Yes")');
    await page.waitForFunction(() => document.querySelector('[data-count=modules]').textContent === '8');
    assert.deepEqual(await counter(page), { modules: 8, items: 28, forms: 4 });
    assert.deepEqual(await page.locator('[data-testid=left-out]').count(), 0, 'nothing is left out at the end');
    await shot('builder-final');
    await page.click('.q-nav button:has-text("Review")');

    // review: every answer with an Edit link; one account number still missing
    await page.waitForSelector('text=Your dashboard is ready.');
    assert.equal(await page.locator('[data-review=state]').textContent(), 'Michigan');
    assert.equal(await page.locator('[data-review=locations]').textContent(), 'Detroit and Ferndale');
    assert.equal(await page.locator('[data-review=team]').textContent(), '11 to 25 people');
    assert.equal(await page.locator('[data-review=tips]').textContent(), 'Yes, pool split by hours');
    assert.equal(await page.locator('[data-review=frequency]').textContent(), 'Weekly, paid Fridays');
    assert.equal(await page.locator('[data-review=contractors]').textContent(), 'Yes, about 2');
    assert.ok(await page.locator('text=One account number is still missing').isVisible());
    await shot('review');

    // editing an answer changes the dashboard
    await page.locator('.review-row:has([data-review=contractors]) button:has-text("Edit")').click();
    await page.click('.choice:has-text("No")');
    await page.waitForFunction(() => document.querySelector('[data-count=modules]').textContent === '7');
    assert.deepEqual(await counter(page), { modules: 7, items: 25, forms: 4 });
    await page.click('.q-nav button:has-text("Review")');
    await page.locator('.review-row:has([data-review=contractors]) button:has-text("Edit")').click();
    await page.click('.choice:has-text("Yes")');
    await page.waitForFunction(() => document.querySelector('[data-count=modules]').textContent === '8');
    await page.click('.q-nav button:has-text("Review")');

    await page.click('button:has-text("Build my dashboard")');
    await page.waitForURL('**/app');
    console.log('setup flow: ok');
  } finally {
    if (problems.length) console.log('browser problems:\n' + problems.join('\n'));
    await browser.close();
    server.stop();
  }
  assert.deepEqual(problems, []);
})().catch((e) => { console.error(e); process.exit(1); });
