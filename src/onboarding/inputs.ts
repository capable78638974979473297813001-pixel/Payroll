import { badRequest } from '../lib/errors.ts';
import * as v from '../lib/validate.ts';
import type { Employee } from '../domain/types.ts';

/**
 * What a person types into the W-4 and I-9 steps, checked once, wherever it is collected: from a private invite link
 * (they are already an employee) or from a request to join (they are not one yet, so the names come with the request).
 */
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export function assertSigned(first: string, last: string, signature: unknown): void {
  if (typeof signature !== 'string' || norm(signature) !== norm(`${first} ${last}`)) throw badRequest(`Type your full name, ${first} ${last}, to sign.`, { field: 'signature' });
}

export function parseW4(o: Record<string, unknown>, first: string, last: string, wantsStateForm: boolean) {
  assertSigned(first, last, o.signature);
  const children = o.children === undefined ? 0 : v.int(o, 'children', 0, 20);
  const others = o.otherDependents === undefined ? 0 : v.int(o, 'otherDependents', 0, 20);
  const federalW4: Employee['federalW4'] = {
    filingStatus: v.oneOf(o, 'filingStatus', ['single', 'married_joint', 'head_of_household'] as const),
    multipleJobs: v.bool(o, 'multipleJobs', false),
    dependentCredit: children * 200_000 + others * 50_000,
    otherIncome: 0, deductions: 0, extraWithholding: 0,
  };
  return { federalW4, exemptions: wantsStateForm ? (o.exemptions === undefined ? 1 : v.int(o, 'exemptions', 0, 30)) : null };
}

export function parseI9(o: Record<string, unknown>, first: string, last: string, today: string) {
  assertSigned(first, last, o.signature);
  const legalFirstName = v.str(o, 'legalFirstName', { max: 60 }); const legalLastName = v.str(o, 'legalLastName', { max: 60 });
  const dateOfBirth = v.date(o, 'dateOfBirth');
  const age = Number(today.slice(0, 4)) - Number(dateOfBirth.slice(0, 4));
  if (dateOfBirth > today || age > 110) throw badRequest('Check the date of birth.', { field: 'dateOfBirth' });
  const status = v.oneOf(o, 'status', ['citizen', 'noncitizen_national', 'permanent_resident', 'authorized_to_work'] as const);
  const ssn = v.ssn(o, 'ssn');
  return { legalFirstName, legalLastName, dateOfBirth, status, ssn, ageAtYearEnd: Math.max(14, age) };
}
