import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import {
  caseCreationDeadline,
  employeeContestDeadline,
  everifyComplianceIssues,
  tncReferralDeadline,
} from '../payroll/everify.ts';
import { freshYearToDate } from '../payroll/ytd.ts';
import type { Employee } from '../payroll/types.ts';
import type { EverifyCase } from '../payroll/everify.ts';

function baseEmployee(overrides: Partial<Employee> = {}): Employee {
  return {
    id: 'e1',
    companyId: 'co-1',
    firstName: 'Jamie',
    lastName: 'Rivera',
    hireDate: '2026-01-14',
    employmentCategory: 'standard',
    payType: { kind: 'hourly', hourlyRate: dollars(20) },
    residenceState: { code: 'TX' },
    federalW4: { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 },
    deductionPlans: [],
    directDepositAccounts: [],
    garnishmentOrders: [],
    ytd: freshYearToDate(),
    ytdYear: 2026,
    ...overrides,
  };
}

describe('E-Verify deadlines (payroll/everify.ts)', () => {
  test('case creation is due 3 business days after hire (Wed hire -> the following Monday, skipping the weekend)', () => {
    assert.equal(caseCreationDeadline('2026-01-14'), '2026-01-19');
  });

  test('TNC referral is due 10 business days after E-Verify issues the TNC result', () => {
    assert.equal(tncReferralDeadline('2026-01-14'), '2026-01-28');
  });

  test('the employee\'s own contest window is 8 business days after referral', () => {
    assert.equal(employeeContestDeadline('2026-01-19'), '2026-01-29');
  });
});

describe('E-Verify compliance findings (payroll/everify.ts)', () => {
  test('no case at all, before the 3-day deadline passes, is not yet a finding', () => {
    const employee = baseEmployee({ hireDate: '2026-01-14' });
    const issues = everifyComplianceIssues(employee, undefined, '2026-01-16');
    assert.deepEqual(issues, []);
  });

  test('no case at all, once the 3-day deadline has passed, IS a finding', () => {
    const employee = baseEmployee({ hireDate: '2026-01-14' });
    const issues = everifyComplianceIssues(employee, undefined, '2026-01-20');
    assert.equal(issues.length, 1);
    assert.match(issues[0], /due to be created by 2026-01-19/);
  });

  test('an employment-authorized case produces no findings regardless of date', () => {
    const employee = baseEmployee({ hireDate: '2026-01-14' });
    const everifyCase: EverifyCase = { employeeId: 'e1', status: 'employment_authorized', createdAt: '2026-01-15' };
    const issues = everifyComplianceIssues(employee, everifyCase, '2026-06-01');
    assert.deepEqual(issues, []);
  });

  test('a pending case (created on time) produces no finding even well after the creation deadline', () => {
    const employee = baseEmployee({ hireDate: '2026-01-14' });
    const everifyCase: EverifyCase = { employeeId: 'e1', status: 'pending', createdAt: '2026-01-15' };
    const issues = everifyComplianceIssues(employee, everifyCase, '2026-06-01');
    assert.deepEqual(issues, []);
  });

  test('a TNC not yet referred, before its own 10-day deadline, is not yet a finding', () => {
    const employee = baseEmployee({ hireDate: '2026-01-14' });
    const everifyCase: EverifyCase = { employeeId: 'e1', status: 'tentative_nonconfirmation', tncIssuedAt: '2026-01-14' };
    const issues = everifyComplianceIssues(employee, everifyCase, '2026-01-20');
    assert.deepEqual(issues, []);
  });

  test('a TNC not referred once the 10-day deadline has passed IS a finding', () => {
    const employee = baseEmployee({ hireDate: '2026-01-14' });
    const everifyCase: EverifyCase = { employeeId: 'e1', status: 'tentative_nonconfirmation', tncIssuedAt: '2026-01-14' };
    const issues = everifyComplianceIssues(employee, everifyCase, '2026-01-29');
    assert.equal(issues.length, 1);
    assert.match(issues[0], /due to be referred by 2026-01-28/);
  });
});
