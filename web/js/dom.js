// Tiny hyperscript. Text always goes in as text nodes, never as HTML, so nothing a user typed can become markup.
const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'path', 'rect', 'circle', 'line', 'g', 'polyline', 'polygon']);

export function h(tag, props, ...children) {
  const el = SVG_TAGS.has(tag) ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k === 'style' && typeof v === 'object') for (const [sk, sv] of Object.entries(v)) el.style.setProperty(sk.startsWith('--') ? sk : sk.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()), String(sv));
    else if (k === 'style') el.style.cssText = String(v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected' || k === 'indeterminate') el[k] = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false || c === true) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function mount(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

export const money = (cents) => (cents < 0 ? '-' : '') + '$' + (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const dollarsToCents = (s) => Math.round(Number(String(s).replace(/[$,\s]/g, '')) * 100);
export const hoursFromMinutes = (m) => (m / 60).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
export const longDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
export const shortDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
export const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
