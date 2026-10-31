import { h } from '../dom.js';
import { api } from '../api.js';
import { link, navigate } from '../router.js';
import { Button, Checkbox, CodeBoxes, Field, Hand, Logo, PwBar, Steps3, Alert, TextLink, modal, pwScore, setLoading, toast } from '../ui.js';
import { refreshUser, session } from '../session.js';

const MIN_PASSWORD = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Where a person goes next, given how far they have got. */
export function nextPath(user) {
  if (!user) return '/';
  if (!user.emailVerified) return '/signup/verify';
  if (!user.profileComplete) return '/signup/business';
  if (!user.companyId) return '/setup/industry';
  return '/app';
}

/** The design's frame for every pre-account screen: slim top bar, a card on the left, a photo or sample on the right. */
function frame({ aside, card, nudge }) {
  return h('div', { class: 'authpage' },
    h('header', { class: 'authtop ui' }, Logo(), h('span', {}, nudge[0], link(nudge[1], { class: 'l2' }, nudge[2]))),
    h('main', { class: 'auth' }, h('div', { class: 'acard ui' }, ...[card].flat()), h('div', { class: 'avis' }, aside)));
}

const photo = (src, alt, pos) => h('figure', { class: 'photo' }, h('img', { src, alt, style: { objectPosition: pos } }));

const googleOn = () => !!(session.config && session.config.google);
function orRule() {
  return googleOn() ? h('div', { class: 'or' }, 'or with email') : null;
}

/** Shown only when this server has Google credentials: a button that does nothing would just be a trap. */
function googleButton() {
  if (!googleOn()) return null;
  return h('button', { class: 'oauth', type: 'button', 'data-testid': 'google', onClick: () => { window.location.href = '/v1/auth/google'; } }, h('i'), 'Continue with Google');
}

// ---------------------------------------------------------------- create account
export function signup(ctx) {
  const first = Field({ label: 'First name', name: 'firstName', autocomplete: 'given-name', autofocus: true });
  const last = Field({ label: 'Last name', name: 'lastName', autocomplete: 'family-name' });
  const biz = Field({ label: 'Business name', name: 'businessName', placeholder: 'Harbor Street Kitchen', autocomplete: 'organization' });
  const email = Field({ label: 'Work email', name: 'email', type: 'email', placeholder: 'you@company.com', autocomplete: 'email', value: ctx && ctx.query.get('email') ? ctx.query.get('email') : '' });
  const bar = h('div', {}, PwBar(0));
  const pw = Field({ label: 'Password', name: 'password', type: 'password', autocomplete: 'new-password', hint: `At least ${MIN_PASSWORD} characters. A phrase works well.`, rightSlot: 'Show', onInput: (v) => { bar.replaceChildren(PwBar(pwScore(v))); update(); } });
  pw.el.querySelector('.inwrap').after(bar);
  const terms = Checkbox({ name: 'terms', onChange: () => update(), label: h('span', {}, 'I agree to the ', h('a', { href: '/terms', target: '_blank', rel: 'noopener' }, 'Terms'), ' and ', h('a', { href: '/privacy', target: '_blank', rel: 'noopener' }, 'Privacy Policy'), ' of OMNIA TAX LLC.') });
  const formError = h('div', {});
  const submit = Button({ size: 'lg', full: true, type: 'submit', disabled: true }, 'Create account');
  const valid = () => first.value.trim() && last.value.trim() && biz.value.trim() && EMAIL_RE.test(email.value.trim()) && pw.value.length >= MIN_PASSWORD && terms.checked;
  function update() { submit.disabled = !valid(); }
  for (const f of [first, last, biz, email]) f.input.addEventListener('input', update);
  update();

  const form = h('form', { class: 'f', novalidate: true, onSubmit: async (e) => {
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
  googleButton(), orRule(),
  h('div', { class: 'r2' }, first.el, last.el),
  biz.el, email.el, pw.el, terms.el, formError, submit);

  const card = [Steps3(0), h('h1', {}, 'Create your ', h('em', {}, 'account')), h('p', {}, 'Start with you. We’ll ask about the business next.'), form];
  const aside = h('div', {}, photo('/assets/img/waiter.jpg', 'A server carrying plates', '50% 30%'),
    Hand('Takes about five minutes. Stop any time, we save as you go.', { style: { left: '-20px', top: '70px', width: '200px', fontSize: '26px' } }),
    Hand('', { style: { left: '30px', top: '200px' }, arrow: {} }));
  return { title: 'Create account — Totali', el: frame({ card, aside, nudge: ['Already have an account?', '/login', 'Log in'] }) };
}

// ---------------------------------------------------------------- verify email
export async function verify() {
  const user = session.user;
  const email = user.email;
  let state = {};
  try { state = JSON.parse(sessionStorage.getItem('totali.verification') || '{}'); } catch { /* none */ }
  const codeBoxes = CodeBoxes({ onChange: () => { submit.disabled = codeBoxes.value().length !== 6; } });
  const errorLine = h('div', { class: 'ferr', role: 'alert', hidden: true });
  const info = h('div', {});
  const submit = Button({ size: 'lg', full: true, type: 'submit', disabled: true }, 'Verify and continue');
  const resendBtn = TextLink('send a new code', { onClick: () => resend() });
  const resendNote = h('span', { class: 'fine' });
  let timer;

  function countdown(seconds) {
    clearInterval(timer);
    const end = Date.now() + seconds * 1000;
    const draw = () => {
      const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      resendBtn.disabled = left > 0;
      resendNote.textContent = left > 0 ? ` (available in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')})` : '';
      if (left <= 0) clearInterval(timer);
    };
    draw();
    timer = setInterval(draw, 500);
  }
  if (state.at && state.resendAfterSeconds) {
    const left = Math.ceil((state.at + state.resendAfterSeconds * 1000 - Date.now()) / 1000);
    if (left > 0) countdown(left);
  }

  async function devHint() {
    info.replaceChildren();
    const cfg = session.config || {};
    if (cfg.mail === 'outbox') {
      info.append(Alert('warn', 'Email isn’t set up on this server, so no code was sent.', cfg.devTools ? undefined : 'An administrator needs to set RESEND_API_KEY.'));
      if (cfg.devTools) {
        try {
          const box = await api.get('/v1/dev/outbox');
          const msg = [...box.messages].reverse().find((m) => m.to === email);
          const code = msg && /\b(\d{6})\b/.exec(msg.text);
          if (code) info.append(h('div', { class: 'alert teal', 'data-testid': 'dev-code' }, h('span', { class: 'dot' }), h('div', {}, 'Development only: your code is ', h('b', { class: 'mono' }, code[1]))));
        } catch { /* no outbox */ }
      }
    } else if (state.sent === false) {
      info.append(Alert('error', 'We couldn’t send the code.', 'Try again in a minute.'));
    }
  }
  devHint();

  async function resend() {
    resendBtn.disabled = true;
    try {
      const r = await api.post('/v1/auth/resend');
      state = { ...state, ...r.verification, at: Date.now() };
      sessionStorage.setItem('totali.verification', JSON.stringify(state));
      countdown(r.verification.resendAfterSeconds);
      codeBoxes.setError(false); errorLine.hidden = true; codeBoxes.clear();
      toast('success', 'A new code is on its way.');
      devHint();
    } catch (err) {
      resendBtn.disabled = false;
      if (err.details && err.details.retryAfterSeconds) countdown(err.details.retryAfterSeconds);
      toast('error', err.code === 'resend_too_soon' ? err.message : 'We couldn’t send the code. Try again in a minute.');
    }
  }

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
    }
  }

  const changeLink = TextLink('Change it', { onClick: () => {
    const f = Field({ label: 'Work email', name: 'email', type: 'email', value: email, autocomplete: 'email', autofocus: true });
    const save = Button({}, 'Send a new code');
    const m = modal({ title: 'Change your email', body: h('div', { class: 'f' }, h('p', { class: 'fine', style: { margin: 0 } }, 'We’ll send a new code to the new address. The old one stops working.'), f.el), actions: [Button({ variant: 'ghost', onClick: () => m.close() }, 'Cancel'), save] });
    save.addEventListener('click', async () => {
      setLoading(save, true);
      try {
        const r = await api.post('/v1/auth/change-email', { email: f.value });
        session.user = r.user;
        sessionStorage.setItem('totali.verification', JSON.stringify({ ...r.verification, at: Date.now() }));
        m.close();
        location.assign('/signup/verify');
      } catch (err) { f.setError(err.message); setLoading(save, false); }
    });
  } });

  codeBoxes.el.addEventListener('input', () => { errorLine.hidden = true; codeBoxes.setError(false); });
  const card = [Steps3(1),
    h('h1', {}, 'Check your ', h('em', {}, 'email')),
    h('p', {}, `We sent a 6-digit code to ${email}. It works for 15 minutes.`),
    h('form', { novalidate: true, onSubmit: (e) => { e.preventDefault(); doVerify(); } }, codeBoxes.el, errorLine, info, submit),
    h('p', { class: 'fine', style: { marginTop: '16px' } }, 'Nothing there? Check spam, or ', resendBtn, resendNote, '. Wrong address? ', changeLink, '.')];

  const mail = h('div', { class: 'mail', style: { position: 'absolute', left: '40px', top: '30px' } },
    h('div', { class: 'mh2' }, h('b', { style: { color: 'var(--ink)' } }, 'Totali'), ' <no-reply@totali.example>', h('br'), `To: ${email}`, h('br'), 'Subject: Your Totali code'),
    h('div', { class: 'mb' }, `Hi ${user.firstName},`, h('br'), 'Use this code to finish creating your account.', h('div', { class: 'code' }, '481 025'), h('span', { class: 'fine' }, 'It expires in 15 minutes. If you didn’t ask for it, ignore this email.'), h('br'), h('br'), h('span', { class: 'fine' }, 'OMNIA TAX LLC · sample email')));
  const aside = h('div', {}, mail, Hand('This is what lands in your inbox.', { style: { left: '60px', top: '370px', width: '260px', fontSize: '26px', transform: 'rotate(-3deg)' } }));
  return { title: 'Check your email — Totali', el: frame({ card, aside, nudge: ['Wrong account?', '/signup', 'Start over'] }), cleanup: () => clearInterval(timer) };
}

// ---------------------------------------------------------------- log in
export function login(ctx) {
  const googleError = ctx && ctx.query.get('google_error');
  const email = Field({ label: 'Work email', name: 'email', type: 'email', autocomplete: 'email', placeholder: 'you@company.com', autofocus: true });
  const pw = Field({ label: h('span', {}, 'Password', h('small', { style: { float: 'right' } }, link('/forgot', { class: 'link', style: 'font-size:12.5px' }, 'Forgot it?'))), name: 'password', type: 'password', autocomplete: 'current-password', rightSlot: 'Show' });
  const keep = Checkbox({ label: 'Keep me signed in on this device', name: 'remember', checked: true });
  const err = h('div', {});
  const btn = Button({ size: 'lg', full: true, type: 'submit' }, 'Log in');
  const form = h('form', { class: 'f', novalidate: true, onSubmit: async (e) => {
    e.preventDefault();
    err.replaceChildren();
    if (!email.value.trim() || !pw.value) { err.append(Alert('error', 'Enter your email and password.')); return; }
    setLoading(btn, true);
    try {
      const r = await api.post('/v1/auth/login', { email: email.value, password: pw.value, remember: keep.checked });
      session.user = r.user;
      navigate(nextPath(r.user));
    } catch (e2) {
      err.replaceChildren(Alert('error', e2.message));
      setLoading(btn, false);
    }
  } }, googleButton(), orRule(), googleError ? Alert('error', googleError) : null, email.el, pw.el, keep.el, err, btn);
  const card = [h('h1', {}, 'Welcome ', h('em', {}, 'back')), h('p', {}, 'Log in to your Totali account.'), form,
    h('p', { class: 'fine', style: { marginTop: '20px' } }, 'Staying signed in lasts until you choose ', h('b', {}, 'Sign out'), ' in the top menu.'),
    h('p', { class: 'fine', style: { marginTop: '8px' } }, 'On a team that uses Totali? ', link('/employee', { class: 'link' }, 'Employee sign in'), '.')];
  const aside = h('div', {}, photo('/assets/img/chef.jpg', 'Cooks plating dishes', '50% 40%'), Hand('Your pay run is where you left it.', { style: { left: '10px', top: '420px', width: '220px', fontSize: '26px', transform: 'rotate(-3deg)' } }));
  return { title: 'Log in — Totali', el: frame({ card, aside, nudge: ['New here?', '/signup', 'Create account'] }) };
}

// ---------------------------------------------------------------- forgot password: ask for a code, then choose a new password
export function forgot() {
  const email = Field({ label: 'Work email', name: 'email', type: 'email', autocomplete: 'email', placeholder: 'you@company.com', autofocus: true });
  const code = Field({ label: '6-digit code', name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 7 });
  const pw = Field({ label: 'New password', name: 'password', type: 'password', autocomplete: 'new-password', hint: `At least ${MIN_PASSWORD} characters.`, rightSlot: 'Show' });
  const err = h('div', {});
  const ask = Button({ size: 'lg', full: true, type: 'submit' }, 'Email me a code');
  const set = Button({ size: 'lg', full: true, type: 'submit' }, 'Set new password');
  const body = h('div', {});

  const stepOne = h('form', { class: 'f', novalidate: true, onSubmit: async (e) => {
    e.preventDefault();
    err.replaceChildren();
    if (!EMAIL_RE.test(email.value.trim())) { email.setError('Enter the email you signed up with.'); return; }
    setLoading(ask, true);
    try {
      await api.post('/v1/auth/forgot', { email: email.value });
      body.replaceChildren(stepTwo);
      code.input.focus();
    } catch (e2) { err.replaceChildren(Alert('error', e2.message)); }
    setLoading(ask, false);
  } }, email.el, err, ask);

  const stepTwo = h('form', { class: 'f', novalidate: true, onSubmit: async (e) => {
    e.preventDefault();
    err.replaceChildren();
    setLoading(set, true);
    try {
      await api.post('/v1/auth/reset', { email: email.value, code: code.value, password: pw.value });
      session.user = null;
      toast('success', 'Password changed. Log in with the new one.');
      navigate('/login');
    } catch (e2) {
      const t = e2.details && e2.details.field === 'password' ? pw : e2.code.startsWith('code_') ? code : null;
      if (t) t.setError(e2.message); else err.replaceChildren(Alert('error', e2.message));
      setLoading(set, false);
    }
  } }, h('p', { class: 'fine', style: { margin: 0 } }, 'If that address has an account, a code is on its way. It works for 15 minutes.'), code.el, pw.el, err, set,
  h('p', { class: 'fine' }, 'No email? Check spam, or ', TextLink('start again', { onClick: () => { err.replaceChildren(); body.replaceChildren(stepOne); } }), '.'));

  body.append(stepOne);
  const card = [h('h1', {}, 'Reset your ', h('em', {}, 'password')), h('p', {}, 'We’ll email a code to the address on your account.'), body];
  const aside = h('div', {}, photo('/assets/img/chef.jpg', 'Cooks plating dishes', '50% 40%'), Hand('It happens. We’ll have you back in a minute.', { style: { left: '10px', top: '420px', width: '200px', fontSize: '26px', transform: 'rotate(-3deg)' } }));
  return { title: 'Reset password — Totali', el: frame({ card, aside, nudge: ['Remembered it?', '/login', 'Log in'] }) };
}

// ---------------------------------------------------------------- after Google: the two things it can't tell us
export function business() {
  const biz = Field({ label: 'Business name', name: 'businessName', placeholder: 'Harbor Street Kitchen', autocomplete: 'organization', autofocus: true });
  const terms = Checkbox({ name: 'terms', onChange: () => update(), label: h('span', {}, 'I agree to the ', h('a', { href: '/terms', target: '_blank', rel: 'noopener' }, 'Terms'), ' and ', h('a', { href: '/privacy', target: '_blank', rel: 'noopener' }, 'Privacy Policy'), ' of OMNIA TAX LLC.') });
  const err = h('div', {}); const go = Button({ size: 'lg', full: true, type: 'submit', disabled: true }, 'Continue');
  const update = () => { go.disabled = !(biz.value.trim() && terms.checked); };
  biz.input.addEventListener('input', update);
  const form = h('form', { class: 'f', novalidate: true, onSubmit: async (e) => {
    e.preventDefault(); err.replaceChildren(); setLoading(go, true);
    try { const r = await api.post('/v1/auth/complete-profile', { businessName: biz.value, acceptTerms: terms.checked }); session.user = r.user; navigate(nextPath(r.user)); }
    catch (e2) { if (e2.details && e2.details.field === 'businessName') biz.setError(e2.message); else err.replaceChildren(Alert('error', e2.message)); setLoading(go, false); update(); }
  } }, biz.el, terms.el, err, go);
  const u = session.user;
  const card = [Steps3(2), h('h1', {}, `One more thing, ${u.firstName}`), h('p', {}, 'Your Google account is confirmed. What’s the business called?'), form];
  const aside = h('div', {}, photo('/assets/img/waiter.jpg', 'A server carrying plates', '50% 30%'), Hand('Takes about five minutes. Stop any time, we save as you go.', { style: { left: '-20px', top: '70px', width: '200px', fontSize: '26px' } }));
  return { title: 'Your business — Totali', el: frame({ card, aside, nudge: ['Signed in as', '/app', u.email] }) };
}
