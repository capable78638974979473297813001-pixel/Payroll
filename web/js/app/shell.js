import { h, plural } from '../dom.js';
import { link, navigate } from '../router.js';
import { Logo } from '../ui.js';
import { applyTheme, terms } from '../theme.js';
import { session, signOut } from '../session.js';
import { app, loadApp } from './state.js';
import { RENDERERS } from '../widgets.js';

const firstPage = (config) => config.tabs.find((t) => t.kind === 'page');
export const tabPath = (tab, config) => (tab.kind === 'settings' ? '/app/settings' : tab.kind === 'help' ? '/app/help' : tab.id === firstPage(config).id ? '/app' : `/app/${tab.id}`);

/** The company's mark beside its name: an initial, a dot, a bar, or nothing. */
export function brandMark(brand) {
  if (brand.mark === 'none') return null;
  const cls = brand.mark === 'dot' ? 'dot' : brand.mark === 'bar' ? 'bar' : '';
  return h('span', { class: `orgmark ${cls}`, 'aria-hidden': 'true' }, brand.mark === 'initial' ? (brand.name.trim()[0] || 'T').toUpperCase() : '');
}

const initials = (u) => `${(u.firstName || '')[0] || ''}${(u.lastName || '')[0] || ''}`.toUpperCase() || 'T';

/**
 * Wraps every page of the signed-in app: the company's own theme, name and tabs around whatever the page draws.
 * `config` is the saved dashboard, or the editor's draft, so a theme change shows at once while editing.
 */
export async function appPage(ctx, { active, title, render, config: override, editbar, header }) {
  await loadApp();
  const config = override || app.dash.config;
  const t = terms(config, app.dash.options.terms);
  const root = h('div', { class: 'dash' });
  applyTheme(root, config.theme, config.brand);

  const behind = app.data ? app.data.onboarding.total - app.data.onboarding.complete : 0;
  const label = (tab) => (tab.kind !== 'page' ? tab.label : tab.id === 'people' ? t('people') : tab.id === 'payroll' ? t('payroll') : tab.id === 'onboarding' ? t('onboarding') : tab.label);
  const pages = config.tabs.filter((x) => x.kind === 'page');
  const extras = config.tabs.filter((x) => x.kind !== 'page');
  const tabLinks = pages.map((tab) => link(tabPath(tab, config), { class: tab.id === active ? 'on' : '', 'aria-current': tab.id === active ? 'page' : undefined, 'data-tab': tab.id }, label(tab), tab.id === 'onboarding' && behind > 0 ? h('em', {}, String(behind)) : null));
  const rightLinks = extras.map((tab) => link(tabPath(tab, config), { class: 'hl', 'aria-current': tab.id === active ? 'page' : undefined, 'data-tab': tab.id }, label(tab)));

  root.classList.add('restaurant-app');
  const sidebar = h('aside', { class: 'restaurant-sidebar' },
    h('div', { class: 'restaurant-logo' }, Logo({ small: true, href: '/app' }), h('span', {}, 'FOR RESTAURANTS')),
    link('/app', { class: 'restaurant-switcher' }, brandMark(config.brand), h('span', {}, h('b', {}, config.brand.name), h('small', { class: config.brand.tagline ? 'sub' : '' }, config.brand.tagline || app.data.company.nicheLabel || 'Restaurant workspace'))),
    h('div', { class: 'restaurant-nav-label' }, 'YOUR WORKSPACE'),
    h('nav', { class: 'restaurant-nav', 'aria-label': 'Dashboard' }, ...pages.map(tab => link(tabPath(tab, config), { class: tab.id === active ? 'on' : '', 'aria-current': tab.id === active ? 'page' : undefined, 'data-tab': tab.id }, label(tab), tab.id === 'onboarding' && behind > 0 ? h('em', {}, String(behind)) : null))),
    h('div', { class: 'restaurant-sidebar-bottom' }, link('/app/settings/pos', { class: 'restaurant-connect-link' }, h('span', {}, 'Your connections', h('small', {}, app.data.pos.connected ? app.data.pos.label : 'Connect your POS'))), h('nav', { class: 'restaurant-nav', 'aria-label': 'Workspace settings' }, ...rightLinks, link('/app/billing', { 'data-tab': 'billing' }, 'Billing'))));
  const topbar = h('header', { class: 'restaurant-topbar ui' },
    h('div', {}, h('span', { class: 'restaurant-breadcrumb' }, config.brand.name), h('span', { 'aria-hidden': 'true' }, ' / '), h('b', {}, title)),
    h('div', { class: 'restaurant-user' }, h('span', {}, session.user.firstName), accountMenu()));
  const main = h('main', { class: 'dash-main wrap ui', id: 'main', tabIndex: -1 });
  const frame = h('div', { class: 'restaurant-frame' }, h('a', { href: '#main', class: 'restaurant-skip' }, 'Skip to content'), sidebar,
    h('div', { class: 'restaurant-workspace' }, topbar, editbar || null, main));
  root.append(frame);
  const out = await render({ root, main, config, t, data: app.data, dash: app.dash });
  if (out) main.append(out);
  return { title: `${title} | ${config.brand.name}`, el: root };
}

/** The initials at the top right: who is signed in, and the places that aren't tabs. */
function accountMenu() {
  const u = session.user;
  const menu = h('div', { class: 'avmenu', role: 'menu', hidden: true },
    h('div', { class: 'who2' }, h('b', {}, `${u.firstName} ${u.lastName}`), h('span', {}, u.email)),
    link('/app/settings', { role: 'menuitem' }, 'Settings'), link('/app/billing', { role: 'menuitem' }, 'Billing'), link('/app/help', { role: 'menuitem' }, 'Help'),
    h('button', { type: 'button', role: 'menuitem', 'data-testid': 'sign-out', onClick: async () => { await signOut(); navigate('/'); } }, 'Sign out'));
  const btn = h('button', { class: 'av signout-av', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': 'Your account', 'data-testid': 'account-menu' }, initials(u));
  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); document.removeEventListener('click', away, true); document.removeEventListener('keydown', esc); };
  const away = (e) => { if (!wrap.contains(e.target)) close(); else if (e.target.closest('a')) close(); };
  const esc = (e) => { if (e.key === 'Escape') { close(); btn.focus(); } };
  btn.addEventListener('click', () => { if (!menu.hidden) return close(); menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); document.addEventListener('click', away, true); document.addEventListener('keydown', esc); });
  const wrap = h('span', { class: 'avwrap' }, btn, menu);
  return wrap;
}

/** "Fri, Oct 30 · 2 locations in Michigan · 14 people" */
export function subline(data, today = new Date()) {
  const locs = data.company.locations || [];
  const day = today.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const bits = [day];
  if (data.company.nicheLabel) bits.push(data.company.nicheLabel);
  if (locs.length > 1) bits.push(`${locs.length} locations in ${data.built ? data.built.answers[0] : data.company.state}`);
  else bits.push(data.built ? data.built.answers[0] : data.company.state);
  bits.push(plural(data.team.active, 'person', 'people'));
  return bits.join(' · ');
}

/** One card: its frame (title, width) and what its renderer drew. A renderer that fails does not take the page with it. */
export function cardElement(widget, { config, t, data, dash, tools }) {
  let drawn;
  try {
    drawn = RENDERERS[widget.type]({ data, settings: widget.settings, t, config, dash });
  } catch (e) {
    drawn = { title: widget.type, body: h('div', { class: 'empty' }, 'This card could not be drawn. Edit or remove it.') };
  }
  const el = h('section', { class: `card ${drawn.className || ''}`, style: { '--span': widget.span }, 'data-widget': widget.id, 'data-type': widget.type, 'data-module': widget.settings && widget.settings.module ? widget.settings.module : undefined },
    drawn.head || (drawn.title ? h('div', { class: 'card-head' }, h('h3', { class: 'card-title' }, drawn.title)) : null), drawn.body);
  if (tools) el.append(tools);
  return el;
}
