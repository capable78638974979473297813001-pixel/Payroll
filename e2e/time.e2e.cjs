// Hours and tips: the week's tips and how the pool splits them. Hours themselves come from the point of sale.
const assert = require('node:assert/strict');
const { startServer, openBrowser, signUpAndVerify, buildCompany } = require('./helpers.cjs');

(async () => {
  const server = await startServer();
  const { browser, page, problems } = await openBrowser();
  const shots = process.env.SHOTS;
  try {
    await signUpAndVerify(page, server.base);
    await buildCompany(page, server.base);
    const { weekStart, ids } = await page.evaluate(async () => {
      const me = await (await fetch('/v1/auth/me')).json(); const cid = me.user.companyId;
      const call = async (m, path, body) => { const r = await fetch(`/v1/companies/${cid}${path}`, { method: m, headers: { 'content-type': 'application/json', 'x-totali-csrf': '1' }, body: body ? JSON.stringify(body) : undefined }); if (!r.ok) throw new Error(path + ' ' + await r.text()); return r.json(); };
      const roles = (await call('GET', '')).settings.roles;
      const server = roles.find((r) => r.tipped === 'customarily' && !r.manager).key; const cook = roles.find((r) => r.tipped === 'never' && r.pay === 'hourly').key;
      const mk = (f, l, roleKey, i) => call('POST', '/employees', { firstName: f, lastName: l, roleKey, hireDate: '2026-01-05', payType: { kind: 'hourly', rateCents: 1700 }, ssn: `512-34-${2000 + i}`, location: 'Detroit', tipCreditNoticeDate: '2026-01-05' });
      const a = await mk('Elena', 'Ruiz', server, 1); const b = await mk('Tom', 'Whitaker', server, 2); const c = await mk('Priya', 'Raman', cook, 3);
      const d = (await call('GET', '/dashboard/data')).hours.weekStart;
      const add = (s, n) => new Date(Date.parse(`${s}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
      await call('POST', '/shifts', { employeeId: a.id, workDate: add(d, 1), minutes: 480, chargedTipsCents: 30000 });
      await call('POST', '/shifts', { employeeId: b.id, workDate: add(d, 1), minutes: 240, chargedTipsCents: 10000, cashTipsCents: 2500 });
      return { weekStart: d, ids: [a.id, b.id, c.id] };
    });
    await page.goto(`${server.base}/app/time`);
    await page.waitForSelector('[data-type=tips_panel] .stats');
    assert.equal(await page.locator('[data-type=time_week]').count(), 0, 'hours are not typed in here: they come from the point of sale');
    assert.ok((await page.locator('[data-type=pos_status]').textContent()).includes('Hours and tips'));
    if (shots) await page.screenshot({ path: `${shots}/time-tips.png`, fullPage: true });
    const tips = await page.locator('[data-type=tips_panel]').textContent();
    assert.ok(tips.includes('$400.00') && tips.includes('$25.00') && tips.includes('$425.00'), 'card, cash and total');
    // the pool splits the card tips by hours: Elena 8h, Tom 4h -> $266.67 / $133.33
    assert.ok(tips.includes('$266.67') && tips.includes('$133.33'), tips);
    // split by role instead
    await page.click('[data-testid=toggle-split]');
    await page.waitForSelector('text=by role');
    console.log('time and tips: ok');
  } finally {
    if (problems.length) console.log('browser problems:\n' + problems.join('\n'));
    await browser.close(); server.stop();
  }
  assert.deepEqual(problems, []);
})().catch((e) => { console.error(e); process.exit(1); });
