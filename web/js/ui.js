import { h } from './dom.js';
import { link } from './router.js';

// ---------------------------------------------------------------- icons
const ICONS = {
  arrow: [['path', { d: 'M2 8h11M9 3.5 13.5 8 9 12.5', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'square' }]],
  check: [['path', { d: 'M2.5 8.5 6.5 12.5 13.5 4', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'square' }]],
  plus: [['path', { d: 'M8 2v12M2 8h12', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }]],
  minus: [['path', { d: 'M2 8h12', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }]],
  x: [['path', { d: 'M3 3l10 10M13 3 3 13', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }]],
  up: [['path', { d: 'M3 10l5-5 5 5', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }]],
  down: [['path', { d: 'M3 6l5 5 5-5', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }]],
  left: [['path', { d: 'M10 3 5 8l5 5', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }]],
  right: [['path', { d: 'M6 3l5 5-5 5', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }]],
  grip: [['circle', { cx: 5, cy: 4, r: 1.3 }], ['circle', { cx: 11, cy: 4, r: 1.3 }], ['circle', { cx: 5, cy: 8, r: 1.3 }], ['circle', { cx: 11, cy: 8, r: 1.3 }], ['circle', { cx: 5, cy: 12, r: 1.3 }], ['circle', { cx: 11, cy: 12, r: 1.3 }]],
  lock: [['rect', { x: 3, y: 7, width: 10, height: 7, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6 }], ['path', { d: 'M5 7V5a3 3 0 0 1 6 0v2', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6 }]],
  warn: [['path', { d: 'M8 2 15 14H1z', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6 }], ['path', { d: 'M8 6.5v3.5M8 11.8v.4', stroke: 'currentColor', 'stroke-width': 1.8 }]],
};

export function icon(name, size = 16) {
  return h('svg', { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': 'true', fill: 'currentColor' }, ...(ICONS[name] || []).map(([t, p]) => h(t, p)));
}

// ---------------------------------------------------------------- logo
export function Logo({ scheme = 'default', href = '/' } = {}) {
  const ink = scheme === 'default' ? '#0A0A0A' : '#FFFFFF';
  const accent = scheme === 'default' ? '#1F3BFF' : scheme === 'reversed' ? '#8C9BFF' : '#FFFFFF';
  const mark = h('svg', { viewBox: '0 0 160 160', role: 'img', 'aria-hidden': 'true' },
    h('rect', { x: 16, y: 24, width: 128, height: 24, fill: ink }),
    h('rect', { x: 16, y: 56, width: 80, height: 24, fill: ink }),
    h('rect', { x: 16, y: 88, width: 104, height: 16, fill: ink }),
    h('rect', { x: 64, y: 112, width: 80, height: 24, fill: accent }));
  return link(href, { class: `logo ${scheme === 'default' ? '' : scheme}`, 'aria-label': 'Totali' }, mark, h('span', { class: 'logo-word' }, 'Totali', h('i', {}, '.')));
}

// ---------------------------------------------------------------- button
export function Button({ variant = 'primary', size = 'lg', arrow = false, full = false, loading = false, disabled = false, href, onClick, type = 'button', ...rest } = {}, ...label) {
  const cls = `btn btn-${variant} ${size === 'lg' ? '' : `btn-${size}`} ${full ? 'btn-full' : ''}`.replace(/\s+/g, ' ').trim();
  const kids = [...label, loading ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : arrow ? icon('arrow') : null];
  if (href && !disabled) return link(href, { class: cls, ...rest }, ...kids);
  return h('button', { class: cls, type, disabled: disabled || loading, 'aria-busy': loading ? 'true' : undefined, onClick, ...rest }, ...kids);
}

/** Set a button's loading state from outside while a request runs. */
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
export function Field({ label, name, type = 'text', value = '', placeholder = '', hint, autocomplete, required = false, optional = false, inputmode, maxlength, onInput, rightSlot, disabled = false, autofocus = false, select, options, rows }) {
  const id = `f${++fieldSeq}`;
  const errId = `${id}-err`;
  let input;
  if (select) {
    input = h('select', { class: 'input', id, name, disabled }, ...options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)));
  } else if (rows) {
    input = h('textarea', { class: 'input', id, name, rows, placeholder, maxlength, disabled }, value);
  } else {
    input = h('input', { class: `input ${rightSlot ? 'has-slot' : ''}`, id, name, type, value, placeholder, autocomplete, inputmode, maxlength, disabled, 'data-autofocus': autofocus ? '' : undefined, required: required || undefined });
  }
  const errorEl = h('div', { class: 'field-error', id: errId, role: 'alert', hidden: true });
  const wrap = h('div', { class: 'input-wrap' }, input);
  let slotBtn = null;
  if (rightSlot === 'Show') {
    slotBtn = h('button', { class: 'field-slot', type: 'button', 'aria-label': 'Show password', 'aria-pressed': 'false', onClick: () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      slotBtn.textContent = show ? 'Hide' : 'Show';
      slotBtn.setAttribute('aria-pressed', String(show));
      slotBtn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    } }, 'Show');
    wrap.append(slotBtn);
  }
  const el = h('label', { class: 'field', for: id },
    label ? h('span', { class: 'field-label' }, label, optional ? h('span', { class: 'req' }, ' (optional)') : null) : null,
    wrap,
    hint ? h('div', { class: 'field-hint' }, hint) : null,
    errorEl);
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
  return { el: h('label', { class: 'check' }, input, h('span', {}, label)), input, get checked() { return input.checked; } };
}

export function PasswordRule(label, met) {
  return h('div', { class: `pw-rule ${met ? 'met' : ''}` }, met ? icon('check', 12) : h('span', { class: 'box' }), label);
}

// ---------------------------------------------------------------- tags, alerts
export function Tag(text, { color = 'ink', solid = false } = {}) {
  return h('span', { class: `tag tag-${color} ${solid ? 'solid' : ''}` }, solid ? h('span', {}, text) : text);
}

export function Alert(kind, message, detail) {
  return h('div', { class: `alert ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, h('div', { class: 'alert-body' }, message, detail ? h('small', {}, detail) : null));
}

let toastHost;
export function toast(kind, message, ms = 5000) {
  if (!toastHost) { toastHost = h('div', { class: 'toasts', 'aria-live': 'polite' }); document.body.append(toastHost); }
  const el = Alert(kind, message);
  toastHost.append(el);
  setTimeout(() => el.remove(), ms);
  return el;
}

// ---------------------------------------------------------------- progress steps
export function ProgressSteps(steps, current) {
  return h('div', { class: 'steps', role: 'list', 'aria-label': 'Progress' }, ...steps.map((label, i) => {
    const state = i < current ? 'done' : i === current ? 'current' : 'todo';
    return h('div', { class: `step ${state}`, role: 'listitem', 'aria-current': state === 'current' ? 'step' : undefined },
      h('div', { class: 'bar' }),
      h('div', { class: 'lab' }, state === 'done' ? icon('check', 12) : h('span', { class: 'idx' }, String(i + 1).padStart(2, '0')), h('span', {}, label)));
  }));
}

// ---------------------------------------------------------------- code boxes
export function CodeBoxes({ length = 6, onChange, onComplete } = {}) {
  const boxes = [];
  const root = h('div', { class: 'code-boxes', role: 'group', 'aria-label': 'Verification code' });
  const value = () => boxes.map((b) => b.value).join('');
  const sync = () => {
    boxes.forEach((b) => b.classList.toggle('filled', b.value !== ''));
    onChange && onChange(value());
    if (value().length === length && onComplete) onComplete(value());
  };
  for (let i = 0; i < length; i++) {
    const b = h('input', { class: 'code-box', inputmode: 'numeric', autocomplete: i === 0 ? 'one-time-code' : 'off', maxlength: 1, 'aria-label': `Digit ${i + 1} of ${length}`, 'data-autofocus': i === 0 ? '' : undefined });
    b.addEventListener('input', () => {
      b.value = b.value.replace(/\D/g, '').slice(-1);
      if (b.value && boxes[i + 1]) boxes[i + 1].focus();
      sync();
    });
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
    if (i === 3 - 1 && length === 6) { root.append(b, h('span', { class: 'code-dash', 'aria-hidden': 'true' })); } else root.append(b);
  }
  return {
    el: root,
    value,
    setError(on) { root.classList.toggle('error', !!on); },
    clear() { boxes.forEach((b) => (b.value = '')); sync(); boxes[0].focus(); },
    focus() { boxes[0].focus(); },
  };
}

// ---------------------------------------------------------------- modal
export function modal({ title, body, actions, onClose, dismissible = true }) {
  const previous = document.activeElement;
  const overlay = h('div', { class: 'modal-overlay', onClick: (e) => { if (dismissible && e.target === overlay) close(); } });
  const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('div', { class: 'modal-head' }, h('h2', { class: 't-title' }, title), dismissible ? h('button', { class: 'icon-btn', 'aria-label': 'Close', onClick: () => close() }, icon('x')) : null), h('div', { class: 'modal-body' }, body), actions ? h('div', { class: 'modal-actions' }, ...actions) : null);
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
  function close() {
    document.removeEventListener('keydown', key);
    overlay.remove();
    if (previous && previous.focus) previous.focus();
    onClose && onClose();
  }
  document.addEventListener('keydown', key);
  document.body.append(overlay);
  (box.querySelector('[data-autofocus]') || box.querySelector('input, button, select, textarea') || box).focus();
  return { close, el: box };
}

/** Run an async action behind a button: disables it, shows a spinner, and shows the error on failure. */
export async function withButton(btn, fn, onError) {
  setLoading(btn, true);
  try { return await fn(); } catch (e) { (onError || ((err) => toast('error', err.message)))(e); } finally { setLoading(btn, false); }
}
