import { h, money, shortDate, longDate, plural } from '../dom.js';
import { api } from '../api.js';
import { link, navigate } from '../router.js';
import { Button, Alert, Chip, Field, modal, setLoading, toast } from '../ui.js';
import { appPage } from './shell.js';
import { app, base, refreshData } from './state.js';
import { who, dollarsToCents, parseCsv, rangeLabel } from './payroll.js';
import { accessCard } from './access.js';

// ---------------------------------------------------------------- a tiny bus, so the cards on a page stay in step
const bus = new EventTarget();
export const peopleChanged = () => bus.dispatchEvent(new Event('people'));
const onChange = (fn) => bus.addEventListener('people', fn);

const payText = (p) => (p.kind === 'hourly' ? `${money(p.cents)}/hr` : `${money(p.cents)}/yr`);
const dot = (label, ok, title) => h('span', { class: `dt ${ok ? 'ok' : 'no'}`, title }, label);
const i9Dot = (state) => dot('I-9', state === 'done', state === 'section1' ? 'Section 1 is done. Section 2 is waiting for you.' : undefined);
function paperwork(r) {
  return h('span', { class: 'dots' }, dot('W-4', r.forms.w4), r.forms.stateForm !== null ? dot(app.data.company.stateForm || 'State', r.forms.stateForm) : null, i9Dot(r.forms.i9), dot('Deposit', r.forms.deposit));
}
function statusChip(r) {
  if (r.done) return Chip(r.invited ? 'Finished' : 'Active', 'ok');
  if (r.linkExpired) return Chip('Link expired', 'warn');
  return r.invited ? Chip('Waiting', 'berry') : Chip('Needs paperwork', 'warn');
}

/** A link to copy, for when the email could not be sent. */
function linkModal(person, url, why) {
  const input = h('input', { class: 'in', readonly: true, value: url, 'aria-label': 'Private link', onFocus: (e) => e.target.select() });
  const copy = Button({ size: 'sm', type: 'button' }, 'Copy link');
  copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(url); copy.firstChild.textContent = 'Copied'; } catch { input.select(); } });
  const m = modal({ title: `Send ${person} their link`, body: h('div', { class: 'f' }, Alert('warn', why), h('p', { class: 'fine', style: { margin: 0 } }, 'Text or message them this link. It is only for them and works for 14 days.'), h('div', { style: { display: 'flex', gap: '8px' } }, input, copy)), actions: [Button({ onClick: () => m.close() }, 'Done')] });
}

async function sendReminder(r, btn) {
  if (btn) setLoading(btn, true);
  try {
    const res = await api.post(`${base()}/employees/${r.employeeId}/remind`);
    if (res.emailed) toast('success', `Reminder sent to ${r.name.split(' ')[0]}.`);
    else linkModal(r.name.split(' ')[0], res.link, 'Email isn’t set up on this server, so nothing was sent.');
    peopleChanged();
  } catch (e) { toast('error', e.message); if (btn) setLoading(btn, false); }
}

// ---------------------------------------------------------------- I-9 section 2, done by the employer
function i9Section2Modal(r) {
  const title = Field({ label: 'Document', name: 'documentTitle', placeholder: 'US Passport, or Driver’s license and Social Security card', autofocus: true });
  const authority = Field({ label: 'Issuing authority', name: 'issuingAuthority', placeholder: 'US Department of State' });
  const number = Field({ label: 'Document number', name: 'documentNumber' });
  const expires = Field({ label: 'Expires', name: 'expires', type: 'date', optional: true });
  const first = Field({ label: 'First day of employment', name: 'firstDayOfEmployment', type: 'date', value: r.startDate || new Date().toISOString().slice(0, 10) });
  const attest = h('input', { type: 'checkbox', name: 'attest' });
  const err = h('div', {});
  const go = Button({}, 'Save section 2');
  const m = modal({ title: `I-9 section 2 for ${r.name}`, body: h('div', { class: 'f' }, h('p', { class: 'fine', style: { margin: 0 } }, 'Look at the original documents in person, then record what you saw.'), title.el, authority.el, h('div', { class: 'r2' }, number.el, expires.el), first.el, h('label', { class: 'ck2' }, attest, h('span', { class: 'cb' }), h('span', { class: 'fine' }, 'I examined the original documents, and they appear genuine and to relate to this person.')), err), actions: [Button({ variant: 'ghost', onClick: () => m.close() }, 'Cancel'), go] });
  go.addEventListener('click', async () => {
    err.replaceChildren(); setLoading(go, true);
    try {
      await api.post(`${base()}/employees/${r.employeeId}/i9-section2`, { documentTitle: title.value, issuingAuthority: authority.value, documentNumber: number.value, expires: expires.value, firstDayOfEmployment: first.value, attest: attest.checked });
      m.close(); toast('success', 'Section 2 saved.'); peopleChanged();
    } catch (e) { err.replaceChildren(Alert('error', e.message)); setLoading(go, false); }
  });
}

// ---------------------------------------------------------------- cards (registered with the dashboard's card types)
export const peopleCards = {
  people_directory({ settings, t, data }) {
    const body = h('div', { class: 'stack', style: { '--gap': '12px' } }, h('div', { class: 'empty' }, 'Loading…'));
    let rows = []; let filter = 'all'; let q = '';
    const draw = () => {
      const locs = data.company.locations || [];
      const pills = [['all', `All ${rows.length}`], ...locs.map((l) => [`loc:${l.name}`, `${l.name} ${rows.filter((r) => r.location === l.name).length}`]), ['needs', `Needs paperwork ${rows.filter((r) => !r.done).length}`], ...(rows.some((r) => r.tipped) ? [['tipped', `Tipped ${rows.filter((r) => r.tipped).length}`]] : [])];
      const list = rows.filter((r) => (filter === 'all' || (filter === 'needs' && !r.done) || (filter === 'tipped' && r.tipped) || filter === `loc:${r.location}`) && (!q || r.name.toLowerCase().includes(q) || r.role.toLowerCase().includes(q)));
      const search = h('input', { class: 'in', type: 'search', placeholder: `Search ${t('people').toLowerCase()}`, 'aria-label': 'Search people', value: q, style: { width: '240px', minHeight: '38px', padding: '8px 12px', fontSize: '14px' } });
      search.addEventListener('input', () => { q = search.value.trim().toLowerCase(); const pos = search.selectionStart; draw(); const s2 = body.querySelector('input[type=search]'); s2.focus(); s2.setSelectionRange(pos, pos); });
      body.replaceChildren(
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px', flexWrap: 'wrap' } }, h('div', { class: 'chips2' }, ...pills.map(([id, label]) => h('button', { type: 'button', class: `pill ${filter === id ? 'on' : ''}`, 'data-filter': id, onClick: () => { filter = id; draw(); } }, label))), search),
        list.length ? h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', { class: 'l hm' }, 'Work location'), settings.showPay === false ? null : h('th', { class: 'hm' }, 'Pay'), h('th', { class: 'l hm' }, 'Paperwork'), h('th', { class: 'l' }, 'Status'))),
          h('tbody', {}, ...list.slice(0, settings.rows || 25).map((r) => h('tr', { 'data-employee': r.employeeId }, h('td', {}, link(`/app/people/${r.employeeId}`, { class: 'who-link' }, who(r.name, r.role))), h('td', { class: 'l hm' }, r.location || ''), settings.showPay === false ? null : h('td', { class: 'hm' }, payText(r.pay)), h('td', { class: 'l hm' }, paperwork(r)), h('td', { class: 'l' }, statusChip(r))))))
          : h('div', { class: 'empty' }, rows.length ? 'No one matches.' : 'Nobody here yet. ', rows.length ? null : link('/app/onboarding', { class: 'link' }, 'Invite your first person')),
        list.length > (settings.rows || 25) ? h('p', { class: 'cap' }, `Showing ${settings.rows || 25} of ${list.length}. Search to find the rest.`) : null);
    };
    const load = async () => { try { rows = (await api.get(`${base()}/onboarding`)).people; draw(); } catch (e) { body.replaceChildren(Alert('error', e.message)); } };
    load(); onChange(load);
    return { title: null, body };
  },

  onboarding_board({ t, data }) {
    const body = h('div', {}, h('div', { class: 'empty' }, 'Loading…'));
    const cap = h('span', { class: 'cap' });
    const load = async () => {
      try {
        const r = await api.get(`${base()}/onboarding`);
        cap.textContent = r.remaining ? `${r.remaining} of ${r.total} still to do` : 'Everyone has finished';
        body.replaceChildren(r.people.length ? h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, h('th', {}, 'Person'), h('th', { class: 'l hm' }, 'Status'), h('th', { class: 'l' }, 'Paperwork'), h('th', { class: 'l' }), h('th', { class: 'l hm' }))),
          h('tbody', {}, ...r.people.map((p) => {
            const remind = p.canRemind ? (() => { const b = h('button', { class: 'link as-button', type: 'button', 'data-remind': p.employeeId }, p.linkExpired ? 'Send a new link' : 'Send reminder'); b.addEventListener('click', () => sendReminder(p, b)); return b; })() : null;
            const s2 = p.i9NeedsSection2 ? h('button', { class: 'link as-button', type: 'button', 'data-i9': p.employeeId, onClick: () => i9Section2Modal(p) }, 'I-9 section 2') : null;
            const bank = p.pendingDeposit ? h('span', { class: 'bank-change' }, Chip('Bank change', 'warn'), ' ', h('button', { class: 'link as-button', type: 'button', 'data-approve-bank': p.employeeId, onClick: async () => { try { await api.post(`${base()}/employees/${p.employeeId}/deposit-change`, { approve: true }); toast('success', `${p.name.split(' ')[0]}’s new account is approved. It’s verified before it’s used.`); peopleChanged(); } catch (e) { toast('error', e.message); } } }, 'Approve'), ' · ', h('button', { class: 'link as-button', type: 'button', 'data-decline-bank': p.employeeId, onClick: async () => { try { await api.post(`${base()}/employees/${p.employeeId}/deposit-change`, { approve: false }); toast('success', 'Declined.'); peopleChanged(); } catch (e) { toast('error', e.message); } } }, 'Decline')) : null;
            return h('tr', { 'data-employee': p.employeeId }, h('td', {}, link(`/app/people/${p.employeeId}`, { class: 'who-link' }, who(p.name, `${p.role}${p.location ? `, ${p.location}` : ''}`))),
              h('td', { class: 'l hm' }, p.invited ? `Invited ${shortDate(p.invitedAt.slice(0, 10))}${p.startDate ? ` · starts ${shortDate(p.startDate)}` : ''}` : 'On payroll'), h('td', { class: 'l' }, paperwork(p)), h('td', { class: 'l' }, statusChip(p)), h('td', { class: 'l hm' }, bank, bank && (remind || s2) ? ' · ' : null, remind, remind && s2 ? ' · ' : null, s2));
          }))) : h('div', { class: 'empty' }, 'Nobody to onboard yet. Invite a new hire on the right.'));
      } catch (e) { body.replaceChildren(Alert('error', e.message)); }
    };
    load(); onChange(load);
    return { title: null, head: h('div', { class: 'ch' }, h('h3', { class: 'ct' }, 'Who’s finished'), cap), body };
  },

  join_requests({ data }) {
    const body = h('div', {}, h('div', { class: 'empty' }, 'Loading…'));
    const cap = h('span', { class: 'cap' });
    const c = data.company;
    const when = (iso) => shortDate(iso.slice(0, 10));
    function approveModal(r, list) {
      const roleSel = Field({ label: 'Role', name: 'roleKey', select: true, value: c.roles[0] && c.roles[0].key, options: c.roles.map((x) => ({ value: x.key, label: x.label })) });
      const locSel = c.locations.length ? Field({ label: 'Location', name: 'location', select: true, value: c.locations[0].name, options: c.locations.map((l) => ({ value: l.name, label: l.name })) }) : null;
      const salaried = () => (c.roles.find((x) => x.key === roleSel.value) || {}).pay === 'salary';
      const rate = Field({ label: 'Hourly rate', name: 'rate', placeholder: '15.50', inputmode: 'decimal' });
      const start = Field({ label: 'Start date', name: 'startDate', type: 'date', value: new Date().toISOString().slice(0, 10) });
      const hasTipCredit = app.data.built.modules.some((x) => x.items.some((i) => i.id === 'tip_credit'));
      const tippedRole = () => (c.roles.find((x) => x.key === roleSel.value) || {}).tipped !== 'never';
      const notice = hasTipCredit ? h('label', { class: 'ck2', hidden: true }, h('input', { type: 'checkbox', name: 'tipCreditNotice', 'data-testid': 'approve-tip-notice' }), h('span', {}, 'I gave them the tip credit notice in writing')) : null;
      const sync = () => { rate.el.querySelector('label').firstChild.textContent = salaried() ? 'Annual salary' : 'Hourly rate'; if (notice) notice.hidden = !tippedRole(); };
      roleSel.input.addEventListener('change', sync); sync();
      const link2 = Field({ label: 'Already on your team?', name: 'link', select: true, value: r.sameEmail || '', options: [{ value: '', label: 'No, add them as a new person' }, ...list.unlinked.map((e) => ({ value: e.id, label: `Yes, this is ${e.name} (${e.role})` }))] });
      const newBits = h('div', { class: 'f' }, h('div', { class: 'r2' }, roleSel.el, locSel ? locSel.el : h('div')), h('div', { class: 'r2' }, rate.el, start.el), notice);
      const showBits = () => { newBits.hidden = !!link2.value; };
      link2.input.addEventListener('change', showBits); showBits();
      const err = h('div', {}); const go = Button({ type: 'button', 'data-testid': 'approve-go' }, 'Approve');
      const m = modal({ title: `Approve ${r.name}`, body: h('div', { class: 'f' }, h('p', { class: 'fine', style: { margin: 0 } }, `Their W-4, I-9 section 1${r.forms.deposit ? ' and bank details' : ''} come across with them. You set the job and the pay.`), list.unlinked.length ? link2.el : null, newBits, err), actions: [Button({ variant: 'ghost', onClick: () => m.close() }, 'Cancel'), go] });
      go.addEventListener('click', async () => {
        err.replaceChildren();
        const linking = list.unlinked.length && link2.value;
        const cents = dollarsToCents(rate.value);
        if (!linking && !cents) return rate.setError(salaried() ? 'Enter their yearly pay, like 52000.' : 'Enter their hourly rate, like 15.50.');
        setLoading(go, true);
        try {
          await api.post(`${base()}/portal/requests/${r.accountId}/approve`, linking ? { linkEmployeeId: link2.value } : { roleKey: roleSel.value, rateCents: cents, ...(locSel ? { location: locSel.value } : {}), startDate: start.value, ...(notice && tippedRole() ? { tipCreditNotice: notice.querySelector('input').checked } : {}) });
          m.close(); toast('success', `${r.firstName} is on your team.`); await refreshData(); peopleChanged(); load();
        } catch (e) { err.replaceChildren(Alert('error', e.message)); setLoading(go, false); }
      });
    }
    function declineModal(r) {
      const why = Field({ label: 'Reason (they will see it)', name: 'reason', optional: true, placeholder: 'We aren’t hiring right now.' });
      const go = Button({ type: 'button', 'data-testid': 'decline-go' }, 'Decline');
      const m = modal({ title: `Decline ${r.name}?`, body: h('div', { class: 'f' }, h('p', { class: 'fine', style: { margin: 0 } }, 'Their details are deleted. They can fix something and send it again.'), why.el), actions: [Button({ variant: 'ghost', onClick: () => m.close() }, 'Cancel'), go] });
      go.addEventListener('click', async () => { setLoading(go, true); try { await api.post(`${base()}/portal/requests/${r.accountId}/decline`, { reason: why.value }); m.close(); toast('success', 'Declined.'); await refreshData(); load(); } catch (e) { toast('error', e.message); setLoading(go, false); } });
    }
    async function load() {
      try {
        const list = await api.get(`${base()}/portal/requests`);
        cap.textContent = list.requests.length ? String(list.requests.length) : '';
        body.replaceChildren(list.requests.length ? h('div', {}, ...list.requests.map((r) => h('div', { class: 'row', 'data-request': r.accountId },
          h('span', { class: 'l1' }, h('b', {}, r.name), h('i', {}, `${r.email} · sent ${when(r.submittedAt)}${r.sameEmail ? ' · matches someone you added' : ''}`)),
          h('span', { class: 'acts' }, Button({ size: 'sm', type: 'button', 'data-testid': 'review-request', onClick: () => approveModal(r, list) }, 'Review'), h('button', { class: 'link as-button', type: 'button', onClick: () => declineModal(r) }, 'Decline')))))
          : h('div', { class: 'empty' }, 'Nobody is waiting. When someone makes an account with your code and sends their details, they show up here.'));
      } catch (e) { body.replaceChildren(Alert('error', e.message)); }
    }
    load(); onChange(load);
    return { title: null, head: h('div', { class: 'ch' }, h('h3', { class: 'ct' }, 'Requests to join'), cap), body };
  },

  employee_access() {
    const body = h('div', {}, h('div', { class: 'empty' }, 'Loading…'));
    accessCard().then((el) => body.replaceChildren(el)).catch((e) => body.replaceChildren(Alert('error', e.message)));
    return { title: 'Employee code', body };
  },

  invite_form({ data }) {
    const c = data.company;
    const first = Field({ label: 'First name', name: 'firstName' });
    const last = Field({ label: 'Last name', name: 'lastName' });
    const email = Field({ label: 'Email', name: 'email', type: 'email', placeholder: 'name@example.com', hint: 'Their link goes here. We don’t send texts yet.' });
    const roleSel = Field({ label: 'Role', name: 'roleKey', select: true, value: c.roles[0] && c.roles[0].key, options: c.roles.map((r) => ({ value: r.key, label: r.label })) });
    const locSel = c.locations.length ? Field({ label: 'Location', name: 'location', select: true, value: c.locations[0].name, options: c.locations.map((l) => ({ value: l.name, label: l.name })) }) : null;
    const salaried = () => (c.roles.find((r) => r.key === roleSel.value) || {}).pay === 'salary';
    const rate = Field({ label: 'Hourly rate', name: 'rate', placeholder: '15.50', inputmode: 'decimal' });
    roleSel.input.addEventListener('change', () => { rate.el.querySelector('label').firstChild.textContent = salaried() ? 'Annual salary' : 'Hourly rate'; });
    const start = Field({ label: 'Start date', name: 'startDate', type: 'date', value: new Date().toISOString().slice(0, 10) });
    const formsWanted = { w4: true, stateForm: true, i9: true, deposit: true };
    const items = [['w4', 'W-4', 'Federal withholding'], ...(c.stateForm ? [['stateForm', c.stateForm, `Added because you’re in ${app.data.built ? app.data.built.answers[0] : c.state}`]] : []), ['i9', 'I-9', 'Section 1 by them, section 2 by you'], ['deposit', 'Direct deposit', 'Bank details for setup']];
    const hasItem = (id) => app.data.built.modules.some((m) => m.items.some((i) => i.id === id));
    const tipNotice = hasItem('tip_credit') ? h('label', { class: 'ck2', hidden: true }, h('input', { type: 'checkbox', name: 'tipCreditNotice', 'data-testid': 'tip-notice' }), h('span', {}, 'I gave them the tip credit notice in writing', h('small', {}, 'Required before we pay a tipped cash wage below the full minimum.'))) : null;
    const tippedRole = () => (c.roles.find((r) => r.key === roleSel.value) || {}).tipped !== 'never';
    const showNotice = () => { if (tipNotice) tipNotice.hidden = !tippedRole(); };
    roleSel.input.addEventListener('change', showNotice); showNotice();
    const opts = h('div', { class: 'opts' });
    const drawOpts = () => opts.replaceChildren(...items.map(([id, label, help]) => h('button', { type: 'button', class: `opt ${formsWanted[id] ? 'on' : ''}`, role: 'checkbox', 'aria-checked': String(formsWanted[id]), 'data-form': id, onClick: () => { formsWanted[id] = !formsWanted[id]; if (id === 'w4' && !formsWanted.w4) formsWanted.stateForm = false; drawOpts(); } }, h('span', { class: 'cb' }), h('span', {}, label, h('small', {}, help)), id === 'stateForm' ? h('em', {}, c.state) : null)));
    drawOpts();
    const err = h('div', {});
    const send = Button({ full: true, type: 'submit' }, 'Send invite');
    const form = h('form', { class: 'f', novalidate: true, onSubmit: async (e) => {
      e.preventDefault(); err.replaceChildren();
      const cents = dollarsToCents(rate.value);
      if (cents === null || cents <= 0) { rate.setError(salaried() ? 'Enter their yearly pay, like 52000.' : 'Enter their hourly rate, like 15.50.'); return; }
      setLoading(send, true);
      try {
        const forms = Object.entries(formsWanted).filter(([, on]) => on).map(([id]) => id);
        const r = await api.post(`${base()}/onboarding/invite`, { firstName: first.value, lastName: last.value, email: email.value, roleKey: roleSel.value, location: locSel ? locSel.value : undefined, rateCents: cents, startDate: start.value, forms, ...(tipNotice && tippedRole() ? { tipCreditNotice: tipNotice.querySelector('input').checked } : {}) });
        first.value = ''; last.value = ''; email.value = ''; rate.value = '';
        if (r.emailed) toast('success', `Invite sent to ${r.employee.firstName}.`); else linkModal(r.employee.firstName, r.link, 'Email isn’t set up on this server, so nothing was sent.');
        await refreshData(); peopleChanged(); navigate(location.pathname + location.search);
      } catch (e2) { const t = { firstName: first, lastName: last, email, roleKey: roleSel }[e2.details && e2.details.field]; if (t) t.setError(e2.message); else err.replaceChildren(Alert('error', e2.message)); }
      setLoading(send, false);
    } }, h('div', { class: 'r2' }, first.el, last.el), email.el, h('div', { class: 'r2' }, roleSel.el, locSel ? locSel.el : h('div')), h('div', { class: 'r2' }, rate.el, start.el), tipNotice, h('div', {}, h('label', { class: 'lab' }, 'Forms they’ll fill in on their phone'), opts), err, send);
    return { title: 'Invite a new hire', body: form };
  },
};

// ---------------------------------------------------------------- bulk invite from a spreadsheet (the People page's button)
export function importPeopleModal() {
  const file = h('input', { type: 'file', accept: '.csv,text/csv', 'aria-label': 'People spreadsheet' });
  const out = h('div', {});
  const c = app.data.company;
  const go = Button({ disabled: true }, 'Send invites');
  let people = [];
  const roleOf = (text) => { const t = String(text || '').trim().toLowerCase(); return (c.roles.find((r) => r.label.toLowerCase() === t || r.key === t) || {}).key; };
  file.addEventListener('change', async () => {
    out.replaceChildren(); people = []; go.disabled = true;
    const f = file.files[0]; if (!f) return;
    const csv = parseCsv(await f.text());
    const head = (csv[0] || []).map((x) => x.trim().toLowerCase());
    const col = (...n) => head.findIndex((x) => n.some((k) => x.includes(k)));
    const ix = { first: col('first'), last: col('last'), email: col('email'), role: col('role', 'job'), loc: col('location'), rate: col('rate', 'pay', 'wage', 'salary'), start: col('start') };
    if (ix.first < 0 || ix.last < 0 || ix.email < 0) return out.replaceChildren(Alert('error', 'The first row needs First name, Last name and Email columns.'));
    const problems = [];
    csv.slice(1).forEach((line, i) => {
      const roleKey = ix.role >= 0 ? roleOf(line[ix.role]) : c.roles[0].key;
      const cents = ix.rate >= 0 ? dollarsToCents(line[ix.rate]) : null;
      if (!roleKey) return problems.push(`Row ${i + 2}: “${line[ix.role]}” isn’t one of your roles (${c.roles.map((r) => r.label).join(', ')}).`);
      if (!cents) return problems.push(`Row ${i + 2}: the pay isn’t a number.`);
      people.push({ firstName: line[ix.first], lastName: line[ix.last], email: line[ix.email], roleKey, rateCents: cents, ...(ix.loc >= 0 && line[ix.loc] ? { location: line[ix.loc].trim() } : {}), ...(ix.start >= 0 && line[ix.start] ? { startDate: line[ix.start].trim() } : {}) });
    });
    out.replaceChildren(h('p', { class: 'fine' }, `${plural(people.length, 'person', 'people')} ready to invite.`), ...problems.slice(0, 5).map((p) => Alert('warn', p)));
    go.disabled = people.length === 0;
  });
  const m = modal({ title: 'Import people from a spreadsheet', body: h('div', { class: 'f' }, h('p', { class: 'fine', style: { margin: 0 } }, 'One row per person. Columns: First name, Last name, Email, Role, Location, Hourly rate, Start date. Each person gets an email with their forms.'), h('a', { class: 'link', href: '#', onClick: (e) => { e.preventDefault(); const csv = `First name,Last name,Email,Role,Location,Hourly rate,Start date\nNoor,Patel,noor@example.com,${c.roles[0].label},${(c.locations[0] || {}).name || ''},15.50,${new Date().toISOString().slice(0, 10)}\n`; const a = h('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: 'people-template.csv' }); document.body.append(a); a.click(); a.remove(); } }, 'Download a template'), file, out), actions: [Button({ variant: 'ghost', onClick: () => m.close() }, 'Cancel'), go] });
  go.addEventListener('click', async () => {
    setLoading(go, true);
    try {
      const r = await api.post(`${base()}/onboarding/invite-many`, { people });
      m.close(); peopleChanged(); await refreshData();
      toast(r.failed ? 'warn' : 'success', `${plural(r.invited, 'invite')} sent.${r.failed ? ` ${r.failed} didn’t go: ${r.results.filter((x) => !x.ok).slice(0, 3).map((x) => `${x.name} (${x.error})`).join('; ')}` : ''}`, 9000);
      const noMail = r.results.some((x) => x.ok && !x.emailed);
      if (noMail) toast('warn', 'Email isn’t set up on this server, so no one was emailed. Open each person to copy their link.', 9000);
    } catch (e) { out.replaceChildren(Alert('error', e.message)); setLoading(go, false); }
  });
}

/** Opening balances for someone who was paid elsewhere earlier this year (wage bases only; not their W-2). */
export function ytdModal(e, done) {
  const asOf = Field({ label: 'Balances as of', name: 'asOf', type: 'date', value: new Date().toISOString().slice(0, 10) });
  const ss = Field({ label: 'Social Security wages so far this year', name: 'ss', placeholder: '18400.00', inputmode: 'decimal' });
  const med = Field({ label: 'Medicare wages so far', name: 'med', placeholder: 'Same as Social Security if unsure', inputmode: 'decimal', optional: true });
  const futa = Field({ label: 'Federal unemployment (FUTA) wages so far', name: 'futa', placeholder: '7000.00', inputmode: 'decimal', optional: true });
  const err = h('div', {}); const go = Button({}, 'Save balances');
  const m = modal({ title: `${e.firstName}’s earlier pay this year`, body: h('div', { class: 'f' }, h('p', { class: 'fine', style: { margin: 0 } }, 'Use the year-to-date numbers from their last pay stub at the old service. We use them so Social Security and unemployment stop at the yearly limit instead of starting over. This does not bring their earlier wages into your W-2s or quarterly filings. Keep the old provider’s records for those.'), asOf.el, ss.el, med.el, futa.el, err), actions: [Button({ variant: 'ghost', onClick: () => m.close() }, 'Cancel'), go] });
  go.addEventListener('click', async () => {
    const ssC = dollarsToCents(ss.value);
    if (ssC === null) return ss.setError('Enter a dollar amount, like 18400.00.');
    const medC = med.value.trim() ? dollarsToCents(med.value) : ssC;
    const futaC = futa.value.trim() ? dollarsToCents(futa.value) : Math.min(ssC, 700000);
    if (medC === null || futaC === null) return err.replaceChildren(Alert('error', 'Those need to be dollar amounts.'));
    setLoading(go, true);
    try { await api.post(`${base()}/employees/${e.id}/ytd-import`, { asOf: asOf.value, socialSecurityWagesCents: ssC, medicareWagesCents: medC, futaWagesCents: futaC }); m.close(); toast('success', 'Saved.'); done(); } catch (e2) { err.replaceChildren(Alert('error', e2.message)); setLoading(go, false); }
  });
}

// ---------------------------------------------------------------- one person
const FILING = { single: 'Single or married filing separately', married_joint: 'Married filing jointly', married_separate: 'Married filing separately', head_of_household: 'Head of household' };

export function profilePage() {
  return async (ctx) => appPage(ctx, { active: 'people', title: 'Person', render: async ({ t }) => {
    await refreshData();
    const id = ctx.params.id;
    let e; let ov;
    try { [e, ov] = await Promise.all([api.get(`${base()}/employees/${id}`), api.get(`${base()}/onboarding`)]); } catch { navigate('/404', { replace: true }); return null; }
    const row = ov.people.find((p) => p.employeeId === id);
    const roleLabel = (app.data.company.roles.find((r) => r.key === e.roleKey) || {}).label || e.roleKey;
    const tipped = (app.data.company.roles.find((r) => r.key === e.roleKey) || {}).tipped !== 'never';
    const runs = (await api.get(`${base()}/pay-runs`)).payRuns.filter((r) => r.status !== 'draft' && r.status !== 'voided').slice(0, 6);
    const paid = (await Promise.all(runs.map((r) => api.get(`${base()}/pay-runs/${r.id}`)))).map((r) => ({ run: r, pc: r.paychecks.find((p) => p.employeeId === id) })).filter((x) => x.pc);
    const initials = `${e.firstName[0]}${e.lastName[0]}`.toUpperCase();
    const host = h('div', {});
    const tabs = ['Overview', 'Pay', 'Taxes', 'Documents'];
    let tab = 'Overview';
    const kv = (...pairs) => h('dl', { class: 'kv' }, ...pairs.flatMap(([k, v2]) => [h('dt', {}, k), h('dd', {}, v2)]));
    const forms = (r) => [
      ['W-4', r.forms.w4, e.onboarding && e.onboarding.w4 ? `Signed ${shortDate(e.onboarding.w4.completedAt.slice(0, 10))}` : 'On file'],
      ...(r.forms.stateForm !== null ? [[app.data.company.stateForm, r.forms.stateForm, e.onboarding && e.onboarding.stateForm ? `Signed ${shortDate(e.onboarding.stateForm.completedAt.slice(0, 10))}` : 'Waiting']] : []),
      ['I-9', r.forms.i9 === 'done', r.forms.i9 === 'done' ? 'Sections 1 and 2 done' : r.forms.i9 === 'section1' ? 'Section 1 done. Section 2 is yours.' : 'Not started'],
      ['Direct deposit', r.forms.deposit, r.forms.deposit ? (e.payoutAccounts.length ? 'Account on file' : 'On file') : 'Not set up'],
    ];
    const paperRows = () => forms(row).map(([name, ok, note]) => h('div', { class: 'row' }, h('span', { class: 'l1' }, h('b', {}, name), h('i', {}, note)), h('span', { class: `dt ${ok ? 'ok' : 'no'}` }, ok ? 'On file' : 'Missing')));
    const pages = {
      Overview: () => h('div', {}, h('div', { class: 'grid g3', style: { gridTemplateColumns: 'repeat(3, minmax(0,1fr))' } },
        h('div', { class: 'card' }, h('h3', { class: 'ct', style: { marginBottom: '12px' } }, 'Job and pay'), kv(['Role', roleLabel], [e.payType.kind === 'hourly' ? 'Hourly rate' : 'Salary', e.payType.kind === 'hourly' ? money(e.payType.rateCents) : `${money(e.payType.annualCents)}/yr`], ['Pay type', `${e.payType.kind === 'hourly' ? 'Hourly' : 'Salaried'}${tipped ? ', tipped' : ''}`], ['Work location', e.location || '—'], ...(e.tags && e.tags.crew ? [['Crew', e.tags.crew]] : []), ...(e.tags && e.tags.department ? [['Department', e.tags.department]] : []), ...(e.tags && e.tags.wcClass ? [['Comp class', e.tags.wcClass]] : []), ...(e.season ? [['Season', `${shortDate(e.season.start)} to ${shortDate(e.season.end)}`]] : []), ['Pay schedule', { weekly: 'Weekly', biweekly: 'Every other week', semimonthly: 'Twice a month', monthly: 'Monthly' }[app.data.company.schedule.frequency]])),
        h('div', { class: 'card' }, h('div', { class: 'ch' }, h('h3', { class: 'ct' }, 'Tax setup'), Chip('Calculated by Omnia.tax', 'line')), kv(['Federal W-4', e.onboarding && !e.onboarding.w4 ? 'Not filled in yet' : FILING[e.federalW4.filingStatus] || e.federalW4.filingStatus], [`${e.workState.code} withholding`, e.workState.certificate && e.workState.certificate.allowances !== undefined ? `${plural(e.workState.certificate.allowances, 'exemption')}` : 'Standard'], ['Tips', tipped ? 'Reported each pay run' : 'None'])),
        h('div', { class: 'card' }, h('h3', { class: 'ct', style: { marginBottom: '6px' } }, 'Paperwork'), ...paperRows())),
      h('div', { class: 'grid', style: { gridTemplateColumns: 'minmax(0,1fr)', marginTop: '18px' } }, h('div', { class: 'card' }, h('div', { class: 'ch' }, h('h3', { class: 'ct' }, 'Recent pay'), paid.length ? link(`/app/payroll/runs/${paid[0].run.id}/stub/${id}`, { class: 'link' }, 'Latest stub') : null),
        paid.length ? h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, h('th', {}, 'Period'), h('th', {}, 'Hours'), h('th', {}, 'Gross'), h('th', {}, 'Net'))), h('tbody', {}, ...paid.map(({ run, pc }) => h('tr', {}, h('td', {}, link(`/app/payroll/runs/${run.id}/stub/${id}`, { class: 'link' }, rangeLabel(run.periodStart, run.periodEnd))), h('td', {}, String(Math.round(pc.hours * 100) / 100)), h('td', {}, money(pc.taxableWagesCents)), h('td', {}, h('b', {}, money(pc.netPayCents)))))))
          : h('div', { class: 'empty' }, 'No pay yet. Their first pay run will show here.')))),
      Pay: () => h('div', { class: 'stack', style: { '--gap': '16px', maxWidth: '640px' } }, payCard(), hasMod('deductions') ? deductionsCard() : null, hasMod('opening_balances') ? ytdCard() : null),
      PayOld: () => h('div', { class: 'card', style: { maxWidth: '640px' } }, h('h3', { class: 'ct', style: { marginBottom: '12px' } }, 'Pay'), kv(['Role', roleLabel], [e.payType.kind === 'hourly' ? 'Hourly rate' : 'Annual salary', e.payType.kind === 'hourly' ? money(e.payType.rateCents) : money(e.payType.annualCents)], ['Started', longDate(e.hireDate)], ['Direct deposit', e.payoutAccounts.length ? 'Set up' : 'Not set up']), h('div', { class: 'acts', style: { marginTop: '14px' } }, Button({ variant: 'ghost', size: 'sm', onClick: editModal }, 'Change role or pay'))),
      Taxes: () => h('div', { class: 'card', style: { maxWidth: '640px' } }, h('h3', { class: 'ct', style: { marginBottom: '12px' } }, 'Tax setup'), kv(['Filing status', FILING[e.federalW4.filingStatus] || e.federalW4.filingStatus], ['More than one job', e.federalW4.multipleJobs ? 'Yes' : 'No'], ['Dependent credit', money(e.federalW4.dependentCredit)], ['Extra withholding', money(e.federalW4.extraWithholding)], [`${e.workState.code} work state`, e.workState.certificate && e.workState.certificate.allowances !== undefined ? plural(e.workState.certificate.allowances, 'exemption') : 'Standard']), h('p', { class: 'cap', style: { marginTop: '12px' } }, 'These come from the forms they filled in. To change them, send a new W-4 link from Onboarding.')),
      Documents: () => h('div', { class: 'card', style: { maxWidth: '640px' } }, h('h3', { class: 'ct', style: { marginBottom: '6px' } }, 'Forms'), ...paperRows(), row.i9NeedsSection2 ? h('div', { class: 'acts', style: { marginTop: '14px' } }, Button({ size: 'sm', onClick: () => i9Section2Modal(row) }, 'Do I-9 section 2')) : null, row.canRemind ? h('div', { class: 'acts', style: { marginTop: '10px' } }, Button({ variant: 'ghost', size: 'sm', onClick: () => sendReminder(row) }, 'Send a reminder')) : null),
    };
    const hasMod = (id) => app.data.built.modules.some((m) => m.id === id || m.items.some((i) => i.id === id));
    const payCard = () => pages.PayOld();
    const PRE = { deferral_401k: '401(k)', deferral_403b: '403(b)', section125: 'Health plan', hsa: 'HSA', fsa: 'FSA', dependent_care: 'Dependent care', commuter: 'Commuter' };
    const planLine = (d) => `${d.amount.kind === 'flat' ? money(d.amount.cents) : `${d.amount.percent}% of pay`}${d.category ? ', before tax' : ', after tax'}`;
    function deductionsCard() {
      const plans = e.deductionPlans || [];
      return h('div', { class: 'card', 'data-card': 'deductions' }, h('div', { class: 'ch' }, h('h3', { class: 'ct' }, 'Deductions'), h('button', { class: 'link as-button', type: 'button', 'data-testid': 'add-deduction', onClick: () => deductionModal() }, 'Add')),
        plans.length ? plans.map((d, i) => h('div', { class: 'row', 'data-deduction': d.code }, h('span', { class: 'l1' }, h('b', {}, d.code), h('i', {}, planLine(d))), h('button', { class: 'link as-button', type: 'button', 'aria-label': `Remove ${d.code}`, onClick: () => saveDeductions(plans.filter((_, j) => j !== i)) }, 'Remove'))) : h('p', { class: 'cap' }, 'None. Add a health plan, 401(k) or other amount to take from each paycheck.'));
    }
    async function saveDeductions(list) {
      try { await api.patch(`${base()}/employees/${id}`, { deductionPlans: list.map((d) => ({ code: d.code, category: d.category, amount: d.amount.kind === 'flat' ? { kind: 'flat', cents: d.amount.cents } : { kind: 'percentOfGross', percent: d.amount.percent }, active: d.active })) }); e = await api.get(`${base()}/employees/${id}`); draw(); } catch (e2) { toast('error', e2.message); }
    }
    function deductionModal() {
      const what = Field({ label: 'What is it', name: 'code', select: true, value: 'deferral_401k', options: [...Object.entries(PRE).map(([v2, l]) => ({ value: v2, label: l })), { value: 'other', label: 'Other (after tax)' }] });
      const name = Field({ label: 'Name on the stub', name: 'label', placeholder: 'Dental', optional: true });
      const mode = Field({ label: 'Taken as', name: 'mode', select: true, value: 'percent', options: [{ value: 'percent', label: 'A percent of pay' }, { value: 'flat', label: 'A dollar amount each check' }] });
      const amt = Field({ label: 'Amount', name: 'amt', placeholder: '5 for 5%, or 25.00', inputmode: 'decimal' });
      const err = h('div', {}); const go = Button({}, 'Add deduction');
      const m = modal({ title: `Add a deduction for ${e.firstName}`, body: h('div', { class: 'f' }, h('p', { class: 'fine', style: { margin: 0 } }, 'Retirement and health amounts marked before tax lower the pay their income tax is figured on. Garnishments and court orders aren’t set up here yet.'), what.el, name.el, mode.el, amt.el, err), actions: [Button({ variant: 'ghost', onClick: () => m.close() }, 'Cancel'), go] });
      go.addEventListener('click', async () => {
        const n = Number(amt.value.replace(/[$,%\s]/g, ''));
        if (!Number.isFinite(n) || n <= 0) return amt.setError('Enter a number.');
        if (mode.value === 'percent' && n > 100) return amt.setError('A percent can’t be over 100.');
        const cat = what.value === 'other' ? null : what.value;
        const code = (name.value.trim() || (PRE[what.value] || 'Deduction')).slice(0, 30);
        const amount = mode.value === 'percent' ? { kind: 'percentOfGross', percent: n } : { kind: 'flat', cents: Math.round(n * 100) };
        m.close(); await saveDeductions([...(e.deductionPlans || []), { code, category: cat, amount, active: true }]);
      });
    }
    function ytdCard() {
      const im = e.ytdImport;
      return h('div', { class: 'card', 'data-card': 'ytd' }, h('h3', { class: 'ct', style: { marginBottom: '6px' } }, 'Earlier pay this year'),
        h('p', { class: 'cap' }, im ? `Opening balances entered as of ${longDate(im.asOf)}.` : 'Paid somewhere else before Totali? Enter their year-to-date so yearly limits carry over.'),
        paid.length ? null : h('div', { class: 'acts', style: { marginTop: '10px' } }, Button({ variant: 'ghost', size: 'sm', 'data-testid': 'ytd-open', onClick: () => ytdModal(e, async () => { e = await api.get(`${base()}/employees/${id}`); draw(); }) }, im ? 'Change balances' : 'Enter balances')));
    }
    const draw = () => host.replaceChildren(h('div', { class: 'tabs2' }, ...tabs.map((x) => h('a', { class: tab === x ? 'on' : '', href: '#', 'data-tab-name': x, onClick: (ev) => { ev.preventDefault(); tab = x; draw(); } }, x))), pages[tab]());
    onChange(async () => { try { [e, ov] = await Promise.all([api.get(`${base()}/employees/${id}`), api.get(`${base()}/onboarding`)]); Object.assign(row, ov.people.find((p) => p.employeeId === id)); draw(); } catch { /* the page was left */ } });

    function editModal() {
      const f = { first: Field({ label: 'First name', name: 'firstName', value: e.firstName }), last: Field({ label: 'Last name', name: 'lastName', value: e.lastName }), email: Field({ label: 'Email', name: 'email', value: e.email || '' }) };
      const roleSel = Field({ label: 'Role', name: 'roleKey', select: true, value: e.roleKey, options: app.data.company.roles.map((r) => ({ value: r.key, label: r.label })) });
      const locs = app.data.company.locations;
      const locSel = locs.length ? Field({ label: 'Location', name: 'location', select: true, value: e.location || locs[0].name, options: locs.map((l) => ({ value: l.name, label: l.name })) }) : null;
      const rate = Field({ label: e.payType.kind === 'hourly' ? 'Hourly rate' : 'Annual salary', name: 'rate', value: ((e.payType.kind === 'hourly' ? e.payType.rateCents : e.payType.annualCents) / 100).toFixed(2), inputmode: 'decimal' });
      const has = (id) => app.data.built.modules.some((m) => m.items.some((i) => i.id === id));
      const tagF = {
        ...(has('crew_tags') ? { crew: Field({ label: 'Crew', name: 'crew', value: (e.tags && e.tags.crew) || '', placeholder: 'Red crew', optional: true }) } : {}),
        ...(has('dept_tags') ? { department: Field({ label: 'Department', name: 'department', value: (e.tags && e.tags.department) || '', placeholder: 'Front desk', optional: true }) } : {}),
        ...(has('wc_classes') ? { wcClass: Field({ label: 'Workers’ comp class code', name: 'wcClass', value: (e.tags && e.tags.wcClass) || '', placeholder: '5190', optional: true, hint: 'Your insurer assigns the classes.' }) } : {}),
      };
      const seasonOn = has('seasonal_dates');
      const sStart = seasonOn ? Field({ label: 'Season starts', name: 'seasonStart', type: 'date', value: (e.season && e.season.start) || '', optional: true }) : null;
      const sEnd = seasonOn ? Field({ label: 'Season ends', name: 'seasonEnd', type: 'date', value: (e.season && e.season.end) || '', optional: true }) : null;
      const err = h('div', {}); const save = Button({}, 'Save');
      const end = h('button', { class: 'link as-button', type: 'button', style: { color: '#B3261E' }, onClick: () => { m.close(); endModal(); } }, 'End their employment');
      const m = modal({ title: `Edit ${e.firstName}`, body: h('div', { class: 'f' }, h('div', { class: 'r2' }, f.first.el, f.last.el), f.email.el, h('div', { class: 'r2' }, roleSel.el, locSel ? locSel.el : h('div')), rate.el, ...Object.values(tagF).map((x) => x.el), sStart ? h('div', { class: 'r2' }, sStart.el, sEnd.el) : null, err, h('div', {}, end)), actions: [Button({ variant: 'ghost', onClick: () => m.close() }, 'Cancel'), save] });
      save.addEventListener('click', async () => {
        err.replaceChildren(); const cents = dollarsToCents(rate.value);
        if (!cents) return rate.setError('Enter a number, like 15.50.');
        const role = app.data.company.roles.find((r) => r.key === roleSel.value);
        setLoading(save, true);
        try {
          await api.patch(`${base()}/employees/${id}`, { firstName: f.first.value, lastName: f.last.value, ...(f.email.value ? { email: f.email.value } : {}), roleKey: roleSel.value, ...(locSel ? { location: locSel.value } : {}), payType: role.pay === 'hourly' ? { kind: 'hourly', rateCents: cents } : { kind: 'salary', annualCents: cents }, ...(Object.keys(tagF).length ? { tags: { ...(e.tags || {}), ...Object.fromEntries(Object.entries(tagF).map(([k, f]) => [k, f.value.trim()])) } } : {}), ...(seasonOn ? { season: sStart.value && sEnd.value ? { start: sStart.value, end: sEnd.value } : null } : {}) });
          m.close(); toast('success', 'Saved.'); navigate(`/app/people/${id}`);
          location.reload();
        } catch (e2) { err.replaceChildren(Alert('error', e2.message)); setLoading(save, false); }
      });
    }
    function endModal() {
      const date = Field({ label: 'Last day', name: 'terminationDate', type: 'date', value: new Date().toISOString().slice(0, 10) });
      const err = h('div', {}); const go = Button({}, 'End employment');
      const m = modal({ title: `End ${e.firstName}’s employment`, body: h('div', { class: 'f' }, h('p', { class: 'fine', style: { margin: 0 } }, 'They stay in your records and past pay stubs. They won’t be on new pay runs after this day.'), date.el, err), actions: [Button({ variant: 'ghost', onClick: () => m.close() }, 'Cancel'), go] });
      go.addEventListener('click', async () => { setLoading(go, true); try { await api.post(`${base()}/employees/${id}/terminate`, { terminationDate: date.value }); m.close(); toast('success', `${e.firstName} is no longer active.`); navigate('/app/people'); } catch (e2) { err.replaceChildren(Alert('error', e2.message)); setLoading(go, false); } });
    }

    draw();
    return h('div', {}, h('div', { style: { display: 'flex', gap: '20px', alignItems: 'center', margin: '28px 0 20px' } }, h('span', { class: 'av', style: { width: '68px', height: '68px', fontSize: '22px', background: 'var(--blush)', color: 'var(--berry)' } }, initials),
      h('div', { style: { flex: 1 } }, h('h1', { class: 'pt', style: { fontSize: '28px' } }, e.firstName, ' ', h('em', {}, e.lastName)), h('p', { class: 'cap' }, `${roleLabel}${e.location ? ` · ${e.location}` : ''} · Started ${longDate(e.hireDate)} `, e.terminationDate ? Chip('Ended', 'line') : statusChip(row), ' ', tipped ? Chip('Tipped', 'berry') : null)),
      h('div', { class: 'acts' }, Button({ variant: 'ghost', size: 'sm', onClick: editModal }, 'Edit'), paid.length ? Button({ size: 'sm', href: `/app/payroll/runs/${paid[0].run.id}/stub/${id}` }, 'Latest stub') : null)), host);
  } });
}
