import { h } from '../dom.js';
import { link } from '../router.js';
import { Button, Logo, Tag } from '../ui.js';
import { session } from '../session.js';

/** A small static dashboard, themed through the same kind of variables a real dashboard's theme sets. */
function mini({ title, vars, cards }) {
  return h('div', { class: 'mini', style: vars },
    h('div', { class: 'm-top' }, h('span', {}, title), h('span', {}, 'Pay date Fri')),
    h('div', { class: 'm-grid' }, ...cards.map((c) => h('div', { class: `m-card ${c.span}` }, h('b', {}, c.big), h('span', {}, c.label), c.bar ? h('div', { class: 'm-bar', style: { width: c.bar } }) : null))));
}

const diner = () => mini({
  title: 'Maple & Main Diner',
  vars: { '--m-bg': '#FFF8EC', '--m-ink': '#2B1D0E', '--m-accent': '#C2410C', '--m-card': '#FCEBD0', '--m-radius': '10px', '--m-font': 'Georgia, serif' },
  cards: [
    { span: 's3', big: '$4,218', label: 'Tips this week', bar: '72%' },
    { span: 's3', big: '31', label: 'Servers on tonight' },
    { span: 's2', big: '6', label: 'Open shifts' },
    { span: 's4', big: 'Fri', label: 'Next payday, 1 day to approve', bar: '40%' },
  ],
});

const steakhouse = () => mini({
  title: 'THE IRON LEDGER',
  vars: { '--m-bg': '#14110F', '--m-ink': '#F2E8D5', '--m-accent': '#D4A24C', '--m-card': '#211C18', '--m-radius': '0', '--m-card-border': '1px solid #3a322a', '--m-font': 'ui-serif, Georgia, serif' },
  cards: [
    { span: 's2', big: '94%', label: 'Forms done' },
    { span: 's2', big: '$18.6k', label: 'Payroll, this run' },
    { span: 's2', big: '4', label: 'Sommeliers' },
    { span: 's6', big: 'Tip pool: by role', label: 'Captains 3 pts · Servers 2 · Bussers 1', bar: '58%' },
  ],
});

const industries = [
  ['Restaurants and bars', ['Tips', 'Shift hours', 'Tip pool']],
  ['Hotels and venues', ['Departments', 'Seasonal staff', 'Service charge']],
  ['Trades and construction', ['Job costing', 'Crews', 'Workers’ comp classes']],
  ['Office and studios', ['Salaried and hourly', 'Time off', 'Multi-state']],
  ['Delivery and couriers', ['Trips', 'Mileage', 'Contractor drivers']],
];

function sectionHead(idx, what) {
  return h('div', { class: 'wrap' }, h('div', { class: 'section-head' }, h('div', { class: 'idx' }, idx), h('div', { class: 'what' }, what)));
}

export function landing() {
  const signedIn = session.user && session.user.emailVerified;
  const nav = h('header', { class: 'topbar' }, h('div', { class: 'wrap' },
    Logo(),
    h('nav', { class: 'topnav', 'aria-label': 'Main' },
      h('a', { class: 'plain hide-sm', href: '#how' }, 'How it works'),
      h('a', { class: 'plain hide-sm', href: '#industries' }, 'Industries'),
      h('a', { class: 'plain hide-sm', href: '#yours' }, 'Make it yours'),
      h('a', { class: 'plain hide-sm', href: '#pricing' }, 'Pricing'),
      signedIn ? Button({ variant: 'primary', size: 'md', href: '/app', arrow: true }, 'Open your dashboard') : [link('/login', { class: 'plain' }, 'Log in'), Button({ variant: 'primary', size: 'md', href: '/signup' }, 'Create account')])));

  const hero = h('section', { class: 'hero' }, h('div', { class: 'wrap' },
    h('p', { class: 'eyebrow', style: { color: 'var(--color-cobalt)', marginBottom: '24px' } }, 'Payroll, shaped to your business'),
    h('h1', { class: 't-display' }, 'Payroll that looks like your business.'),
    h('p', { class: 't-lead' }, 'Pick your industry, answer six questions, and get a payroll dashboard built for how you really run. Then reshape every part of it.'),
    h('div', { class: 'hero-cta' },
      signedIn ? Button({ variant: 'primary', href: '/app', arrow: true }, 'Open your dashboard') : [Button({ variant: 'primary', href: '/signup', arrow: true }, 'Create account'), link('/login', { class: 'btn btn-text' }, 'Log in')],
      h('span', { class: 't-small muted' }, 'About five minutes. It saves as you go.'))),
    h('div', { class: 'hero-band' }, h('div', { class: 'wrap' },
      h('div', { class: 'fig' }, h('span', { class: 'micro' }, 'Fig. 1'), h('span', { class: 'micro' }, 'Two restaurants, one product')),
      h('div', { class: 'stage' }, diner(), steakhouse()))));

  const how = h('section', { id: 'how' }, sectionHead('01', 'How it works'), h('div', { class: 'wrap' }, h('div', { class: 'section-body' }, h('div', { class: 'three' },
    h('div', {}, h('span', { class: 'label-mono' }, 'Step 01'), h('h3', {}, 'Pick your industry.'), h('p', {}, 'Restaurants run differently from trades, hotels, offices and couriers. Start from the one closest to you.')),
    h('div', {}, h('span', { class: 'label-mono' }, 'Step 02'), h('h3', {}, 'Answer six questions.'), h('p', {}, 'State, locations, team size, tips, pay schedule, contractors. Each answer adds or removes parts of your dashboard as you go.')),
    h('div', {}, h('span', { class: 'label-mono' }, 'Step 03'), h('h3', {}, 'Run payroll.'), h('p', {}, 'Enter hours and tips, review every paycheck, approve. Paying your team happens at your own bank, so you stay in control of the money.'))))));

  const ind = h('section', { id: 'industries' }, sectionHead('02', 'Five industries'), h('div', { class: 'wrap', style: { marginTop: '32px' } }, h('div', { class: 'ind-cards' },
    ...industries.map(([name, tags]) => h('div', { class: 'ind-card' }, h('h3', {}, name), h('div', { class: 'tags' }, ...tags.map((t) => h('span', {}, t))))))));

  const yours = h('section', { id: 'yours' }, sectionHead('03', 'Make it yours'), h('div', { class: 'wrap' }, h('div', { class: 'section-body' },
    h('h2', { class: 't-heading-md', style: { maxWidth: '16ch' } }, 'Not five templates. Every part is yours.'),
    h('p', { class: 't-lead', style: { marginTop: '24px', maxWidth: '620px' } }, 'A high-end diner and a steakhouse should not share a dashboard. Choose which cards you see, how big they are and where they sit. Set the colors, type, corners and density. Rename things in your own words: crew, brigade, front of house.'),
    h('div', { class: 'row', style: { marginTop: '24px', flexWrap: 'wrap', gap: '8px' } }, ...['Layout', 'Cards and sizes', 'Colors', 'Type', 'Density', 'Your vocabulary'].map((t) => Tag(t, { color: 'cobalt' }))))));

  const pricing = h('section', { id: 'pricing' }, sectionHead('04', 'Pricing'), h('div', { class: 'wrap' }, h('div', { class: 'section-body pricing' },
    h('div', { class: 'big' }, 'Simple per-employee pricing.'),
    h('div', { class: 'stack' }, h('p', { class: 't-lead' }, 'You pay for the people on your payroll. Nothing to pay while you set up.'), h('p', { class: 'eyebrow' }, 'Nothing to pay yet')))));

  const cta = h('section', { class: 'cta-band' }, h('div', { class: 'wrap' }, h('h2', { class: 't-display' }, 'Build yours.'), h('div', { class: 'hero-cta' }, signedIn ? Button({ variant: 'white', href: '/app', arrow: true }, 'Open your dashboard') : Button({ variant: 'white', href: '/signup', arrow: true }, 'Create account'))));

  const footer = h('footer', { class: 'footer' }, h('div', { class: 'wrap' }, h('span', {}, '© 2026 OMNIA TAX LLC. Totali is a product of OMNIA TAX LLC.'), h('span', { class: 'row', style: { gap: '24px' } }, h('a', { href: '/terms' }, 'Terms'), h('a', { href: '/privacy' }, 'Privacy Policy'), h('a', { href: 'mailto:hello@omnia.tax' }, 'Contact'))));

  return { title: 'Totali — payroll that looks like your business', el: h('div', {}, nav, hero, how, ind, yours, pricing, cta, footer) };
}
