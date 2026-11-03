import { createHash } from 'node:crypto';
import { conflict } from '../lib/errors.ts';
import type { Store } from '../store/store.ts';

/** Restaurant app runs must come from a connected, reconciled labor source. API-only employers retain their existing workflow. */
export function posPayrollReadiness(store: Store, companyId: string, from: string, to: string) {
  const company = store.companies.require(companyId, 'Company');
  const connection = store.posConnections.where(c => c.companyId === companyId)[0];
  const required = Boolean(company.setup);
  const reasons: Array<{ code: string; message: string; to: string }> = [];
  const connected = Boolean(connection && connection.provider !== 'file');
  if (!connected) reasons.push({ code: 'pos_required', message: 'Connect your POS or 7shifts before running payroll.', to: '/app/settings/pos' });
  else {
    const summary = connection!.lastSummary;
    if (connection!.lastError) reasons.push({ code: 'pos_sync_failed', message: 'The last import failed. Sync this pay period again.', to: '/app/payroll/run' });
    if (!summary || summary.from > from || summary.to < to) reasons.push({ code: 'pos_period_missing', message: 'Import the entire selected pay period from your connected system.', to: '/app/payroll/run' });
    if (summary?.unmapped.length) reasons.push({ code: 'pos_unmatched', message: `${summary.unmapped.length} POS employees need matching. Match them, then sync again.`, to: '/app/settings/pos' });
    if (summary?.problems.length) reasons.push({ code: 'pos_import_issues', message: 'Resolve the import exceptions and sync again.', to: '/app/settings/pos' });
    const prefix = `pos:${connection!.provider}:`;
    if (store.shifts.where(s => s.companyId === companyId && s.workDate >= from && s.workDate <= to && !s.lockedByRunId && !(s.externalId ?? '').startsWith(prefix)).length) reasons.push({ code: 'pos_manual_time', message: 'This period contains time outside the connected source. Reconcile it before payroll.', to: '/app/time' });
  }
  return { required, connected, provider: connection?.provider ?? null, label: connection?.label ?? null, lastSyncAt: connection?.lastSyncAt ?? null, ready: reasons.length === 0, reasons };
}

export function assertPosPayrollReady(store: Store, companyId: string, from: string, to: string) {
  const readiness = posPayrollReadiness(store, companyId, from, to);
  if (readiness.required && !readiness.ready) throw conflict('pos_not_ready', readiness.reasons[0]!.message, { readiness });
}

/** Only this company's imported labor; no credentials, SSNs or bank details are returned. */
export function posWorkspace(store: Store, companyId: string, from: string, to: string) {
  const readiness = posPayrollReadiness(store, companyId, from, to);
  const conn = store.posConnections.where(c => c.companyId === companyId)[0];
  const prefix = conn ? `pos:${conn.provider}:` : '';
  const company = store.companies.require(companyId, 'Company');
  const roles = new Map(company.settings.roles.map(r => [r.key, r.label]));
  const employees = new Map(store.employees.where(e => e.companyId === companyId).map(e => [e.id, e]));
  const shifts = prefix ? store.shifts.where(s => s.companyId === companyId && s.workDate >= from && s.workDate <= to && (s.externalId ?? '').startsWith(prefix)).sort((a,b) => b.workDate.localeCompare(a.workDate) || a.employeeId.localeCompare(b.employeeId)) : [];
  const rows = shifts.map(s => { const employee = employees.get(s.employeeId); return { id: s.id, sourceId: s.externalId, employeeId: s.employeeId, name: employee ? `${employee.firstName} ${employee.lastName}` : s.employeeId, role: roles.get(s.roleKey) ?? s.roleKey, location: employee?.location ?? null, workDate: s.workDate, clockIn: s.clockIn ?? null, clockOut: s.clockOut ?? null, minutes: s.minutes, cardTipsCents: s.chargedTipsCents, cashTipsCents: s.cashTipsCents, locked: Boolean(s.lockedByRunId) }; });
  return { from, to, readiness, summary: conn?.lastSummary ?? null, totals: { shifts: rows.length, people: new Set(rows.map(r => r.employeeId)).size, minutes: rows.reduce((s,r)=>s+r.minutes,0), cardTipsCents: rows.reduce((s,r)=>s+r.cardTipsCents,0), cashTipsCents: rows.reduce((s,r)=>s+r.cashTipsCents,0) }, rows, availableData: ['Employees', 'Timecards', 'Hours', 'Reported tips'], unavailableData: ['Sales', 'Orders', 'Inventory'] };
}

/** A reviewed run must still refer to the same POS import and employee mapping at approval. */
export function posRevision(store: Store, companyId: string, from: string, to: string): string | undefined {
  if (!store.companies.require(companyId, 'Company').setup) return undefined;
  const connection = store.posConnections.where(c => c.companyId === companyId)[0];
  const shifts = store.shifts.where(s => s.companyId === companyId && s.workDate >= from && s.workDate <= to).sort((a,b)=>a.id.localeCompare(b.id));
  return createHash('sha256').update(JSON.stringify({ connection: connection ? { id: connection.id, employeeMap: Object.entries(connection.employeeMap).sort(), summary: connection.lastSummary, lastError: connection.lastError } : null, shifts })).digest('hex');
}
