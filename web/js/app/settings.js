import { h } from '../dom.js';
import { appPage } from './shell.js';

// Filled in by the settings phase. The page exists now so the tab works.
export function settingsPage() {
  return async (ctx) => appPage(ctx, { active: 'settings', title: 'Settings', render: () => h('div', { class: 'stack', style: { '--gap': '16px' } }, h('div', { class: 'dash-title' }, h('h1', {}, 'Settings')), h('section', { class: 'card', style: { '--span': 12 } }, h('p', { style: { margin: 0 } }, 'Settings are coming together here.'))) });
}
