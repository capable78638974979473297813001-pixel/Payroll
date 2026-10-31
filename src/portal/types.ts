/** An employee signed in to their own dashboard. The cookie holds a random token; only its hash is stored. */
export interface PortalSession {
  id: string;
  employeeId: string;
  companyId: string;
  hash: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent?: string;
}
