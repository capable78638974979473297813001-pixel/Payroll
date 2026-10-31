import { h, money, shortDate, longDate, plural, hoursFromMinutes } from '../dom.js';
import { api } from '../api.js';
import { link, navigate } from '../router.js';
import { Button, Alert, Chip, Field, Logo, modal, setLoading, toast } from '../ui.js';
import { applyTheme } from '../theme.js';
import { refreshPortal } from '../session.js';

// ---------------------------------------------------------------- state: who is signed in
const me = { data: null };
/** The approved employee's own data. Null when signed out, or when signed in but not approved yet. */
async function load(force = false) {
  if (me.data && !force) return me.data;
  try { me.data = await api.get('/v1/portal/me'); } catch (e) { if (e.status === 401 || e.status === 403) { me.data = null; return null; } throw e; }
  return me.data;
}
/** Where this login stands: null (not signed in), draft, pending, declined, approved or ended. */
const standing = async () => (await refreshPortal());
const homeFor = (p) => (p && p.status === 'approved' ? '/me' : '/me/join');
export const employeeGuard = async (pattern) => {
  const p = await standing();
  if (!p) return '/employee';
  if (p.status === 'approved') return pattern === '/me/join' ? '/me' : null;
  return pattern === '/me/join' ? null : '/me/join';
};
export const employeeSignedIn = async () => { const p = await standing(); return p ? homeFor(p) : null; };

const FREQ = { weekly: 'Weekly', biweekly: 'Every other week', semimonthly: 'Twice a month', monthly: 'Monthly' };
const initials = (e) => `${e.firstName[0]}${e.lastName[0]}`.toUpperCase();
const rangeText = (a, b) => `${shortDate(a)} to ${shortDate(b)}, ${b.slice(0, 4)}`;
const statusLine = (d) => (d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : d < 0 ? `${-d} days ago` : `In ${d} days`);

const shell = (card, visual) => h('div', { class: 'authpage' }, h('header', { class: 'authtop ui' }, Logo(), h('span', {}, 'Own the business?', link('/login', { class: 'l2' }, 'Owner log in'))),
  h('main', { class: 'auth' }, h('div', { class: 'acard ui' }, card), visual || h('div', { class: 'avis' }, h('figure', { class: 'photo' }, h('img', { src: '/assets/img/waiter.jpg', alt: 'A server carrying plates', style: { objectPosition: '50% 30%' } })))));

// ---------------------------------------------------------------- the employee section: make an account, or sign in
export function employeeSignIn(ctx) {
  let mode = ctx && ctx.query.get('mode') === 'signin' ? 'signin' : 'signup';
  const card = h('div', {});
  const err = h('div', {});
  const done = async () => { me.data = null; const p = await refreshPortal(); navigate(homeFor(p)); };

  function signup() {
    const code = Field({ label: 'Company code', name: 'companyCode', placeholder: 'K7QM-2XRD', autocomplete: 'off', autofocus: true, hint: 'Your manager gave you this. It works for three days after they make it.' });
    const email = Field({ label: 'Your email', name: 'email', type: 'email', autocomplete: 'email', placeholder: 'you@example.com', hint: 'This is your username. We won’t send anything to it.' });
    const pw = Field({ label: 'Choose a password', name: 'password', type: 'password', autocomplete: 'new-password', rightSlot: 'Show', hint: 'At least 10 characters. A phrase works well.' });
    const q = ctx && ctx.query.get('code'); if (q) code.value = q;
    code.input.addEventListener('input', () => { const d = code.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); code.value = d.length > 4 ? `${d.slice(0, 4)}-${d.slice(4)}` : d; });
    const go = Button({ size: 'lg', full: true, type: 'submit', 'data-testid': 'emp-create' }, 'Create account');
    return h('form', { class: 'f', novalidate: true, onSubmit: async (e) => {
      e.preventDefault(); err.replaceChildren();
      if (code.value.replace(/[^A-Za-z0-9]/g, '').length !== 8) return code.setError('The code has 8 letters and numbers, like K7QM-2XRD.');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.value.trim())) return email.setError('Enter your email address.');
      if (!pw.value) return pw.setError('Choose a password.');
      setLoading(go, true);
      try { await api.post('/v1/portal/signup', { code: code.value, email: email.value, password: pw.value }); await done(); return; }
      catch (e2) { const t = { code, email, password: pw }[e2.details && e2.details.field]; if (t) t.setError(e2.message); else err.replaceChildren(Alert('error', e2.message)); }
      setLoading(go, false);
    } }, code.el, email.el, pw.el, err, go);
  }

  function signin() {
    const email = Field({ label: 'Your email', name: 'email', type: 'email', autocomplete: 'email', autofocus: true });
    const pw = Field({ label: 'Password', name: 'password', type: 'password', autocomplete: 'current-password', rightSlot: 'Show' });
    const go = Button({ size: 'lg', full: true, type: 'submit', 'data-testid': 'emp-signin' }, 'Sign in');
    return h('form', { class: 'f', novalidate: true, onSubmit: async (e) => {
      e.preventDefault(); err.replaceChildren();
      if (!email.value.trim() || !pw.value) return err.replaceChildren(Alert('error', 'Enter your email and password.'));
      setLoading(go, true);
      try { await api.post('/v1/portal/signin', { email: email.value, password: pw.value }); await done(); return; } catch (e2) { err.replaceChildren(Alert('error', e2.message)); }
      setLoading(go, false);
    } }, email.el, pw.el, err, go);
  }

  function reset() {
    const email = Field({ label: 'Your email', name: 'email', type: 'email', autocomplete: 'email', autofocus: true });
    const pw = Field({ label: 'Choose a new password', name: 'password', type: 'password', autocomplete: 'new-password', rightSlot: 'Show', hint: 'At least 10 characters.' });
    pw.el.hidden = true;
    const msg = h('div', {});
    const go = Button({ size: 'lg', full: true, type: 'submit', 'data-testid': 'emp-reset-go' }, 'Continue');
    let ready = false;
    return h('form', { class: 'f', novalidate: true, onSubmit: async (e) => {
      e.preventDefault(); err.replaceChildren(); msg.replaceChildren();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.value.trim())) return email.setError('Enter your email address.');
      setLoading(go, true);
      try {
        if (!ready) {
          const r = await api.post('/v1/portal/reset/start', { email: email.value });
          if (r.state === 'none') err.replaceChildren(Alert('error', 'There’s no login with that email.'));
          else if (r.state === 'waiting') msg.replaceChildren(Alert('info', 'Your manager has been asked.', 'Nothing is emailed. Once they allow it in Totali, come back here, enter your email again and choose a new password.'));
          else { ready = true; pw.el.hidden = false; email.input.readOnly = true; go.firstChild.textContent = 'Save new password'; pw.input.focus(); }
        } else { await api.post('/v1/portal/reset/finish', { email: email.value, password: pw.value }); await done(); return; }
      } catch (e2) { if (e2.details && e2.details.field === 'password') pw.setError(e2.message); else err.replaceChildren(Alert('error', e2.message)); }
      setLoading(go, false);
    } }, email.el, pw.el, msg, err, go);
  }

  const draw = () => {
    err.replaceChildren();
    if (mode === 'reset') {
      card.replaceChildren(h('h1', {}, 'Reset your password'), h('p', {}, 'Before your manager has approved you, you can choose a new one right away. After that, your manager has to allow it first, since nothing is sent to your email.'), reset(),
        h('p', { class: 'fine', style: { marginTop: '18px' } }, h('button', { class: 'link as-button', type: 'button', onClick: () => { mode = 'signin'; draw(); } }, 'Back to sign in')));
      const f = card.querySelector('input'); if (f) f.focus();
      return;
    }
    card.replaceChildren(
      h('h1', {}, mode === 'signup' ? 'Create your login' : 'Welcome back'),
      h('p', {}, mode === 'signup' ? 'Use the code from your manager once to make your account. Then you’ll fill in your details and send them to be approved.' : 'See your pay stubs, hours and tax forms.'),
      mode === 'signup' ? signup() : signin(),
      mode === 'signin' ? h('p', { class: 'fine', style: { marginTop: '14px' } }, h('button', { class: 'link as-button', type: 'button', 'data-testid': 'emp-forgot', onClick: () => { mode = 'reset'; draw(); } }, 'Forgot your password?')) : null,
      h('p', { class: 'fine', style: { marginTop: '18px' } }, mode === 'signup' ? 'Already have a login? ' : 'First time here? ', h('button', { class: 'link as-button', type: 'button', 'data-testid': 'emp-switch', onClick: () => { mode = mode === 'signup' ? 'signin' : 'signup'; draw(); } }, mode === 'signup' ? 'Sign in' : 'Create account')));
    const first = card.querySelector('input'); if (first) first.focus();
  };
  draw();
  return { title: 'Employee sign in | Totali', el: shell(card) };
}

// ---------------------------------------------------------------- the request: your details, on your phone, sent to your manager
const FILING_OPTS = [['single', 'Single or married filing separately'], ['married_joint', 'Married filing jointly'], ['head_of_household', 'Head of household']];
const STATUS = [['citizen', 'A citizen of the United States'], ['noncitizen_national', 'A noncitizen national'], ['permanent_resident', 'A lawful permanent resident'], ['authorized_to_work', 'A noncitizen authorized to work']];

export function joinPage() {
  return async () => {
    const a = await api.get('/v1/portal/account');
    const out = h('button', { class: 'link as-button', type: 'button', 'data-testid': 'emp-sign-out', onClick: async () => { try { await api.post('/v1/portal/logout'); } catch { /* a dead session is fine */ } me.data = null; await refreshPortal(); navigate('/employee'); } }, 'Sign out');
    const frame = (...kids) => ({ title: `Your details | ${a.business}`, el: h('div', {}, h('header', { class: 'eptop ui' }, Logo({ small: true, href: '/' }), h('span', { class: 'co' }, h('span', { class: 'orgmark' }, (a.business[0] || 'T').toUpperCase()), a.business, ' ', out)), h('main', { class: 'empage ui', style: { gridTemplateColumns: 'minmax(0, 560px)', justifyContent: 'center' } }, h('div', { 'data-testid': `join-${a.status}` }, ...kids))) });
    if (a.status === 'pending') return frame(h('h1', { class: 'pt', style: { fontSize: '26px' } }, 'Request sent'), h('p', { class: 'cap', style: { margin: '10px 0 0', maxWidth: '46ch' } }, `${a.business} will look at your details and approve you. You don’t need to do anything else. Come back and sign in with ${a.email} after they have. Your name will be at the top of the Totali page.`), h('div', { class: 'acts', style: { marginTop: '18px' } }, Button({ variant: 'ghost', onClick: () => navigate(location.pathname) }, 'Check again')));
    if (a.status === 'ended') return frame(h('h1', { class: 'pt', style: { fontSize: '26px' } }, 'Your access has ended'), h('p', { class: 'cap', style: { margin: '10px 0 0' } }, `${a.business} has taken you off their team. Your past pay stubs are with them.`));
    if (a.status === 'declined') {
      const again = Button({ type: 'button', 'data-testid': 'emp-reopen' }, 'Fix it and send again');
      again.addEventListener('click', async () => { setLoading(again, true); try { await api.post('/v1/portal/reopen'); navigate(location.pathname); } catch (e) { toast('error', e.message); setLoading(again, false); } });
      return frame(h('h1', { class: 'pt', style: { fontSize: '26px' } }, 'Not approved'), h('p', { class: 'cap', style: { margin: '10px 0 0' } }, a.declineReason ? `${a.business} said: “${a.declineReason}”` : `${a.business} didn’t approve this request.`), h('div', { class: 'acts', style: { marginTop: '18px' } }, again));
    }

    // draft: the whole request on one page
    const first = Field({ label: 'First name', name: 'firstName', autocomplete: 'given-name', autofocus: true });
    const last = Field({ label: 'Last name', name: 'lastName', autocomplete: 'family-name' });
    const filing = Field({ label: 'Filing status', name: 'filingStatus', select: true, value: 'single', options: FILING_OPTS.map(([v, l]) => ({ value: v, label: l })) });
    const multi = h('input', { type: 'checkbox', name: 'multipleJobs' });
    const kids = Field({ label: 'Children under 17', name: 'children', type: 'number', value: '0', min: 0, max: 20 });
    const others = Field({ label: 'Other dependents', name: 'otherDependents', type: 'number', value: '0', min: 0, max: 20 });
    const ex = a.form.stateForm ? Field({ label: `${a.form.stateName} ${a.form.stateForm}: exemptions`, name: 'exemptions', type: 'number', value: '1', min: 0, max: 30 }) : null;
    const dob = Field({ label: 'Date of birth', name: 'dateOfBirth', type: 'date', autocomplete: 'bday' });
    const ssn = Field({ label: 'Social Security number', name: 'ssn', placeholder: '123-45-6789', autocomplete: 'off', inputmode: 'numeric' });
    ssn.input.addEventListener('input', () => { const d = ssn.value.replace(/\D/g, '').slice(0, 9); ssn.value = d.length > 5 ? `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}` : d.length > 3 ? `${d.slice(0, 3)}-${d.slice(3)}` : d; });
    const status = Field({ label: 'I am', name: 'status', select: true, value: 'citizen', options: STATUS.map(([v, l]) => ({ value: v, label: l })) });
    const bank = Field({ label: 'Bank name', name: 'bankName', autocomplete: 'off', optional: true });
    const routing = Field({ label: 'Routing number', name: 'routingNumber', inputmode: 'numeric', maxlength: 9, autocomplete: 'off', hint: '9 digits, on the bottom left of a check.' });
    const account = Field({ label: 'Account number', name: 'accountNumber', inputmode: 'numeric', maxlength: 17, autocomplete: 'off', type: 'password' });
    const acctType = Field({ label: 'Account type', name: 'accountType', select: true, value: 'checking', options: [{ value: 'checking', label: 'Checking' }, { value: 'savings', label: 'Savings' }] });
    const confirm = h('input', { type: 'checkbox', name: 'confirm' });
    const bankBox = h('div', { class: 'f' }, bank.el, h('div', { class: 'r2' }, routing.el, account.el), acctType.el, h('label', { class: 'ck2' }, confirm, h('span', { class: 'cb' }), h('span', { class: 'fine' }, 'These bank details are mine and correct.')));
    const wantBank = h('input', { type: 'checkbox', name: 'wantBank', checked: true });
    wantBank.addEventListener('change', () => { bankBox.hidden = !wantBank.checked; });
    const sig = h('input', { class: 'in sig', name: 'signature', autocomplete: 'off', 'aria-label': 'Type your full name to sign' });
    const err = h('div', {}); const go = Button({ size: 'lg', full: true, type: 'submit', 'data-testid': 'emp-send' }, 'Send request');
    const fields = { firstName: first, lastName: last, signature: { setError: (m) => err.replaceChildren(Alert('error', m)) }, dateOfBirth: dob, ssn, routingNumber: routing, accountNumber: account, accountType: acctType, confirm: { setError: (m) => err.replaceChildren(Alert('error', m)) }, exemptions: ex || undefined, status };
    const sec = (t) => h('div', { class: 'sec2', style: { margin: '10px 0 -6px' } }, t);
    const form = h('form', { class: 'f', novalidate: true, onSubmit: async (e) => {
      e.preventDefault(); err.replaceChildren();
      if (!first.value.trim() || !last.value.trim()) return err.replaceChildren(Alert('error', 'Enter your first and last name.'));
      setLoading(go, true);
      try {
        await api.post('/v1/portal/request', {
          firstName: first.value, lastName: last.value, signature: sig.value,
          w4: { filingStatus: filing.value, multipleJobs: multi.checked, children: Number(kids.value) || 0, otherDependents: Number(others.value) || 0, ...(ex ? { exemptions: Number(ex.value) || 0 } : {}) },
          i9: { legalFirstName: first.value, legalLastName: last.value, dateOfBirth: dob.value, ssn: ssn.value, status: status.value },
          ...(wantBank.checked ? { deposit: { bankName: bank.value, routingNumber: routing.value.replace(/\D/g, ''), accountNumber: account.value.replace(/\D/g, ''), accountType: acctType.value, confirm: confirm.checked } } : {}),
        });
        navigate(location.pathname); return;
      } catch (e2) { const t = fields[e2.details && e2.details.field]; if (t) t.setError(e2.message); else err.replaceChildren(Alert('error', e2.message)); if (t && t.el) t.el.scrollIntoView({ block: 'center' }); }
      setLoading(go, false);
    } },
      sec('About you'), h('div', { class: 'r2' }, first.el, last.el),
      sec('Your W-4 (tax withholding)'), filing.el, h('label', { class: 'ck2' }, multi, h('span', { class: 'cb' }), h('span', { class: 'fine' }, 'I have more than one job, or my spouse works.')), h('div', { class: 'r2' }, kids.el, others.el), ex ? ex.el : null,
      sec('Your I-9 (work eligibility)'), h('div', { class: 'r2' }, dob.el, ssn.el), status.el,
      sec('Direct deposit'), h('label', { class: 'ck2' }, wantBank, h('span', { class: 'cb' }), h('span', { class: 'fine' }, 'Add my bank account now. All of my pay goes there.')), bankBox,
      sec('Sign'), sig, h('p', { class: 'help' }, `Type your full name. By signing you say this is correct to the best of your knowledge. Section 2 of the I-9 is done in person with your manager, so bring your ID on your first day.`), err, go);
    return frame(h('p', { class: 'cap', style: { marginBottom: '6px' } }, `Hi. You’re joining ${a.business}.`), h('h1', { class: 'pt', style: { fontSize: '26px' } }, 'Your details'), h('p', { class: 'cap', style: { margin: '6px 0 20px' } }, 'About five minutes. When you send this, your manager checks it and approves you. Nothing is saved until you send.'), form);
  };
}

// ---------------------------------------------------------------- the frame every employee page sits in
async function page(ctx, { active, title, render }) {
  const d = await load();
  if (!d) { const p = await refreshPortal(); navigate(p ? '/me/join' : '/employee', { replace: true }); return { title: 'Sign in', el: h('div') }; }
  const root = h('div', { class: 'dash emp' });
  applyTheme(root, d.theme, d.brand);
  const tabs = [['/me', 'Home', 'home'], ['/me/stubs', 'Pay stubs', 'stubs'], ['/me/hours', 'Hours', 'hours'], ['/me/details', 'My details', 'details']];
  const out = async () => { try { await api.post('/v1/portal/logout'); } catch { /* signing out of a dead session is fine */ } me.data = null; await refreshPortal(); navigate('/employee'); };
  const nav = h('header', { class: 'nav ui' }, Logo({ small: true, href: '/me' }), h('span', { class: 'org' }, h('span', { class: 'orgmark' }, (d.brand.name[0] || 'T').toUpperCase()), h('b', {}, d.brand.name)),
    h('nav', { class: 'tabs', 'aria-label': 'Your pages' }, ...tabs.map(([to, label, id]) => link(to, { class: id === active ? 'on' : '', 'aria-current': id === active ? 'page' : undefined, 'data-tab': id }, label))),
    h('span', { class: 'rt2' }, h('span', { class: 'who-name' }, d.employee.firstName), h('button', { class: 'signout', type: 'button', 'data-testid': 'emp-sign-out', onClick: out }, 'Sign out')));
  const main = h('main', { class: 'dash-main wrap ui' });
  root.append(h('div', { class: 'dash-frame' }, nav, h('div', {}, main)));
  main.append(await render(d));
  return { title: `${title} | ${d.brand.name}`, el: root };
}

const head = (title, sub) => h('div', { class: 'ph2' }, h('div', {}, h('h1', { class: 'pt' }, ...title), sub ? h('p', {}, sub) : null));
const stat = (l, v, s) => h('div', {}, h('i', {}, l), h('b', {}, v), s ? h('small', {}, s) : null);

// ---------------------------------------------------------------- home
export function homePage() {
  return (ctx) => page(ctx, { active: 'home', title: 'Home', render: async (d) => {
    const hr = new Date().getHours();
    const week = await weekFor(d.today);
    const stubs = d.latest;
    const todo = [];
    if (!d.forms.w4) todo.push(['Fill in your W-4', 'Your employer can’t work out your taxes without it.', '/me/details']);
    if (d.deposit.pending) todo.push(['Bank change waiting', `Your employer hasn’t approved the account ending ${d.deposit.pending.last4} yet.`, '/me/details']);
    else if (!d.forms.deposit) todo.push(['Add your direct deposit', 'So your pay reaches your bank.', '/me/details']);
    if (d.forms.i9 !== 'done') todo.push(['Finish your I-9', d.forms.i9 === 'section1' ? 'Your manager does section 2 in person. Bring your ID.' : 'Ask your manager for the link.', '/me/details']);
    return h('div', {},
      head([`${hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening'}, `, h('em', {}, d.employee.firstName)], `${d.employee.role}${d.employee.location ? ` · ${d.employee.location}` : ''}`),
      todo.length ? h('div', { class: 'card', style: { marginBottom: '18px' } }, h('h3', { class: 'ct', style: { marginBottom: '6px' } }, 'To do'), ...todo.map(([t, s, to]) => h('div', { class: 'row' }, h('span', { class: 'l1' }, h('b', {}, t), h('i', {}, s)), link(to, { class: 'link' }, 'Open')))) : null,
      h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' } },
        h('div', { class: 'card' }, h('div', { class: 'ch' }, h('h3', { class: 'ct' }, 'Next pay day')), h('div', { class: 'big2' }, h('div', {}, h('i', {}, longDate(d.nextPay.checkDate)), h('span', { class: 'n' }, statusLine(d.nextPay.daysUntil)))), h('p', { class: 'cap' }, `For ${rangeText(d.nextPay.periodStart, d.nextPay.periodEnd)}. ${FREQ[d.company.schedule]}.`)),
        h('div', { class: 'card' }, h('div', { class: 'ch' }, h('h3', { class: 'ct' }, 'Latest pay stub'), stubs ? link(`/me/stubs/${stubs.runId}`, { class: 'link' }, 'Open') : null),
          stubs ? h('div', {}, h('div', { class: 'big2' }, h('div', {}, h('i', {}, `Paid ${longDate(stubs.checkDate)}`), h('span', { class: 'n' }, money(stubs.netCents)))), h('p', { class: 'cap' }, `${stubs.hours} hours · ${money(stubs.grossCents)} before taxes`)) : h('p', { class: 'cap' }, 'Your first pay stub shows up here after your first pay day.')),
        h('div', { class: 'card' }, h('div', { class: 'ch' }, h('h3', { class: 'ct' }, 'This week'), link('/me/hours', { class: 'link' }, 'Details')), h('div', { class: 'big2' }, h('div', {}, h('i', {}, 'Hours so far'), h('span', { class: 'n' }, hoursFromMinutes(week.totalMinutes) || '0'))), week.tipsCents ? h('p', { class: 'cap' }, `${money(week.tipsCents)} in tips`) : h('p', { class: 'cap' }, 'Your hours show up as your manager enters them.'))),
      h('div', { style: { margin: '18px 0' } }, h('div', { class: 'stats' }, stat(`Gross pay, ${d.today.slice(0, 4)}`, money(d.ytd.grossCents)), stat('Taxes withheld', money(d.ytd.taxCents)), stat('Take-home', money(d.ytd.netCents)), stat('Hours paid', String(Math.round(d.ytd.hours * 100) / 100)))),
      h('p', { class: 'cap', style: { maxWidth: '64ch' } }, 'Pay and hours come from your employer. If something looks wrong, tell your manager: only they can change it.'));
  } });
}

async function weekFor(today) {
  const dt = new Date(`${today}T12:00:00Z`); const dow = (dt.getUTCDay() + 6) % 7; // week starts Monday here; the employer's own workweek is on your stubs
  const start = new Date(dt.getTime() - dow * 864e5).toISOString().slice(0, 10); const end = new Date(dt.getTime() + (6 - dow) * 864e5).toISOString().slice(0, 10);
  return api.get(`/v1/portal/hours?start=${start}&end=${end}`);
}

// ---------------------------------------------------------------- pay stubs
export function stubsPage() {
  return (ctx) => page(ctx, { active: 'stubs', title: 'Pay stubs', render: async (d) => {
    const { stubs } = await api.get('/v1/portal/stubs');
    return h('div', {}, head(['Pay ', h('em', {}, 'stubs')], 'Every paycheck, with how it was worked out'),
      h('div', { class: 'card' }, stubs.length ? h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, h('th', {}, 'Pay date'), h('th', { class: 'l hm' }, 'Period'), h('th', { class: 'hm' }, 'Hours'), h('th', { class: 'hm' }, 'Gross'), h('th', { class: 'hm' }, 'Taxes'), h('th', {}, 'Take-home'))),
        h('tbody', {}, ...stubs.map((s) => h('tr', { 'data-run': s.runId }, h('td', {}, link(`/me/stubs/${s.runId}`, { class: 'link' }, longDate(s.checkDate))), h('td', { class: 'l hm' }, rangeText(s.periodStart, s.periodEnd)), h('td', { class: 'hm' }, String(s.hours)), h('td', { class: 'hm' }, money(s.grossCents)), h('td', { class: 'hm' }, money(s.taxCents)), h('td', {}, h('b', {}, money(s.netCents))))))) : h('div', { class: 'empty' }, 'No pay stubs yet. They appear here once your employer runs payroll.')));
  } });
}

export function stubPage() {
  return (ctx) => page(ctx, { active: 'stubs', title: 'Pay stub', render: async (d) => {
    let r;
    try { r = await api.get(`/v1/portal/stubs/${encodeURIComponent(ctx.params.rid)}`); } catch { navigate('/me/stubs', { replace: true }); return h('div'); }
    const l = r.line; const rl = (a, b, c = '') => h('div', { class: `rl ${c}` }, h('span', {}, a), h('span', {}, b));
    const wages = r.earnings.filter((e) => !/^TIPS|^SVC/.test(e.code)); const tips = r.earnings.filter((e) => /^TIPS|^SVC/.test(e.code)).reduce((n, e) => n + e.amountCents, 0);
    const fica = r.taxLines.filter((t) => /^US_(SS|MED)_EE$/.test(t.id)).reduce((n, t) => n + t.amountCents, 0);
    const calr = (t, why, amt, accent) => h('div', { class: 'calr' }, h('span', {}, h('b', {}, t), why ? h('i', {}, why) : null), amt === undefined ? h('span') : h('b', accent ? { style: { color: 'var(--berry)' } } : {}, money(amt)));
    return h('div', {}, head(['Pay ', h('em', {}, 'stub')], `Paid ${longDate(l.checkDate)} · ${rangeText(l.periodStart, l.periodEnd)}`),
      h('div', { class: 'stubwrap' }, h('div', { style: { position: 'relative' } }, h('div', { class: 'receipt' },
        h('div', { class: 'rh' }, h('b', {}, d.brand.name), h('span', {}, `Pay stub · ${d.employee.firstName} ${d.employee.lastName} · ${d.employee.role}`)),
        rl('Period', rangeText(l.periodStart, l.periodEnd)), rl('Pay date', longDate(l.checkDate)), h('hr'),
        ...wages.map((e) => rl(e.detail || e.code, money(e.amountCents))), tips ? rl('Tips', money(tips), 'circle') : null, rl('Gross pay', money(l.grossCents), 't'), h('hr'),
        ...r.taxLines.map((t) => rl(t.name, money(t.amountCents))), rl('Total taxes', money(l.taxCents), 't'), h('hr'), rl('Net pay', money(l.netCents), 'big'),
        h('div', { class: 'rf' }, 'Taxes calculated by the Omnia.tax engine.'))),
      h('div', {}, h('h2', { class: 'st2' }, 'How your check was ', h('em', {}, 'worked out')),
        h('div', { class: 'cal' }, calr(`Gross ${money(l.grossCents)}`, `${l.hours} hours${tips ? `, plus ${money(tips)} in tips. Tips count as pay for tax.` : '.'}`),
          ...r.taxLines.filter((t) => t.id === 'US_FIT').map((t) => calr(t.name, 'Worked out from your W-4.', t.amountCents)), fica ? calr('Social Security and Medicare', '6.2% and 1.45% of gross.', fica) : null,
          ...r.taxLines.filter((t) => !/^US_(FIT|SS_EE|MED_EE)$/.test(t.id)).map((t) => calr(t.name, t.jurisdiction === 'state' ? 'From your state’s rules and your state form.' : 'From where you live and work.', t.amountCents)), calr('Take-home pay', 'What’s left after taxes.', l.netCents, true)),
        h('div', { class: 'acts', style: { marginTop: '18px' } }, Button({ variant: 'ghost', size: 'sm', type: 'button', onClick: () => window.print() }, 'Print or save as PDF'), link('/me/stubs', { class: 'link' }, 'All pay stubs')))), h('p', { class: 'cap', style: { marginTop: '14px' } }, `Questions about this stub? Talk to your manager at ${d.brand.name}.`));
  } });
}

// ---------------------------------------------------------------- hours
export function hoursPage() {
  return (ctx) => page(ctx, { active: 'hours', title: 'Hours', render: async (d) => {
    let offset = 0; const host = h('div', {});
    const addDays = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
    const dt = new Date(`${d.today}T12:00:00Z`); const monday = addDays(d.today, -((dt.getUTCDay() + 6) % 7));
    const draw = async () => {
      const from = addDays(monday, offset * 7); const to = addDays(from, 6);
      const r = await api.get(`/v1/portal/hours?start=${from}&end=${to}`);
      host.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'ch' }, h('h3', { class: 'ct' }, offset === 0 ? 'This week' : 'Week'), h('span', { style: { display: 'flex', gap: '10px', alignItems: 'center' } }, h('span', { class: 'cap' }, `${shortDate(from)} to ${shortDate(to)}`), Button({ variant: 'ghost', size: 'sm', type: 'button', 'data-testid': 'prev', onClick: () => { offset -= 1; draw(); } }, 'Earlier'), Button({ variant: 'ghost', size: 'sm', type: 'button', disabled: offset >= 0, onClick: () => { offset += 1; draw(); } }, 'Later'))),
        h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, h('th', { class: 'l' }, 'Day'), h('th', {}, 'Hours'), h('th', {}, 'Tips'), h('th', { class: 'l' }, ''))), h('tbody', {}, ...r.days.map((x) => h('tr', {}, h('td', { class: 'l' }, new Date(`${x.date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' })), h('td', {}, x.minutes ? hoursFromMinutes(x.minutes) : h('span', { class: 'mut' }, '–')), h('td', {}, x.tipsCents ? money(x.tipsCents) : h('span', { class: 'mut' }, '–')), h('td', { class: 'l' }, x.paid ? Chip('Paid', 'ok') : null))), h('tr', { class: 'tot' }, h('td', { class: 'l' }, 'Total'), h('td', {}, hoursFromMinutes(r.totalMinutes) || '0'), h('td', {}, r.tipsCents ? money(r.tipsCents) : '–'), h('td')))),
        h('p', { class: 'cap', style: { marginTop: '10px' } }, 'Your manager enters these. If a day is wrong, tell them before pay day.')));
    };
    await draw();
    return h('div', {}, head(['Your ', h('em', {}, 'hours')], 'Day by day, with tips'), host);
  } });
}

// ---------------------------------------------------------------- my details: W-4, deposit, the rest
const FILING = { single: 'Single or married filing separately', married_joint: 'Married filing jointly', head_of_household: 'Head of household' };
export function detailsPage() {
  return (ctx) => page(ctx, { active: 'details', title: 'My details', render: async (d) => {
    const w4 = await api.get('/v1/portal/w4');
    const redraw = async () => { await load(true); navigate(location.pathname); };
    const kv = (...p) => h('dl', { class: 'kv' }, ...p.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));

    function w4Modal() {
      let filing = w4.filingStatus; let multi = w4.multipleJobs;
      const kids = Field({ label: 'Children under 17', name: 'children', type: 'number', value: String(Math.floor(w4.dependentCredit / 200_000)), min: 0, max: 20 });
      const others = Field({ label: 'Other dependents', name: 'otherDependents', type: 'number', value: String(Math.round((w4.dependentCredit % 200_000) / 50_000)), min: 0, max: 20 });
      const extra = Field({ label: 'Extra tax to withhold each pay (optional)', name: 'extra', value: w4.extraWithholdingCents ? (w4.extraWithholdingCents / 100).toFixed(2) : '', inputmode: 'decimal' });
      const ex = w4.stateForm ? Field({ label: `${w4.stateForm} exemptions`, name: 'exemptions', type: 'number', value: String(w4.exemptions ?? 1), min: 0, max: 30 }) : null;
      const sig = h('input', { class: 'in sig', name: 'signature', placeholder: `${d.employee.firstName} ${d.employee.lastName}`, autocomplete: 'off', 'aria-label': 'Type your full name to sign' });
      const opts = (list, sel, on, label) => { const w = h('div', { class: 'opts', role: 'radiogroup', 'aria-label': label }); const dr = (s) => w.replaceChildren(...list.map(([v, t]) => h('button', { type: 'button', class: `opt ${s === v ? 'on' : ''}`, role: 'radio', 'aria-checked': String(s === v), 'data-value': v, onClick: () => { on(v); dr(v); } }, h('span', { class: 'rd' }), t))); dr(sel); return w; };
      const err = h('div', {}); const go = Button({}, 'Save my W-4');
      const m = modal({ title: 'Update your W-4', body: h('div', { class: 'f' }, h('p', { class: 'fine', style: { margin: 0 } }, 'This applies to pay runs your employer starts after you save it.'), h('div', {}, h('label', { class: 'lab' }, 'Filing status'), opts(Object.entries(FILING), filing, (v) => { filing = v; }, 'Filing status')), h('div', {}, h('label', { class: 'lab' }, 'More than one job?'), opts([['no', 'No, just this one'], ['yes', 'Yes']], multi ? 'yes' : 'no', (v) => { multi = v === 'yes'; }, 'More than one job')), h('div', { class: 'r2' }, kids.el, others.el), extra.el, ex ? ex.el : null, h('div', {}, h('label', { class: 'lab' }, 'Sign'), sig), err), actions: [Button({ variant: 'ghost', onClick: () => m.close() }, 'Cancel'), go] });
      go.addEventListener('click', async () => {
        err.replaceChildren();
        const extraCents = extra.value.trim() ? Math.round(Number(extra.value.replace(/[$,]/g, '')) * 100) : 0;
        if (!Number.isFinite(extraCents) || extraCents < 0) return extra.setError('Enter dollars, like 25.00.');
        setLoading(go, true);
        try { await api.put('/v1/portal/w4', { filingStatus: filing, multipleJobs: multi, children: Number(kids.value) || 0, otherDependents: Number(others.value) || 0, extraWithholdingCents: extraCents, ...(ex ? { exemptions: Number(ex.value) || 0 } : {}), signature: sig.value }); m.close(); toast('success', 'Saved. It applies from your next pay run.'); redraw(); }
        catch (e) { err.replaceChildren(Alert('error', e.message)); setLoading(go, false); }
      });
    }

    function depositModal() {
      let type = 'checking';
      const bank = Field({ label: 'Bank name', name: 'bankName', autocomplete: 'off' });
      const routing = Field({ label: 'Routing number', name: 'routingNumber', inputmode: 'numeric', maxlength: 9, autocomplete: 'off', hint: '9 digits, bottom left of a check.' });
      const account = Field({ label: 'Account number', name: 'accountNumber', inputmode: 'numeric', maxlength: 17, autocomplete: 'off', type: 'password' });
      const confirm = h('input', { type: 'checkbox', name: 'confirm' });
      const types = h('div', { class: 'opts c2', role: 'radiogroup', 'aria-label': 'Account type' }); const dt = () => types.replaceChildren(...[['checking', 'Checking'], ['savings', 'Savings']].map(([v, t]) => h('button', { type: 'button', class: `opt ${type === v ? 'on' : ''}`, role: 'radio', 'aria-checked': String(type === v), 'data-value': v, onClick: () => { type = v; dt(); } }, h('span', { class: 'rd' }), t))); dt();
      const err = h('div', {}); const go = Button({}, 'Send for approval');
      const m = modal({ title: 'Change your direct deposit', body: h('div', { class: 'f' }, h('p', { class: 'fine', style: { margin: 0 } }, 'Your employer has to approve a new account before your pay goes there. Until then, your current account keeps being used.'), bank.el, h('div', { class: 'r2' }, routing.el, account.el), types, h('label', { class: 'ck2' }, confirm, h('span', { class: 'cb' }), h('span', { class: 'fine' }, 'I confirm these details are mine and correct.')), err), actions: [Button({ variant: 'ghost', onClick: () => m.close() }, 'Cancel'), go] });
      go.addEventListener('click', async () => {
        err.replaceChildren(); setLoading(go, true);
        try { await api.post('/v1/portal/deposit', { bankName: bank.value, routingNumber: routing.value.replace(/\D/g, ''), accountNumber: account.value.replace(/\D/g, ''), accountType: type, confirm: confirm.checked }); m.close(); toast('success', 'Sent to your employer for approval.'); redraw(); }
        catch (e) { err.replaceChildren(Alert('error', e.message)); setLoading(go, false); }
      });
    }

    const dep = d.deposit;
    return h('div', {}, head(['My ', h('em', {}, 'details')], 'Your job, your tax forms and where your pay goes'),
      h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' } },
        h('div', { class: 'card' }, h('h3', { class: 'ct', style: { marginBottom: '12px' } }, 'Your job'), kv(['Role', d.employee.role], [d.employee.pay.kind === 'hourly' ? 'Hourly rate' : 'Salary', d.employee.pay.kind === 'hourly' ? money(d.employee.pay.cents) : `${money(d.employee.pay.cents)}/yr`], ['Location', d.employee.location || '—'], ['Started', longDate(d.employee.hireDate)], ['Email', d.employee.email]), h('p', { class: 'cap', style: { marginTop: '10px' } }, 'To change any of this, ask your manager.')),
        h('div', { class: 'card' }, h('div', { class: 'ch' }, h('h3', { class: 'ct' }, 'Tax withholding'), d.forms.w4 ? Chip('On file', 'ok') : Chip('Needed', 'warn')), kv(['Filing status', FILING[w4.filingStatus] || w4.filingStatus], ['More than one job', w4.multipleJobs ? 'Yes' : 'No'], ['Extra withholding', w4.extraWithholdingCents ? money(w4.extraWithholdingCents) : 'None'], ...(w4.stateForm ? [[`${d.company.state} ${w4.stateForm}`, w4.exemptions === null ? 'Not filled in' : plural(w4.exemptions, 'exemption')]] : [])), h('div', { class: 'acts', style: { marginTop: '14px' } }, Button({ variant: 'ghost', size: 'sm', 'data-testid': 'update-w4', onClick: w4Modal }, d.forms.w4 ? 'Update my W-4' : 'Fill in my W-4'))),
        h('div', { class: 'card' }, h('div', { class: 'ch' }, h('h3', { class: 'ct' }, 'Direct deposit'), dep.last4 ? Chip('Set up', 'ok') : Chip('Needed', 'warn')),
          kv(['Account', dep.last4 ? `${dep.bank ? `${dep.bank}, ` : ''}ending ${dep.last4}` : 'None yet']),
          dep.pending ? h('div', { class: 'alert', style: { marginTop: '12px' } }, h('span', { class: 'dot' }), h('span', {}, `Waiting for your employer to approve the account ending ${dep.pending.last4}. `, h('button', { class: 'link as-button', type: 'button', onClick: async () => { try { await api.del('/v1/portal/deposit'); toast('success', 'Request cancelled.'); redraw(); } catch (e) { toast('error', e.message); } } }, 'Cancel it'))) : h('div', { class: 'acts', style: { marginTop: '14px' } }, Button({ variant: 'ghost', size: 'sm', 'data-testid': 'change-deposit', onClick: depositModal }, dep.last4 ? 'Change my account' : 'Add my account'))),
        h('div', { class: 'card' }, h('h3', { class: 'ct', style: { marginBottom: '6px' } }, 'Paperwork'),
          h('div', { class: 'row' }, h('span', { class: 'l1' }, h('b', {}, 'W-4')), h('span', { class: `dt ${d.forms.w4 ? 'ok' : 'no'}` }, d.forms.w4 ? 'On file' : 'Missing')),
          h('div', { class: 'row' }, h('span', { class: 'l1' }, h('b', {}, 'I-9'), h('i', {}, d.forms.i9 === 'done' ? 'Both sections done' : d.forms.i9 === 'section1' ? 'Your manager does section 2' : 'Not started')), h('span', { class: `dt ${d.forms.i9 === 'done' ? 'ok' : 'no'}` }, d.forms.i9 === 'done' ? 'On file' : 'To do')),
          h('div', { class: 'row' }, h('span', { class: 'l1' }, h('b', {}, 'Direct deposit')), h('span', { class: `dt ${d.forms.deposit ? 'ok' : 'no'}` }, d.forms.deposit ? 'On file' : 'Missing')))));
  } });
}
