/** What a person types in to ask to join a company. Held encrypted: it has a Social Security number and bank details. */
export interface JoinRequest {
  firstName: string;
  lastName: string;
  w4: { federalW4: import('../domain/types.ts').Employee['federalW4']; exemptions: number | null; signedAt: string };
  i9: { legalFirstName: string; legalLastName: string; dateOfBirth: string; status: string; ssn: string; ageAtYearEnd: number; signedAt: string };
  deposit?: { bankName?: string; routingNumber: string; accountNumber: string; accountType: 'checking' | 'savings' };
  submittedAt: string;
}

/**
 * An employee's own login. It exists before they are on the payroll: they make it with the company's code, fill in
 * a request, and the owner approves it, which is when the employee is created and linked here.
 *   draft     made the account, has not sent the request
 *   pending   sent it, waiting for the owner
 *   approved  an employee record is linked
 *   declined  the owner said no, and may have said why
 */
export interface PortalAccount {
  id: string;
  companyId: string;
  email: string;
  passwordHash: string;
  status: 'draft' | 'pending' | 'approved' | 'declined';
  createdAt: string;
  requestEncrypted?: string;
  /** The parts of the request an owner can see in a list without opening anything private. */
  summary?: { firstName: string; lastName: string; submittedAt: string; forms: { w4: boolean; i9: boolean; deposit: boolean } };
  employeeId?: string;
  decidedAt?: string;
  declineReason?: string;
}

/** An employee signed in. The cookie holds a random token; only its hash is stored. */
export interface PortalSession {
  id: string;
  accountId: string;
  companyId: string;
  hash: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent?: string;
}
