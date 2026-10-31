import { h } from '../dom.js';
import { api } from '../api.js';
import { Button, Alert, Field, Hand, Logo, setLoading } from '../ui.js';

const STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');

/** What a contractor opens from the link in their email: a W-9, short, on a phone. */
export function w9Page() {
  return async (ctx) => {
    const token = encodeURIComponent(ctx.params.token);
    let st;
    try { st = await api.get(`/v1/w9/${token}`); } catch (e) {
      return { title: 'Your W-9 | Totali', el: h('div', {}, h('header', { class: 'eptop ui' }, Logo({ small: true })), h('main', { class: 'empage ui' }, h('div', {}, h('h1', { class: 'pt', style: { fontSize: '26px' } }, 'This link ', h('em', {}, 'isn’t valid')), h('p', { class: 'cap', style: { margin: '10px 0 0' } }, 'It may have expired, or you may have sent your W-9 already. Ask the business for a new link.')))) };
    }
    const host = h('div', {});
    let tinType = 'ssn';
    const legal = Field({ label: 'Name (as on your tax return)', name: 'legalName', value: st.name });
    const biz = Field({ label: 'Business name', name: 'businessName', optional: true });
    const cls = Field({ label: 'Tax classification', name: 'classification', select: true, value: st.classifications[0], options: st.classifications.map((c) => ({ value: c, label: c })) });
    const tin = Field({ label: 'Taxpayer ID', name: 'tin', placeholder: '123-45-6789', inputmode: 'numeric', autocomplete: 'off' });
    const street = Field({ label: 'Street', name: 'street' }); const city = Field({ label: 'City', name: 'city' });
    const state = Field({ label: 'State', name: 'state', select: true, value: 'MI', options: STATES.map((s) => ({ value: s, label: s })) }); const zip = Field({ label: 'ZIP', name: 'zip', inputmode: 'numeric' });
    const sig = h('input', { class: 'in sig', name: 'signature', placeholder: st.name, autocomplete: 'off', 'aria-label': 'Type your name to sign' });
    const certify = h('input', { type: 'checkbox', name: 'certify' });
    const types = h('div', { class: 'opts c2', role: 'radiogroup', 'aria-label': 'Number type', style: { marginTop: '8px' } });
    const drawTypes = () => types.replaceChildren(...[['ssn', 'Social Security number'], ['ein', 'Employer ID (EIN)']].map(([v, t]) => h('button', { type: 'button', class: `opt ${tinType === v ? 'on' : ''}`, role: 'radio', 'aria-checked': String(tinType === v), 'data-value': v, onClick: () => { tinType = v; drawTypes(); } }, h('span', { class: 'rd' }), t)));
    drawTypes();
    const err = h('div', {}); const go = Button({ size: 'lg', full: true, type: 'submit' }, 'Send my W-9');
    const form = h('form', { class: 'f', novalidate: true, onSubmit: async (e) => {
      e.preventDefault(); err.replaceChildren(); setLoading(go, true);
      try {
        await api.post(`/v1/w9/${token}`, { businessName: biz.value, classification: cls.value, tinType, tin: tin.value, address: { street: street.value, city: city.value, state: state.value, zip: zip.value }, signature: sig.value, certify: certify.checked });
        done();
      } catch (e2) { const t = { tin, zip }[e2.details && e2.details.field]; if (t) t.setError(e2.message); else err.replaceChildren(Alert('error', e2.message)); setLoading(go, false); }
    } }, legal.el, biz.el, cls.el, h('div', {}, h('label', { class: 'lab' }, 'Number type'), types), tin.el, street.el, h('div', { class: 'r3' }, city.el, state.el, zip.el),
    h('div', {}, h('div', { class: 'sec2' }, 'Sign'), h('div', { style: { marginTop: '8px' } }, sig), h('p', { class: 'help' }, 'Type your name. Under penalties of perjury, you certify that the number is correct and that you are not subject to backup withholding.')),
    h('label', { class: 'ck2' }, certify, h('span', { class: 'cb' }), h('span', { class: 'fine' }, 'I certify these details are correct.')), err, go);
    const aside = h('aside', { style: { position: 'relative', paddingTop: '20px' } }, h('div', { class: 'card', style: { background: '#FBF1E5', boxShadow: 'none' } }, h('h3', { class: 'ct', style: { marginBottom: '8px' } }, 'Who sees this'), h('p', { class: 'cap', style: { fontSize: '14px' } }, `Only ${st.business} and the people they allow. Your number is stored encrypted and shown to them as its last four digits.`)), Hand('Two minutes, and you’re done.', { style: { marginTop: '20px', fontSize: '25px', transform: 'rotate(-2deg)', position: 'static' } }));
    function done() { host.replaceChildren(h('h1', { class: 'pt', style: { fontSize: '26px' } }, 'Thank ', h('em', {}, 'you')), h('p', { class: 'cap', style: { margin: '10px 0' } }, `${st.business} has your W-9. You can close this page.`)); aside.replaceChildren(); }
    host.append(h('h1', { class: 'pt', style: { fontSize: '26px' } }, 'Your ', h('em', {}, 'W-9')), h('p', { class: 'cap', style: { margin: '6px 0 20px' } }, `${st.business} needs this to report what they pay you.`), form);
    return { title: `Your W-9 | ${st.business}`, el: h('div', {}, h('header', { class: 'eptop ui' }, Logo({ small: true, href: '/' }), h('span', { class: 'co' }, h('span', { class: 'orgmark' }, st.business[0].toUpperCase()), st.business)), h('main', { class: 'empage ui' }, host, aside)) };
  };
}
