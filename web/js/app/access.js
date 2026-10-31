import { h, plural } from '../dom.js';
import { api } from '../api.js';
import { navigate } from '../router.js';
import { Button, Alert, Chip, modal, toast } from '../ui.js';
import { app, base } from './state.js';

/** A card you can print and tape up in the back room. */
function printCard(a) {
  const name = app.dash ? app.dash.config.brand.name : app.data.company.name;
  const url = `${location.origin}/employee`;
  const flyer = h('div', { class: 'flyer' }, h('h1', {}, name), h('p', { class: 'lead' }, 'See your pay stubs, your hours and your tax forms on your phone.'),
    h('ol', {}, h('li', {}, `Go to ${url.replace(/^https?:\/\//, '')}`), h('li', {}, 'Enter this company code and your email'), h('li', {}, 'Type the 6-digit code we email you')), h('div', { class: 'code' }, a.code), h('p', { class: 'small' }, 'No password. Use the email your manager has for you.'));
  document.body.append(flyer); document.body.classList.add('printing-flyer');
  const done = () => { document.body.classList.remove('printing-flyer'); flyer.remove(); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done); window.print(); setTimeout(done, 1500);
}

export async function accessCard() {
  const a = await api.get(`${base()}/portal/access`);
  const redraw = () => navigate(location.pathname + location.search);
  const copy = Button({ size: 'sm', type: 'button', 'data-testid': 'copy-code' }, 'Copy code');
  copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(a.code); copy.firstChild.textContent = 'Copied'; } catch { toast('error', 'Couldn’t copy. Select the code and copy it.'); } });
  const rotate = h('button', { class: 'link as-button', type: 'button', 'data-testid': 'rotate-code', onClick: () => {
    const m = modal({ title: 'Make a new code?', body: h('p', { style: { margin: 0 } }, 'The old code stops working right away and everyone signed in with it is signed out. Give the new code to your team.'), actions: [Button({ variant: 'ghost', onClick: () => m.close() }, 'Keep the old one'), Button({ onClick: async () => { try { await api.post(`${base()}/portal/rotate`); m.close(); toast('success', 'New code made.'); redraw(); } catch (e) { toast('error', e.message); } } }, 'Make a new code')] });
  } }, 'Make a new code');
  const toggle = h('button', { class: 'link as-button', type: 'button', 'data-testid': 'toggle-access', onClick: async () => { try { await api.put(`${base()}/portal/enabled`, { enabled: !a.enabled }); toast('success', a.enabled ? 'Employee sign-in is off. Everyone was signed out.' : 'Employee sign-in is on.'); redraw(); } catch (e) { toast('error', e.message); } } }, a.enabled ? 'Turn employee sign-in off' : 'Turn employee sign-in on');
  return h('div', { class: 'stack', style: { '--gap': '12px' } },
    h('p', { class: 'cap' }, 'Give this code to your team. They go to ', h('b', {}, `${location.host}/employee`), ', enter it with their own email, and get a 6-digit code by email. No passwords.'),
    h('div', { class: 'joincode', 'data-testid': 'join-code', style: a.enabled ? {} : { opacity: '.45' } }, a.code),
    h('div', { class: 'acts' }, copy, Button({ variant: 'ghost', size: 'sm', type: 'button', onClick: () => printCard(a) }, 'Print a sign-in card')),
    !a.enabled ? Alert('warn', 'Employee sign-in is off.') : null,
    a.withoutEmail ? Alert('info', `${plural(a.withoutEmail, 'person', 'people')} can’t sign in yet.`, 'They need an email address. Add it from their profile.') : null,
    h('p', { class: 'cap' }, a.withEmail ? `${plural(a.withEmail, 'person', 'people')} can sign in. ${a.signedInRecently} signed in this month.` : 'Nobody has an email on file yet. Invite people from Onboarding and they can sign in once they have one.'),
    h('div', { class: 'acts' }, rotate, toggle));
}
