/**
 * What the employer agrees to before Totali may use their bank's API. Totali
 * sends nothing until a named person approves the exact file, so this records
 * the standing permission, the account, and the largest file Totali may send.
 *
 * DRAFT wording: it has not been reviewed by a lawyer, and the bank's own
 * agreement is what actually governs use of its API.
 */
export const API_AUTHORIZATION_VERSION = '2026-10-bank-api-v1';

export function apiAuthorizationText(p: { companyName: string; bankName: string; accountLast4: string; maxFileCents: number }): string {
  const cap = `$${(p.maxFileCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return [
    `${p.companyName} authorizes Totali to use the bank API credentials it has provided to submit ACH credit payments for ${p.companyName}'s payroll to ${p.bankName}, in ${p.companyName}'s name, from the account ending ${p.accountLast4}.`,
    `Totali will do this only after a named person at ${p.companyName} has approved the exact payment file in Totali, confirming its entry count and total, and only for files totalling no more than ${cap}.`,
    `${p.companyName} understands that Totali does not hold its money; that ${p.companyName} remains the originator of every payment and is responsible for it; that a payment accepted by the bank cannot be recalled by Totali; and that it can end this authorization at any time by removing the credentials at its bank and in Totali.`,
    `${p.companyName} confirms that its agreement with ${p.bankName} allows this use of the bank's API.`,
  ].join('\n\n');
}
