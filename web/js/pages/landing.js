import markup from './landing.markup.js';
import { navigate, wireLinks } from '../router.js';
import { session } from '../session.js';

/** The marketing page, from the design's own markup, with its two email forms and its buttons wired to signup. */
export function landing() {
  const el = document.createElement('div');
  // Trusted, static markup shipped with the app (design/totali/pages/landing.html). No user text goes through here.
  el.innerHTML = markup;
  const signedIn = !!(session.user && session.user.emailVerified);
  if (signedIn) {
    const login = el.querySelector('.top a[href="/login"]');
    if (login) { login.setAttribute('href', '/app'); login.textContent = 'Open your dashboard'; }
    const create = el.querySelector('.top a.btn');
    if (create) create.remove();
  }
  for (const f of el.querySelectorAll('form[data-signup]')) {
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const email = (f.querySelector('input[type=email]') || {}).value || '';
      navigate(signedIn ? '/app' : `/signup${email.trim() ? `?email=${encodeURIComponent(email.trim())}` : ''}`);
    });
  }
  wireLinks(el);
  return { title: 'Totali: payroll for the whole crew', el, bodyClass: '' };
}
