import { h } from '../dom.js';
import { Logo } from '../ui.js';
import { link } from '../router.js';

const DRAFT = h('div', { class: 'alert', style: { margin: '0 0 22px' } }, h('span', { class: 'dot' }), h('span', {}, h('b', {}, 'Draft. '), 'This page describes how Totali works today in plain language. It has not been reviewed by a lawyer, and OMNIA TAX LLC will replace it with reviewed terms before launch.'));

function doc(title, em, updated, sections) {
  return { title: `${title} | Totali`, el: h('div', {}, h('header', { class: 'authtop ui' }, Logo(), h('span', {}, link('/', { class: 'l2' }, 'Back to Totali'))),
    h('main', { class: 'legal-page ui' }, h('h1', { class: 'pt', style: { fontSize: '30px' } }, title.replace(em, ''), h('em', {}, em)), h('p', { class: 'cap', style: { margin: '6px 0 18px' } }, `OMNIA TAX LLC · Last updated ${updated}`), DRAFT,
      ...sections.flatMap(([head, ...paras]) => [h('h2', { class: 'st2', style: { margin: '24px 0 8px', fontSize: '19px' } }, head), ...paras.map((p) => h('p', { style: { margin: '0 0 10px', lineHeight: '1.6', maxWidth: '68ch' } }, p))]))) };
}

export const terms = () => doc('Terms of service', 'service', 'October 31, 2026', [
  ['What Totali is', 'Totali is payroll software made by OMNIA TAX LLC. It works out pay and taxes from the hours, tips and forms you give it, keeps your records, and writes the payment file for your bank. Taxes are calculated by the Omnia.tax engine.'],
  ['What stays with you', 'You are the employer. You are responsible for the accuracy of what you enter, for paying your team and your taxes on time, and for filing what the law requires of you. Totali does not hold or move your money: you upload the payment file at your own bank and release it there. Totali is not a law firm, an accountant or a tax adviser, and what it shows is not legal or tax advice.'],
  ['Your account', 'Keep your password private and your sign-in secure. You are responsible for what happens under your account. Tell us at once if you think someone else has access.'],
  ['Pricing', 'Totali is billed per employee who is on a pay run in a month. We confirm your price with you before your first invoice.'],
  ['Your data', 'Your records are yours. You can export them, and you can ask us to delete your account. See the Privacy Policy for what we keep and why.'],
  ['Changes and contact', 'We will tell you before these terms change in a way that matters. Questions: hello@omnia.tax.'],
]);

export const privacy = () => doc('Privacy policy', 'policy', 'October 31, 2026', [
  ['What we collect', 'Your name, work email and business details; your employees’ names, pay, hours, tips, tax forms, Social Security numbers and bank details that you or they enter; and records of what you do in the app. When you sign in with Google we receive your name and verified email address from Google, and nothing else.'],
  ['How we protect it', 'Social Security numbers, bank account numbers, taxpayer IDs and uploaded documents are encrypted before they are stored. Passwords are stored only as salted hashes. A new hire’s link to their forms is private to them and expires.'],
  ['Who else touches it', 'Email is sent through Resend. Card details for your Totali subscription go straight to Stripe and never reach us; we keep the card’s brand and last four digits. Hosting is provided by Render. We do not sell your data and we do not use it for advertising.'],
  ['What your employees see', 'A new hire sees only their own forms, through the private link you send. They can’t see anyone else.'],
  ['Keeping and deleting', 'We keep payroll records for as long as the law expects an employer to keep them, and for as long as your account is open. Ask us to close your account and we will delete what the law doesn’t require us to keep.'],
  ['Contact', 'Questions or requests: hello@omnia.tax.'],
]);
