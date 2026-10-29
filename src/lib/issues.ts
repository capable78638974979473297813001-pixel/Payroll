/**
 * A finding a pay run raises about itself.
 *
 *   blocking: the numbers cannot be trusted or paid as they stand. The run cannot be approved until it is fixed.
 *   review:   Totali made a documented assumption or does not model a rule. An operator has to acknowledge it to approve.
 *   info:     for the record.
 */
export interface Issue {
  severity: 'blocking' | 'review' | 'info';
  code: string;
  message: string;
  employeeId?: string;
  date?: string;
}

export const blocking = (code: string, message: string, extra: Partial<Issue> = {}): Issue => ({ severity: 'blocking', code, message, ...extra });
export const review = (code: string, message: string, extra: Partial<Issue> = {}): Issue => ({ severity: 'review', code, message, ...extra });
export const info = (code: string, message: string, extra: Partial<Issue> = {}): Issue => ({ severity: 'info', code, message, ...extra });
