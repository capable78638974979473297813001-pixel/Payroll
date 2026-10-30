import { badRequest } from '../lib/errors.ts';
import { CARD_STYLES, DENSITIES, FONTS, HEADERS, MARKS, MODES, NAVS, NUMBER_STYLES, RADII, TERMS, WIDGET_BY_TYPE, type SettingDef } from './widgets.ts';

export interface DashboardWidget {
  id: string;
  type: string;
  /** Width in columns of 12. */
  span: number;
  settings: Record<string, string | number | boolean | string[]>;
}

export type TabKind = 'page' | 'help' | 'settings';

export interface DashboardTab {
  id: string;
  label: string;
  kind: TabKind;
  widgets: DashboardWidget[];
}

export interface DashboardTheme {
  mode: string;
  accent: string;
  accent2: string;
  font: string;
  headingFont: string;
  radius: number;
  density: string;
  cardStyle: string;
  nav: string;
  header: string;
  numbers: string;
}

export interface DashboardConfig {
  version: 1;
  brand: { name: string; tagline: string; mark: string };
  theme: DashboardTheme;
  terms: Record<string, string>;
  tabs: DashboardTab[];
}

export const LIMITS = { tabs: 12, widgetsPerTab: 40, widgetsTotal: 150, bytes: 80_000 };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const HEX = /^#[0-9a-f]{6}$/;
const ID = /^[a-z0-9_-]{1,40}$/;
/** Tab ids become part of the address (/app/<id>), so they cannot collide with pages that live there. */
const RESERVED_TAB_IDS = new Set(['contractors', 'login', 'signup', 'setup', 'join', 'app', 'api', 'run', 'new']);

/** Printable text with no markup characters. Everything a person can type into a dashboard goes through this. */
function plain(v: unknown, path: string, max: number, { allowEmpty = false, freeText = false }: { allowEmpty?: boolean; freeText?: boolean } = {}): string {
  if (typeof v !== 'string') throw badRequest(`${path} must be text.`, { path });
  const t = freeText ? v.trim() : v.trim().replace(/[ \t]+/g, ' ');
  if (!allowEmpty && t === '') throw badRequest(`${path} cannot be empty.`, { path });
  if (t.length > max) throw badRequest(`${path} is longer than ${max} characters.`, { path });
  if ((freeText ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f<>]/).test(t)) throw badRequest(`${path} has characters we can't accept.`, { path });
  return t;
}

function oneOf(v: unknown, path: string, list: Array<{ value: string }>): string {
  if (typeof v !== 'string' || !list.some((x) => x.value === v)) throw badRequest(`${path} must be one of: ${list.map((x) => x.value).join(', ')}.`, { path });
  return v;
}

export function hex(v: unknown, path: string): string {
  if (typeof v !== 'string' || !HEX.test(v.toLowerCase())) throw badRequest(`${path} must be a color like #1f3bff.`, { path });
  return v.toLowerCase();
}

function settingValue(def: SettingDef, v: unknown, path: string): string | number | boolean | string[] {
  switch (def.type) {
    case 'toggle':
      if (typeof v !== 'boolean') throw badRequest(`${path} must be on or off.`, { path });
      return v;
    case 'number':
      if (typeof v !== 'number' || !Number.isInteger(v) || v < (def.min ?? 0) || v > (def.max ?? 1000)) throw badRequest(`${path} must be a whole number from ${def.min ?? 0} to ${def.max ?? 1000}.`, { path });
      return v;
    case 'select':
      return oneOf(v, path, def.options ?? []);
    case 'text':
      return plain(v, path, def.maxLength ?? 120, { allowEmpty: true, freeText: def.freeText === true });
    case 'multi': {
      if (!Array.isArray(v) || v.length > (def.options?.length ?? 10)) throw badRequest(`${path} must be a list.`, { path });
      const out: string[] = [];
      for (const x of v) {
        const o = oneOf(x, path, def.options ?? []);
        if (!out.includes(o)) out.push(o);
      }
      return out;
    }
  }
}

export interface Availability {
  /** Is the module or item (or a `prefix_*` pattern) part of this business? */
  has(id: string): boolean;
  /** The business's state codes, home state first. */
  states: string[];
}

/** Does the business have what a widget needs? */
export function widgetAvailable(type: string, a: Availability): boolean {
  const def = WIDGET_BY_TYPE[type];
  if (!def) return false;
  if (!def.needs) return true;
  return def.needs.some((n) => a.has(n));
}

function validateWidget(raw: unknown, path: string, a: Availability): DashboardWidget {
  if (!isObj(raw)) throw badRequest(`${path} is not a card.`, { path });
  const id = typeof raw.id === 'string' && /^w_[a-z0-9]{4,16}$/.test(raw.id) ? raw.id : null;
  if (!id) throw badRequest(`${path}.id must look like w_abc123.`, { path });
  const def = typeof raw.type === 'string' ? WIDGET_BY_TYPE[raw.type] : undefined;
  if (!def) throw badRequest(`${path}.type is not a card Totali has.`, { path });
  if (!widgetAvailable(def.type, a)) throw badRequest(`${def.label} needs ${def.needsLabel ?? 'a part of the business you did not set up'}.`, { path, widget: def.type });
  const span = raw.span;
  if (typeof span !== 'number' || !def.spans.includes(span)) throw badRequest(`${def.label} can be ${def.spans.join(', ')} columns wide.`, { path });
  const given = raw.settings === undefined ? {} : raw.settings;
  if (!isObj(given)) throw badRequest(`${path}.settings must be an object.`, { path });
  for (const k of Object.keys(given)) if (!def.settings.some((s) => s.key === k)) throw badRequest(`${def.label} has no setting called ${k}.`, { path: `${path}.settings.${k}` });
  const settings: DashboardWidget['settings'] = {};
  for (const s of def.settings) settings[s.key] = given[s.key] === undefined ? s.default : settingValue(s, given[s.key], `${path}.settings.${s.key}`);
  if (def.type === 'state_card') {
    const st = String(settings.state || '').toUpperCase() || a.states[0] || '';
    if (!a.states.includes(st)) throw badRequest(`State card: ${st || 'that state'} is not one of your states.`, { path });
    settings.state = st;
  }
  return { id, type: def.type, span, settings };
}

/** Check a whole dashboard. Returns the cleaned config; throws a message the editor can show. Unknown keys are refused, not ignored. */
export function validateConfig(raw: unknown, a: Availability): DashboardConfig {
  if (!isObj(raw)) throw badRequest('The dashboard must be an object.');
  if (JSON.stringify(raw).length > LIMITS.bytes) throw badRequest('That dashboard is too large.');
  if (raw.version !== 1) throw badRequest('Unsupported dashboard version.');
  const allowed = new Set(['version', 'brand', 'theme', 'terms', 'tabs', 'rev']);
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw badRequest(`Unknown dashboard field ${k}.`, { path: k });

  const b = raw.brand;
  if (!isObj(b)) throw badRequest('brand is missing.');
  const brand = { name: plain(b.name, 'brand.name', 60), tagline: plain(b.tagline ?? '', 'brand.tagline', 100, { allowEmpty: true }), mark: oneOf(b.mark, 'brand.mark', MARKS) };

  const t = raw.theme;
  if (!isObj(t)) throw badRequest('theme is missing.');
  const radius = t.radius;
  if (typeof radius !== 'number' || !RADII.includes(radius)) throw badRequest(`theme.radius must be one of ${RADII.join(', ')}.`, { path: 'theme.radius' });
  const theme: DashboardTheme = {
    mode: oneOf(t.mode, 'theme.mode', MODES),
    accent: hex(t.accent, 'theme.accent'),
    accent2: hex(t.accent2, 'theme.accent2'),
    font: oneOf(t.font, 'theme.font', FONTS),
    headingFont: oneOf(t.headingFont, 'theme.headingFont', FONTS),
    radius,
    density: oneOf(t.density, 'theme.density', DENSITIES),
    cardStyle: oneOf(t.cardStyle, 'theme.cardStyle', CARD_STYLES),
    nav: oneOf(t.nav, 'theme.nav', NAVS),
    header: oneOf(t.header, 'theme.header', HEADERS),
    numbers: oneOf(t.numbers, 'theme.numbers', NUMBER_STYLES),
  };

  const terms: Record<string, string> = {};
  if (raw.terms !== undefined) {
    if (!isObj(raw.terms)) throw badRequest('terms must be an object.');
    for (const [k, v] of Object.entries(raw.terms)) {
      if (!TERMS[k]) throw badRequest(`${k} is not a word you can rename.`, { path: `terms.${k}` });
      const word = plain(v, `terms.${k}`, 24, { allowEmpty: true });
      if (word && word !== TERMS[k]!.default) terms[k] = word;
    }
  }

  if (!Array.isArray(raw.tabs) || raw.tabs.length < 1 || raw.tabs.length > LIMITS.tabs) throw badRequest(`A dashboard has 1 to ${LIMITS.tabs} tabs.`);
  const tabs: DashboardTab[] = [];
  const widgetIds = new Set<string>();
  const tabIds = new Set<string>();
  let total = 0;
  for (const [i, rt] of raw.tabs.entries()) {
    const p = `tabs[${i}]`;
    if (!isObj(rt)) throw badRequest(`${p} is not a tab.`);
    if (typeof rt.id !== 'string' || !ID.test(rt.id)) throw badRequest(`${p}.id is not valid.`, { path: p });
    if (tabIds.has(rt.id)) throw badRequest(`Two tabs share the id ${rt.id}.`, { path: p });
    tabIds.add(rt.id);
    if (RESERVED_TAB_IDS.has(rt.id)) throw badRequest(`${rt.id} is a name Totali uses for something else. Pick another name for the tab.`, { path: p });
    const kind = rt.kind === 'page' || rt.kind === 'help' || rt.kind === 'settings' ? rt.kind : null;
    if (!kind) throw badRequest(`${p}.kind must be page, help or settings.`, { path: p });
    if ((kind === 'settings') !== (rt.id === 'settings') || (kind === 'help') !== (rt.id === 'help')) throw badRequest('The Settings and Help tabs keep their own names.', { path: p });
    const label = plain(rt.label, `${p}.label`, 24);
    const rawWidgets = rt.widgets === undefined ? [] : rt.widgets;
    if (!Array.isArray(rawWidgets) || rawWidgets.length > LIMITS.widgetsPerTab) throw badRequest(`A tab holds up to ${LIMITS.widgetsPerTab} cards.`, { path: p });
    if (kind !== 'page' && rawWidgets.length > 0) throw badRequest(`The ${kind} tab does not hold cards.`, { path: p });
    const widgets = rawWidgets.map((w, j) => validateWidget(w, `${p}.widgets[${j}]`, a));
    for (const w of widgets) {
      if (widgetIds.has(w.id)) throw badRequest(`Two cards share the id ${w.id}.`, { path: p });
      widgetIds.add(w.id);
    }
    total += widgets.length;
    tabs.push({ id: rt.id, label, kind, widgets });
  }
  if (total > LIMITS.widgetsTotal) throw badRequest(`A dashboard holds up to ${LIMITS.widgetsTotal} cards.`);
  // Settings must always be reachable, or an owner could lock themselves out of editing.
  if (tabs.filter((x) => x.kind === 'settings').length !== 1) throw badRequest('A dashboard needs exactly one Settings tab.');
  if (tabs.filter((x) => x.kind === 'help').length > 1) throw badRequest('A dashboard can have one Help tab.');
  if (!tabs.some((x) => x.kind === 'page')) throw badRequest('A dashboard needs at least one page of cards.');
  return { version: 1, brand, theme, terms, tabs };
}
