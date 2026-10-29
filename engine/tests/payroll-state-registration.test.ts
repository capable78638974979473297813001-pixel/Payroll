import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import { checkStateRegistrationCompliance } from '../payroll/stateRegistration.ts';
import { freshYearToDate } from '../payroll/ytd.ts';
import type { Company, Employee } from '../payroll/types.ts';

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
    ...overrides,
  };
}

describe('state registration compliance (payroll/stateRegistration.ts)', () => {
  test('an employee working in a state with no registration on file is a finding', () => {
    const company = baseCompany();
    const employee = baseEmployee({ workState: { code: 'CA' } });
    const issues = checkStateRegistrationCompliance(company, [employee], '2026-06-01');
    assert.equal(issues.length, 1);
    assert.equal(issues[0].kind, 'not_registered');
    assert.equal(issues[0].stateCode, 'CA');
    assert.deepEqual(issues[0].employeeIds, ['e1']);
  });

  test('a registered state with no rate mismatch produces no finding', () => {
    const company = baseCompany({
      employerContext: { stateUnemploymentRate: { TX: 0.027 } },
      stateRegistrations: [{ stateCode: 'TX', suiAccountNumber: '12345', suiRate: 0.027, registeredDate: '2025-01-01' }],
    });
    const employee = baseEmployee({ workState: { code: 'TX' } });
    const issues = checkStateRegistrationCompliance(company, [employee], '2026-06-01');
    assert.deepEqual(issues, []);
  });

  test('a registration whose own rate no longer matches EmployerContext is a rate_mismatch finding', () => {
    const company = baseCompany({
      employerContext: { stateUnemploymentRate: { TX: 0.031 } }, // rate went up, registration record wasn't updated
      stateRegistrations: [{ stateCode: 'TX', suiAccountNumber: '12345', suiRate: 0.027, registeredDate: '2025-01-01' }],
    });
    const employee = baseEmployee({ workState: { code: 'TX' } });
    const issues = checkStateRegistrationCompliance(company, [employee], '2026-06-01');
    assert.equal(issues.length, 1);
    assert.equal(issues[0].kind, 'rate_mismatch');
    assert.equal(issues[0].configuredRate, 0.031);
    assert.equal(issues[0].registeredRate, 0.027);
  });

  test('an employee with no workState falls back to the company home state', () => {
    const company = baseCompany({ homeState: 'TX' });
    const employee = baseEmployee({ workState: undefined });
    const issues = checkStateRegistrationCompliance(company, [employee], '2026-06-01');
    assert.equal(issues.length, 1);
    assert.equal(issues[0].stateCode, 'TX');
  });

  test('a terminated employee (before asOfDate) is excluded from the active headcount entirely', () => {
    const company = baseCompany();
    const employee = baseEmployee({ workState: { code: 'CA' }, terminationDate: '2026-01-01' });
    const issues = checkStateRegistrationCompliance(company, [employee], '2026-06-01');
    assert.deepEqual(issues, []);
  });

  test('an employee terminated ON or AFTER asOfDate still counts as active for that date', () => {
    const company = baseCompany();
    const employee = baseEmployee({ workState: { code: 'CA' }, terminationDate: '2026-06-01' });
    const issues = checkStateRegistrationCompliance(company, [employee], '2026-06-01');
    assert.equal(issues.length, 1);
  });

  test('multiple employees in the same unregistered state are grouped into one finding', () => {
    const company = baseCompany();
    const employees = [
      baseEmployee({ id: 'e1', workState: { code: 'CA' } }),
      baseEmployee({ id: 'e2', workState: { code: 'CA' } }),
    ];
    const issues = checkStateRegistrationCompliance(company, employees, '2026-06-01');
    assert.equal(issues.length, 1);
    assert.deepEqual(issues[0].employeeIds.sort(), ['e1', 'e2']);
  });

  test('findings across multiple states are sorted by state code', () => {
    const company = baseCompany({ homeState: 'TX' });
    const employees = [
      baseEmployee({ id: 'e1', workState: { code: 'NY' } }),
      baseEmployee({ id: 'e2', workState: { code: 'CA' } }),
    ];
    const issues = checkStateRegistrationCompliance(company, employees, '2026-06-01');
    assert.deepEqual(issues.map((i) => i.stateCode), ['CA', 'NY']);
  });

  test('no findings at all for a fully compliant single-state employer', () => {
    const company = baseCompany({
      homeState: 'TX',
      employerContext: { stateUnemploymentRate: { TX: 0.027 } },
      stateRegistrations: [{ stateCode: 'TX', suiAccountNumber: '12345', suiRate: 0.027, registeredDate: '2025-01-01' }],
    });
    const employee = baseEmployee({ workState: { code: 'TX' } });
    const issues = checkStateRegistrationCompliance(company, [employee], '2026-06-01');
    assert.deepEqual(issues, []);
  });
});
