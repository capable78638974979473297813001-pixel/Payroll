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

  const nav = h('header', { class: 'nav ui' },
    Logo({ small: true, href: '/app' }),
    link('/app', { class: 'org', 'aria-label': config.brand.name }, brandMark(config.brand), h('b', {}, config.brand.name), config.brand.tagline ? h('span', { class: 'sub', style: { marginLeft: '2px' } }, config.brand.tagline) : null),
    h('nav', { class: 'tabs', 'aria-label': 'Dashboard' }, ...tabLinks),
    h('span', { class: 'rt2' }, ...rightLinks, h('button', { class: 'av signout-av', type: 'button', title: `${session.user.firstName} ${session.user.lastName} · Sign out`, 'aria-label': 'Sign out', onClick: async () => { await signOut(); navigate('/'); } }, initials(session.user))));
  const main = h('main', { class: 'dash-main wrap ui', id: 'main' });
  const frame = h('div', { class: 'dash-frame' }, nav, h('div', {}, editbar || null, main));
  root.append(frame);
  const out = await render({ root, main, config, t, data: app.data, dash: app.dash });
  if (out) main.append(out);
  return { title: `${title} — ${config.brand.name}`, el: root };
}

/** "Fri, Oct 30 · 2 locations in Michigan · 14 people" */
export function subline(data, today = new Date()) {
  const locs = data.company.locations || [];
  const day = today.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const bits = [day];
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
