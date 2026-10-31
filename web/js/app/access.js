import { h } from '../dom.js';
import { api } from '../api.js';
import { navigate } from '../router.js';
import { Button, Alert, modal, toast } from '../ui.js';
import { app, base } from './state.js';

const niceDay = (iso) => new Date(iso).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
const left = (a) => (a.expired ? 'This code has run out.' : `Works until ${niceDay(a.expiresAt)}. ${a.daysLeft} ${a.daysLeft === 1 ? 'day' : 'days'} left.`);

/** A card you can print and tape up in the back room. */
function printCard(a) {
  const name = app.dash ? app.dash.config.brand.name : app.data.company.name;
  const url = `${location.origin}/employee`;
  const flyer = h('div', { class: 'flyer' }, h('h1', {}, name), h('p', { class: 'lead' }, 'Set up your own login to see your pay stubs and hours on your phone.'),
    h('ol', {}, h('li', {}, `Go to ${url.replace(/^https?:\/\//, '')}`), h('li', {}, 'Tap Create account and enter this code'), h('li', {}, 'Fill in your details and send them to your manager')), h('div', { class: 'code' }, a.code), h('p', { class: 'small' }, a.expired ? 'This code has run out. Ask your manager for a new one.' : `This code works until ${niceDay(a.expiresAt)}.`));
  document.body.append(flyer); document.body.classList.add('printing-flyer');
  const done = () => { document.body.classList.remove('printing-flyer'); flyer.remove(); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done); window.print(); setTimeout(done, 1500);
}

function newCodeModal(after) {
  const go = Button({ type: 'button', 'data-testid': 'confirm-new-code' }, 'Make a new code');
  const m = modal({ title: 'Make a new code?', body: h('p', { style: { margin: 0 } }, 'The old code stops working right away. The new one works for three days. People who already made an account stay signed in.'), actions: [Button({ variant: 'ghost', onClick: () => m.close() }, 'Keep the old one'), go] });
  go.addEventListener('click', async () => { try { await api.post(`${base()}/portal/rotate`); m.close(); toast('success', 'New code ready.'); after(); } catch (e) { toast('error', e.message); } });
}

function codeBlock(a, { onNew }) {
  const copy = Button({ size: 'sm', type: 'button', 'data-testid': 'copy-code' }, 'Copy code');
  copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(a.code); copy.firstChild.textContent = 'Copied'; } catch { toast('error', 'Couldn’t copy. Select the code and copy it.'); } });
  return h('div', { class: 'stack', style: { '--gap': '12px' } },
    h('div', { class: 'joincode', 'data-testid': 'join-code', style: a.expired ? { opacity: '.4' } : {} }, a.code),
    h('p', { class: 'cap', 'data-testid': 'code-life' }, left(a)),
    h('div', { class: 'acts' }, a.expired ? Button({ size: 'sm', type: 'button', 'data-testid': 'new-code', onClick: () => newCodeModal(onNew) }, 'Make a new code') : copy,
      Button({ variant: 'ghost', size: 'sm', type: 'button', onClick: () => printCard(a) }, 'Print a card'),
      a.expired ? null : h('button', { class: 'link as-button', type: 'button', 'data-testid': 'rotate-code', onClick: () => newCodeModal(onNew) }, 'Make a new code')));
}

export async function accessCard() {
  const a = await api.get(`${base()}/portal/access`);
  const redraw = () => navigate(location.pathname + location.search);
  return h('div', { class: 'stack', style: { '--gap': '12px' } },
    h('p', { class: 'cap' }, 'Give this code to each new hire. They go to ', h('b', {}, `${location.host}/employee`), ', make an account, and send you their details. You approve them in Requests to join.'),
    codeBlock(a, { onNew: redraw }),
    a.expired ? Alert('info', 'Hiring someone new?', 'Make a new code and give it to them. A code only works for three days.') : null,
    h('p', { class: 'cap' }, a.joined ? `${a.joined} ${a.joined === 1 ? 'person has' : 'people have'} their own login.` : 'Nobody has made a login yet.', a.started ? ` ${a.started} made an account and haven’t sent their details.` : ''));
}

/** Shown once, right after the dashboard is built: the first thing to do is bring in the team. */
export async function welcomeModal() {
  let a;
  try { a = await api.get(`${base()}/portal/access`); } catch { return; }
  const m = modal({ title: 'Now add your employees', body: h('div', { class: 'stack', style: { '--gap': '14px' }, 'data-testid': 'welcome' },
    h('p', { style: { margin: 0 } }, 'Give your team this code. They go to ', h('b', {}, `${location.host}/employee`), ', make an account with it, fill in their details on their phone and send them to you. You look them over and approve, and they’re on payroll.'),
    codeBlock(a, { onNew: () => { m.close(); welcomeModal(); } }),
    h('p', { class: 'cap', style: { margin: 0 } }, 'A code works for three days. If you hire someone later, make a new one from the Onboarding tab.')),
  actions: [Button({ type: 'button', 'data-testid': 'welcome-done', onClick: () => m.close() }, 'Got it')] });
}
