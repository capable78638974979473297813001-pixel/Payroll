import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import { computeComplianceDashboard } from '../payroll/complianceDashboard.ts';
import { freshYearToDate } from '../payroll/ytd.ts';
import type { Company, Employee } from '../payroll/types.ts';
import type { I9Record } from '../payroll/i9.ts';

function baseCompany(overrides: Partial<Company> = {}): Company {
  return {
    id: 'co-1',
    legalName: 'Acme Corp',
    ein: '00-0000000',
    homeState: 'TX',
    paySchedule: { frequency: 'biweekly', anchorPeriodStart: '2026-01-01', checkDateLagDays: 5 },
    ...overrides,
  };
}

function baseEmployee(overrides: Partial<Employee> = {}): Employee {
  return {
    id: 'e1',
    companyId: 'co-1',
    firstName: 'Jamie',
    lastName: 'Rivera',
    hireDate: '2024-01-01',
    employmentCategory: 'standard',
    payType: { kind: 'hourly', hourlyRate: dollars(20) },
    residenceState: { code: 'TX' },
    federalW4: { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 },
    deductionPlans: [],
    directDepositAccounts: [],
    garnishmentOrders: [],
    ytd: freshYearToDate(),
    ytdYear: 2026,
    ssn: '123-45-6789',
    mailingAddress: '1 Elm St',
    ...overrides,
  };
}

describe('compliance dashboard (payroll/complianceDashboard.ts)', () => {
  test('a fully compliant company produces zero issues across every category', () => {
    const company = baseCompany({
      employerContext: { stateUnemploymentRate: { TX: 0.027 } },
      stateRegistrations: [{ stateCode: 'TX', suiAccountNumber: '1', suiRate: 0.027, registeredDate: '2020-01-01' }],
    });
    const employee = baseEmployee({ hireDate: '2020-01-01', payType: { kind: 'hourly', hourlyRate: dollars(20) } });
    const i9Records = new Map<string, I9Record>([[employee.id, { employeeId: employee.id, section1CompletedAt: '2020-01-01', section2CompletedAt: '2020-01-02' }]]);
    const everifyCases = new Map([[employee.id, { employeeId: employee.id, status: 'employment_authorized' as const }]]);
    const filed = new Set([employee.id]);

    const dashboard = computeComplianceDashboard(company, [employee], i9Records, everifyCases, filed, '2026-06-01');
    assert.equal(dashboard.totalIssueCount, 0);
    assert.deepEqual(dashboard.minimumWageIssues, []);
    assert.deepEqual(dashboard.i9Issues, []);
    assert.deepEqual(dashboard.everifyIssues, []);
    assert.deepEqual(dashboard.newHireReportingIssues, []);
    assert.deepEqual(dashboard.stateRegistrationIssues, []);
  });

  test('a below-minimum-wage hourly employee surfaces in minimumWageIssues', () => {
    const company = baseCompany({ homeState: 'TX' });
    const employee = baseEmployee({ payType: { kind: 'hourly', hourlyRate: 1 } }); // 1 cent/hour, always below any floor
    const dashboard = computeComplianceDashboard(company, [employee], new Map(), new Map(), new Set([employee.id]), '2026-06-01');
    assert.equal(dashboard.minimumWageIssues.length, 1);
    assert.equal(dashboard.minimumWageIssues[0].employeeId, employee.id);
  });

  test('a missing I-9 record with a long-past hire date surfaces in i9Issues', () => {
    const company = baseCompany();
    const employee = baseEmployee({ hireDate: '2020-01-01' });
    const dashboard = computeComplianceDashboard(company, [employee], new Map(), new Map(), new Set([employee.id]), '2026-06-01');
    assert.equal(dashboard.i9Issues.length, 1);
    assert.equal(dashboard.i9Issues[0].employeeId, employee.id);
    assert.ok(dashboard.i9Issues[0].issues.length > 0);
  });

  test('an unfiled new hire surfaces in newHireReportingIssues', () => {
    const company = baseCompany();
    const employee = baseEmployee({ hireDate: '2026-01-01' });
    const dashboard = computeComplianceDashboard(company, [employee], new Map(), new Map(), new Set(), '2026-06-01');
    assert.equal(dashboard.newHireReportingIssues.length, 1);
    assert.equal(dashboard.newHireReportingIssues[0].employeeId, employee.id);
  });

  test('an employee working in an unregistered state surfaces in stateRegistrationIssues', () => {
    const company = baseCompany({ homeState: 'TX' });
    const employee = baseEmployee({ workState: { code: 'CA' } });
    const dashboard = computeComplianceDashboard(company, [employee], new Map(), new Map(), new Set([employee.id]), '2026-06-01');
    assert.equal(dashboard.stateRegistrationIssues.length, 1);
    assert.equal(dashboard.stateRegistrationIssues[0].stateCode, 'CA');
  });

  test('totalIssueCount sums every category, including multiple issues within one category', () => {
    const company = baseCompany({ homeState: 'TX' });
    const employees = [
      baseEmployee({ id: 'e1', payType: { kind: 'hourly', hourlyRate: 1 }, hireDate: '2020-01-01' }), // minimum wage + I-9
      baseEmployee({ id: 'e2', hireDate: '2026-01-01', workState: { code: 'CA' } }), // new-hire reporting + state registration
    ];
    const dashboard = computeComplianceDashboard(company, employees, new Map(), new Map(), new Set(), '2026-06-01');
    const expectedTotal =
      dashboard.minimumWageIssues.length +
      dashboard.i9Issues.reduce((sum, e) => sum + e.issues.length, 0) +
      dashboard.everifyIssues.reduce((sum, e) => sum + e.issues.length, 0) +
      dashboard.newHireReportingIssues.length +
      dashboard.stateRegistrationIssues.length;
    assert.equal(dashboard.totalIssueCount, expectedTotal);
    assert.ok(dashboard.totalIssueCount >= 3, `expected at least 3 issues, got ${dashboard.totalIssueCount}`);
  });

  test('an employee with no I-9 issues at all is excluded from i9Issues rather than listed with an empty array', () => {
    const company = baseCompany();
    const employee = baseEmployee({ hireDate: '2026-06-01' }); // hired today, nothing overdue yet
    const dashboard = computeComplianceDashboard(company, [employee], new Map(), new Map(), new Set([employee.id]), '2026-06-01');
    assert.deepEqual(dashboard.i9Issues, []);
  });

  test('a missing E-Verify case past its own creation deadline surfaces in everifyIssues', () => {
    const company = baseCompany();
    const employee = baseEmployee({ hireDate: '2020-01-01' });
    const dashboard = computeComplianceDashboard(company, [employee], new Map(), new Map(), new Set([employee.id]), '2026-06-01');
    assert.equal(dashboard.everifyIssues.length, 1);
    assert.equal(dashboard.everifyIssues[0].employeeId, employee.id);
  });

  test('an E-Verify case already employment_authorized produces no everify finding', () => {
    const company = baseCompany();
    const employee = baseEmployee({ hireDate: '2020-01-01' });
    const everifyCases = new Map([[employee.id, { employeeId: employee.id, status: 'employment_authorized' as const }]]);
    const dashboard = computeComplianceDashboard(company, [employee], new Map(), everifyCases, new Set([employee.id]), '2026-06-01');
    assert.deepEqual(dashboard.everifyIssues, []);
  });
});
