import { h } from '../dom.js';
import { link, navigate } from '../router.js';
import { Button, toast } from '../ui.js';
import { applyTheme, terms } from '../theme.js';
import { session, signOut } from '../session.js';
import { app, loadApp } from './state.js';
import { RENDERERS } from '../widgets.js';

const tabPath = (tab, config) => (tab.kind === 'settings' ? '/app/settings' : tab.id === config.tabs.find((t) => t.kind === 'page').id ? '/app' : `/app/${tab.id}`);

export function brandMark(brand) {
  if (brand.mark === 'none') return null;
  const cls = brand.mark === 'dot' ? 'dot' : brand.mark === 'bar' ? 'bar' : '';
  return h('span', { class: `brand-mark ${cls}`, 'aria-hidden': 'true' }, brand.mark === 'initial' ? (brand.name.trim()[0] || 'T').toUpperCase() : '');
}

/**
 * Wraps every page of the signed-in app: the company's own theme, name and tabs around whatever the page draws.
 * `config` is the saved dashboard, or the editor's draft, so a theme change shows at once while editing.
 */
export async function appPage(ctx, { active, title, render, config: override, editbar }) {
  await loadApp();
  const config = override || app.dash.config;
  const t = terms(config, app.dash.options.terms);
  const root = h('div', { class: 'dash' });
  applyTheme(root, config.theme, config.brand);

  const tabs = config.tabs.map((tab) => link(tabPath(tab, config), { class: 'dash-tab', 'aria-current': tab.id === active ? 'page' : undefined, 'data-tab': tab.id }, tab.kind === 'settings' || tab.kind === 'help' ? tab.label : tab.id === 'people' ? t('people') : tab.id === 'payroll' ? t('payroll') : tab.id === 'onboarding' ? t('onboarding') : tab.label));
  const head = h('header', { class: 'dash-head' }, h('div', { class: 'inner' },
    link('/app', { class: 'dash-brand' }, brandMark(config.brand), h('span', {}, config.brand.name, config.brand.tagline ? h('small', {}, config.brand.tagline) : null)),
    h('nav', { class: 'dash-tabs', 'aria-label': 'Dashboard' }, ...tabs),
    h('div', { class: 'dash-user' }, h('span', {}, session.user.firstName), h('button', { class: 'btn btn-text btn-sm', type: 'button', onClick: async () => { await signOut(); navigate('/'); } }, 'Sign out'))));
  const main = h('main', { class: 'dash-main', id: 'main' });
  const frame = h('div', { class: 'dash-frame' }, head, h('div', {}, editbar || null, main));
  root.append(frame);
  const out = await render({ root, main, config, t, data: app.data, dash: app.dash });
  if (out) main.append(out);
  return { title: `${title} — ${config.brand.name}`, el: root };
}

/** One card: its frame (title, width) and what its renderer drew. A renderer that fails does not take the page with it. */
export function cardElement(widget, { config, t, data, dash, tools }) {
  let drawn;
  try {
    drawn = RENDERERS[widget.type]({ data, settings: widget.settings, t, config, dash });
  } catch (e) {
    drawn = { title: widget.type, body: h('div', { class: 'empty' }, 'This card could not be drawn. Edit or remove it.') };
  }
  const el = h('section', { class: `card ${drawn.className || ''}`, style: { '--span': widget.span }, 'data-widget': widget.id, 'data-type': widget.type },
    drawn.title ? h('div', { class: 'card-head' }, h('h3', { class: 'card-title' }, drawn.title)) : null, drawn.body);
  if (tools) el.append(tools);
  return el;
}
