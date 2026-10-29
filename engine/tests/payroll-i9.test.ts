import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { i9ComplianceIssues, i9Deadlines, i9RetentionDueDate, i9Status } from '../payroll/i9.ts';
import type { I9Record } from '../payroll/i9.ts';
import { dollars } from '../src/money.ts';
import { freshYearToDate } from '../payroll/ytd.ts';
import type { Employee } from '../payroll/types.ts';

function employeeHiredOn(hireDate: string): Employee {
  return {
    id: 'e1',
    companyId: 'co-1',
    firstName: 'Test',
    lastName: 'Employee',
    hireDate,
    employmentCategory: 'standard',
    payType: { kind: 'hourly', hourlyRate: dollars(20) },
    residenceState: { code: 'TX' },
    federalW4: { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 },
    deductionPlans: [],
    directDepositAccounts: [],
    garnishmentOrders: [],
    ytd: freshYearToDate(),
    ytdYear: Number(hireDate.slice(0, 4)),
  };
}

describe('I-9 deadlines (payroll/i9.ts)', () => {
  test("Section 1 is due the hire date itself, whatever day of the week it falls on", () => {
    assert.equal(i9Deadlines('2026-01-05').section1DueBy, '2026-01-05');
  });

  test('a Monday hire: Section 2 is due Thursday — the exact worked example USCIS\'s own guidance uses', () => {
    const deadlines = i9Deadlines('2026-01-05'); // confirmed Monday
    assert.equal(deadlines.section2DueBy, '2026-01-08'); // confirmed Thursday
    assert.equal(deadlines.shortTermException, false);
  });

  test('a Friday hire: the weekend is skipped, landing Section 2\'s deadline on the following Wednesday', () => {
    const deadlines = i9Deadlines('2026-01-09'); // confirmed Friday
    assert.equal(deadlines.section2DueBy, '2026-01-14'); // confirmed Wednesday
  });

  test('a job expected to last fewer than 3 business days pulls Section 2\'s deadline in to the first day too', () => {
    // Hired Monday, expected to leave the very next day (Tuesday) — only
    // 1 business day of employment, well under the 3-day window.
    const deadlines = i9Deadlines('2026-01-05', '2026-01-06');
    assert.equal(deadlines.section2DueBy, '2026-01-05');
    assert.equal(deadlines.shortTermException, true);
  });

  test('a job expected to last exactly 3 business days or more keeps the ordinary deadline, not the short-term exception', () => {
    // Monday hire, expected to work through the following Thursday — that's
    // exactly 3 business days (Tue, Wed, Thu), not fewer than 3.
    const deadlines = i9Deadlines('2026-01-05', '2026-01-08');
    assert.equal(deadlines.shortTermException, false);
    assert.equal(deadlines.section2DueBy, '2026-01-08');
  });
});

describe('I-9 retention date (payroll/i9.ts)', () => {
  test('with no termination on file, retention runs 3 years from the hire date', () => {
    assert.equal(i9RetentionDueDate('2026-01-05'), '2029-01-05');
  });

  test('a long-tenured employee: 3-years-from-hire is later than 1-year-after-termination, so it wins', () => {
    assert.equal(i9RetentionDueDate('2020-01-05', '2026-06-01'), '2027-06-01'); // 1yr after term (2027-06-01) > 3yr after hire (2023-01-05)
  });

  test('an employee terminated right around the 3-year mark: 1-year-after-termination is LATER than 3-years-from-hire and must win instead', () => {
    // Hired 2026-01-05 (3 years from hire = 2029-01-05); terminated
    // 2029-01-01, just before that mark, so 1 year after termination
    // (2030-01-01) is clearly the later, controlling date.
    assert.equal(i9RetentionDueDate('2026-01-05', '2029-01-01'), '2030-01-01');
  });

  test('a Feb 29 hire date rolls over correctly into a non-leap year rather than producing an invalid date', () => {
    assert.equal(i9RetentionDueDate('2024-02-29'), '2027-03-01');
  });
});

describe('I-9 status and compliance findings (payroll/i9.ts)', () => {
  test('status progresses from section1_pending to section2_pending to complete', () => {
    assert.equal(i9Status({ employeeId: 'e1' }), 'section1_pending');
    assert.equal(i9Status({ employeeId: 'e1', section1CompletedAt: '2026-01-05' }), 'section2_pending');
    assert.equal(i9Status({ employeeId: 'e1', section1CompletedAt: '2026-01-05', section2CompletedAt: '2026-01-06' }), 'complete');
  });

  test('no findings before either deadline has passed, even with nothing on file yet', () => {
    const employee = employeeHiredOn('2026-01-05');
    assert.deepEqual(i9ComplianceIssues(employee, undefined, '2026-01-05'), []);
  });

  test('a missing Section 1 past its deadline is a real finding', () => {
    const employee = employeeHiredOn('2026-01-05');
    const issues = i9ComplianceIssues(employee, undefined, '2026-01-10');
    assert.equal(issues.length, 2, 'both Section 1 and Section 2 are overdue by this point');
    assert.match(issues[0], /Section 1/);
  });

  test('Section 1 on file but Section 2 still missing past ITS OWN deadline is a distinct finding', () => {
    const employee = employeeHiredOn('2026-01-05');
    const record: I9Record = { employeeId: 'e1', section1CompletedAt: '2026-01-05' };
    const issues = i9ComplianceIssues(employee, record, '2026-01-10');
    assert.equal(issues.length, 1);
    assert.match(issues[0], /Section 2/);
  });

  test('a fully completed I-9 has no findings, ever', () => {
    const employee = employeeHiredOn('2026-01-05');
    const record: I9Record = { employeeId: 'e1', section1CompletedAt: '2026-01-05', section2CompletedAt: '2026-01-07' };
    assert.deepEqual(i9ComplianceIssues(employee, record, '2027-01-01'), []);
  });
});
