import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import { buildOrgChart } from '../payroll/orgChart.ts';
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

function emp(overrides: Partial<Employee> = {}): Employee {
  return {
    id: 'e1',
    companyId: 'co-1',
    firstName: 'First',
    lastName: 'Last',
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

describe('org chart (payroll/orgChart.ts)', () => {
  test('a single employee with no manager is a lone root with no reports', () => {
    const company = baseCompany();
    const alice = emp({ id: 'alice', firstName: 'Alice', lastName: 'Anders' });
    const result = buildOrgChart(company, [alice], '2026-06-01');
    assert.equal(result.roots.length, 1);
    assert.equal(result.roots[0].employeeId, 'alice');
    assert.equal(result.roots[0].name, 'Alice Anders');
    assert.deepEqual(result.roots[0].reports, []);
    assert.deepEqual(result.employeeIdsInCycles, []);
  });

  test('a simple two-level hierarchy nests the report under the manager', () => {
    const company = baseCompany();
    const manager = emp({ id: 'mgr', firstName: 'Morgan', lastName: 'Manager' });
    const report = emp({ id: 'rep', firstName: 'Riley', lastName: 'Report', managerId: 'mgr' });
    const result = buildOrgChart(company, [manager, report], '2026-06-01');
    assert.equal(result.roots.length, 1);
    assert.equal(result.roots[0].employeeId, 'mgr');
    assert.equal(result.roots[0].reports.length, 1);
    assert.equal(result.roots[0].reports[0].employeeId, 'rep');
  });

  test('a manager id pointing to someone not found at all is treated as a root, not dropped', () => {
    const company = baseCompany();
    const orphan = emp({ id: 'e1', managerId: 'does-not-exist' });
    const result = buildOrgChart(company, [orphan], '2026-06-01');
    assert.equal(result.roots.length, 1);
    assert.equal(result.roots[0].employeeId, 'e1');
  });

  test('a manager id pointing to a terminated (inactive) employee is treated as a root', () => {
    const company = baseCompany();
    const terminatedManager = emp({ id: 'mgr', terminationDate: '2025-01-01' });
    const stillActiveReport = emp({ id: 'rep', managerId: 'mgr' });
    const result = buildOrgChart(company, [terminatedManager, stillActiveReport], '2026-06-01');
    assert.equal(result.roots.length, 1);
    assert.equal(result.roots[0].employeeId, 'rep');
  });

  test('multiple top-level roots (e.g. co-founders) are all returned, sorted by name', () => {
    const company = baseCompany();
    const zed = emp({ id: 'z', firstName: 'Zed', lastName: 'Zimmer' });
    const amy = emp({ id: 'a', firstName: 'Amy', lastName: 'Adams' });
    const result = buildOrgChart(company, [zed, amy], '2026-06-01');
    assert.equal(result.roots.length, 2);
    assert.deepEqual(result.roots.map((r) => r.employeeId), ['a', 'z']);
  });

  test('a direct two-employee cycle (A manages B, B manages A) is detected and both are excluded from the tree', () => {
    const company = baseCompany();
    const a = emp({ id: 'a', managerId: 'b' });
    const b = emp({ id: 'b', managerId: 'a' });
    const result = buildOrgChart(company, [a, b], '2026-06-01');
    assert.deepEqual(result.roots, []);
    assert.deepEqual(result.employeeIdsInCycles, ['a', 'b']);
  });

  test('a self-referential manager (A manages A) is its own one-employee cycle', () => {
    const company = baseCompany();
    const a = emp({ id: 'a', managerId: 'a' });
    const result = buildOrgChart(company, [a], '2026-06-01');
    assert.deepEqual(result.roots, []);
    assert.deepEqual(result.employeeIdsInCycles, ['a']);
  });

  test('an employee who merely REPORTS INTO a cycle (but isn\'t part of it) is not marked as being in the cycle', () => {
    // b -> c -> b is the cycle; a's manager is b, but a itself has no back-reference.
    const company = baseCompany();
    const a = emp({ id: 'a', managerId: 'b' });
    const b = emp({ id: 'b', managerId: 'c' });
    const c = emp({ id: 'c', managerId: 'b' });
    const result = buildOrgChart(company, [a, b, c], '2026-06-01');
    assert.deepEqual(result.employeeIdsInCycles, ['b', 'c']);
    assert.ok(!result.employeeIdsInCycles.includes('a'), 'a must not be marked as part of the cycle');
  });

  test('an employee whose manager is in a cycle still appears in the chart, promoted to a root rather than silently vanishing', () => {
    const company = baseCompany();
    const a = emp({ id: 'a', firstName: 'A', managerId: 'b' });
    const b = emp({ id: 'b', firstName: 'B', managerId: 'c' });
    const c = emp({ id: 'c', firstName: 'C', managerId: 'b' });
    const result = buildOrgChart(company, [a, b, c], '2026-06-01');
    // b and c are excluded as cycle members; a must still show up somewhere.
    const allNodeIds = new Set(result.roots.map((r) => r.employeeId));
    assert.ok(allNodeIds.has('a'), `expected 'a' to appear as a root, roots were: ${JSON.stringify(result.roots.map((r) => r.employeeId))}`);
  });

  test('a terminated employee is excluded entirely, and their still-active reports become roots', () => {
    const company = baseCompany();
    const terminatedManager = emp({ id: 'mgr', terminationDate: '2025-06-01' });
    const activeReport = emp({ id: 'rep', managerId: 'mgr' });
    const result = buildOrgChart(company, [terminatedManager, activeReport], '2026-06-01');
    assert.equal(result.roots.length, 1);
    assert.equal(result.roots[0].employeeId, 'rep');
  });

  test('reports are sorted by name at every level', () => {
    const company = baseCompany();
    const manager = emp({ id: 'mgr', firstName: 'Morgan' });
    const zed = emp({ id: 'z', firstName: 'Zed', managerId: 'mgr' });
    const amy = emp({ id: 'a', firstName: 'Amy', managerId: 'mgr' });
    const result = buildOrgChart(company, [manager, zed, amy], '2026-06-01');
    assert.deepEqual(result.roots[0].reports.map((r) => r.employeeId), ['a', 'z']);
  });

  test('jobTitle and department pass through onto each node when present', () => {
    const company = baseCompany();
    const alice = emp({ id: 'alice', jobTitle: 'Baker', department: 'Kitchen' });
    const result = buildOrgChart(company, [alice], '2026-06-01');
    assert.equal(result.roots[0].jobTitle, 'Baker');
    assert.equal(result.roots[0].department, 'Kitchen');
  });
});
