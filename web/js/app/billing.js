import { h, longDate } from '../dom.js';
import { api } from '../api.js';
import { navigate } from '../router.js';
import { Button, Alert, Chip, Field, modal, setLoading, toast } from '../ui.js';
import { appPage } from './shell.js';
import { base, refreshData } from './state.js';

const CARD = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover' };

function emailModal(current, done) {
  const f = Field({ label: 'Billing email', name: 'billingEmail', type: 'email', value: current, autofocus: true });
  const go = Button({}, 'Save');
  const m = modal({ title: 'Billing email', body: h('div', { class: 'f' }, h('p', { class: 'fine', style: { margin: 0 } }, 'Stripe sends your receipts here.'), f.el), actions: [Button({ variant: 'ghost', onClick: () => m.close() }, 'Cancel'), go] });
  go.addEventListener('click', async () => { setLoading(go, true); try { await api.put(`${base()}/billing/email`, { email: f.value }); m.close(); toast('success', 'Saved.'); done(); } catch (e) { f.setError(e.message); setLoading(go, false); } });
}

/** Go to a page Stripe hosts. The card number is typed there, never here. */
async function toStripe(btn, path) {
  setLoading(btn, true);
  try { const r = await api.post(`${base()}${path}`); location.href = r.url; } catch (e) { toast('error', e.message); setLoading(btn, false); }
}

export function billingPage() {
  return async (ctx) => appPage(ctx, { active: 'settings', title: 'Billing', render: async () => {
    // coming back from Stripe's checkout: ask Stripe what happened before showing anything
    const q = new URLSearchParams(location.search);
    if (q.get('checkout') === 'success' && q.get('session_id')) {
      try { await api.post(`${base()}/billing/checkout/finish`, { sessionId: q.get('session_id') }); toast('success', 'You’re subscribed. Thank you.'); } catch (e) { toast('error', e.message); }
      history.replaceState(null, '', '/app/billing');
    } else if (q.get('checkout') === 'cancelled') { toast('info', 'No charge was made.'); history.replaceState(null, '', '/app/billing'); }
    await refreshData();
    const b = await api.get(`${base()}/billing`);
    const redraw = () => navigate(location.pathname);
    const sub = b.subscription;
    const start = Button({ type: 'button', 'data-testid': 'start-subscription' }, 'Start your subscription');
    start.addEventListener('click', () => toStripe(start, '/billing/checkout'));
    const manage = Button({ variant: 'ghost', type: 'button', 'data-testid': 'manage-billing' }, 'Manage billing');
    manage.addEventListener('click', () => toStripe(manage, '/billing/portal'));
    const status = !sub ? Chip('Not started', 'line') : sub.pastDue ? Chip('Payment late', 'warn') : sub.active ? Chip(sub.endsAtPeriodEnd ? 'Ending' : 'Active', 'ok') : Chip('Cancelled', 'line');
    return h('div', { class: 'billing' },
      h('div', { class: 'ph2' }, h('div', {}, h('h1', { class: 'pt' }, 'Billing'), h('p', {}, 'One flat price, whatever the size of your team.'))),
      !b.available ? Alert('info', 'Payments aren’t switched on for this server.', 'An administrator needs to add the Stripe keys. Nothing is charged until they do.') : null,
      sub && sub.pastDue ? Alert('warn', 'Your last payment didn’t go through.', 'Stripe will try again. Update your card to keep payroll running.') : null,
      h('div', { class: 'grid', style: { gridTemplateColumns: 'minmax(0,1.5fr) minmax(0,1fr)', alignItems: 'start' } },
        h('div', { class: 'grid' },
          h('div', { class: 'card' }, h('div', { class: 'ch' }, h('h3', { class: 'ct' }, 'Totali'), status),
            h('div', { class: 'big2' }, h('div', {}, h('i', {}, 'Price'), h('span', { class: 'n', 'data-testid': 'price' }, b.plan.label))),
            h('p', { class: 'cap', style: { marginTop: '4px' } }, 'Every employee and every pay run is included, however big your team gets. Billed every three months, in advance. Cancel any time and you keep access until the period you paid for ends.'),
            sub && sub.active ? h('p', { style: { margin: '14px 0 0' }, 'data-testid': 'renews' }, sub.endsAtPeriodEnd ? `Ends on ${longDate(sub.renews.slice(0, 10))}. You won’t be charged again.` : `Next charge of $20.00 on ${longDate(sub.renews.slice(0, 10))}.`) : null,
            h('div', { class: 'acts', style: { marginTop: '16px' } }, sub && b.available ? manage : sub ? null : b.available ? start : null))),
        h('div', { class: 'grid' },
          h('div', { class: 'card' }, h('h3', { class: 'ct', style: { marginBottom: '6px' } }, 'Payment'),
            h('div', { class: 'row' }, h('span', { class: 'l1' }, h('b', {}, b.card ? `${CARD[b.card.brand] || 'Card'} ending ${b.card.last4}` : 'No card yet'), h('i', {}, b.card ? `Expires ${String(b.card.expMonth).padStart(2, '0')}/${b.card.expYear}` : 'You add it on Stripe’s secure page when you subscribe.'))),
            h('div', { class: 'row' }, h('span', { class: 'l1' }, h('b', {}, 'Receipts go to'), h('i', {}, b.email)), h('button', { class: 'link as-button', type: 'button', 'data-testid': 'email-button', onClick: () => emailModal(b.email, redraw) }, 'Change'))),
          h('div', { class: 'card' }, h('h3', { class: 'ct', style: { marginBottom: '8px' } }, 'Who’s billed'), h('p', { class: 'cap', style: { margin: 0 } }, `${b.billedTo}. Payments are handled by Stripe. Totali never sees or stores your card number.`)))));
  } });
}
