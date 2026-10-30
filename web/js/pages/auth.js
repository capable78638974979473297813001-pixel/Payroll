import { h } from '../dom.js';
import { api } from '../api.js';
import { link, navigate } from '../router.js';
import { Button, Checkbox, CodeBoxes, Field, Logo, PasswordRule, ProgressSteps, Alert, modal, setLoading, toast, icon } from '../ui.js';
import { refreshUser, session } from '../session.js';

const STEPS = ['Account', 'Verify', 'Your business'];
const MIN_PASSWORD = 10;

/** Where a person goes next, given how far they have got. */
export function nextPath(user) {
  if (!user) return '/';
  if (!user.emailVerified) return '/signup/verify';
  if (!user.companyId) return '/setup/industry';
  return '/app';
}

function shell({ step, panel, children, title, lead, email }) {
  return h('div', { class: 'ob' },
    h('aside', { class: 'ob-panel' },
      h('div', { class: 'ob-top' }, Logo({ scheme: 'on-blue' }), h('span', { class: 'micro' }, 'Onboarding')),
      h('div', { class: 'ob-numeral' }, h('span', { class: 'n' }, String(step + 1).padStart(2, '0')), h('span', { class: 'of' }, h('span', { class: 'eyebrow' }, 'Step'), h('span', { class: 'eyebrow' }, `of ${String(STEPS.length).padStart(2, '0')}`))),
      h('hr', { class: 'rule-w' }),
      panel),
    h('main', { class: 'ob-form' }, h('div', { class: 'inner' },
      h('div', { class: 'ob-meta' }, h('span', {}, `Step ${String(step + 1).padStart(2, '0')} of ${String(STEPS.length).padStart(2, '0')}`), email ? h('span', { class: 'muted', style: { textTransform: 'none', letterSpacing: 0, fontWeight: 400, fontSize: '14px', fontFamily: 'var(--font-sans)' } }, email) : null),
      ProgressSteps(STEPS, step),
      h('h1', { class: 't-heading-lg' }, title),
      lead ? h('p', { class: 't-lead' }, lead) : null,
      children)));
}

const panelRows = (head, rows, foot) => h('div', {},
  h('div', { class: 'ob-panel-head' }, h('span', { class: 'label-mono' }, head[0]), h('span', { class: 'label-mono muted-on' }, head[1])),
  h('div', { class: 'ob-rows' }, ...rows.map(([k, v]) => h('div', {}, h('span', {}, k), h('span', { class: 'v' }, v)))),
  foot);

// ---------------------------------------------------------------- B01: create account
export function signup() {
  const first = Field({ label: 'First name', name: 'firstName', autocomplete: 'given-name', autofocus: true });
  const last = Field({ label: 'Last name', name: 'lastName', autocomplete: 'family-name' });
  const biz = Field({ label: 'Business name', name: 'businessName', placeholder: 'Harbor Street Kitchen', autocomplete: 'organization' });
  const email = Field({ label: 'Work email', name: 'email', type: 'email', placeholder: 'you@company.com', autocomplete: 'email' });
  const rules = h('div', { class: 'pw-rules' });
  const drawRules = (pw) => rules.replaceChildren(PasswordRule(`${MIN_PASSWORD}+ characters`, pw.length >= MIN_PASSWORD));
  const pw = Field({ label: 'Password', name: 'password', type: 'password', autocomplete: 'new-password', rightSlot: 'Show', onInput: (v) => { drawRules(v); update(); } });
  drawRules('');
  const terms = Checkbox({ label: h('span', {}, 'I agree to the ', h('a', { href: '/terms', target: '_blank', rel: 'noopener' }, 'Terms'), ' and ', h('a', { href: '/privacy', target: '_blank', rel: 'noopener' }, 'Privacy Policy'), ' of OMNIA TAX LLC.'), name: 'terms', onChange: () => update() });
  const formError = h('div', { class: 'stack' });
  const submit = Button({ variant: 'primary', full: true, arrow: true, type: 'submit', disabled: true }, 'Create account');
  const valid = () => first.value.trim() && last.value.trim() && biz.value.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.value.trim()) && pw.value.length >= MIN_PASSWORD && terms.checked;
  function update() { submit.disabled = !valid(); }
  for (const f of [first, last, biz, email]) f.input.addEventListener('input', update);

  const google = h('button', { class: 'btn btn-secondary btn-full', type: 'button', disabled: !(session.config && session.config.google), title: session.config && session.config.google ? '' : 'Google sign-in isn’t set up on this server yet.', onClick: () => { window.location.href = '/v1/auth/google'; } }, 'Continue with Google');

  const form = h('form', { novalidate: true, onSubmit: async (e) => {
    e.preventDefault();
    if (!valid()) return;
    formError.replaceChildren();
    setLoading(submit, true);
    try {
      const r = await api.post('/v1/auth/signup', { firstName: first.value, lastName: last.value, businessName: biz.value, email: email.value, password: pw.value, acceptTerms: terms.checked });
      session.user = r.user;
      sessionStorage.setItem('totali.verification', JSON.stringify({ ...r.verification, at: Date.now() }));
      navigate('/signup/verify');
    } catch (err) {
      const field = err.details && err.details.field;
      const target = { firstName: first, lastName: last, businessName: biz, email, password: pw }[field];
      if (target) target.setError(err.message);
      else formError.replaceChildren(Alert('error', err.message, err.code === 'account_exists' ? 'You can log in with that email.' : undefined));
      setLoading(submit, false);
      update();
    }
  } },
  google,
  h('div', { class: 'row', style: { gap: '16px', color: 'var(--color-gray)' } }, h('hr', { class: 'rule', style: { flex: 1 } }), h('span', { class: 't-small' }, 'or use email'), h('hr', { class: 'rule', style: { flex: 1 } })),
  h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' } }, first.el, last.el),
  biz.el, email.el, h('div', {}, pw.el, rules), terms.el, formError, submit,
  h('div', { class: 'ob-links' }, h('span', {}, 'Already have an account?'), link('/login', { class: 'btn btn-text btn-sm' }, 'Log in')),
  h('p', { class: 't-caption muted', style: { margin: 0 } }, 'Signup takes about five minutes and saves as you go.'));

  const panel = panelRows(['What you get', 'Totali'], [['Setup', 'Built for you'], ['Dashboard', 'Fully yours'], ['Taxes', 'Omnia.tax engine'], ['Paying your team', 'At your bank']],
    h('div', { style: { marginTop: '40px' } }, h('div', { class: 'rule-w', style: { margin: '0 0 16px' } }), h('p', { class: 'label-mono' }, 'Price'), h('p', { class: 't-heading-sm', style: { margin: '8px 0 0' } }, 'Simple per-employee pricing'), h('p', { class: 't-small muted-on', style: { margin: '8px 0 0' } }, 'Nothing to pay yet.')));
  return { title: 'Create account — Totali', el: shell({ step: 0, panel, title: 'Create your account.', lead: 'A few questions about you and your business. Then we build your dashboard.', children: form }) };
}

// ---------------------------------------------------------------- B02: verify email
export async function verify() {
  const user = session.user;
  let state = {};
  try { state = JSON.parse(sessionStorage.getItem('totali.verification') || '{}'); } catch { /* none */ }
  const email = user.email;
  const expiryMinutes = 15;
  const codeBoxes = CodeBoxes({ onChange: () => { submit.disabled = codeBoxes.value().length !== 6; } });
  const errorLine = h('div', { class: 'field-error', role: 'alert', hidden: true });
  const info = h('div', { class: 'stack', style: { '--gap': '8px' } });
  const submit = Button({ variant: 'primary', full: true, arrow: true, type: 'submit', disabled: true }, 'Verify');

  // Resend countdown. The server decides the gap; we only count it down.
  const resendAt = state.at && state.resendAfterSeconds ? state.at + state.resendAfterSeconds * 1000 : 0;
  const chip = h('span', { style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: '48px', height: '24px', padding: '0 8px', background: 'var(--color-ink)', color: '#fff', fontFamily: 'var(--font-mono)', fontSize: '13px', fontWeight: 700 } });
  const resendBtn = h('button', { class: 'btn btn-text', type: 'button', style: { fontSize: '16px' } }, 'Resend code');
  const resendRow = h('div', { class: 'row', style: { gap: '8px', marginTop: '32px' } });
  let timer;
  function tick() {
    const left = Math.max(0, Math.ceil((resendAt - Date.now()) / 1000));
    if (left > 0) {
      resendBtn.disabled = true;
      chip.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      resendRow.replaceChildren(resendBtn, h('span', { class: 'muted' }, 'in'), chip);
    } else {
      clearInterval(timer);
      resendBtn.disabled = false;
      resendRow.replaceChildren(resendBtn);
    }
  }
  function startCountdown(seconds) {
    state.at = Date.now(); state.resendAfterSeconds = seconds;
    sessionStorage.setItem('totali.verification', JSON.stringify(state));
    clearInterval(timer);
    const end = Date.now() + seconds * 1000;
    const draw = () => {
      const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      if (left > 0) { resendBtn.disabled = true; chip.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`; resendRow.replaceChildren(resendBtn, h('span', { class: 'muted' }, 'in'), chip); }
      else { clearInterval(timer); resendBtn.disabled = false; resendRow.replaceChildren(resendBtn); }
    };
    draw(); timer = setInterval(draw, 500);
  }
  tick(); if (resendAt > Date.now()) timer = setInterval(tick, 500); else { resendBtn.disabled = false; resendRow.replaceChildren(resendBtn); }

  async function devHint() {
    info.replaceChildren();
    if (state.mailer === 'outbox' || (session.config && session.config.mail === 'outbox')) {
      info.append(Alert('warn', 'Email isn’t set up on this server, so no code was sent.', session.config.devTools ? undefined : 'An administrator needs to set RESEND_API_KEY.'));
      if (session.config.devTools) {
        try {
          const box = await api.get('/v1/dev/outbox');
          const msg = [...box.messages].reverse().find((m) => m.to === email);
          const code = msg && /\b(\d{6})\b/.exec(msg.text);
          if (code) info.append(h('div', { class: 'alert info', 'data-testid': 'dev-code' }, h('div', { class: 'alert-body' }, 'Development only: your code is ', h('span', { class: 'mono', style: { fontWeight: 700 } }, code[1]))));
        } catch { /* no outbox */ }
      }
    } else if (state.sent === false && state.reason) {
      info.append(Alert('error', 'We couldn’t send the code.', 'Try again in a minute.'));
    }
  }
  devHint();

  resendBtn.addEventListener('click', async () => {
    resendBtn.disabled = true;
    try {
      const r = await api.post('/v1/auth/resend');
      state = { ...state, ...r.verification, at: Date.now() };
      startCountdown(r.verification.resendAfterSeconds);
      codeBoxes.setError(false); errorLine.hidden = true; codeBoxes.clear();
      toast('success', 'A new code is on its way.');
      devHint();
    } catch (err) {
      resendBtn.disabled = false;
      if (err.details && err.details.retryAfterSeconds) startCountdown(err.details.retryAfterSeconds);
      toast('error', err.code === 'resend_too_soon' ? err.message : 'We couldn’t send the code. Try again in a minute.');
    }
  });

  async function doVerify() {
    if (codeBoxes.value().length !== 6) return;
    errorLine.hidden = true; codeBoxes.setError(false);
    setLoading(submit, true);
    try {
      await api.post('/v1/auth/verify', { code: codeBoxes.value() });
      await refreshUser();
      sessionStorage.removeItem('totali.verification');
      navigate(nextPath(session.user));
    } catch (err) {
      codeBoxes.setError(true);
      errorLine.textContent = err.message; errorLine.hidden = false;
      setLoading(submit, false);
      submit.disabled = true;
      if (err.details && err.details.attemptsLeft === 0) resendBtn.focus();
    }
  }

  const changeBtn = h('button', { class: 'btn btn-text', type: 'button', onClick: () => {
    const f = Field({ label: 'Work email', name: 'email', type: 'email', value: email, autocomplete: 'email', autofocus: true });
    const save = Button({ variant: 'primary' }, 'Send a new code');
    const m = modal({ title: 'Change your email', body: h('div', { class: 'stack' }, h('p', { class: 'muted', style: { margin: 0 } }, 'We’ll send a new code to the new address. The old one stops working.'), f.el), actions: [Button({ variant: 'secondary', onClick: () => m.close() }, 'Cancel'), save] });
    save.addEventListener('click', async () => {
      setLoading(save, true);
      try {
        const r = await api.post('/v1/auth/change-email', { email: f.value });
        session.user = r.user; state = { ...r.verification, at: Date.now() };
        sessionStorage.setItem('totali.verification', JSON.stringify(state));
        m.close();
        navigate('/signup/verify');
        location.reload();
      } catch (err) { f.setError(err.message); setLoading(save, false); }
    });
  } }, 'Change it');

  const form = h('form', { novalidate: true, onSubmit: (e) => { e.preventDefault(); doVerify(); } },
    h('div', { style: { marginTop: '0' } }, h('span', { class: 'field-label', style: { display: 'block', fontSize: '13px', fontWeight: 700, marginBottom: '8px' } }, 'Verification code'), codeBoxes.el, errorLine),
    info, submit, resendRow,
    h('div', { class: 'ob-links', style: { marginTop: '40px' } }, h('span', {}, 'Wrong email?'), changeBtn));
  codeBoxes.el.addEventListener('input', () => { errorLine.hidden = true; codeBoxes.setError(false); });

  const lead = h('div', {}, h('p', { class: 't-lead', style: { margin: 0 } }, 'We sent a 6-digit code to ', h('strong', { style: { color: 'var(--color-ink)' } }, email), '.'), h('p', { class: 't-lead', style: { margin: 0 } }, 'Enter it below to confirm this address.'));
  const mail = h('div', {}, h('p', { class: 'label-mono muted-on', style: { margin: '0 0 12px' } }, 'Sample message'),
    h('div', { class: 'sample-mail' },
      h('dl', {}, h('dt', {}, 'FROM'), h('dd', {}, 'Totali'), h('dt', {}, 'TO'), h('dd', {}, email), h('dt', {}, 'SUBJECT'), h('dd', { style: { fontWeight: 700 } }, 'Your verification code')),
      h('p', { style: { margin: '24px 0 0', fontSize: '14px' } }, 'Use this code to verify your email:'),
      h('div', { class: 'code' }, '481 902'),
      h('p', { class: 't-caption muted', style: { margin: 0 } }, `The code expires in ${expiryMinutes} minutes. If you didn’t ask for it, you can ignore this email.`)));
  return { title: 'Check your email — Totali', el: shell({ step: 1, panel: mail, title: 'Check your email.', email, children: h('div', {}, h('div', { style: { marginTop: '24px', maxWidth: '560px' } }, lead), h('div', { style: { marginTop: '48px' } }, form)) }), cleanup: () => clearInterval(timer) };
}

// ---------------------------------------------------------------- log in
export function login() {
  const email = Field({ label: 'Email', name: 'email', type: 'email', autocomplete: 'email', placeholder: 'you@company.com', autofocus: true });
  const pw = Field({ label: 'Password', name: 'password', type: 'password', autocomplete: 'current-password', rightSlot: 'Show' });
  const err = h('div', {});
  const btn = Button({ variant: 'primary', full: true, arrow: true, type: 'submit' }, 'Log in');
  const form = h('form', { novalidate: true, onSubmit: async (e) => {
    e.preventDefault();
    err.replaceChildren();
    if (!email.value.trim() || !pw.value) { err.append(Alert('error', 'Enter your email and password.')); return; }
    setLoading(btn, true);
    try {
      const r = await api.post('/v1/auth/login', { email: email.value, password: pw.value });
      session.user = r.user;
      navigate(nextPath(r.user));
    } catch (e2) {
      err.replaceChildren(Alert('error', e2.message));
      setLoading(btn, false);
    }
  } }, email.el, pw.el, err, btn,
  h('div', { class: 'ob-links', style: { marginTop: 0 } }, h('span', {}, 'New to Totali?'), link('/signup', { class: 'btn btn-text btn-sm' }, 'Create account')),
  h('p', { class: 't-caption muted', style: { margin: 0 } }, 'You stay signed in on this device until you sign out.'));
  return { title: 'Log in — Totali', el: h('div', { class: 'page-center' }, h('div', { class: 'card-plain stack', style: { '--gap': '32px' } }, Logo(), h('div', {}, h('h1', { class: 't-heading-sm' }, 'Log in.'), h('p', { class: 't-small muted', style: { margin: '8px 0 0' } }, 'Welcome back.')), form)) };
}
