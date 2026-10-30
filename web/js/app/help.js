import { h } from '../dom.js';
import { api } from '../api.js';
import { Button, Alert, toast, setLoading, Hand } from '../ui.js';
import { appPage } from './shell.js';
import { base } from './state.js';

const CATS = [
  ['start', 'Getting started', 'Account, industry and your first questions'],
  ['payroll', 'Running payroll', 'Hours, review, approval and stubs'],
  ['taxes', 'Taxes and state setup', 'Your state, your city and your account numbers'],
  ['hires', 'New hires and paperwork', 'W-4, state forms, I-9 and direct deposit'],
  ['tips', 'Time and tips', 'Overtime, tip pools and who gets what'],
  ['billing', 'Billing and your account', 'Plan, invoices and signing out'],
];

const FAQ = [
  ['start', 'Why did these items appear on my dashboard?', 'They came from your answers when you set up: your state, your locations, whether anyone earns tips, and so on. Change an answer in Settings, under Your dashboard, and the items follow. History is never deleted.'],
  ['start', 'Can I change my industry later?', 'Not inside the same company. Your industry decides your roles, forms and the way tips or crews are handled. Everything else you told us (locations, team size, tips, pay frequency, contractors) can be changed in Settings. For a different kind of business, start a new company.'],
  ['start', 'Can I make the dashboard look like my business?', 'Yes. Press Customize on any dashboard page. You can change colors, fonts, corners, spacing, the navigation, what each card shows, the order of cards, the tabs, and the words used (call your team a crew or a brigade).'],
  ['taxes', 'Where do I add my unemployment account number?', 'Settings, then State accounts. Add your state unemployment number, your withholding account, and any city account. You register these with the state yourself; Totali keeps them and puts them on your filings.'],
  ['taxes', 'Why can’t I approve my pay run?', 'Two things stop an approval. Your EIN has to be in Company setup, because it goes on every pay stub and filing. And any problem the review marks “Fix first” has to be fixed. Items marked “Review” can be approved once you’ve read them.'],
  ['taxes', 'Who works out the taxes?', 'The Omnia.tax engine, line by line, from each person’s forms, where they work and live, and what they were paid. Every pay stub explains how it was worked out.'],
  ['hires', 'What happens if someone has no W-4?', 'They’re left out of the pay run until it’s on file, and the review tells you who. Send a reminder from Onboarding and they fill it in on their phone.'],
  ['hires', 'How does a new hire fill in their forms?', 'You invite them from Onboarding. They get a private link by email that works for 14 days, with no account to make. They do the W-4, state form, section 1 of the I-9 and direct deposit. You finish section 2 of the I-9 in person.'],
  ['payroll', 'Does Totali pay my team?', 'No. Totali works out the pay and writes the payment file for your bank. You upload it in your bank’s ACH portal and release it there. Your money never passes through Totali. Set your bank up in Settings, under Paying your team.'],
  ['payroll', 'Can I fix a pay run after I approve it?', 'Before anything is paid you can void it from the run’s page and run it again. The hours go back to open. After it’s paid, the run is locked.'],
  ['tips', 'How is overtime worked out?', 'From the hours. Anything over 40 in a workweek is paid at time and a half, whichever box you typed it in. Some states add daily overtime; the engine applies your state’s rules.'],
  ['tips', 'How do tips work?', 'Enter tips for each person in Run payroll. If you pool tips, Time and tips shows the split by hours or by role. Tips count as pay for tax, and each stub shows them separately.'],
  ['billing', 'How much does Totali cost?', 'One price per employee who is on a pay run that month. We confirm your price before your first invoice, and nothing is charged until then.'],
  ['billing', 'How do I sign out?', 'Press your initials at the top right and choose Sign out. You stay signed in on a device until you do. “Sign out everywhere” is in Settings, under Your dashboard.'],
];

export function helpPage() {
  return async (ctx) => appPage(ctx, { active: 'help', title: 'Help', render: () => {
    let cat = null; let q = '';
    const list = h('div', { class: 'faq' });
    const search = h('input', { class: 'in', type: 'search', placeholder: 'Search help articles', 'aria-label': 'Search help articles', style: { maxWidth: '520px' } });
    const draw = () => {
      const hits = FAQ.filter(([c, a, b]) => (!cat || c === cat) && (!q || `${a} ${b}`.toLowerCase().includes(q)));
      list.replaceChildren(...(hits.length ? hits.map(([, question, answer]) => { const d = h('details', { class: 'faq-item' }, h('summary', {}, question), h('p', {}, answer)); return d; }) : [h('div', { class: 'empty' }, 'Nothing matches. Tell us what you were looking for on the right.')]));
      cards.querySelectorAll('.card').forEach((c) => c.classList.toggle('on', c.dataset.cat === cat));
    };
    const cards = h('div', { class: 'grid g3', style: { marginTop: '22px', gridTemplateColumns: 'repeat(3, minmax(0,1fr))' } }, ...CATS.map(([id, title, sub]) => h('button', { type: 'button', class: 'card cat', 'data-cat': id, style: { textAlign: 'left', cursor: 'pointer', minHeight: '96px', font: 'inherit', color: 'inherit' }, onClick: () => { cat = cat === id ? null : id; draw(); } }, h('h3', { class: 'ct', style: { marginBottom: '6px' } }, title), h('p', { class: 'cap' }, sub))));
    search.addEventListener('input', () => { q = search.value.trim().toLowerCase(); draw(); });
    const msg = h('textarea', { class: 'in', rows: 5, maxlength: 4000, placeholder: 'What were you doing, and what happened?', 'aria-label': 'Your message' });
    const err = h('div', {}); const send = Button({ type: 'button' }, 'Message us');
    send.addEventListener('click', async () => {
      err.replaceChildren(); setLoading(send, true);
      try { await api.post(`${base()}/support`, { message: msg.value }); msg.value = ''; toast('success', 'Sent. A person will write back to your email.'); } catch (e) { err.replaceChildren(Alert('error', e.message)); }
      setLoading(send, false);
    });
    draw();
    return h('div', {}, h('div', { class: 'ph2' }, h('div', {}, h('h1', { class: 'pt' }, 'How can we ', h('em', {}, 'help'), '?'))), search, cards,
      h('div', { class: 'grid', style: { gridTemplateColumns: 'minmax(0,1.4fr) minmax(0,1fr)', marginTop: '30px', alignItems: 'start' } },
        h('div', {}, h('h2', { class: 'st2', style: { marginBottom: '12px' } }, 'Common ', h('em', {}, 'questions')), list),
        h('div', { class: 'card', style: { background: '#FBF1E5', boxShadow: 'none' } }, h('h3', { class: 'ct', style: { marginBottom: '6px' } }, 'Still stuck?'), h('p', { class: 'cap', style: { marginBottom: '12px' } }, 'Tell us what you were doing and we’ll write back.'), msg, err, h('div', { style: { marginTop: '12px' } }, send), Hand('A person reads these.', { style: { marginTop: '20px', fontSize: '24px', transform: 'rotate(-2deg)', position: 'static' } }))));
  } });
}
