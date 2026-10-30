import { h, plural, longDate } from '../dom.js';
import { api } from '../api.js';
import { navigate } from '../router.js';
import { Button, Alert, Chip, Field, modal, setLoading, toast } from '../ui.js';
import { appPage } from './shell.js';
import { base, refreshData } from './state.js';

let stripeLoader;
function loadStripe() {
  if (window.Stripe) return Promise.resolve(window.Stripe);
  stripeLoader = stripeLoader || new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://js.stripe.com/v3/'; s.async = true;
    s.onload = () => resolve(window.Stripe); s.onerror = () => { stripeLoader = null; reject(new Error('Couldn’t load the card form. Check your connection and try again.')); };
    document.head.append(s);
  });
  return stripeLoader;
}

const CARD = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover' };

function cardModal(done) {
  const mount = h('div', { id: 'payment-element', style: { minHeight: '120px' } }, h('div', { class: 'empty' }, 'Loading the card form…'));
  const err = h('div', {});
  const save = Button({ disabled: true }, 'Save card');
  const m = modal({ title: 'Add a card', body: h('div', { class: 'f' }, h('p', { class: 'fine', style: { margin: 0 } }, 'Your card goes straight to Stripe. Totali never sees the number.'), mount, err), actions: [Button({ variant: 'ghost', onClick: () => m.close() }, 'Cancel'), save] });
  let stripe; let elements;
  (async () => {
    try {
      const [Stripe, start] = await Promise.all([loadStripe(), api.post(`${base()}/billing/card`)]);
      stripe = Stripe(start.publishableKey);
      elements = stripe.elements({ clientSecret: start.clientSecret, appearance: { theme: 'stripe', variables: { colorPrimary: '#8E1F4E', fontFamily: 'Instrument Sans, system-ui, sans-serif', borderRadius: '8px' } } });
      mount.replaceChildren();
      elements.create('payment').mount(mount);
      save.disabled = false;
    } catch (e) { mount.replaceChildren(Alert('error', e.message)); }
  })();
  save.addEventListener('click', async () => {
    err.replaceChildren(); setLoading(save, true);
    try {
      const r = await stripe.confirmSetup({ elements, redirect: 'if_required' });
      if (r.error) throw new Error(r.error.message);
      await api.post(`${base()}/billing/card/finish`, { setupIntentId: r.setupIntent.id });
      m.close(); toast('success', 'Card saved.'); done();
    } catch (e) { err.replaceChildren(Alert('error', e.message)); setLoading(save, false); }
  });
}

function emailModal(current, done) {
  const f = Field({ label: 'Billing email', name: 'billingEmail', type: 'email', value: current, autofocus: true });
  const go = Button({}, 'Save');
  const m = modal({ title: 'Billing email', body: h('div', { class: 'f' }, h('p', { class: 'fine', style: { margin: 0 } }, 'Invoices and receipts go here.'), f.el), actions: [Button({ variant: 'ghost', onClick: () => m.close() }, 'Cancel'), go] });
  go.addEventListener('click', async () => { setLoading(go, true); try { await api.put(`${base()}/billing/email`, { email: f.value }); m.close(); toast('success', 'Saved.'); done(); } catch (e) { f.setError(e.message); setLoading(go, false); } });
}

export function billingPage() {
  return async (ctx) => appPage(ctx, { active: 'settings', title: 'Billing', render: async () => {
    await refreshData();
    const b = await api.get(`${base()}/billing`);
    const redraw = () => navigate(location.pathname);
    const stat = (label, v) => h('div', {}, h('i', {}, label), h('b', {}, v));
    return h('div', {}, h('div', { class: 'ph2' }, h('div', {}, h('h1', { class: 'pt' }, h('em', {}, 'Billing')), h('p', {}, 'One price per employee, nothing else'))),
      h('div', { class: 'grid', style: { gridTemplateColumns: 'minmax(0,1.5fr) minmax(0,1fr)', alignItems: 'start' } },
        h('div', { class: 'grid' },
          h('div', { class: 'card' }, h('div', { class: 'ch' }, h('h3', { class: 'ct' }, 'Your plan'), Chip(b.plan.label, 'berry')),
            h('div', { class: 'big2' }, h('div', {}, h('i', {}, b.plan.name), h('span', { class: 'n' }, 'Simple per-employee pricing'))),
            h('p', { class: 'cap', style: { marginTop: '4px' } }, 'You’re billed for people on your roster who are on a pay run that month. Your price is confirmed before your first invoice.'),
            h('div', { class: 'stats s3', style: { marginTop: '16px' } }, stat('On a pay run this month', String(b.onPayRun)), stat('Invited, not yet counted', String(b.invitedNotCounted)), stat('Next invoice', b.nextInvoice ? longDate(b.nextInvoice) : '—'))),
          h('div', { class: 'card' }, h('div', { class: 'ch' }, h('h3', { class: 'ct' }, 'Invoices')),
            b.invoices.length ? h('table', { class: 'tbl' }, h('tbody', {}, ...b.invoices.map((i) => h('tr', {}, h('td', {}, i.date), h('td', {}, i.amountCents))))) : h('div', { style: { textAlign: 'center', padding: '28px 0 22px', color: 'var(--mut)' } }, h('div', { style: { font: 'italic 300 22px Fraunces,serif', color: 'var(--berry)', marginBottom: '6px' } }, 'Nothing to pay yet'), 'Your first invoice shows up here after your first approved pay run.'))),
        h('div', { class: 'grid' },
          h('div', { class: 'card' }, h('h3', { class: 'ct', style: { marginBottom: '6px' } }, 'Payment method'),
            h('div', { class: 'row' }, h('span', { class: 'l1' }, h('b', {}, b.card ? `${CARD[b.card.brand] || 'Card'} ending ${b.card.last4}` : 'No card yet'), h('i', {}, b.card ? `Expires ${String(b.card.expMonth).padStart(2, '0')}/${String(b.card.expYear).slice(-2)}` : b.cardsAvailable ? 'Add one before your first invoice' : 'Card payments aren’t switched on for this server yet')), b.cardsAvailable ? h('button', { class: 'link as-button', type: 'button', 'data-testid': 'card-button', onClick: () => cardModal(redraw) }, b.card ? 'Change' : 'Add a card') : null),
            h('div', { class: 'row' }, h('span', { class: 'l1' }, h('b', {}, 'Billing email'), h('i', {}, b.email)), h('button', { class: 'link as-button', type: 'button', 'data-testid': 'email-button', onClick: () => emailModal(b.email, redraw) }, 'Change'))),
          h('div', { class: 'card', style: { background: '#FBF1E5', boxShadow: 'none' } }, h('h3', { class: 'ct', style: { marginBottom: '8px' } }, 'Who bills you'), h('dl', { class: 'kv', style: { gridTemplateColumns: '110px 1fr' } }, h('dt', {}, 'Seller'), h('dd', {}, 'OMNIA TAX LLC'), h('dt', {}, 'Product'), h('dd', {}, 'Totali'), h('dt', {}, 'Billed to'), h('dd', {}, b.billedTo), h('dt', {}, 'Tax engine'), h('dd', {}, 'Omnia.tax'))))));
  } });
}
