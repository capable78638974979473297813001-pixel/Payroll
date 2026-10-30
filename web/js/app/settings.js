import { h } from '../dom.js';
import { appPage } from './shell.js';

// Filled in by the settings phase. The page exists now so the tab works.
export function settingsPage() {
  return async (ctx) => appPage(ctx, { active: 'settings', title: 'Settings', render: () => h('div', {}, h('div', { class: 'ph2' }, h('div', {}, h('h1', { class: 'pt' }, 'Settings'))), h('section', { class: 'card' }, h('p', { style: { margin: 0 } }, 'Settings are coming together here.'))) });
}
