import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import { compute1095CForEmployee } from '../payroll/form1095c.ts';
import type { EmployerCoverageOfferPolicy } from '../payroll/form1095c.ts';
import type { BenefitElection } from '../payroll/benefits.ts';

function basePolicy(overrides: Partial<EmployerCoverageOfferPolicy> = {}): EmployerCoverageOfferPolicy {
  return {
    offeredMinimumEssentialCoverage: true,
    offeredMinimumValue: true,
    offeredToSpouse: true,
    offeredToDependents: true,
    employeeMonthlyContribution: dollars(150),
    qualifyingOfferMonthlyCeiling: dollars(130),
    ...overrides,
  };
}

describe('Form 1095-C generation (payroll/form1095c.ts)', () => {
  test('a full-year employee with no coverage offer at all gets 1H/blank every month', () => {
    const employee = { id: 'e1', hireDate: '2020-01-01' };
    const policy = basePolicy({ offeredMinimumEssentialCoverage: false, employeeMonthlyContribution: 0 });
    const result = compute1095CForEmployee(employee, [], true, policy, 2026);
    assert.equal(result.months.length, 12);
    for (const m of result.months) {
      assert.equal(m.line14, '1H');
      assert.equal(m.line16, undefined);
    }
  });

  test('a month before hire date is 1H/2A regardless of the offer policy', () => {
    const employee = { id: 'e1', hireDate: '2026-04-15' };
    const policy = basePolicy();
    const result = compute1095CForEmployee(employee, [], true, policy, 2026);
    const jan = result.months.find((m) => m.month === '2026-01')!;
    assert.equal(jan.line14, '1H');
    assert.equal(jan.line16, '2A');
    const apr = result.months.find((m) => m.month === '2026-04')!;
    assert.notEqual(apr.line16, '2A'); // employed for at least part of April
  });

  test('a month after termination is 1H/2A', () => {
    const employee = { id: 'e1', hireDate: '2020-01-01', terminationDate: '2026-06-10' };
    const policy = basePolicy();
    const result = compute1095CForEmployee(employee, [], true, policy, 2026);
    const july = result.months.find((m) => m.month === '2026-07')!;
    assert.equal(july.line14, '1H');
    assert.equal(july.line16, '2A');
    const june = result.months.find((m) => m.month === '2026-06')!;
    assert.notEqual(june.line16, '2A'); // still employed through part of June
  });

  test('a qualifying offer under the ceiling is 1A with no active enrollment', () => {
    const employee = { id: 'e1', hireDate: '2020-01-01' };
    const policy = basePolicy({ employeeMonthlyContribution: dollars(100), qualifyingOfferMonthlyCeiling: dollars(130) });
    const result = compute1095CForEmployee(employee, [], true, policy, 2026);
    for (const m of result.months) assert.equal(m.line14, '1A');
  });

  test('an active benefit election in a given month drives line 16 to 2C (enrolled)', () => {
    const employee = { id: 'e1', hireDate: '2020-01-01' };
    const election: BenefitElection = { id: 'el-1', employeeId: 'e1', planId: 'plan-1', coverageTier: 'family', effectiveDate: '2026-03-01', endDate: '2026-08-31' };
    const policy = basePolicy();
    const result = compute1095CForEmployee(employee, [election], true, policy, 2026);

    const jan = result.months.find((m) => m.month === '2026-01')!;
    assert.notEqual(jan.line16, '2C');
    const may = result.months.find((m) => m.month === '2026-05')!;
    assert.equal(may.line16, '2C');
    const sep = result.months.find((m) => m.month === '2026-09')!;
    assert.notEqual(sep.line16, '2C');
  });

  test('a benefit election belonging to a DIFFERENT employee is ignored entirely', () => {
    const employee = { id: 'e1', hireDate: '2020-01-01' };
    const otherEmployeesElection: BenefitElection = { id: 'el-1', employeeId: 'someone-else', planId: 'plan-1', coverageTier: 'family', effectiveDate: '2026-01-01' };
    const policy = basePolicy();
    const result = compute1095CForEmployee(employee, [otherEmployeesElection], true, policy, 2026);
    for (const m of result.months) assert.notEqual(m.line16, '2C');
  });

  test('not full-time and not enrolled is 2B for every employed month', () => {
    const employee = { id: 'e1', hireDate: '2020-01-01' };
    const policy = basePolicy();
    const result = compute1095CForEmployee(employee, [], false, policy, 2026);
    for (const m of result.months) assert.equal(m.line16, '2B');
  });

  test('a named limited-non-assessment-period month is 2D, other months are unaffected', () => {
    const employee = { id: 'e1', hireDate: '2026-01-01' };
    const policy = basePolicy({ limitedNonAssessmentPeriodMonths: ['2026-01', '2026-02'] });
    const result = compute1095CForEmployee(employee, [], true, policy, 2026);
    assert.equal(result.months.find((m) => m.month === '2026-01')!.line16, '2D');
    assert.equal(result.months.find((m) => m.month === '2026-02')!.line16, '2D');
    assert.notEqual(result.months.find((m) => m.month === '2026-03')!.line16, '2D');
  });

  test('an affordability safe harbor produces its own code when no other rule takes priority', () => {
    const employee = { id: 'e1', hireDate: '2020-01-01' };
    const policy = basePolicy({ affordabilitySafeHarborUsed: 'fpl' });
    const result = compute1095CForEmployee(employee, [], true, policy, 2026);
    for (const m of result.months) assert.equal(m.line16, '2G');
  });

  test('failing the ALE-wide 95% offer test suppresses the safe harbor code for every month', () => {
    const employee = { id: 'e1', hireDate: '2020-01-01' };
    const policy = basePolicy({ affordabilitySafeHarborUsed: 'fpl', aleFailed95PercentOfferTest: true });
    const result = compute1095CForEmployee(employee, [], true, policy, 2026);
    for (const m of result.months) assert.equal(m.line16, undefined);
  });

  test('produces exactly 12 months, January through December, in order', () => {
    const employee = { id: 'e1', hireDate: '2020-01-01' };
    const result = compute1095CForEmployee(employee, [], true, basePolicy(), 2026);
    assert.deepEqual(
      result.months.map((m) => m.month),
      Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`),
    );
  });
});
