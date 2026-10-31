// Customizing a dashboard in a real browser: every kind of change, saved, reloaded, and checked.
const assert = require('node:assert/strict');
const { startServer, openBrowser, signUpAndVerify, buildCompany } = require('./helpers.cjs');

const cssVar = (page, name) => page.evaluate((n) => document.querySelector('.dash').style.getPropertyValue(n).trim(), name);
const cards = (page) => page.locator('.grid.cards > .card[data-widget]');
const typesOnPage = (page) => page.locator('.grid.cards > .card[data-widget]').evaluateAll((els) => els.map((e) => e.dataset.type));

(async () => {
  const server = await startServer();
  const { browser, page, problems } = await openBrowser();
  const shots = process.env.SHOTS;
  const shot = async (name, full = false) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: full }); };
  try {
    await signUpAndVerify(page, server.base, { business: 'Maple & Main Diner' });
    await buildCompany(page, server.base);

    // ---- restaurant overview is operational rather than a wall of configurable cards
    assert.deepEqual(await page.locator('.restaurant-sidebar > .restaurant-nav a').allTextContents(), ['Overview', 'Payroll', 'People', 'Time and tips', 'Onboarding', 'Taxes', 'Reports']);
    assert.ok(await page.locator('[data-testid=restaurant-overview]').isVisible());
    assert.ok((await page.locator('.restaurant-switcher b').textContent()).includes('Maple & Main Diner'));
    assert.ok((await page.locator('.restaurant-payday').textContent()).includes('Run it by'));
    assert.ok((await page.locator('.restaurant-home-grid').textContent()).includes('Add your company details'));
    assert.ok((await page.locator('.restaurant-metrics').textContent()).includes('Hours recorded'));
    assert.equal(await cssVar(page, '--d-accent'), '#1e5b47');
    await shot('dash-start', true);

    // ---- customize: look
    await page.click('[data-testid=customize]');
    assert.ok(await page.locator('.editbar').isVisible());
    await page.click('[data-testid=open-theme]');
    await page.click('.swatch[data-color="#c2410c"] >> nth=0');
    assert.equal(await cssVar(page, '--d-accent'), '#c2410c', 'the page changes as you choose');
    await page.click('[aria-label="Mode"] .sel-opt[data-value=paper]');
    assert.equal(await page.locator('.dash').first().getAttribute('data-mode'), 'paper');
    await page.click('[aria-label="Heading font"] .sel-opt[data-value=didone]');
    assert.ok((await cssVar(page, '--d-font-head')).includes('Didot'));
    await page.click('[aria-label="Corners"] .sel-opt[data-value="16"]');
    assert.equal(await cssVar(page, '--d-radius'), '16px');
    await page.click('[aria-label="Card style"] .sel-opt[data-value=elevated]');
    assert.equal(await page.locator('.dash').first().getAttribute('data-cards'), 'elevated');
    await page.click('[aria-label="Navigation"] .sel-opt[data-value=side]');
    assert.equal(await page.locator('.dash').first().getAttribute('data-nav'), 'side');
    await page.click('[aria-label="Spacing"] .sel-opt[data-value=airy]');
    await page.fill('input[aria-label="Main color hex"]', '#fde047');
    assert.ok((await page.locator('.warnline').first().textContent()).includes('hard to read'), 'a pale accent is flagged');
    await page.fill('input[aria-label="Main color hex"]', '#9f1239');
    assert.equal(await page.locator('.warnline').first().textContent(), '');

    // ---- words
    await page.click('[data-testid=open-words]');
    await page.fill('input[name=brandName]', 'Maple & Main');
    await page.fill('input[name=tagline]', 'Breakfast all day');
    await page.fill('input[name=term_team]', 'Crew');
    await page.fill('input[name=term_people]', 'Staff');
    assert.ok((await page.locator('[data-module=team] .card-title').textContent()).includes('Crew'), 'the card uses the new word');
    assert.ok((await page.locator('.restaurant-sidebar > .restaurant-nav [data-tab=people]').textContent()).includes('Staff'));
    assert.equal(await page.locator('.restaurant-switcher .sub').textContent(), 'Breakfast all day');

    // ---- cards: add, resize, reorder, settings, remove
    await page.click('[data-testid=open-add]');
    assert.ok(await page.locator('[data-add=tip_pool_card]').isEnabled());
    await page.click('[data-add=big_number]');
    await page.click('[data-add=note]');
    const before = await typesOnPage(page);
    assert.deepEqual(before.slice(-2), ['big_number', 'note']);
    await page.click('[aria-label="Close panel"]');
    // resize the note to half
    await page.locator('[data-type=note] [data-action=width]').selectOption('6');
    assert.equal(await page.locator('[data-type=note]').evaluate((e) => e.style.getPropertyValue('--span')), '6');
    // write the note through the card's settings
    await page.locator('[data-type=note] [data-action=settings]').click();
    await page.fill('textarea[name=text]', 'Soup of the day: split pea.\n<script>alert(1)</script>');
    await page.click('[data-testid=card-done]');
    const noteText = await page.locator('[data-type=note]').textContent();
    assert.ok(noteText.includes('Soup of the day') && noteText.includes('<script>'), 'markup is shown as text, never run');
    // move the note earlier, past the big number
    await page.locator('[data-type=note] [data-action=earlier]').click();
    assert.deepEqual((await typesOnPage(page)).slice(-2), ['note', 'big_number']);
    // make the big number show tips this week
    await page.locator('[data-type=big_number] [data-action=settings]').click();
    await page.selectOption('select[name=metric]', 'tips_week');
    await page.click('[data-testid=card-done]');
    assert.ok((await page.locator('[data-type=big_number] .card-title').textContent()).includes('Tips this week'));
    // remove a card
    const n0 = await cards(page).count();
    await page.locator('[data-module=contractors] [data-action=remove]').click();
    assert.equal(await cards(page).count(), n0 - 1);
    await page.screenshot({ path: shots ? `${shots}/dash-editing.png` : undefined, fullPage: false }).catch(() => {});

    // ---- drag and drop (two cards on screen, as a person would have them)
    await page.evaluate(() => window.scrollTo(0, 0));
    const mods = () => page.locator('.grid.cards > .card[data-widget]').evaluateAll((els) => els.map((e) => e.dataset.module || e.dataset.type));
    const orderBefore = await mods();
    await page.locator('[data-module=pay_run]').scrollIntoViewIfNeeded();
    await page.locator('[data-module=team] .grip').dispatchEvent('mousedown');
    const a = await page.locator('[data-module=team]').boundingBox();
    const b = await page.locator('[data-module=pay_run]').boundingBox();
    assert.ok(a.y >= 0 && b.y >= 0 && a.y + 40 < 900 && b.y + 40 < 900, 'both cards are on screen');
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + a.width / 2 + 8, a.y + a.height / 2 + 8, { steps: 4 });
    await page.mouse.move(b.x + 40, b.y + 10, { steps: 12 });
    await page.mouse.up();
    const orderAfter = await mods();
    assert.notDeepEqual(orderAfter, orderBefore, 'dragging moved a card');
    assert.ok(orderAfter.indexOf('team') < orderAfter.indexOf('pay_run'), 'the team card moved ahead of the pay run');
    assert.equal(orderAfter.length, orderBefore.length, 'nothing was lost');

    // ---- tabs
    await page.click('[data-testid=open-tabs]');
    await page.fill('input[name=newTab]', 'Bar');
    await page.click('[data-testid=add-tab]');
    assert.ok(await page.locator('.restaurant-sidebar > .restaurant-nav [data-tab=bar]').isVisible());
    await page.fill('input[name=newTab]', 'Contractors');
    await page.click('[data-testid=add-tab]');
    assert.ok(await page.locator('.restaurant-sidebar > .restaurant-nav [data-tab=contractors-tab]').isVisible(), 'a reserved name gets a safe id');
    assert.equal(await page.locator('[data-tab-row=settings] button[aria-label*="Remove"]').count(), 0, 'Settings cannot be removed');

    // ---- save, reload, and it is all still there
    await shot('dash-before-save');
    await page.evaluate(() => window.scrollTo(0, 0));
    for (const id of ['save-dash', 'cancel-edit']) {
      const box = await page.locator(`[data-testid=${id}]`).boundingBox();
      const top = await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e && e.closest('[data-testid]') ? e.closest('[data-testid]').dataset.testid : (e && e.closest('.drawer') ? 'drawer' : 'other'); }, [box.x + box.width / 2, box.y + box.height / 2]);
      assert.equal(top, id, `${id} is reachable with a panel open`);
    }
    await page.click('[data-testid=save-dash]');
    await page.waitForSelector('.editbar', { state: 'detached' });
    await page.reload();
    await page.waitForSelector('[data-testid=grid]');
    assert.equal(await cssVar(page, '--d-accent'), '#9f1239');
    assert.equal(await page.locator('.dash').first().getAttribute('data-nav'), 'side');
    assert.equal(await page.locator('.restaurant-switcher b').textContent(), 'Maple & Main');
    assert.ok(await page.locator('.restaurant-sidebar > .restaurant-nav [data-tab=bar]').isVisible());
    assert.ok((await typesOnPage(page)).includes('note'));
    await shot('dash-saved', true);

    // ---- a very different look: dark, mono, top bar, square, outlined. Same business, same data.
    await page.click('[data-testid=customize]');
    await page.click('[data-testid=open-theme]');
    await page.click('[aria-label="Mode"] .sel-opt[data-value=dark]');
    await page.click('[aria-label="Text font"] .sel-opt[data-value=serif]');
    await page.click('[aria-label="Heading font"] .sel-opt[data-value=serif]');
    await page.click('[aria-label="Corners"] .sel-opt[data-value="0"]');
    await page.click('[aria-label="Card style"] .sel-opt[data-value=outlined]');
    await page.click('[aria-label="Navigation"] .sel-opt[data-value=top]');
    await page.fill('input[aria-label="Main color hex"]', '#d4a24c');
    await page.click('[aria-label="Numbers"] .sel-opt[data-value=light]');
    await shot('dash-steakhouse', true);

    // ---- cancel discards; the saved look is unchanged
    await page.click('[data-testid=cancel-edit]');
    await page.click('button:has-text("Discard changes")');
    assert.equal(await cssVar(page, '--d-accent'), '#9f1239');

    // ---- undo the last save
    await page.click('[data-testid=customize]');
    await page.click('button:has-text("Undo last save")');
    await page.click('.modal button:has-text("Undo")');
    await page.waitForSelector('.editbar', { state: 'detached' });
    assert.equal(await cssVar(page, '--d-accent'), '#1e5b47', 'back to how it was before the save');

    // ---- start over
    await page.click('[data-testid=customize]');
    await page.click('button:has-text("Start over")');
    await page.click('.modal button:has-text("Start over")');
    await page.waitForSelector('.editbar', { state: 'detached' });
    assert.equal(await page.locator('.restaurant-switcher b').textContent(), 'Maple & Main Diner');
    console.log('dashboard customization: ok');
  } finally {
    if (problems.length) console.log('browser problems:\n' + problems.join('\n'));
    await browser.close();
    server.stop();
  }
  assert.deepEqual(problems, []);
})().catch((e) => { console.error(e); process.exit(1); });
