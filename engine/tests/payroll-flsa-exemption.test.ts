import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import {
  FLSA_STANDARD_SALARY_LEVEL_WEEKLY,
  FLSA_COMPUTER_EMPLOYEE_HOURLY_RATE,
  FLSA_HCE_ANNUAL_COMPENSATION_THRESHOLD,
  requiresSalaryLevelTest,
  meetsStandardSalaryLevelTest,
  meetsComputerEmployeeSalaryLevelTest,
  meetsHighlyCompensatedEmployeeTest,
  meetsSalaryLevelRequirement,
} from '../payroll/flsaExemption.ts';

describe('FLSA white-collar exemption salary-level tests (payroll/flsaExemption.ts)', () => {
  test('outside sales has no salary-level requirement at all', () => {
    assert.equal(requiresSalaryLevelTest('outside_sales'), false);
    assert.equal(requiresSalaryLevelTest('executive'), true);
    assert.equal(meetsSalaryLevelRequirement('outside_sales', null, null, null), true);
  });

  test('the standard weekly salary level is $684, at or above passes', () => {
    assert.equal(meetsStandardSalaryLevelTest(FLSA_STANDARD_SALARY_LEVEL_WEEKLY), true);
    assert.equal(meetsStandardSalaryLevelTest(FLSA_STANDARD_SALARY_LEVEL_WEEKLY - 1), false);
  });

  test('executive/administrative/professional use the standard weekly test via the dispatcher', () => {
    assert.equal(meetsSalaryLevelRequirement('executive', FLSA_STANDARD_SALARY_LEVEL_WEEKLY, null, null), true);
    assert.equal(meetsSalaryLevelRequirement('administrative', FLSA_STANDARD_SALARY_LEVEL_WEEKLY - 1, null, null), false);
    assert.equal(meetsSalaryLevelRequirement('professional', null, null, null), false); // no salary supplied at all
  });

  test('the computer employee exemption accepts EITHER a qualifying salary OR a qualifying hourly rate', () => {
    assert.equal(meetsComputerEmployeeSalaryLevelTest(FLSA_STANDARD_SALARY_LEVEL_WEEKLY, null), true);
    assert.equal(meetsComputerEmployeeSalaryLevelTest(null, FLSA_COMPUTER_EMPLOYEE_HOURLY_RATE), true);
    assert.equal(meetsComputerEmployeeSalaryLevelTest(null, FLSA_COMPUTER_EMPLOYEE_HOURLY_RATE - 1), false);
    assert.equal(meetsComputerEmployeeSalaryLevelTest(null, null), false);
  });

  test('the highly-compensated-employee test requires BOTH the weekly salary floor AND the annual comp threshold', () => {
    assert.equal(meetsHighlyCompensatedEmployeeTest(FLSA_STANDARD_SALARY_LEVEL_WEEKLY, FLSA_HCE_ANNUAL_COMPENSATION_THRESHOLD), true);
    assert.equal(meetsHighlyCompensatedEmployeeTest(FLSA_STANDARD_SALARY_LEVEL_WEEKLY - 1, FLSA_HCE_ANNUAL_COMPENSATION_THRESHOLD), false); // high total comp doesn't waive the weekly floor
    assert.equal(meetsHighlyCompensatedEmployeeTest(FLSA_STANDARD_SALARY_LEVEL_WEEKLY, dollars(90_000)), false); // meets weekly floor but not total comp
  });

  test('the dispatcher routes highly_compensated through the two-part test, not the standard one alone', () => {
    assert.equal(meetsSalaryLevelRequirement('highly_compensated', FLSA_STANDARD_SALARY_LEVEL_WEEKLY, null, dollars(90_000)), false);
    assert.equal(meetsSalaryLevelRequirement('highly_compensated', FLSA_STANDARD_SALARY_LEVEL_WEEKLY, null, FLSA_HCE_ANNUAL_COMPENSATION_THRESHOLD), true);
  });
});
