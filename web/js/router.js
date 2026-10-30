// A small history-API router. A route is a pattern like '/app/people/:id' and a page function that returns an element.
const routes = [];
let rootEl = null;
let current = null;
let guard = null;

export function route(pattern, page) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => (keys.push(k), '([^/]+)')).replace(/\*$/, '(.*)') + '/?$');
  routes.push({ re, keys, page, pattern });
}

export function setGuard(fn) {
  guard = fn;
}

export function navigate(path, { replace = false } = {}) {
  if (path === location.pathname + location.search) return render();
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
  return render();
}

export function link(path, props = {}, ...children) {
  const a = document.createElement('a');
  a.setAttribute('href', path);
  for (const [k, v] of Object.entries(props)) if (v !== undefined && v !== false && v !== null) a.setAttribute(k, v === true ? '' : v);
  a.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(path);
  });
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) a.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return a;
}

/** Make every in-app link inside static markup go through the router instead of reloading the page. */
export function wireLinks(root) {
  for (const a of root.querySelectorAll('a[href^="/"]')) {
    if (a.dataset.wired) continue;
    a.dataset.wired = '1';
    a.addEventListener('click', (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigate(a.getAttribute('href'));
    });
  }
}

export function currentRoute() {
  return { path: location.pathname, query: new URLSearchParams(location.search) };
}

export async function render() {
  const path = location.pathname;
  let hit = null;
  for (const r of routes) {
    const m = r.re.exec(path);
    if (m) { hit = { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) }; break; }
  }
  if (!hit) hit = { r: routes.find((x) => x.pattern === '/404'), params: {} };
  const ctx = { params: hit.params, query: new URLSearchParams(location.search), path };
  if (guard) {
    const redirect = await guard(ctx, hit.r.pattern);
    if (redirect && redirect !== path) return navigate(redirect, { replace: true });
  }
  if (current && current.cleanup) { try { current.cleanup(); } catch { /* a page's cleanup must not stop navigation */ } }
  const token = Symbol();
  render.token = token;
  const out = await hit.r.page(ctx);
  if (render.token !== token) return; // a newer navigation won
  current = out && out.el ? out : { el: out };
  document.title = (out && out.title) || 'Totali';
  // The design's marketing page sits on a plain body; every other screen uses the app body.
  document.body.className = out && out.bodyClass !== undefined ? out.bodyClass : 'tapp';
  rootEl.replaceChildren(current.el);
  window.scrollTo(0, 0);
  const focusTarget = current.el.querySelector('[data-autofocus]');
  if (focusTarget) focusTarget.focus();
}

export function start(el) {
  rootEl = el;
  window.addEventListener('popstate', render);
  return render();
}
