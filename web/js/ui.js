import { h } from './dom.js';
import { link } from './router.js';

// ---------------------------------------------------------------- icons
const ICONS = {
  arrow: [['path', { d: 'M2 8h11M9 3.5 13.5 8 9 12.5', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }]],
  check: [['path', { d: 'M3 8.5 6.5 12 13 4.5', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }]],
  plus: [['path', { d: 'M8 2.5v11M2.5 8h11', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round' }]],
  gear: [['circle', { cx: 8, cy: 8, r: 2.2, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5 }], ['path', { d: 'M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round' }]],
  x: [['path', { d: 'M3.5 3.5l9 9M12.5 3.5l-9 9', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round' }]],
  up: [['path', { d: 'M3 10l5-5 5 5', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }]],
  down: [['path', { d: 'M3 6l5 5 5-5', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }]],
  left: [['path', { d: 'M10 3 5 8l5 5', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }]],
  right: [['path', { d: 'M6 3l5 5-5 5', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }]],
  grip: [['circle', { cx: 5, cy: 4, r: 1.2 }], ['circle', { cx: 11, cy: 4, r: 1.2 }], ['circle', { cx: 5, cy: 8, r: 1.2 }], ['circle', { cx: 11, cy: 8, r: 1.2 }], ['circle', { cx: 5, cy: 12, r: 1.2 }], ['circle', { cx: 11, cy: 12, r: 1.2 }]],
};

export function icon(name, size = 16) {
  return h('svg', { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': 'true', fill: 'currentColor', class: 'ico' }, ...(ICONS[name] || []).map(([t, p]) => h(t, p)));
}

// ---------------------------------------------------------------- logo
const SQUIGGLE = () => h('svg', { viewBox: '0 0 120 10', preserveAspectRatio: 'none', 'aria-hidden': 'true' }, h('path', { d: 'M2 6 C 22 1, 40 9, 62 5 S 100 2, 118 6', fill: 'none', stroke: '#D9553B', 'stroke-width': 2.6, 'stroke-linecap': 'round' }));
export function Logo({ small = false, href = '/' } = {}) {
  return link(href, { class: `logo ${small ? 'sm' : ''}`, 'aria-label': 'Totali' }, 'totali', SQUIGGLE());
}

/** Hand-lettered margin note, with an optional arrow. */
export function Hand(text, { style = {}, arrow = null } = {}) {
  return h('div', { class: 'hand', style }, text, arrow ? h('svg', { viewBox: '0 0 110 60', width: 110, height: 60, 'aria-hidden': 'true', style: arrow.style || {} }, h('path', { d: arrow.d || 'M6 8 C 30 2, 70 14, 100 46', fill: 'none', stroke: '#1E5B47', 'stroke-width': 2.4, 'stroke-linecap': 'round' }), h('path', { d: 'M86 52 L104 54 L100 36', fill: 'none', stroke: '#1E5B47', 'stroke-width': 2.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) : null);
}

// ---------------------------------------------------------------- button
export function Button({ variant = 'primary', size = 'md', full = false, loading = false, disabled = false, href, onClick, type = 'button', ...rest } = {}, ...label) {
  const cls = ['btn', variant === 'ghost' || variant === 'secondary' ? 'ghost' : '', variant === 'teal' ? 'teal' : '', size === 'sm' ? 'sm' : '', size === 'lg' ? 'lg' : '', full ? 'full' : ''].filter(Boolean).join(' ');
  const kids = [...label, loading ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : null];
  if (href && !disabled) return link(href, { class: cls, ...rest }, ...kids);
  return h('button', { class: cls, type, disabled: disabled || loading, 'aria-busy': loading ? 'true' : undefined, onClick, ...rest }, ...kids);
}

/** A text link styled like the design's "link". */
export function TextLink(label, { href, onClick, ...rest } = {}) {
  return href ? link(href, { class: 'link', ...rest }, label) : h('button', { class: 'link as-button', type: 'button', onClick, ...rest }, label);
}

export function setLoading(btn, on, label) {
  btn.disabled = on;
  btn.setAttribute('aria-busy', on ? 'true' : 'false');
  const sp = btn.querySelector('.spinner');
  if (on && !sp) btn.append(h('span', { class: 'spinner', 'aria-hidden': 'true' }));
  if (!on && sp) sp.remove();
  if (label !== undefined) btn.firstChild.textContent = label;
}

// ---------------------------------------------------------------- fields
let fieldSeq = 0;
export function Field({ label, name, type = 'text', value = '', placeholder = '', hint, autocomplete, optional = false, inputmode, maxlength, onInput, rightSlot, disabled = false, autofocus = false, select, options, rows, min, max }) {
  const id = `f${++fieldSeq}`;
  const errId = `${id}-err`;
  let input;
  if (select) input = h('select', { class: 'in', id, name, disabled }, ...options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)));
  else if (rows) input = h('textarea', { class: 'in', id, name, rows, placeholder, maxlength, disabled }, value);
  else input = h('input', { class: 'in', id, name, type, value, placeholder, autocomplete, inputmode, maxlength, disabled, min, max, 'data-autofocus': autofocus ? '' : undefined });
  const errorEl = h('div', { class: 'ferr', id: errId, role: 'alert', hidden: true });
  const wrap = h('div', { class: 'inwrap' }, input);
  if (rightSlot === 'Show') {
    const btn = h('button', { class: 'slot', type: 'button', 'aria-label': 'Show password', 'aria-pressed': 'false', onClick: () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? 'Hide' : 'Show';
      btn.setAttribute('aria-pressed', String(show));
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    } }, 'Show');
    wrap.append(btn);
    input.classList.add('has-slot');
  }
  const el = h('div', { class: 'fld' },
    label ? h('label', { class: 'lab', for: id }, label, optional ? h('small', {}, '(optional)') : null) : null,
    wrap, hint ? h('div', { class: 'help' }, hint) : null, errorEl);
  if (onInput) input.addEventListener('input', () => onInput(input.value, input));
  input.addEventListener('input', () => setError(null));
  function setError(msg) {
    el.classList.toggle('has-error', !!msg);
    errorEl.hidden = !msg;
    errorEl.textContent = msg || '';
    if (msg) input.setAttribute('aria-describedby', errId); else input.removeAttribute('aria-describedby');
    input.setAttribute('aria-invalid', msg ? 'true' : 'false');
  }
  return { el, input, setError, get value() { return input.value; }, set value(v) { input.value = v; } };
}

export function Checkbox({ label, name, checked = false, onChange }) {
  const input = h('input', { type: 'checkbox', name, checked, onChange: (e) => onChange && onChange(e.target.checked) });
  return { el: h('label', { class: 'ck2' }, input, h('span', { class: 'cb', 'aria-hidden': 'true' }), h('span', { class: 'fine' }, label)), input, get checked() { return input.checked; } };
}

/** Password strength bar: four segments. */
export function PwBar(score) {
  return h('div', { class: 'pwbar', role: 'img', 'aria-label': `Password strength ${score} of 4` }, ...[1, 2, 3, 4].map((i) => h('span', { class: i <= score ? 'on' : '' })));
}
export function pwScore(pw) {
  if (pw.length < 10) return pw.length ? 1 : 0;
  let s = 2;
  if (pw.length >= 14) s += 1;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw) && /\d|\W/.test(pw)) s += 1;
  if (pw.includes(' ') && pw.length >= 14) s = 4;
  return Math.min(4, s);
}

// ---------------------------------------------------------------- chips and notices
/** A chip. `kind` is ok, warn, new, berry or line. */
export function Chip(text, kind = '') {
  return h('span', { class: `chip ${kind}` }, text);
}
const STATUS = { auto: ['Auto', 'ok'], manual: ['Manual', 'line'], open: ['Open', 'line'], setup: ['Set up', 'ok'], todo: ['To do', 'warn'], toset: ['To set', 'warn'], reference: ['Reference', 'line'], added: ['Added', 'ok'], ready: ['Ready', 'ok'] };
export function StatusChip(item) {
  const [label, kind] = STATUS[item.status] || [item.status, ''];
  return Chip(item.chip || label, kind);
}

export function Alert(kind, message, detail) {
  return h('div', { class: `alert ${kind === 'error' ? 'err' : kind === 'success' ? 'good' : kind === 'info' ? 'teal' : ''}`, role: kind === 'error' ? 'alert' : 'status' }, h('span', { class: 'dot' }), h('div', {}, h('b', {}, message), detail ? h('div', { class: 'cap' }, detail) : null));
}

let toastHost;
export function toast(kind, message, ms = 5000) {
  if (!toastHost) { toastHost = h('div', { class: 'toasts', 'aria-live': 'polite' }); document.body.append(toastHost); }
  const el = Alert(kind, message);
  toastHost.append(el);
  setTimeout(() => el.remove(), ms);
  return el;
}

// ---------------------------------------------------------------- the three signup steps
export function Steps3(current) {
  const names = ['Account', 'Verify', 'Your business'];
  const kids = [];
  names.forEach((n, i) => {
    kids.push(h('span', { class: i < current ? 'done' : i === current ? 'on' : '', 'aria-current': i === current ? 'step' : undefined }, n));
    if (i < names.length - 1) kids.push(h('i'));
  });
  return h('div', { class: 'steps3', role: 'list', 'aria-label': 'Progress' }, ...kids);
}

// ---------------------------------------------------------------- code boxes
export function CodeBoxes({ length = 6, onChange, onComplete } = {}) {
  const boxes = [];
  const root = h('div', { class: 'codes', role: 'group', 'aria-label': 'Verification code' });
  const value = () => boxes.map((b) => b.value).join('');
  const sync = () => { onChange && onChange(value()); if (value().length === length && onComplete) onComplete(value()); };
  for (let i = 0; i < length; i++) {
    const b = h('input', { class: 'cb-in', inputmode: 'numeric', autocomplete: i === 0 ? 'one-time-code' : 'off', maxlength: 1, 'aria-label': `Digit ${i + 1} of ${length}`, 'data-autofocus': i === 0 ? '' : undefined });
    b.addEventListener('input', () => { b.value = b.value.replace(/\D/g, '').slice(-1); if (b.value && boxes[i + 1]) boxes[i + 1].focus(); sync(); });
    b.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !b.value && boxes[i - 1]) { boxes[i - 1].value = ''; boxes[i - 1].focus(); sync(); e.preventDefault(); }
      if (e.key === 'ArrowLeft' && boxes[i - 1]) boxes[i - 1].focus();
      if (e.key === 'ArrowRight' && boxes[i + 1]) boxes[i + 1].focus();
    });
    b.addEventListener('paste', (e) => {
      const digits = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, length);
      if (!digits) return;
      e.preventDefault();
      boxes.forEach((x, j) => { x.value = digits[j] || ''; });
      boxes[Math.min(digits.length, length - 1)].focus();
      sync();
    });
    boxes.push(b);
    root.append(b);
  }
  return {
    el: root, value,
    setError(on) { root.classList.toggle('error', !!on); },
    clear() { boxes.forEach((b) => (b.value = '')); sync(); boxes[0].focus(); },
    focus() { boxes[0].focus(); },
  };
}

// ---------------------------------------------------------------- modal
export function modal({ title, body, actions, onClose, dismissible = true }) {
  const previous = document.activeElement;
  const overlay = h('div', { class: 'modal-overlay', onClick: (e) => { if (dismissible && e.target === overlay) close(); } });
  const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('div', { class: 'modal-head' }, h('h2', { class: 'st2' }, title), dismissible ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onClick: () => close() }, icon('x')) : null), h('div', { class: 'modal-body' }, body), actions ? h('div', { class: 'modal-actions' }, ...actions) : null);
  overlay.append(box);
  function key(e) {
    if (e.key === 'Escape' && dismissible) close();
    if (e.key === 'Tab') {
      const f = [...box.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled);
      if (!f.length) return;
      const first = f[0]; const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
      else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
    }
  }
  function close() { document.removeEventListener('keydown', key); overlay.remove(); if (previous && previous.focus) previous.focus(); onClose && onClose(); }
  document.addEventListener('keydown', key);
  document.body.append(overlay);
  (box.querySelector('[data-autofocus]') || box.querySelector('input, button, select, textarea') || box).focus();
  return { close, el: box };
}

export async function withButton(btn, fn, onError) {
  setLoading(btn, true);
  try { return await fn(); } catch (e) { (onError || ((err) => toast('error', err.message)))(e); } finally { setLoading(btn, false); }
}
