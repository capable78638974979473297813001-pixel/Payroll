import { newId } from '../lib/ids.ts';
import { conflict, notFound } from '../lib/errors.ts';
import type { Store } from '../store/store.ts';
import type { Company } from '../domain/types.ts';
import { availabilityFor, defaultConfig } from './defaults.ts';
import { validateConfig, widgetAvailable, type DashboardConfig } from './schema.ts';
import { WIDGETS, TERMS, FONTS, MODES, CARD_STYLES, DENSITIES, NAVS, HEADERS, NUMBER_STYLES, MARKS, RADII } from './widgets.ts';

export interface DashboardDoc {
  /** The company's id: one dashboard per company. */
  id: string;
  rev: number;
  config: DashboardConfig;
  updatedAt: string;
  /** The last revisions, newest first, so a change can be undone. */
  history: Array<{ rev: number; at: string; config: DashboardConfig }>;
}

const KEEP = 20;

export class DashboardService {
  private readonly store: Store;
  private readonly now: () => Date;
  constructor(store: Store, now: () => Date = () => new Date()) {
    this.store = store;
    this.now = now;
  }

  private date(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private company(companyId: string): Company {
    return this.store.companies.require(companyId, 'Company');
  }

  /** The dashboard, created from the business's answers the first time it is asked for. */
  get(companyId: string): DashboardDoc {
    const existing = this.store.dashboards.get(companyId);
    if (existing) return existing;
    const company = this.company(companyId);
    const a = availabilityFor(company, this.date());
    const config = validateConfig(defaultConfig(company, a), a);
    return this.store.tx(() => this.store.dashboards.put({ id: companyId, rev: 1, config, updatedAt: this.now().toISOString(), history: [] }));
  }

  /** Everything the editor needs: the dashboard, and what could be put on it. */
  describe(companyId: string) {
    const doc = this.get(companyId);
    const company = this.company(companyId);
    const a = availabilityFor(company, this.date());
    return {
      rev: doc.rev,
      config: doc.config,
      updatedAt: doc.updatedAt,
      revisions: doc.history.map((h) => ({ rev: h.rev, at: h.at })),
      catalog: WIDGETS.map((wd) => ({ ...wd, available: widgetAvailable(wd.type, a), ...(widgetAvailable(wd.type, a) ? {} : { reason: `Needs ${wd.needsLabel ?? 'a part of your business you did not set up'}` }) })),
      states: a.states,
      options: { terms: TERMS, fonts: FONTS, modes: MODES, cardStyles: CARD_STYLES, densities: DENSITIES, navs: NAVS, headers: HEADERS, numbers: NUMBER_STYLES, marks: MARKS, radii: RADII },
    };
  }

  /**
   * Save a new dashboard. `expectedRev` is the revision the editor started from, so two people editing at once
   * cannot silently overwrite each other.
   */
  save(companyId: string, raw: unknown, expectedRev: unknown) {
    const doc = this.get(companyId);
    if (typeof expectedRev !== 'number' || expectedRev !== doc.rev) throw conflict('dashboard_changed', 'Someone changed the dashboard while you were editing. Reload to see their changes.', { rev: doc.rev });
    const company = this.company(companyId);
    const a = availabilityFor(company, this.date());
    const config = validateConfig(raw, a);
    return this.write(doc, config);
  }

  private write(doc: DashboardDoc, config: DashboardConfig) {
    const at = this.now().toISOString();
    const history = [{ rev: doc.rev, at: doc.updatedAt, config: doc.config }, ...doc.history].slice(0, KEEP);
    this.store.tx(() => this.store.dashboards.put({ id: doc.id, rev: doc.rev + 1, config, updatedAt: at, history }));
    return this.describe(doc.id);
  }

  /** Go back to the starting dashboard for what the business has. The current one is kept in the history. */
  reset(companyId: string) {
    const doc = this.get(companyId);
    const company = this.company(companyId);
    const a = availabilityFor(company, this.date());
    return this.write(doc, validateConfig(defaultConfig(company, a), a));
  }

  /** Restore an earlier revision. Cards the business no longer has are dropped rather than refusing the restore. */
  revert(companyId: string, rev: unknown) {
    const doc = this.get(companyId);
    const old = doc.history.find((h) => h.rev === rev);
    if (!old) throw notFound('Revision');
    const company = this.company(companyId);
    const a = availabilityFor(company, this.date());
    const cleaned = { ...old.config, tabs: old.config.tabs.map((t) => ({ ...t, widgets: t.widgets.filter((x) => widgetAvailable(x.type, a)) })) };
    return this.write(doc, validateConfig(cleaned, a));
  }
}

export const newWidgetId = () => `w_${newId('x').slice(-8).toLowerCase().replace(/[^a-z0-9]/g, 'a')}`;
