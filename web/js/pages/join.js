import { h } from '../dom.js';
import { api } from '../api.js';
import { Button, Alert, Field, Hand, Logo, Steps3, setLoading } from '../ui.js';

const STATUS = [['citizen', 'A citizen of the United States'], ['noncitizen_national', 'A noncitizen national'], ['permanent_resident', 'A lawful permanent resident'], ['authorized_to_work', 'A noncitizen authorized to work']];
const FILING = [['single', 'Single or married filing separately'], ['married_joint', 'Married filing jointly'], ['head_of_household', 'Head of household']];

function options(list, selected, onPick, { columns = 1, label } = {}) {
  const wrap = h('div', { class: `opts ${columns === 2 ? 'c2' : ''}`, role: 'radiogroup', 'aria-label': label, style: { marginTop: '8px' } });
  const draw = (sel) => wrap.replaceChildren(...list.map(([v, text]) => h('button', { type: 'button', class: `opt ${sel === v ? 'on' : ''}`, role: 'radio', 'aria-checked': String(sel === v), 'data-value': v, onClick: () => { onPick(v); draw(v); } }, h('span', { class: 'rd' }), text)));
  draw(selected);
  return wrap;
}

/** The page a new hire opens from their private link: no account, three short forms, on a phone. */
export function joinPage() {
  return async (ctx) => {
    const token = ctx.params.token;
    let st;
    try { st = await api.get(`/v1/join/${encodeURIComponent(token)}`); } catch (e) {
      return { title: 'Your forms | Totali', el: h('div', {}, h('header', { class: 'eptop ui' }, Logo({ small: true })), h('main', { class: 'empage ui' }, h('div', {}, h('h1', { class: 'pt', style: { fontSize: '26px' } }, 'This link ', h('em', {}, 'isn’t valid')), h('p', { class: 'cap', style: { margin: '10px 0 0' } }, e.status === 429 ? e.message : 'It may have expired, or been replaced by a newer one. Ask your manager to send you a fresh link.')))) };
    }
    const host = h('div', {});
    const aside = h('aside', { style: { position: 'relative', paddingTop: '20px' } });
    let current = st.next;

    const frame = (stepId, title, sub, form, why, note) => {
      const stepsEl = Steps3(0);
      const names = st.steps;
      stepsEl.replaceChildren(...names.flatMap((s, i) => [h('span', { class: s.done ? 'done' : s.id === stepId ? 'on' : '' }, s.label), i < names.length - 1 ? h('i') : null].filter(Boolean)));
      host.replaceChildren(h('p', { class: 'cap', style: { marginBottom: '6px' } }, `Hi ${st.firstName}. ${names.length === 1 ? 'One short form' : `${['Zero', 'One', 'Two', 'Three'][names.length]} short forms`}, about ${names.length * 2} minutes.`), h('div', { style: { marginBottom: '18px' } }, stepsEl), h('h1', { class: 'pt', style: { fontSize: '26px' } }, ...title), h('p', { class: 'cap', style: { margin: '6px 0 20px' } }, sub), form);
      aside.replaceChildren(h('div', { class: 'card', style: { background: '#F3F4EF', boxShadow: 'none' } }, h('h3', { class: 'ct', style: { marginBottom: '8px' } }, why[0]), h('p', { class: 'cap', style: { fontSize: '14px' } }, why[1])), Hand(note, { style: { marginTop: '20px', fontSize: '25px', transform: 'rotate(-2deg)', position: 'static' } }));
    };

    const submit = (path, build, after) => async (e, btn, err) => {
      e.preventDefault(); err.replaceChildren(); setLoading(btn, true);
      try { const body = build(); const r = await api.post(`/v1/join/${encodeURIComponent(token)}/${path}`, body); st = await api.get(`/v1/join/${encodeURIComponent(token)}`); current = st.next; draw(); } catch (e2) { err.replaceChildren(Alert('error', e2.message)); setLoading(btn, false); }
      void after;
    };

    function w4() {
      let filing = 'single'; let multi = false;
      const kids = Field({ label: 'Children under 17', name: 'children', type: 'number', value: '0', min: 0, max: 20 });
      const others = Field({ label: 'Other dependents', name: 'otherDependents', type: 'number', value: '0', min: 0, max: 20 });
      const ex = st.steps.find((s) => s.id === 'w4').state ? Field({ label: 'Exemptions', name: 'exemptions', type: 'number', value: '1', min: 0, max: 30 }) : null;
      const sig = h('input', { class: 'in sig', name: 'signature', placeholder: `${st.firstName} ${st.lastName}`, autocomplete: 'off', 'aria-label': 'Type your full name to sign' });
      const err = h('div', {}); const go = Button({ size: 'lg', full: true, type: 'submit' }, 'Save and continue');
      const form = h('form', { class: 'f', novalidate: true, onSubmit: (e) => submit('w4', () => ({ filingStatus: filing, multipleJobs: multi, children: Number(kids.value) || 0, otherDependents: Number(others.value) || 0, ...(ex ? { exemptions: Number(ex.value) || 0 } : {}), signature: sig.value }))(e, go, err) },
        h('div', {}, h('div', { class: 'sec2' }, 'Step 1 · Filing status'), options(FILING, filing, (v) => { filing = v; }, { label: 'Filing status' })),
        h('div', {}, h('div', { class: 'sec2' }, 'Step 2 · More than one job?'), options([['no', 'No, just this one'], ['yes', 'Yes']], 'no', (v) => { multi = v === 'yes'; }, { columns: 2, label: 'More than one job' })),
        h('div', {}, h('div', { class: 'sec2' }, 'Step 3 · Dependents'), h('div', { class: 'r2', style: { marginTop: '8px' } }, kids.el, others.el)),
        ex ? h('div', {}, h('div', { class: 'sec2' }, `${st.stateName} · ${st.steps.find((s) => s.id === 'w4').state}`), h('div', { style: { marginTop: '8px' } }, ex.el)) : null,
        h('div', {}, h('div', { class: 'sec2' }, 'Sign'), h('div', { style: { marginTop: '8px' } }, sig), h('p', { class: 'help' }, 'Type your full name. By signing you say this is correct to the best of your knowledge.')), err, go);
      frame('w4', ['Your ', h('em', {}, 'tax'), ' withholding'], ex ? `Federal W-4, plus ${st.stateName}’s ${st.steps.find((s) => s.id === 'w4').state}.` : 'Federal W-4.', form, ['Why we ask', 'Your answers tell payroll how much tax to hold back from each paycheck. You can change them any time.'], 'Not sure? Single, no extras is a fine place to start.');
    }

    function i9() {
      let status = 'citizen';
      const first = Field({ label: 'Legal first name', name: 'legalFirstName', value: st.firstName });
      const last = Field({ label: 'Legal last name', name: 'legalLastName', value: st.lastName });
      const dob = Field({ label: 'Date of birth', name: 'dateOfBirth', type: 'date' });
      const ssn = Field({ label: 'Social Security no.', name: 'ssn', placeholder: '123-45-6789', autocomplete: 'off', inputmode: 'numeric' });
      const sig = h('input', { class: 'in sig', name: 'signature', placeholder: `${st.firstName} ${st.lastName}`, autocomplete: 'off', 'aria-label': 'Type your full name to sign' });
      const err = h('div', {}); const go = Button({ size: 'lg', full: true, type: 'submit' }, 'Save and continue');
      const fmt = () => { const d = ssn.value.replace(/\D/g, '').slice(0, 9); ssn.value = d.length > 5 ? `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}` : d.length > 3 ? `${d.slice(0, 3)}-${d.slice(3)}` : d; };
      ssn.input.addEventListener('input', fmt);
      const form = h('form', { class: 'f', novalidate: true, onSubmit: (e) => submit('i9', () => ({ legalFirstName: first.value, legalLastName: last.value, dateOfBirth: dob.value, ssn: ssn.value, status, signature: sig.value }))(e, go, err) },
        h('div', { class: 'sec2' }, 'Section 1 · About you'), h('div', { class: 'r2' }, first.el, last.el), h('div', { class: 'r2' }, dob.el, ssn.el),
        h('div', {}, h('label', { class: 'lab' }, 'I am'), options(STATUS, status, (v) => { status = v; }, { label: 'Work status' })),
        h('div', {}, h('label', { class: 'lab' }, 'Signature'), sig),
        h('div', { class: 'dropz' }, h('b', {}, 'Section 2 is next, with your manager.'), h('br'), 'Bring your documents on your first day. Your manager looks at them and completes the rest.'), err, go);
      frame('i9', ['Your ', h('em', {}, 'work'), ' eligibility'], 'Form I-9, section 1.', form, ['Who sees this', 'Only the owner and the people they allow. Your Social Security number is hidden on screen after you save it.'], 'You only do section 1. Your manager does the rest in person.');
    }

    function deposit() {
      let type = 'checking';
      const bank = Field({ label: 'Bank name', name: 'bankName', autocomplete: 'off' });
      const routing = Field({ label: 'Routing number', name: 'routingNumber', inputmode: 'numeric', maxlength: 9, autocomplete: 'off', hint: '9 digits, on the bottom left of a check.' });
      const account = Field({ label: 'Account number', name: 'accountNumber', inputmode: 'numeric', maxlength: 17, autocomplete: 'off', type: 'password' });
      const confirm = h('input', { type: 'checkbox', name: 'confirm' });
      const err = h('div', {}); const go = Button({ size: 'lg', full: true, type: 'submit' }, 'Finish');
      const form = h('form', { class: 'f', novalidate: true, onSubmit: (e) => submit('deposit', () => ({ bankName: bank.value, routingNumber: routing.value.replace(/\D/g, ''), accountNumber: account.value.replace(/\D/g, ''), accountType: type, confirm: confirm.checked }))(e, go, err) },
        bank.el, h('div', { class: 'r2' }, routing.el, account.el),
        h('div', {}, h('label', { class: 'lab' }, 'Account type'), options([['checking', 'Checking'], ['savings', 'Savings']], type, (v) => { type = v; }, { columns: 2, label: 'Account type' })),
        h('p', { class: 'fine', style: { margin: 0 } }, 'All of your pay goes to this account. Ask your manager if you want to split it.'),
        h('label', { class: 'ck2' }, confirm, h('span', { class: 'cb' }), h('span', { class: 'fine' }, 'I confirm these details are mine and correct.')), err, go);
      frame('deposit', ['Where should your ', h('em', {}, 'pay'), ' go?'], 'Direct deposit details.', form, ['Heads up', 'This sets up your deposit details with your employer. Payments aren’t made through Totali. Your employer tells you how you’ll be paid.'], 'Last one. You’re done after this.');
    }

    function done() {
      host.replaceChildren(h('h1', { class: 'pt', style: { fontSize: '26px' } }, 'You’re ', h('em', {}, 'all set')), h('p', { class: 'cap', style: { margin: '10px 0 18px' } }, `Thanks, ${st.firstName}. ${st.business} has what it needs.`),
        st.steps.some((s) => s.id === 'i9') ? h('div', { class: 'dropz' }, h('b', {}, 'One thing left, in person.'), h('br'), 'Bring your ID documents on your first day so your manager can finish your I-9.') : null);
      aside.replaceChildren(Hand('See you soon.', { style: { fontSize: '30px', transform: 'rotate(-2deg)', position: 'static', marginTop: '20px' } }));
    }

    function draw() { if (!current) return done(); ({ w4, i9, deposit })[current](); }
    draw();
    return { title: `Your forms | ${st.business}`, el: h('div', {}, h('header', { class: 'eptop ui' }, Logo({ small: true, href: '/' }), h('span', { class: 'co' }, h('span', { class: 'orgmark' }, st.business[0].toUpperCase()), st.business)), h('main', { class: 'empage ui' }, host, aside)) };
  };
}
