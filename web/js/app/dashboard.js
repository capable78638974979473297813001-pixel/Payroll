import { h } from '../dom.js';
import { api } from '../api.js';
import { navigate } from '../router.js';
import { Button, Field, icon, modal, setLoading, toast } from '../ui.js';
import { appPage, cardElement, subline } from './shell.js';
import { importPeopleModal } from './people.js';
import { app, base, loadApp } from './state.js';
import { SWATCHES, LOOKS, accentOnCard } from '../theme.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
const SPAN_LABEL = { 3: '¼', 4: '⅓', 6: '½', 8: '⅔', 12: 'Full' };
const rid = () => `w_${Math.random().toString(36).slice(2, 10).padEnd(8, 'a')}`;
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'tab';
const RESERVED = new Set(['contractors', 'login', 'signup', 'setup', 'join', 'app', 'api', 'run', 'new', 'help', 'settings']);

/** A page of cards: the company's tab, drawn from its saved dashboard, or from the editor's draft while customizing. */
export function dashboardTab() {
  return async (ctx) => {
    await loadApp();
    const wrapper = h('div', {});
    const st = { tabId: ctx.params.tab || app.dash.config.tabs.find((t) => t.kind === 'page').id, editing: false, draft: null, panel: null };
    let drawerEl = null;
    let page = null;

    const cfg = () => (st.editing ? st.draft : app.dash.config);
    const tabOf = (c) => c.tabs.find((t) => t.id === st.tabId && t.kind === 'page') || c.tabs.find((t) => t.kind === 'page');
    const dirty = () => st.editing && JSON.stringify(st.draft) !== JSON.stringify(app.dash.config);
    const def = (type) => app.dash.catalog.find((c) => c.type === type);

    if (ctx.params.tab && !app.dash.config.tabs.some((t) => t.id === ctx.params.tab)) { navigate('/404', { replace: true }); return h('div'); }

    async function draw() {
      const y = window.scrollY;
      const c = cfg();
      const tab = tabOf(c);
      st.tabId = tab.id;
      page = await appPage(ctx, { active: tab.id, title: tab.label, config: c, editbar: st.editing ? editBar() : null, render: ({ config, t, data, dash }) => view(tab, { config, t, data, dash }) });
      wrapper.replaceChildren(page.el);
      wrapper.classList.toggle('editing', st.editing);
      document.title = page.title;
      syncDrawerTheme();
      window.scrollTo(0, y);
    }

    function syncDrawerTheme() {
      const root = wrapper.querySelector('.dash');
      if (!root || !drawerEl) return;
      for (const k of ['mode', 'density', 'cards', 'nav', 'header', 'numbers']) drawerEl.dataset[k] = root.dataset[k];
      drawerEl.style.cssText = root.style.cssText;
    }

    // ------------------------------------------------------------ the page
    function view(tab, { config, t, data, dash }) {
      const grid = h('div', { class: 'grid cards', 'data-testid': 'grid' });
      for (const w of tab.widgets) grid.append(cardElement(w, { config, t, data, dash, tools: st.editing ? tools(tab, w) : null }));
      if (!tab.widgets.length) grid.append(h('div', { class: 'card', style: { '--span': 12 } }, h('div', { class: 'empty' }, st.editing ? 'This tab is empty. Add a card to start.' : 'This tab is empty.', st.editing ? null : [' ', h('button', { class: 'link as-button', type: 'button', onClick: startEdit }, 'Customize')])));
      if (st.editing) grid.append(h('button', { class: 'card add-slot', type: 'button', style: { '--span': 4, alignItems: 'center', justifyContent: 'center', minHeight: '120px', border: '2px dashed var(--d-line)', background: 'none', cursor: 'pointer', color: 'var(--d-muted)', fontWeight: 700 }, onClick: () => openPanel('add') }, '+ Add a card'));
      const first = tab.id === config.tabs.find((x) => x.kind === 'page').id;
      return h('div', {}, h('div', { class: 'ph2' }, h('div', {}, h('h1', { class: 'pt' }, first ? config.brand.name : tab.label), first ? h('p', {}, subline(data)) : null),
        h('div', { class: 'acts' },
          first ? Button({ variant: 'ghost', size: 'sm', href: '/app/onboarding' }, 'Add employee') : null,
          tab.id === 'people' ? Button({ variant: 'ghost', size: 'sm', type: 'button', onClick: importPeopleModal }, 'Import from spreadsheet') : null,
          tab.id === 'people' ? Button({ size: 'sm', href: '/app/onboarding' }, 'Add employee') : null,
          tab.id === 'time' ? Button({ size: 'sm', href: '/app/payroll/run' }, 'Run payroll') : null,
          tab.id === 'payroll' ? Button({ size: 'sm', href: '/app/payroll/run' }, 'Run payroll') : null,
          first ? Button({ size: 'sm', href: '/app/payroll/run' }, t('payroll') === 'Payroll' ? 'Run payroll' : `Run ${t('payroll').toLowerCase()}`) : null,
          st.editing ? null : Button({ variant: 'ghost', size: 'sm', type: 'button', onClick: startEdit, 'data-testid': 'customize' }, 'Customize'))), grid);
    }

    // ------------------------------------------------------------ edit mode
    function startEdit() { st.draft = clone(app.dash.config); st.editing = true; window.addEventListener('beforeunload', guard); draw(); }
    function guard(e) { if (dirty()) { e.preventDefault(); e.returnValue = ''; } }
    function stopEdit() { st.editing = false; st.draft = null; closePanel(); window.removeEventListener('beforeunload', guard); draw(); }

    function editBar() {
      const save = Button({ variant: 'primary', size: 'sm', type: 'button', 'data-testid': 'save-dash' }, 'Save changes');
      save.addEventListener('click', async () => {
        setLoading(save, true);
        try {
          const res = await api.put(`${base()}/dashboard`, { config: st.draft, rev: app.dash.rev });
          app.dash = res; toast('success', 'Dashboard saved.'); stopEdit();
        } catch (e) { toast('error', e.code === 'dashboard_changed' ? 'The dashboard changed somewhere else. Reload to see it.' : e.message); setLoading(save, false); }
      });
      const reset = Button({ variant: 'secondary', size: 'sm', type: 'button', onClick: confirmReset }, 'Start over');
      const undo = app.dash.revisions.length ? Button({ variant: 'secondary', size: 'sm', type: 'button', onClick: confirmUndo }, 'Undo last save') : null;
      return h('div', { class: 'editbar', role: 'toolbar', 'aria-label': 'Customize your dashboard' },
        h('span', { class: 'eb-label' }, 'Customizing your dashboard'),
        Button({ variant: 'secondary', size: 'sm', type: 'button', onClick: () => openPanel('add'), 'data-testid': 'open-add' }, 'Add a card'),
        Button({ variant: 'secondary', size: 'sm', type: 'button', onClick: () => openPanel('theme'), 'data-testid': 'open-theme' }, 'Look'),
        Button({ variant: 'secondary', size: 'sm', type: 'button', onClick: () => openPanel('words'), 'data-testid': 'open-words' }, 'Words'),
        Button({ variant: 'secondary', size: 'sm', type: 'button', onClick: () => openPanel('tabs'), 'data-testid': 'open-tabs' }, 'Tabs'),
        undo, reset,
        Button({ variant: 'secondary', size: 'sm', type: 'button', onClick: cancel, 'data-testid': 'cancel-edit' }, 'Cancel'), save);
    }

    function cancel() {
      if (!dirty()) return stopEdit();
      const m = modal({ title: 'Discard your changes?', body: h('p', { style: { margin: 0 } }, 'Everything you changed since you started customizing will be lost.'), actions: [Button({ variant: 'secondary', onClick: () => m.close() }, 'Keep editing'), Button({ variant: 'primary', onClick: () => { m.close(); stopEdit(); } }, 'Discard changes')] });
    }
    function confirmReset() {
      const m = modal({ title: 'Start over?', body: h('p', { style: { margin: 0 } }, 'Your dashboard goes back to the suggested one for your business: its cards, tabs, look and words. What you have now is kept, so you can undo.'), actions: [Button({ variant: 'secondary', onClick: () => m.close() }, 'Cancel'), Button({ variant: 'primary', onClick: async () => { try { app.dash = await api.post(`${base()}/dashboard/reset`); m.close(); toast('success', 'Back to the suggested dashboard.'); stopEdit(); } catch (e) { toast('error', e.message); } } }, 'Start over')] });
    }
    function confirmUndo() {
      const last = app.dash.revisions[0];
      const m = modal({ title: 'Undo your last save?', body: h('p', { style: { margin: 0 } }, 'Go back to how the dashboard was before you last saved.'), actions: [Button({ variant: 'secondary', onClick: () => m.close() }, 'Cancel'), Button({ variant: 'primary', onClick: async () => { try { app.dash = await api.post(`${base()}/dashboard/revert`, { rev: last.rev }); m.close(); toast('success', 'Reverted.'); stopEdit(); } catch (e) { toast('error', e.message); } } }, 'Undo')] });
    }

    // ------------------------------------------------------------ one card's tools
    function move(tab, id, delta) {
      const i = tab.widgets.findIndex((x) => x.id === id); const j = i + delta;
      if (j < 0 || j >= tab.widgets.length) return;
      [tab.widgets[i], tab.widgets[j]] = [tab.widgets[j], tab.widgets[i]];
      draw();
    }
    function tools(tab, w) {
      const d = def(w.type);
      const i = tab.widgets.findIndex((x) => x.id === w.id);
      const width = h('select', { 'aria-label': `Width of ${d.label}`, 'data-action': 'width', onChange: (e) => { w.span = Number(e.target.value); draw(); } }, ...d.spans.map((s) => h('option', { value: s, selected: s === w.span }, SPAN_LABEL[s] || s)));
      const grip = h('button', { type: 'button', 'aria-label': `Drag ${d.label}`, title: 'Drag to move', class: 'grip', onMouseDown: (e) => { e.currentTarget.closest('.card').draggable = true; } }, icon('grip'));
      return h('div', { class: 'card-tools', role: 'toolbar', 'aria-label': d.label },
        grip, width,
        h('button', { type: 'button', 'aria-label': `Move ${d.label} earlier`, title: 'Move earlier', disabled: i === 0, onClick: () => move(tab, w.id, -1), 'data-action': 'earlier' }, icon('left')),
        h('button', { type: 'button', 'aria-label': `Move ${d.label} later`, title: 'Move later', disabled: i === tab.widgets.length - 1, onClick: () => move(tab, w.id, 1), 'data-action': 'later' }, icon('right')),
        d.settings.length ? h('button', { type: 'button', 'aria-label': `Settings for ${d.label}`, title: 'Settings', onClick: () => cardSettings(tab, w), 'data-action': 'settings' }, icon('plus')) : null,
        h('button', { type: 'button', 'aria-label': `Remove ${d.label}`, title: 'Remove', onClick: () => { tab.widgets = tab.widgets.filter((x) => x.id !== w.id); draw(); }, 'data-action': 'remove' }, icon('x')));
    }

    function cardSettings(tab, w) {
      const d = def(w.type);
      const values = { ...w.settings };
      const fields = d.settings.map((s) => {
        if (s.type === 'toggle') return h('label', { class: 'check' }, h('input', { type: 'checkbox', name: s.key, checked: !!values[s.key], onChange: (e) => { values[s.key] = e.target.checked; } }), h('span', {}, s.label));
        if (w.type === 'state_card' && s.key === 'state') return h('div', {}, h('span', { class: 'field-lab' }, s.label), h('select', { class: 'in', name: s.key, onChange: (e) => { values.state = e.target.value; } }, ...app.dash.states.map((c) => h('option', { value: c, selected: c === values.state }, c))));
        if (s.type === 'select') return h('div', {}, h('span', { class: 'field-lab' }, s.label), h('select', { class: 'in', name: s.key, onChange: (e) => { values[s.key] = e.target.value; } }, ...s.options.map((o) => h('option', { value: o.value, selected: o.value === values[s.key] }, o.label))));
        if (s.type === 'multi') return h('div', {}, h('span', { class: 'field-lab' }, s.label), h('div', { class: 'stack', style: { '--gap': '8px' } }, ...s.options.map((o) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: (values[s.key] || []).includes(o.value), onChange: (e) => { const set = new Set(values[s.key] || []); e.target.checked ? set.add(o.value) : set.delete(o.value); values[s.key] = [...set]; } }), h('span', {}, o.label)))));
        if (s.type === 'number') return h('div', {}, h('span', { class: 'field-lab' }, s.label), h('input', { class: 'in', name: s.key, type: 'number', min: s.min, max: s.max, value: String(values[s.key]), onInput: (e) => { values[s.key] = Math.floor(Number(e.target.value)); } }));
        return h('div', {}, h('span', { class: 'field-lab' }, s.label), (s.maxLength || 0) > 100 ? h('textarea', { class: 'in', name: s.key, rows: 5, maxlength: s.maxLength, onInput: (e) => { values[s.key] = e.target.value; } }, values[s.key] || '') : h('input', { class: 'in', name: s.key, type: 'text', maxlength: s.maxLength, value: values[s.key] || '', onInput: (e) => { values[s.key] = e.target.value; } }));
      });
      const pages = st.draft.tabs.filter((x) => x.kind === 'page');
      let target = tab.id;
      const mv = pages.length > 1 ? h('div', {}, h('span', { class: 'field-lab' }, 'Show on tab'), h('select', { class: 'in', onChange: (e) => { target = e.target.value; } }, ...pages.map((p) => h('option', { value: p.id, selected: p.id === tab.id }, p.label)))) : null;
      const apply = Button({ variant: 'primary', 'data-testid': 'card-done' }, 'Done');
      const m = modal({ title: d.label, body: h('div', { class: 'dash stack', style: { '--gap': '20px', background: 'transparent' } }, h('p', { class: 'muted', style: { margin: 0 } }, d.description), ...fields, mv), actions: [Button({ variant: 'secondary', onClick: () => m.close() }, 'Cancel'), apply] });
      apply.addEventListener('click', () => {
        w.settings = values;
        if (target !== tab.id) { tab.widgets = tab.widgets.filter((x) => x.id !== w.id); st.draft.tabs.find((x) => x.id === target).widgets.push(w); }
        m.close(); draw();
      });
    }

    // ------------------------------------------------------------ drag and drop
    wrapper.addEventListener('dragstart', (e) => { const card = e.target.closest && e.target.closest('.card[data-widget]'); if (!card || !st.editing) return; e.dataTransfer.setData('text/plain', card.dataset.widget); e.dataTransfer.effectAllowed = 'move'; card.classList.add('dragging'); });
    wrapper.addEventListener('dragend', (e) => { const card = e.target.closest && e.target.closest('.card'); if (card) { card.draggable = false; card.classList.remove('dragging'); } wrapper.querySelectorAll('.drop-before,.drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after')); });
    const dropSide = (card, e) => { const r = card.getBoundingClientRect(); return Number(card.style.getPropertyValue('--span')) >= 12 ? e.clientY < r.top + r.height / 2 : e.clientX < r.left + r.width / 2; };
    wrapper.addEventListener('dragover', (e) => {
      const card = e.target.closest && e.target.closest('.card[data-widget]');
      if (!card || !st.editing) return;
      e.preventDefault();
      wrapper.querySelectorAll('.drop-before,.drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
      card.classList.add(dropSide(card, e) ? 'drop-before' : 'drop-after');
    });
    wrapper.addEventListener('drop', (e) => {
      const card = e.target.closest && e.target.closest('.card[data-widget]');
      if (!card || !st.editing) return;
      e.preventDefault();
      const id = e.dataTransfer.getData('text/plain');
      const tab = tabOf(st.draft);
      const from = tab.widgets.findIndex((x) => x.id === id);
      if (from < 0 || id === card.dataset.widget) return draw();
      const before = dropSide(card, e);
      const [item] = tab.widgets.splice(from, 1);
      let to = tab.widgets.findIndex((x) => x.id === card.dataset.widget);
      if (!before) to += 1;
      tab.widgets.splice(to, 0, item);
      draw();
    });

    // ------------------------------------------------------------ the drawer: add cards, look, words, tabs
    function closePanel() { st.panel = null; if (drawerEl) { drawerEl.remove(); drawerEl = null; } }
    function openPanel(name) {
      st.panel = name;
      if (drawerEl) drawerEl.remove();
      drawerEl = h('aside', { class: 'dash drawer', role: 'dialog', 'aria-label': { add: 'Add a card', theme: 'Look', words: 'Words', tabs: 'Tabs' }[name], 'data-panel': name });
      syncDrawerTheme();
      document.body.append(drawerEl);
      renderPanel();
    }
    const optGrid = (options, current, onPick, label) => h('div', { class: 'opt-grid', role: 'group', 'aria-label': label }, ...options.map((o) => h('button', { class: 'sel-opt', type: 'button', 'aria-pressed': String(String(o.value) === String(current)), 'data-value': o.value, onClick: () => { onPick(o.value); renderPanel(); draw(); } }, o.label)));

    function renderPanel() {
      if (!drawerEl) return;
      const c = st.draft;
      const title = { add: 'Add a card', theme: 'Look', words: 'Words', tabs: 'Tabs' }[st.panel];
      const body = st.panel === 'add' ? addPanel(c) : st.panel === 'theme' ? themePanel(c) : st.panel === 'words' ? wordsPanel(c) : tabsPanel(c);
      drawerEl.replaceChildren(h('div', { class: 'drawer-head' }, h('h2', {}, title), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close panel', onClick: closePanel }, icon('x'))), h('div', { class: 'drawer-body' }, body));
    }

    function addPanel(c) {
      const tab = tabOf(c);
      const cats = [...new Set(app.dash.catalog.map((x) => x.category))];
      return h('div', { class: 'stack', style: { '--gap': '20px' } }, h('p', { class: 'sub', style: { margin: 0 } }, `Adds to the ${tab.label} tab.`), ...cats.map((cat) => h('div', { class: 'stack', style: { '--gap': '8px' } }, h('span', { class: 'field-lab' }, cat), ...app.dash.catalog.filter((x) => x.category === cat).map((x) => h('button', { class: 'add-card', type: 'button', disabled: !x.available, 'data-add': x.type, onClick: () => {
        const settings = Object.fromEntries(x.settings.map((s) => [s.key, x.type === 'state_card' && s.key === 'state' ? app.dash.states[0] : s.default]));
        const id = rid();
        tab.widgets.push({ id, type: x.type, span: x.defaultSpan, settings });
        toast('success', `${x.label} added.`); draw();
        setTimeout(() => { const el = wrapper.querySelector(`[data-widget="${id}"]`); if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 50);
      } }, h('b', {}, x.label), h('span', {}, x.available ? x.description : x.reason))))));
    }

    function colorField(label, key) {
      const th = st.draft.theme;
      const warnEl = h('div', { class: 'warnline', role: 'status' });
      const warn = () => { const r = accentOnCard(th); warnEl.textContent = key === 'accent' && r < 3 ? `This color is hard to read as numbers on your cards (${r.toFixed(1)} to 1). Pick a darker one, or change the mode.` : ''; };
      const hexIn = h('input', { class: 'in', type: 'text', value: th[key], maxlength: 7, 'aria-label': `${label} hex`, style: { width: '110px' }, onInput: (e) => { const v = e.target.value.trim(); if (/^#[0-9a-fA-F]{6}$/.test(v)) { th[key] = v.toLowerCase(); draw(); warn(); } } });
      const pick = h('input', { type: 'color', value: th[key], 'aria-label': `${label} picker`, style: { width: '44px', height: '40px', padding: 0, border: 0, background: 'none' }, onInput: (e) => { th[key] = e.target.value; hexIn.value = e.target.value; draw(); warn(); } });
      warn();
      return h('div', { class: 'stack', style: { '--gap': '8px' } }, h('span', { class: 'field-lab' }, label),
        h('div', { class: 'swatches' }, ...SWATCHES.map((s) => h('button', { class: 'swatch', type: 'button', style: { background: s }, 'aria-label': `${label} ${s}`, 'aria-pressed': String(th[key] === s), 'data-color': s, onClick: () => { th[key] = s; renderPanel(); draw(); } }))),
        h('div', { class: 'hrow', style: { gap: '8px' } }, pick, hexIn), warnEl);
    }

    function themePanel(c) {
      const th = c.theme; const o = app.dash.options;
      const pick = (key) => (v) => { th[key] = key === 'radius' ? Number(v) : v; };
      return h('div', { class: 'stack', style: { '--gap': '24px' } },
        Button({ variant: 'secondary', size: 'md', type: 'button', 'data-testid': 'surprise', onClick: () => { Object.assign(th, LOOKS[Math.floor(Math.random() * LOOKS.length)]); renderPanel(); draw(); } }, 'Surprise me'),
        colorField('Main color', 'accent'), colorField('Second color', 'accent2'),
        h('div', {}, h('span', { class: 'field-lab' }, 'Mode'), optGrid(o.modes, th.mode, pick('mode'), 'Mode')),
        h('div', {}, h('span', { class: 'field-lab' }, 'Text'), optGrid(o.fonts, th.font, pick('font'), 'Text font')),
        h('div', {}, h('span', { class: 'field-lab' }, 'Headings'), optGrid(o.fonts, th.headingFont, pick('headingFont'), 'Heading font')),
        h('div', {}, h('span', { class: 'field-lab' }, 'Corners'), optGrid(o.radii.map((r) => ({ value: r, label: r === 0 ? 'Square' : r >= 24 ? 'Round' : `${r}px` })), th.radius, pick('radius'), 'Corners')),
        h('div', {}, h('span', { class: 'field-lab' }, 'Spacing'), optGrid(o.densities, th.density, pick('density'), 'Spacing')),
        h('div', {}, h('span', { class: 'field-lab' }, 'Cards'), optGrid(o.cardStyles, th.cardStyle, pick('cardStyle'), 'Card style')),
        h('div', {}, h('span', { class: 'field-lab' }, 'Navigation'), optGrid(o.navs, th.nav, pick('nav'), 'Navigation')),
        h('div', {}, h('span', { class: 'field-lab' }, 'Header'), optGrid(o.headers, th.header, pick('header'), 'Header')),
        h('div', {}, h('span', { class: 'field-lab' }, 'Numbers'), optGrid(o.numbers, th.numbers, pick('numbers'), 'Numbers')));
    }

    function wordsPanel(c) {
      const o = app.dash.options;
      const name = Field({ label: 'Name in the header', name: 'brandName', value: c.brand.name, onInput: (v) => { if (v.trim()) { c.brand.name = v.trim(); draw(); } } });
      const tag = Field({ label: 'A line under it', name: 'tagline', value: c.brand.tagline, placeholder: 'Optional', onInput: (v) => { c.brand.tagline = v; draw(); } });
      return h('div', { class: 'stack', style: { '--gap': '20px' } }, name.el, tag.el,
        h('div', {}, h('span', { class: 'field-lab' }, 'Mark'), optGrid(o.marks, c.brand.mark, (v) => { c.brand.mark = v; }, 'Mark')),
        h('div', { class: 'stack', style: { '--gap': '12px' } }, h('span', { class: 'field-lab' }, 'Your own words'), h('p', { class: 'sub', style: { margin: 0 } }, 'Call things what you call them: crew, brigade, front of house.'),
          ...Object.entries(o.terms).map(([key, tm]) => Field({ label: tm.label, name: `term_${key}`, value: c.terms[key] || '', placeholder: tm.default, maxlength: 24, onInput: (v) => { const w = v.trim(); if (w) c.terms[key] = w; else delete c.terms[key]; draw(); } }).el)));
    }

    function tabsPanel(c) {
      const list = h('div', { class: 'stack', style: { '--gap': '8px' } });
      const rows = () => list.replaceChildren(...c.tabs.map((tab, i) => {
        const fixed = tab.kind !== 'page';
        const input = h('input', { class: 'in', value: tab.label, maxlength: 24, 'aria-label': `Name of tab ${i + 1}`, onInput: (e) => { if (e.target.value.trim()) { tab.label = e.target.value.trim(); draw(); } } });
        const mv = (d) => { const j = i + d; if (j < 0 || j >= c.tabs.length) return; [c.tabs[i], c.tabs[j]] = [c.tabs[j], c.tabs[i]]; rows(); draw(); };
        return h('div', { class: 'tab-row', 'data-tab-row': tab.id }, input,
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Move ${tab.label} up`, disabled: i === 0, onClick: () => mv(-1) }, icon('up')),
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Move ${tab.label} down`, disabled: i === c.tabs.length - 1, onClick: () => mv(1) }, icon('down')),
          tab.kind === 'settings' ? h('span', { class: 'sub', title: 'Settings always stays' }, 'Fixed') : tab.kind === 'help' ? h('span', {}) : h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Remove ${tab.label}`, disabled: c.tabs.filter((x) => x.kind === 'page').length <= 1, onClick: () => {
            if (tab.widgets.length && !window.confirm(`Remove ${tab.label} and its ${tab.widgets.length} cards?`)) return;
            c.tabs.splice(i, 1); rows(); draw();
          } }, icon('x')));
        void fixed;
      }));
      rows();
      const nameIn = Field({ label: 'New tab', name: 'newTab', placeholder: 'Bar, Banquets, Weekend' });
      const add = Button({ variant: 'secondary', size: 'md', type: 'button', 'data-testid': 'add-tab' }, icon('plus'), 'Add a tab');
      add.addEventListener('click', () => {
        const label = nameIn.value.trim();
        if (!label) return nameIn.setError('Give the tab a name.');
        let id = slug(label); if (RESERVED.has(id)) id = `${id}-tab`;
        let n = 2; const first = id; while (c.tabs.some((x) => x.id === id)) id = `${first}-${n++}`;
        const at = c.tabs.findIndex((x) => x.kind !== 'page');
        c.tabs.splice(at < 0 ? c.tabs.length : at, 0, { id, label, kind: 'page', widgets: [] });
        nameIn.value = ''; rows(); st.tabId = id; draw();
      });
      const helpOn = c.tabs.some((x) => x.kind === 'help');
      return h('div', { class: 'stack', style: { '--gap': '20px' } }, list, h('div', { class: 'stack', style: { '--gap': '8px' } }, nameIn.el, add),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: helpOn, onChange: (e) => { if (e.target.checked) c.tabs.splice(c.tabs.length - 1, 0, { id: 'help', label: 'Help', kind: 'help', widgets: [] }); else c.tabs = c.tabs.filter((x) => x.kind !== 'help'); renderPanel(); draw(); } }), h('span', {}, 'Show a Help tab')));
    }

    await draw();
    return { title: page.title, el: wrapper, cleanup: () => { window.removeEventListener('beforeunload', guard); closePanel(); } };
  };
}
