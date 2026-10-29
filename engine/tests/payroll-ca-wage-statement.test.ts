import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import {
  CA_WAGE_STATEMENT_FIRST_VIOLATION_PENALTY,
  CA_WAGE_STATEMENT_SUBSEQUENT_VIOLATION_PENALTY,
  CA_WAGE_STATEMENT_MAX_AGGREGATE_PENALTY,
  caWageStatementComplianceIssues,
  caWageStatementPenaltyExposure,
} from '../payroll/caWageStatement.ts';
import type { CaWageStatementData } from '../payroll/caWageStatement.ts';

function completeStatement(overrides: Partial<CaWageStatementData> = {}): CaWageStatementData {
  return {
    grossWagesCents: dollars(1_000),
    isExemptSalaried: false,
    totalHoursWorked: 40,
    isPieceRateWork: false,
    pieceRateUnitsEarned: null,
    deductionsCents: dollars(100),
    netWagesCents: dollars(900),
    payPeriodStart: '2026-01-01',
    payPeriodEnd: '2026-01-15',
    employeeName: 'Jamie Rivera',
    lastFourSsn: '6789',
    employerLegalName: 'Acme Corp',
    employerAddress: '1 Elm St, Sacramento, CA',
    hourlyRateLines: [{ hourlyRateCents: dollars(25), hoursAtThisRate: 40 }],
    ...overrides,
  };
}

describe('California itemized wage statement (payroll/caWageStatement.ts)', () => {
  test('a fully complete non-exempt statement has no compliance issues', () => {
    assert.deepEqual(caWageStatementComplianceIssues(completeStatement()), []);
  });

  test('every missing required field is reported for a bare empty object', () => {
    const issues = caWageStatementComplianceIssues({});
    assert.ok(issues.length >= 8);
  });

  test('a non-exempt employee missing hours worked and hourly rate lines is flagged', () => {
    const statement = completeStatement({ totalHoursWorked: null, hourlyRateLines: [] });
    const issues = caWageStatementComplianceIssues(statement);
    assert.equal(issues.length, 2);
    assert.match(issues[0], /hours worked/);
    assert.match(issues[1], /hourly rate/);
  });

  test('an exempt salaried employee is NOT flagged for missing hours worked or hourly rate lines', () => {
    const statement = completeStatement({ isExemptSalaried: true, totalHoursWorked: null, hourlyRateLines: [] });
    assert.deepEqual(caWageStatementComplianceIssues(statement), []);
  });

  test('piece-rate work missing units earned is flagged; non-piece-rate work is not', () => {
    const missingPieceRate = completeStatement({ isPieceRateWork: true, pieceRateUnitsEarned: null });
    const issues = caWageStatementComplianceIssues(missingPieceRate);
    assert.equal(issues.length, 1);
    assert.match(issues[0], /piece-rate/);

    const notPieceRate = completeStatement({ isPieceRateWork: false, pieceRateUnitsEarned: null });
    assert.deepEqual(caWageStatementComplianceIssues(notPieceRate), []);
  });

  test('an SSN suffix that is not exactly 4 digits is flagged', () => {
    assert.equal(caWageStatementComplianceIssues(completeStatement({ lastFourSsn: '678' })).length, 1);
    assert.equal(caWageStatementComplianceIssues(completeStatement({ lastFourSsn: '' })).length, 1);
  });

  test('penalty exposure is $50 for the first affected pay period alone', () => {
    assert.equal(caWageStatementPenaltyExposure(1), CA_WAGE_STATEMENT_FIRST_VIOLATION_PENALTY);
  });

  test('penalty exposure adds $100 for each subsequent affected pay period', () => {
    assert.equal(caWageStatementPenaltyExposure(3), CA_WAGE_STATEMENT_FIRST_VIOLATION_PENALTY + 2 * CA_WAGE_STATEMENT_SUBSEQUENT_VIOLATION_PENALTY);
  });

  test('penalty exposure caps at $4,000 aggregate however many pay periods are affected', () => {
    assert.equal(caWageStatementPenaltyExposure(100), CA_WAGE_STATEMENT_MAX_AGGREGATE_PENALTY);
  });

  test('zero affected pay periods means zero penalty exposure', () => {
    assert.equal(caWageStatementPenaltyExposure(0), 0);
  });
});
