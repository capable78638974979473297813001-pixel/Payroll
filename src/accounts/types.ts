/** A person who signs in to Totali. They own at most one company. */
export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  /** The business name given at signup, used to create the company once the builder finishes. */
  businessName: string;
  passwordHash: string;
  emailVerifiedAt?: string;
  termsAcceptedAt: string;
  termsVersion: string;
  /** Set when the builder creates their company. */
  companyId?: string;
  /** Where they got to in the setup builder, saved as they go. */
  setup?: SetupDraft;
  createdAt: string;
}

/** The builder's saved state: the industry, the answers so far, and the step they are on. */
export interface SetupDraft {
  industry?: string;
  answers: Record<string, unknown>;
  step: string;
  updatedAt: string;
}

/** A six-digit code. Only a salted hash is stored. */
export interface EmailCode {
  id: string;
  userId: string;
  purpose: 'verify_email' | 'reset_password';
  /** Where the code was sent, so changing the address invalidates earlier codes. */
  email: string;
  salt: string;
  hash: string;
  expiresAt: string;
  attemptsLeft: number;
  sentAt: string;
  usedAt?: string;
}

/** A signed-in browser. The cookie holds a random token; only its hash is stored. */
export interface Session {
  id: string;
  userId: string;
  hash: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip?: string;
  userAgent?: string;
}
