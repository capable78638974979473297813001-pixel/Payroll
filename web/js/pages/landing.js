import markup from './landing.markup.js';
import { navigate, wireLinks } from '../router.js';
import { session } from '../session.js';

/** The marketing page, with its two email forms and its buttons wired to signup. */
export function landing() {
  const el = document.createElement('div');
  // Trusted, static markup shipped with the app (design/totali/pages/landing.html). No user text goes through here.
  el.innerHTML = markup;
  const signedIn = !!(session.user && session.user.emailVerified);
  if (signedIn) {
    const login = el.querySelector('.lp-top a[href="/login"]');
    if (login) { login.setAttribute('href', '/app'); login.textContent = 'Open your dashboard'; }
    const create = el.querySelector('.lp-top a.btn');
    if (create) create.remove();
  }
  // An employee who made a login sees their name at the top, with the way into their own dashboard.
  const emp = session.portal;
  if (emp && !signedIn) {
    const acct = el.querySelector('.lp-acct');
    const label = { approved: ['Open your dashboard', '/me'], pending: ['See your request', '/me/join'], draft: ['Finish your details', '/me/join'], declined: ['See your request', '/me/join'], ended: ['Your account', '/me/join'] }[emp.status] || ['Open', '/me/join'];
    const who = document.createElement('span'); who.className = 'lp-who'; who.textContent = emp.name || emp.email; who.setAttribute('data-testid', 'emp-name');
    const open = document.createElement('a'); open.className = 'btn sm'; open.href = label[1]; open.textContent = label[0]; open.setAttribute('data-testid', 'emp-open');
    if (acct) acct.replaceChildren(who, open);
  }
  for (const f of el.querySelectorAll('form[data-signup]')) {
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const email = (f.querySelector('input[type=email]') || {}).value || '';
      navigate(signedIn ? '/app' : `/signup${email.trim() ? `?email=${encodeURIComponent(email.trim())}` : ''}`);
    });
  }
  wireLinks(el);
  return { title: 'Totali: payroll for restaurants, crews and small teams', el, bodyClass: '' };
}
