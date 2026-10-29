import { randomUUID } from 'node:crypto';

/**
 * A record of who changed what, when — the trail a compliance-heavy HCM
 * platform needs for exactly the actions this project's own admin UI can
 * take: approving a pay run commits YTD and money movement; terminating
 * an employee, hiring one, changing a garnishment order, or completing an
 * I-9 section are all facts a real company needs to reconstruct later
 * ("who approved this run", "when was this order added"), not just see
 * the current state of.
 *
 * SCOPE: this is the log ENTRY shape and how to build one — not an
 * authentication system. `actor` is whatever string the caller supplies;
 * this demo-scale build has no real login, so its own server always logs
 * `'admin'`. A real deployment wires `actor` to its own session/auth
 * layer; this module doesn't invent one to fill the gap.
 */

export interface AuditLogEntry {
  id: string;
  timestamp: string; // ISO datetime
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  details?: Record<string, unknown>;
}

export function auditLogEntry(
  actor: string,
  action: string,
  entityType: string,
  entityId: string,
  details?: Record<string, unknown>,
): AuditLogEntry {
  return { id: randomUUID(), timestamp: new Date().toISOString(), actor, action, entityType, entityId, details };
}
