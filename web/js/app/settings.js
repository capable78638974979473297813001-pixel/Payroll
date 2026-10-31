import { h, plural, longDate } from '../dom.js';
import { api } from '../api.js';
import { link, navigate } from '../router.js';
import { Button, Alert, Chip, Field, Hand, modal, setLoading, toast, PwBar, pwScore } from '../ui.js';
import { session, signOut } from '../session.js';
import { appPage } from './shell.js';
import { app, base, loadApp, refreshData } from './state.js';
import { bodyFor, summarize } from '../pages/setup.js';
import { accessCard } from './access.js';
import { posSection } from './pos.js';

const SECTIONS = [['dashboard', 'Your dashboard'], ['company', 'Company'], ['schedule', 'Pay schedule'], ['state', 'State accounts'], ['people', 'People and roles'], ['pos', 'Point of sale'], ['access', 'Employee access'], ['payments', 'Paying your team'], ['account', 'Account']];
const italic = { fontFamily: 'Fraunces, serif', fontStyle: 'italic', color: 'var(--berry)' };

export function settingsPage() {
  return async (ctx) => appPage(ctx, { active: 'settings', title: 'Settings', render: async () => {
    await refreshData();
    const section = ctx.params.section && SECTIONS.some(([id]) => id === ctx.params.section) ? ctx.params.section : 'dashboard';
    const nav = h('div', { class: 'subnav' }, ...SECTIONS.map(([id, label]) => link(id === 'dashboard' ? '/app/settings' : `/app/settings/${id}`, { class: id === section ? 'on' : '', 'data-section': id }, label)), link('/app/billing', { 'data-section': 'billing' }, 'Billing'));
    const content = await ({ dashboard, company, schedule, state, people, pos: posSection, access, payments, account })[section]();
    return h('div', {}, h('div', { class: 'ph2' }, h('div', {}, h('h1', { class: 'pt' }, h('em', {}, 'Settings')), h('p', {}, 'Company, taxes and who has access'))),
      h('div', { class: 'grid', style: { gridTemplateColumns: '200px minmax(0,1fr)', alignItems: 'start' } }, h('div', {}, nav), content));
  } });
}

const rowKV = (label, value, action) => h('div', { class: 'row' }, h('span', { class: 'l1' }, h('b', {}, label)), h('span', { style: italic }, value), action || null);

// ---------------------------------------------------------------- editing one answer, with what it will change
let metaCache = null;
async function editAnswer(question, after) {
  metaCache = metaCache || (await api.get('/v1/builder/industries'));
  const meta = metaCache;
  const c = app.data.company;
  const ind = meta.industries.find((i) => i.id === c.industry);
  const q = ind.questions.find((x) => x.id === question);
  const answers = { ...app.data.built.answersRaw };
  const ctx = { meta, answers, industry: c.industry };
  const note = h('div', {});
  const err = h('div', {});
  const save = Button({ disabled: false }, 'Save');
  let provisional = answers[q.id];
  let body;
  const baseline = await api.post('/v1/builder/preview', { industry: c.industry, answers });
  const idsOf = (b) => new Map(b.modules.flatMap((m) => [[m.id, m.label], ...m.items.map((i) => [i.id, i.label])]));
  const before = idsOf(baseline);
  const change = async () => {
    save.disabled = !body.valid();
    if (!body.valid()) return note.replaceChildren();
    provisional = body.value();
    try {
      const r = await api.post('/v1/builder/preview', { industry: c.industry, answers: { ...answers, [q.id]: provisional } });
      const now = idsOf(r);
      const added = [...now].filter(([id]) => !before.has(id)).map(([, l]) => l);
      const removed = [...before].filter(([id]) => !now.has(id)).map(([, l]) => l);
      note.replaceChildren(...(added.length || removed.length ? [h('div', { class: 'adds' }, h('b', {}, 'This changes your dashboard'), h('ul', {}, ...added.slice(0, 4).map((l) => h('li', {}, `Adds ${l}`)), ...removed.slice(0, 4).map((l) => h('li', {}, `Removes ${l}`)), added.length + removed.length > 8 ? h('li', {}, 'and more') : null))] : []), removed.length ? h('p', { class: 'fine', style: { marginTop: '8px' } }, 'History stays saved. Nothing is deleted.') : null);
    } catch { /* the preview is a courtesy */ }
  };
  body = bodyFor(q, answers[q.id], ctx, change);
  const m = modal({ title: q.rail, body: h('div', { class: 'f' }, h('p', { class: 'fine', style: { margin: 0 } }, q.title), body.el, note, err), actions: [Button({ variant: 'ghost', onClick: () => m.close() }, 'Cancel'), save] });
  save.addEventListener('click', async () => {
    err.replaceChildren(); setLoading(save, true);
    try {
      const chk = await api.post('/v1/builder/check', { industry: c.industry, question: q.id, value: body.value() });
      if (!chk.ok) throw new Error(chk.error);
      await api.put(`${base()}/setup`, { answers: { [q.id]: chk.value } });
      m.close(); toast('success', 'Saved. Your dashboard follows.'); await loadApp({ force: true }); await refreshData(); after();
    } catch (e) { err.replaceChildren(Alert('error', e.message)); setLoading(save, false); }
  });
}

// ---------------------------------------------------------------- your dashboard
async function dashboard() {
  const c = app.data.company;
  // The raw answers come with the dashboard data, so the editor starts from exactly what was saved.
  const meta = (metaCache = metaCache || (await api.get('/v1/builder/industries')));
  const ind = meta.industries.find((i) => i.id === c.industry);
  const answers = app.data.built.answersRaw;
  const ctx = { meta, answers, industry: c.industry };
  const redraw = () => navigate(location.pathname);
  return h('div', { class: 'grid' },
    h('div', { class: 'card' }, h('div', { class: 'ch' }, h('h3', { class: 'ct' }, 'Your answers'), h('span', { class: 'cap' }, 'Change one and the dashboard follows')),
      ...ind.questions.filter((q) => !q.when || (answers[q.when.question] && answers[q.when.question].on)).map((q) => rowKV(q.rail, summarize(q, answers[q.id], ctx), q.id === 'state' ? h('span', { class: 'cap', title: 'Every tax rate, form and year-to-date total follows your state.' }, 'Fixed') : h('button', { class: 'link as-button', type: 'button', 'data-edit': q.id, onClick: () => editAnswer(q.id, redraw) }, 'Edit'))),
      h('div', { class: 'alert teal', style: { marginTop: '12px' } }, h('span', { class: 'dot' }), h('span', {}, 'Switching a section off removes its card. History stays saved. Your state is fixed once you start; for a different state, start a new company.'))),
    h('div', { class: 'card' }, h('h3', { class: 'ct', style: { marginBottom: '6px' } }, 'Who can do what'),
      h('div', { class: 'row' }, h('span', { class: 'l1' }, h('b', {}, 'Owner'), h('i', {}, 'Everything, including billing')), h('span', { class: 'cap' }, '1 person')),
      h('div', { class: 'row' }, h('span', { class: 'l1' }, h('b', {}, 'Employee'), h('i', {}, 'Fills in their own forms from a private link')), h('span', { class: 'cap' }, plural(app.data.team.active, 'person', 'people'))),
      h('p', { class: 'cap', style: { marginTop: '10px' } }, 'Manager sign-ins aren’t built yet. For now only the owner signs in.')),
    h('div', { class: 'card' }, h('h3', { class: 'ct', style: { marginBottom: '6px' } }, 'This device'), h('p', { class: 'cap' }, 'You stay signed in here until you sign out.'),
      h('div', { class: 'acts', style: { marginTop: '12px' } }, Button({ variant: 'ghost', size: 'sm', onClick: async () => { await signOut(); navigate('/login'); } }, 'Sign out'), h('button', { class: 'link as-button', type: 'button', onClick: async () => { try { await api.post('/v1/auth/logout-all'); session.user = null; navigate('/login'); } catch (e) { toast('error', e.message); } } }, 'Sign out everywhere'))));
}

// ---------------------------------------------------------------- pay schedule
async function schedule() {
  const c = app.data.company;
  const meta = (metaCache = metaCache || (await api.get('/v1/builder/industries')));
  const q = meta.industries.find((i) => i.id === c.industry).questions.find((x) => x.id === 'frequency');
  const answers = app.data.built.answersRaw;
  return h('div', { class: 'card', style: { maxWidth: '640px' } }, h('div', { class: 'ch' }, h('h3', { class: 'ct' }, 'Pay schedule')),
    rowKV('How often', summarize(q, answers.frequency, { meta, answers })),
    c.schedule.payWeekday ? rowKV('Pay day', c.schedule.payWeekday[0].toUpperCase() + c.schedule.payWeekday.slice(1) + 's') : null,
    h('div', { class: 'acts', style: { marginTop: '14px' } }, Button({ variant: 'ghost', size: 'sm', onClick: () => editAnswer('frequency', () => navigate(location.pathname)) }, 'Change schedule')),
    h('p', { class: 'cap', style: { marginTop: '12px' } }, 'A change applies to pay runs you start after you save it. Runs already approved keep their dates.'));
}

// ---------------------------------------------------------------- state and city accounts
async function state() {
  const t = await api.get(`${base()}/tax-accounts`);
  const c = app.data.company;
  const stateName = app.data.built.answers[0];
  const cityItems = (app.data.built.modules.find((m) => m.id === `state_${c.state.toLowerCase()}`) || { items: [] }).items.filter((i) => /^city_tax_/.test(i.id));
  const uia = Field({ label: 'Unemployment (UIA) account number', name: 'uia', value: t.uia, placeholder: 'Add number' });
  const wh = Field({ label: 'State withholding account', name: 'withholding', value: t.withholding, placeholder: 'Add number' });
  const cities = cityItems.map((i) => { const slug = i.id.replace('city_tax_', ''); return { slug, label: `${i.label.replace(/ income tax$/i, '')} account`, field: Field({ label: i.label.replace(/ income tax$/i, '') + ' account number', name: `city_${slug}`, value: t.cities[slug] || '', placeholder: 'Add number' }) }; });
  const err = h('div', {}); const save = Button({ size: 'sm' }, 'Save');
  save.addEventListener('click', async () => {
    err.replaceChildren(); setLoading(save, true);
    try { await api.put(`${base()}/tax-accounts`, { uia: uia.value, withholding: wh.value, cities: Object.fromEntries(cities.map((x) => [x.slug, x.field.value])) }); toast('success', 'Saved.'); } catch (e) { err.replaceChildren(Alert('error', e.message)); }
    setLoading(save, false);
  });
  return h('div', { class: 'card', style: { maxWidth: '640px' } }, h('div', { class: 'ch' }, h('h3', { class: 'ct' }, 'State and city accounts'), h('span', { class: 'cap' }, stateName)),
    h('div', { class: 'f' }, uia.el, h('p', { class: 'cap', style: { marginTop: '-8px' } }, 'Needed for state unemployment lines.'), wh.el, ...cities.map((x) => x.field.el), err, h('div', { class: 'acts' }, save)),
    h('p', { class: 'cap', style: { marginTop: '12px' } }, 'You register these with the state and city yourself. Totali keeps the numbers and puts them on your filings. It doesn’t register you.'));
}

// ---------------------------------------------------------------- people and roles
async function people() {
  const roles = app.data.company.roles;
  const counts = new Map(app.data.team.byRole.map((x) => [x.label, x.count]));
  return h('div', { class: 'card', style: { maxWidth: '640px' } }, h('div', { class: 'ch' }, h('h3', { class: 'ct' }, 'Roles at your business')),
    ...roles.map((r) => h('div', { class: 'row' }, h('span', { class: 'l1' }, h('b', {}, r.label), h('i', {}, `${r.pay === 'hourly' ? 'Paid by the hour' : 'Salaried'}${r.tipped !== 'never' ? ', earns tips' : ''}`)), h('span', { class: 'cap' }, plural(counts.get(r.label) || 0, 'person', 'people')))),
    h('p', { class: 'cap', style: { marginTop: '10px' } }, 'These come from your industry’s starting setup and decide who can be tipped, who is salaried and who shares a tip pool.'));
}

// ---------------------------------------------------------------- employee access: the code your team signs in with
async function access() {
  return h('div', { class: 'card', style: { maxWidth: '640px' } }, h('div', { class: 'ch' }, h('h3', { class: 'ct' }, 'Employee sign-in code')), await accessCard());
}

// ---------------------------------------------------------------- paying your team: the employer's own bank
async function payments() {
  const [banks, setup] = await Promise.all([api.get('/v1/bank-profiles'), api.get(`${base()}/payment-setup`)]);
  const eb = setup.employerBank || {};
  const sel = Field({ label: 'Your bank', name: 'bankProfile', select: true, value: eb.bankProfile || '', options: [{ value: '', label: 'Another bank' }, ...banks.banks.map((b) => ({ value: b.id, label: b.name }))] });
  const name = Field({ label: 'Bank name', name: 'odfiName', value: eb.odfiName || '', hint: 'As your bank writes it.' });
  const routing = Field({ label: 'Your bank’s ACH routing number', name: 'odfiRoutingNumber', value: eb.odfiRoutingNumber || '', inputmode: 'numeric', maxlength: 9, hint: 'The one your bank gives for sending ACH files. It can differ from the number on your checks.' });
  const origin = Field({ label: 'Immediate origin', name: 'immediateOrigin', value: eb.immediateOrigin || '', hint: 'Your bank assigns this when it turns on ACH for you.' });
  const cid = Field({ label: 'Company ID', name: 'companyId', value: eb.companyId || '', hint: 'Also assigned by your bank. Up to 10 letters and numbers.' });
  const findings = h('div', { class: 'stack', style: { '--gap': '8px' } });
  const guidance = h('div', {});
  const err = h('div', {}); const save = Button({ size: 'sm' }, 'Save');
  const bank = setup.employerBank && setup.employerBank.bank;
  const drawBank = (b) => { guidance.replaceChildren(...(b ? [h('p', { class: 'cap' }, b.guidance), b.askYourBank && b.askYourBank.length ? h('div', {}, h('b', { class: 'cap' }, 'Ask your bank'), h('ul', { class: 'cap', style: { margin: '4px 0 0 18px' } }, ...b.askYourBank.map((x) => h('li', {}, x)))) : null] : [])); findings.replaceChildren(...((b && b.findings) || []).filter((f) => f.severity !== 'info').map((f) => Alert(f.severity === 'error' ? 'error' : 'info', f.message))); };
  drawBank(bank);
  save.addEventListener('click', async () => {
    err.replaceChildren(); setLoading(save, true);
    try {
      const r = await api.put(`${base()}/payment-setup`, { mode: 'employer_bank', employerBank: { odfiName: name.value, odfiRoutingNumber: routing.value, immediateOrigin: origin.value, companyId: cid.value, ...(sel.value ? { bankProfile: sel.value } : {}) } });
      drawBank(r.employerBank && r.employerBank.bank); toast('success', 'Saved. Pay runs can now prepare your bank’s file.');
    } catch (e) { err.replaceChildren(Alert('error', e.message, e.details && e.details.findings ? e.details.findings.map((f) => f.message).join(' ') : undefined)); }
    setLoading(save, false);
  });
  return h('div', { class: 'grid', style: { gridTemplateColumns: 'minmax(0,1fr) 300px', alignItems: 'start' } },
    h('div', { class: 'card' }, h('div', { class: 'ch' }, h('h3', { class: 'ct' }, 'Paying your team'), setup.employerBank ? Chip('Set up', 'ok') : Chip('To do', 'warn')),
      h('p', { class: 'cap', style: { marginBottom: '14px' } }, 'You pay from your own bank. After you approve a pay run, Totali writes the payment file for your bank, you upload it in your bank’s ACH portal and release it there. Totali never holds your money.'),
      h('div', { class: 'f' }, sel.el, name.el, h('div', { class: 'r2' }, routing.el, origin.el), cid.el, findings, err, h('div', { class: 'acts' }, save))),
    h('div', { class: 'grid' }, h('div', { class: 'card', style: { background: 'color-mix(in srgb, var(--d-bg) 70%, var(--d-card))' } }, h('h3', { class: 'ct', style: { marginBottom: '8px' } }, 'Why this takes a call'), h('p', { class: 'cap' }, 'Banks switch ACH on for a business account, and give you the numbers above. Call your bank’s business line and ask for “ACH origination”, then come back.'), guidance),
      Hand('Most banks do this in a day or two.', { style: { fontSize: '24px', position: 'static', transform: 'rotate(-2deg)' } })));
}

// ---------------------------------------------------------------- account
async function account() {
  const u = session.user;
  const current = Field({ label: 'Current password', name: 'current', type: 'password', autocomplete: 'current-password', rightSlot: 'Show' });
  const bar = h('div', {}, PwBar(0));
  const next = Field({ label: 'New password', name: 'password', type: 'password', autocomplete: 'new-password', rightSlot: 'Show', hint: 'At least 10 characters.', onInput: (v) => bar.replaceChildren(PwBar(pwScore(v))) });
  const err = h('div', {}); const save = Button({ size: 'sm' }, 'Change password');
  save.addEventListener('click', async () => {
    err.replaceChildren(); setLoading(save, true);
    try { await api.post('/v1/auth/change-password', { current: current.value, password: next.value }); current.value = ''; next.value = ''; toast('success', 'Password changed. Other browsers were signed out.'); }
    catch (e) { const t = { current, password: next }[e.details && e.details.field]; if (t) t.setError(e.message); else err.replaceChildren(Alert('error', e.message)); }
    setLoading(save, false);
  });
  return h('div', { class: 'grid', style: { maxWidth: '640px' } },
    h('div', { class: 'card' }, h('h3', { class: 'ct', style: { marginBottom: '6px' } }, 'You'), rowKV('Name', `${u.firstName} ${u.lastName}`), rowKV('Email', u.email)),
    !u.hasPassword ? h('div', { class: 'card' }, h('h3', { class: 'ct', style: { marginBottom: '6px' } }, 'Password'), h('p', { class: 'cap' }, 'You sign in with Google, so there’s no password. To add one, use “Forgot it?” on the log in page and we’ll email you a code.')) : h('div', { class: 'card' }, h('h3', { class: 'ct', style: { marginBottom: '10px' } }, 'Change your password'), h('div', { class: 'f' }, current.el, h('div', {}, next.el), bar, err, h('div', { class: 'acts' }, save))));
}

// ---------------------------------------------------------------- company setup (business verification)
async function company() {
  const p = await api.get(`${base()}/profile`);
  const meta = (metaCache = metaCache || (await api.get('/v1/builder/industries')));
  const host = h('div', {});
  const draw = (v) => host.replaceChildren(companyView(v, draw, meta));
  draw(p);
  return host;
}

function companyView(p, redraw, meta) {
  const names = ['Business', 'Owners', 'Address', 'Documents', 'Review'];
  const flags = [p.sections.business, p.sections.owners, p.sections.address, p.sections.documents, p.sections.review];
  const cur = flags.findIndex((x) => !x);
  const kids = [];
  names.forEach((n, i) => { kids.push(h('span', { class: flags[i] ? 'done' : i === cur ? 'on' : '', 'data-n': String(i + 1) }, n)); if (i < names.length - 1) kids.push(h('i')); });
  const run = async (btn, fn, ok) => { setLoading(btn, true); try { const r = await fn(); toast('success', ok); redraw(r); } catch (e) { setLoading(btn, false); throw e; } };
  const guard = (errEl, btn, fn, ok) => async () => { errEl.replaceChildren(); try { await run(btn, fn, ok); } catch (e) { errEl.replaceChildren(Alert('error', e.message)); } };

  // business
  const legal = Field({ label: 'Legal business name', name: 'legalName', value: p.legalName });
  const dba = Field({ label: 'Doing business as', name: 'dba', value: p.dba });
  const type = Field({ label: 'Entity type', name: 'entityType', select: true, value: p.entityType || p.entityTypes[1], options: p.entityTypes.map((x) => ({ value: x, label: x })) });
  const ein = p.hasEin ? null : Field({ label: 'EIN', name: 'ein', placeholder: '12-3456789', inputmode: 'numeric', autocomplete: 'off' });
  const formed = Field({ label: 'State formed', name: 'stateFormed', select: true, value: p.stateFormed, options: meta.states.map((s) => ({ value: s.code, label: s.name })) });
  const bErr = h('div', {}); const bSave = Button({ size: 'sm' }, 'Save business');
  bSave.addEventListener('click', guard(bErr, bSave, () => api.put(`${base()}/profile`, { legalName: legal.value, dba: dba.value, entityType: type.value, stateFormed: formed.value, ...(ein && ein.value ? { ein: ein.value } : {}) }), 'Business details saved.'));

  // owners
  const owners = p.owners.map((o) => ({ ...o }));
  const ownersEl = h('div', {});
  const oErr = h('div', {});
  const oName = Field({ label: 'Owner or officer', name: 'ownerName' });
  const oPct = Field({ label: 'Owns %', name: 'ownerPercent', type: 'number', value: '100', min: 0, max: 100 });
  const oRuns = h('input', { type: 'checkbox', name: 'ownerRuns' });
  const drawOwners = () => ownersEl.replaceChildren(...owners.map((o, i) => h('div', { class: 'row' }, h('span', { class: 'l1' }, h('b', {}, o.name), h('i', {}, `Owner · ${o.percent}%${o.runsBusiness ? ' · Runs the business' : ''}`)), h('button', { class: 'link as-button', type: 'button', 'aria-label': `Remove ${o.name}`, onClick: () => { owners.splice(i, 1); drawOwners(); } }, 'Remove'))));
  drawOwners();
  const addOwner = Button({ variant: 'ghost', size: 'sm', type: 'button' }, 'Add owner');
  addOwner.addEventListener('click', () => { if (!oName.value.trim()) return oName.setError('Enter a name.'); owners.push({ name: oName.value.trim(), percent: Number(oPct.value) || 0, runsBusiness: oRuns.checked }); oName.value = ''; oRuns.checked = false; drawOwners(); });
  const oSave = Button({ size: 'sm' }, 'Save owners');
  oSave.addEventListener('click', guard(oErr, oSave, () => api.put(`${base()}/profile`, { owners }), 'Owners saved.'));

  // address
  const a = p.address || {};
  const street = Field({ label: 'Street', name: 'street', value: a.street || '' });
  const city = Field({ label: 'City', name: 'city', value: a.city || '' });
  const st = Field({ label: 'State', name: 'addrState', select: true, value: a.state || p.stateFormed, options: meta.states.map((s) => ({ value: s.code, label: s.code })) });
  const zip = Field({ label: 'ZIP', name: 'zip', value: a.zip || '', inputmode: 'numeric' });
  const aErr = h('div', {}); const aSave = Button({ size: 'sm' }, 'Save address');
  aSave.addEventListener('click', guard(aErr, aSave, () => api.put(`${base()}/profile`, { address: { street: street.value, city: city.value, state: st.value, zip: zip.value } }), 'Address saved.'));

  // documents
  const file = h('input', { type: 'file', accept: 'application/pdf,image/png,image/jpeg', hidden: true, 'aria-label': 'Choose a document' });
  const dErr = h('div', {});
  async function upload(f) {
    dErr.replaceChildren();
    if (f.size > 600_000) return dErr.replaceChildren(Alert('error', 'Files can be up to 600 KB. Try a smaller scan or a photo.'));
    const buf = new Uint8Array(await f.arrayBuffer()); let bin = ''; buf.forEach((b) => { bin += String.fromCharCode(b); });
    try { const r = await api.post(`${base()}/profile/documents`, { name: f.name, type: f.type, contentBase64: btoa(bin) }); toast('success', 'Added.'); redraw(r); } catch (e) { dErr.replaceChildren(Alert('error', e.message)); }
  }
  file.addEventListener('change', () => { if (file.files[0]) upload(file.files[0]); });
  const drop = h('div', { class: 'dropz', tabindex: 0, role: 'button', onClick: () => file.click(), onKeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') file.click(); } }, 'Drop a formation document or EIN letter here, or ', h('span', { class: 'link' }, 'choose a file'));
  drop.addEventListener('dragover', (e) => e.preventDefault());
  drop.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]); });

  // review
  const rErr = h('div', {}); const submit = Button({ size: 'sm', disabled: !(flags[0] && flags[1] && flags[2] && flags[3]) || flags[4] }, flags[4] ? 'Submitted' : 'Mark company setup complete');
  submit.addEventListener('click', guard(rErr, submit, () => api.put(`${base()}/profile`, { submit: true }), 'Company setup complete.'));

  const sec = (title, ...kids) => h('div', {}, h('h3', { class: 'ct', style: { marginBottom: '12px' } }, title), ...kids);
  return h('div', {}, h('div', { class: 'pstep', style: { marginTop: '6px' } }, ...kids),
    h('div', { class: 'grid', style: { gridTemplateColumns: 'minmax(0,1fr) 300px', alignItems: 'start', marginTop: '14px' } },
      h('div', { class: 'card' },
        sec('Business details', h('div', { class: 'f' }, h('div', { class: 'r2' }, legal.el, dba.el), h('div', { class: 'r2' }, type.el, formed.el), ein ? ein.el : h('div', {}, h('label', { class: 'lab' }, 'EIN'), h('div', { class: 'in fill', style: { display: 'flex', justifyContent: 'space-between' } }, p.ein, h('span', { class: 'cap' }, 'Locked once saved'))), bErr, h('div', { class: 'acts' }, bSave))),
        h('hr', { class: 'sep' }), sec('Owners and control', h('p', { class: 'cap', style: { marginBottom: '10px' } }, 'Everyone who owns 25% or more, plus one person who runs the business.'), ownersEl, h('div', { class: 'f', style: { marginTop: '10px' } }, h('div', { class: 'r2' }, oName.el, oPct.el), h('label', { class: 'ck2' }, oRuns, h('span', { class: 'cb' }), h('span', { class: 'fine' }, 'Runs the business')), oErr, h('div', { class: 'acts' }, addOwner, oSave))),
        h('hr', { class: 'sep' }), sec('Business address', h('div', { class: 'f' }, street.el, h('div', { class: 'r3' }, city.el, st.el, zip.el), aErr, h('div', { class: 'acts' }, aSave))),
        h('hr', { class: 'sep' }), sec('Documents', drop, file, dErr, ...p.documents.map((d) => h('div', { class: 'row' }, h('span', { class: 'l1' }, h('b', {}, d.name), h('i', {}, `${d.size < 1000 ? `${d.size} bytes` : `${Math.round(d.size / 1000)} KB`} · added ${longDate(d.addedAt.slice(0, 10))}`)), h('button', { class: 'link as-button', type: 'button', onClick: async () => { try { redraw(await api.del(`${base()}/profile/documents/${d.id}`)); } catch (e) { toast('error', e.message); } } }, 'Remove')))),
        h('hr', { class: 'sep' }), sec('Review', h('p', { class: 'cap', style: { marginBottom: '10px' } }, flags[4] ? `Submitted ${longDate(p.submittedAt.slice(0, 10))}.` : 'When every section above is done, mark it complete.'), rErr, h('div', { class: 'acts' }, submit))),
      h('div', { class: 'grid' }, h('div', { class: 'card', style: { background: '#FBF1E5', boxShadow: 'none' } }, h('h3', { class: 'ct', style: { marginBottom: '8px' } }, 'Why we ask'), h('p', { class: 'cap', style: { fontSize: '14px' } }, 'Totali confirms who the business is before your first pay run. Everything here is stored for your account and not shown to your team. Your EIN goes on every pay stub and filing.')),
        h('div', { class: 'card' }, h('h3', { class: 'ct', style: { marginBottom: '6px' } }, 'Progress'), h('div', { class: 'prg' }, h('span', { style: { width: `${(p.done / p.total) * 100}%` } })), h('p', { class: 'cap' }, `${p.done} of ${p.total} sections done`)),
        Hand('Have your EIN letter handy. That’s the slow part.', { style: { fontSize: '25px', position: 'static', transform: 'rotate(-2deg)' } }))));
}
