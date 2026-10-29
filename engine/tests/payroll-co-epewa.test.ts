import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  CO_EPEWA_PENALTY_MIN,
  CO_EPEWA_PENALTY_MAX,
  CO_EPEWA_REMOTE_EXCEPTION_EMPLOYEE_THRESHOLD,
  CO_EPEWA_REMOTE_EXCEPTION_SUNSET_DATE,
  coPromotionalNoticeScope,
  coEpewaComplaintDeadline,
  clampCoEpewaPenalty,
  coEpewaTotalPenalty,
} from '../payroll/coEpewa.ts';

describe('Colorado Equal Pay for Equal Work Act, Part 2 (payroll/coEpewa.ts)', () => {
  describe('coPromotionalNoticeScope', () => {
    test('an out-of-state employer with a small, fully-remote Colorado workforce owes notice only for remote openings, before the sunset date', () => {
      assert.equal(
        coPromotionalNoticeScope({
          employerPhysicallyLocatedInColorado: false,
          coloradoEmployeeCount: 10,
          allColoradoEmployeesFullyRemote: true,
          decisionDate: '2027-01-01',
        }),
        'remote_openings_only',
      );
    });

    test('the carve-out requires strictly fewer than 15 Colorado employees', () => {
      assert.equal(
        coPromotionalNoticeScope({
          employerPhysicallyLocatedInColorado: false,
          coloradoEmployeeCount: CO_EPEWA_REMOTE_EXCEPTION_EMPLOYEE_THRESHOLD,
          allColoradoEmployeesFullyRemote: true,
          decisionDate: '2027-01-01',
        }),
        'all_openings',
      );
      assert.equal(
        coPromotionalNoticeScope({
          employerPhysicallyLocatedInColorado: false,
          coloradoEmployeeCount: CO_EPEWA_REMOTE_EXCEPTION_EMPLOYEE_THRESHOLD - 1,
          allColoradoEmployeesFullyRemote: true,
          decisionDate: '2027-01-01',
        }),
        'remote_openings_only',
      );
    });

    test('an employer physically located in Colorado never qualifies for the carve-out', () => {
      assert.equal(
        coPromotionalNoticeScope({
          employerPhysicallyLocatedInColorado: true,
          coloradoEmployeeCount: 5,
          allColoradoEmployeesFullyRemote: true,
          decisionDate: '2027-01-01',
        }),
        'all_openings',
      );
    });

    test('a workforce that is not fully remote never qualifies for the carve-out', () => {
      assert.equal(
        coPromotionalNoticeScope({
          employerPhysicallyLocatedInColorado: false,
          coloradoEmployeeCount: 5,
          allColoradoEmployeesFullyRemote: false,
          decisionDate: '2027-01-01',
        }),
        'all_openings',
      );
    });

    test('the carve-out itself sunsets on July 1, 2029 — every employer owes full notice from that date on', () => {
      assert.equal(
        coPromotionalNoticeScope({
          employerPhysicallyLocatedInColorado: false,
          coloradoEmployeeCount: 5,
          allColoradoEmployeesFullyRemote: true,
          decisionDate: CO_EPEWA_REMOTE_EXCEPTION_SUNSET_DATE,
        }),
        'all_openings',
      );
      assert.equal(
        coPromotionalNoticeScope({
          employerPhysicallyLocatedInColorado: false,
          coloradoEmployeeCount: 5,
          allColoradoEmployeesFullyRemote: true,
          decisionDate: '2029-06-30',
        }),
        'remote_openings_only',
      );
    });
  });

  test('coEpewaComplaintDeadline is exactly one year after the person learned of the violation', () => {
    assert.equal(coEpewaComplaintDeadline('2026-03-10'), '2027-03-10');
  });

  describe('clampCoEpewaPenalty', () => {
    test('clamps below the $500 floor up to the floor', () => {
      assert.equal(clampCoEpewaPenalty(dollarsCents(200)), CO_EPEWA_PENALTY_MIN);
    });

    test('clamps above the $10,000 ceiling down to the ceiling', () => {
      assert.equal(clampCoEpewaPenalty(dollarsCents(50_000)), CO_EPEWA_PENALTY_MAX);
    });

    test('leaves an in-range amount untouched', () => {
      assert.equal(clampCoEpewaPenalty(dollarsCents(2_000)), dollarsCents(2_000));
    });
  });

  test('coEpewaTotalPenalty sums independently-clamped per-violation fines, since the statute is per-violation', () => {
    const total = coEpewaTotalPenalty([dollarsCents(200), dollarsCents(2_000), dollarsCents(50_000)]);
    assert.equal(total, CO_EPEWA_PENALTY_MIN + dollarsCents(2_000) + CO_EPEWA_PENALTY_MAX);
  });
});

function dollarsCents(dollars: number): number {
  return dollars * 100;
}
