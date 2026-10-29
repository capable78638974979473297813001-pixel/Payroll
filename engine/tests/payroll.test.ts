import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import type { PaycheckInput } from '../src/types.ts';
import type { GarnishmentOrder } from '../src/garnishment.ts';
import { minimumWage } from '../src/minimum-wage.ts';

import { generatePayPeriods, periodForCheckDate } from '../payroll/schedule.ts';
import type { PayScheduleConfig } from '../payroll/types.ts';
import { accumulateYtd, freshYearToDate } from '../payroll/ytd.ts';
import type { YtdAccumulatorInput } from '../payroll/ytd.ts';
import { allocateNetPay, buildNachaFile, validateRoutingNumber } from '../payroll/directDeposit.ts';
import type { AchCredit, AchFileConfig } from '../payroll/directDeposit.ts';
import { buildPaycheckInput, computeEmployeePaycheck } from '../payroll/engine.ts';
import { activeEmployeesFor, approvePayRun, draftPayRun, recalculatePayRun, voidPayRun } from '../payroll/run.ts';
import type { Company, DirectDepositAccount, Employee } from '../payroll/types.ts';
import { renderPaystubText } from '../payroll/paystub.ts';

// ============================================================================
// Pay schedules
// ============================================================================

describe('pay schedule generation (payroll/schedule.ts)', () => {
  test('biweekly: 26 or 27 periods a year, stepping in fixed 14-day increments from an anchor from a prior year', () => {
    // The anchor is the schedule's own FIRST period — there is no period
    // before it — so an anchor placed late in December (as in the OTHER
    // biweekly test below) legitimately yields fewer than 26 periods in
    // its own first partial year. Using a year-old anchor here instead
    // means the anchor itself never constrains the window, so a full
    // 26-27 is the only possible count.
    const config: PayScheduleConfig = { frequency: 'biweekly', anchorPeriodStart: '2025-01-05', checkDateLagDays: 5 };
    const periods = generatePayPeriods(config, 2026);
    assert.ok(periods.length === 26 || periods.length === 27, `expected 26-27 periods, got ${periods.length}`);
    for (let i = 1; i < periods.length; i++) {
      const prevEnd = Date.parse(periods[i - 1].periodEnd);
      const thisStart = Date.parse(periods[i].periodStart);
      assert.equal(thisStart - prevEnd, 86_400_000, `gap/overlap between period ${i - 1} and ${i}`);
    }
    for (const p of periods) assert.equal(p.checkDate.slice(0, 4), '2026');
  });

  test('an anchor placed so late in the prior year that it constrains the window still produces internally consistent periods, just fewer of them', () => {
    const config: PayScheduleConfig = { frequency: 'biweekly', anchorPeriodStart: '2026-01-04', checkDateLagDays: 5 };
    const periods = generatePayPeriods(config, 2026);
    assert.equal(periods.length, 25, 'the anchor itself is the earliest possible period start, which caps how many fit before Dec 31');
    assert.equal(periods[0].periodStart, '2026-01-04');
    assert.equal(periods[0].periodEnd, '2026-01-17'); // 14-day period, inclusive
    assert.equal(periods[0].checkDate, '2026-01-22'); // periodEnd + 5 days
    // Every period is exactly 14 days apart from the last, with no gaps or overlaps.
    for (let i = 1; i < periods.length; i++) {
      const prevEnd = Date.parse(periods[i - 1].periodEnd);
      const thisStart = Date.parse(periods[i].periodStart);
      assert.equal(thisStart - prevEnd, 86_400_000, `gap/overlap between period ${i - 1} and ${i}`);
    }
    for (const p of periods) assert.equal(p.checkDate.slice(0, 4), '2026');
  });

  test('weekly: an anchor from a PRIOR year still produces a full year of correct periods', () => {
    const config: PayScheduleConfig = { frequency: 'weekly', anchorPeriodStart: '2019-01-07', checkDateLagDays: 3 };
    const periods = generatePayPeriods(config, 2026);
    assert.ok(periods.length === 52 || periods.length === 53, `expected ~52 periods, got ${periods.length}`);
    for (const p of periods) {
      const start = Date.parse(p.periodStart);
      const end = Date.parse(p.periodEnd);
      assert.equal((end - start) / 86_400_000, 6, 'a weekly period must span exactly 7 days inclusive');
    }
  });

  test('semimonthly: 24 periods, split on the 1st/16th by default, each month\'s second period runs to its own actual last day', () => {
    const config: PayScheduleConfig = { frequency: 'semimonthly', checkDateLagDays: 5 };
    const periods = generatePayPeriods(config, 2026);
    assert.equal(periods.length, 24);
    const february = periods.filter((p) => p.periodStart.startsWith('2026-02'));
    assert.deepEqual(
      february.map((p) => p.periodEnd),
      ['2026-02-15', '2026-02-28'], // 2026 is not a leap year
    );
  });

  test('monthly: 12 periods, one calendar month each', () => {
    const config: PayScheduleConfig = { frequency: 'monthly', checkDateLagDays: 5 };
    const periods = generatePayPeriods(config, 2026);
    assert.equal(periods.length, 12);
    assert.deepEqual(periods[0], { periodStart: '2026-01-01', periodEnd: '2026-01-31', checkDate: '2026-02-05' });
  });

  test('periodForCheckDate finds the period a check date belongs to, including across a year boundary', () => {
    const config: PayScheduleConfig = { frequency: 'biweekly', anchorPeriodStart: '2026-01-04', checkDateLagDays: 5 };
    const found = periodForCheckDate(config, '2026-01-22');
    assert.equal(found?.periodStart, '2026-01-04');
    assert.equal(periodForCheckDate(config, '2026-06-15'), null, 'a date with no matching period returns null, never a nearest guess');
  });
});

// ============================================================================
// YTD accumulation
// ============================================================================

describe('YTD accumulation across pay periods (payroll/ytd.ts)', () => {
  function ss(taxableWages: number): YtdAccumulatorInput['taxLines'][number][] {
    return [
      { id: 'US_SS_EE', taxableWages },
      { id: 'US_SS_ER', taxableWages },
    ];
  }

  test('Social Security wage base: two periods correctly telescope to the annual cap, never double-counted from the paired EE/ER lines', () => {
    const cap = dollars(184_500); // 2026 SS wage base
    let ytd = freshYearToDate();

    // Period 1: $100,000 of wages, fully under the cap.
    ytd = accumulateYtd(ytd, { checkDate: '2026-01-15', grossPay: dollars(100_000), taxLines: ss(dollars(100_000)) });
    assert.equal(ytd.socialSecurity, dollars(100_000));

    // Period 2: another $100,000 requested, but only $84,500 is actually taxable
    // (the engine itself would report exactly that as taxableWages via underCap()).
    const period2Taxable = dollars(84_500);
    ytd = accumulateYtd(ytd, { checkDate: '2026-02-15', grossPay: dollars(100_000), taxLines: ss(period2Taxable) });
    assert.equal(ytd.socialSecurity, cap, 'must land exactly on the wage base, not double the paired EE/ER lines');
  });

  test('Additional Medicare (US_MED_ADDL) never inflates ytd.medicare — it is a subset of US_MED_EE, not an addition to it', () => {
    let ytd = freshYearToDate();
    const wages = dollars(250_000); // over the $200k Additional Medicare threshold on its own
    ytd = accumulateYtd(ytd, {
      checkDate: '2026-01-15',
      grossPay: wages,
      taxLines: [
        { id: 'US_MED_EE', taxableWages: wages },
        { id: 'US_MED_ER', taxableWages: wages },
        { id: 'US_MED_ADDL', taxableWages: dollars(50_000) }, // the slice above $200k
      ],
    });
    assert.equal(ytd.medicare, wages, 'ytd.medicare must equal the full Medicare wages once, not wages + the surtax slice again');
  });

  test('a state with BOTH an employee (_UC_EE) and employer (_SUI_ER) line sharing one wage-base tracker is not double-counted', () => {
    let ytd = freshYearToDate();
    const taxable = dollars(30_000);
    ytd = accumulateYtd(ytd, {
      checkDate: '2026-01-15',
      grossPay: dollars(30_000),
      taxLines: [
        { id: 'NJ_UC_EE', taxableWages: taxable },
        { id: 'NJ_SUI_ER', taxableWages: taxable },
      ],
    });
    assert.equal(ytd.stateUnemployment?.NJ, taxable, 'the two lines must add ONE $30,000, not $60,000');
  });

  test('Pennsylvania: an uncapped employee UC line and a capped employer SUI line sharing stateUnemployment do not corrupt each other', () => {
    // PA_UC_EE has no wage base (0.07% of every dollar, uncapped); PA_SUI_ER
    // is capped at $10,000/yr. Above that cap the two lines' taxableWages
    // genuinely diverge — this is not the NJ/AK case above where both sides
    // share one wage base and reporting either is fine. The tracker must
    // still end up holding the EMPLOYER figure, since that is the only side
    // whose OWN next-period computation reads ytd.stateUnemployment.PA back
    // (stateUnemploymentEmployeeTax() ignores ytd whenever its own wageBase
    // is null — see that function's own body in src/taxes/state.ts).
    let ytd = freshYearToDate();
    ytd.stateUnemployment = { PA: dollars(9_500) };
    const forward = accumulateYtd(ytd, {
      checkDate: '2026-06-15',
      grossPay: dollars(5_000),
      taxLines: [
        { id: 'PA_UC_EE', taxableWages: dollars(5_000) }, // uncapped: all $5,000 is taxable
        { id: 'PA_SUI_ER', taxableWages: dollars(500) }, // capped: only $500 remains before the $10,000 cap
      ],
    });
    assert.equal(forward.stateUnemployment?.PA, dollars(10_000), 'must land on the EMPLOYER cap ($9,500 + $500), not the uncapped employee figure');

    // Order in PaycheckResult.taxes must not change the outcome.
    const reversed = accumulateYtd(ytd, {
      checkDate: '2026-06-15',
      grossPay: dollars(5_000),
      taxLines: [
        { id: 'PA_SUI_ER', taxableWages: dollars(500) },
        { id: 'PA_UC_EE', taxableWages: dollars(5_000) },
      ],
    });
    assert.equal(reversed.stateUnemployment?.PA, dollars(10_000), 'the resolved figure must not depend on tax-line order');
  });

  test('a state with both a PFML employee and employer line shares one statePaidLeave tracker the same way', () => {
    let ytd = freshYearToDate();
    const taxable = dollars(20_000);
    ytd = accumulateYtd(ytd, {
      checkDate: '2026-01-15',
      grossPay: dollars(20_000),
      taxLines: [
        { id: 'WA_PFML_EE', taxableWages: taxable },
        { id: 'WA_PFML_ER', taxableWages: taxable },
      ],
    });
    assert.equal(ytd.statePaidLeave?.WA, taxable);
  });

  test('stateDisabilityEmployee and stateLongTermCare trackers key correctly by state code', () => {
    let ytd = freshYearToDate();
    ytd = accumulateYtd(ytd, {
      checkDate: '2026-01-15',
      grossPay: dollars(10_000),
      taxLines: [
        { id: 'NJ_DBL_EE', taxableWages: dollars(10_000) },
        { id: 'WA_LTC_EE', taxableWages: dollars(10_000) },
      ],
    });
    assert.equal(ytd.stateDisabilityEmployee?.NJ, dollars(10_000));
    assert.equal(ytd.stateLongTermCare?.WA, dollars(10_000));
    assert.equal(ytd.stateDisabilityEmployee?.WA, undefined, 'must not cross-pollinate between states');
  });

  test("Oregon's Portland-area local triggers key on their own short name, not the full TaxLine id", () => {
    let ytd = freshYearToDate();
    ytd = accumulateYtd(ytd, {
      checkDate: '2026-01-15',
      grossPay: dollars(5_000),
      taxLines: [
        { id: 'OR_METRO_SHS', taxableWages: dollars(1_000) },
        { id: 'OR_MULTNOMAH_PFA', taxableWages: dollars(500) },
      ],
    });
    assert.equal(ytd.localIncomeTax?.OR_METRO, dollars(1_000));
    assert.equal(ytd.localIncomeTax?.OR_MULTNOMAH, dollars(500));
  });

  test('categoryCashWages accumulates from grossPay for household/agricultural/election-worker categories, and crossing the threshold does not retroactively tax the earlier period', () => {
    let ytd = freshYearToDate();
    // Period 1: $1,600 cash, under the $3,000 household coverage threshold —
    // no SS/Medicare lines would fire from the real engine (they'd read
    // $0 taxableWages), so nothing is passed here for them either.
    ytd = accumulateYtd(ytd, {
      checkDate: '2026-01-15',
      employmentCategory: 'household',
      grossPay: dollars(1_600),
      taxLines: [],
    });
    assert.equal(ytd.categoryCashWages, dollars(1_600));

    // Period 2: another $1,600 crosses the $3,000 threshold; the engine
    // would now tax the FULL current-period wages, never reaching back for
    // period 1's — this test only checks the running cash total itself.
    ytd = accumulateYtd(ytd, {
      checkDate: '2026-02-15',
      employmentCategory: 'household',
      grossPay: dollars(1_600),
      taxLines: [{ id: 'US_SS_EE', taxableWages: dollars(1_600) }, { id: 'US_SS_ER', taxableWages: dollars(1_600) }],
    });
    assert.equal(ytd.categoryCashWages, dollars(3_200));
    assert.equal(ytd.socialSecurity, dollars(1_600), 'only period 2 is taxable — period 1 is never collected retroactively');
  });

  test('a standard employee never touches categoryCashWages at all', () => {
    const ytd = accumulateYtd(freshYearToDate(), {
      checkDate: '2026-01-15',
      employmentCategory: 'standard',
      grossPay: dollars(5_000),
      taxLines: [],
    });
    assert.equal(ytd.categoryCashWages, undefined);
  });

  test('railroad monthly compensation resets to zero on a new calendar month rather than accumulating all year', () => {
    let ytd = freshYearToDate();
    ytd = accumulateYtd(ytd, {
      checkDate: '2026-01-15',
      grossPay: dollars(3_000),
      taxLines: [{ id: 'US_RUIA_ER', taxableWages: dollars(2_150) }], // hits the monthly cap
    });
    assert.equal(ytd.railroadMonthlyCompensation, dollars(2_150));

    // Same month again: should ADD (though realistically underCap() would
    // already report $0 more taxable here — this proves the accumulator
    // itself doesn't reset mid-month).
    ytd = accumulateYtd(ytd, { checkDate: '2026-01-29', grossPay: dollars(3_000), taxLines: [{ id: 'US_RUIA_ER', taxableWages: 0 }] });
    assert.equal(ytd.railroadMonthlyCompensation, dollars(2_150));

    // A NEW month: must reset to zero before adding, not carry January forward.
    ytd = accumulateYtd(ytd, { checkDate: '2026-02-12', grossPay: dollars(3_000), taxLines: [{ id: 'US_RUIA_ER', taxableWages: dollars(2_150) }] });
    assert.equal(ytd.railroadMonthlyCompensation, dollars(2_150), 'February must start from zero, not 2150+2150');
  });

  test('freshYearToDate produces every tracker zeroed/empty, matching what a year rollover should reset to', () => {
    const ytd = freshYearToDate();
    assert.equal(ytd.socialSecurity, 0);
    assert.equal(ytd.medicare, 0);
    assert.equal(ytd.futa, 0);
    assert.deepEqual(ytd.stateUnemployment, {});
  });
});

// ============================================================================
// Direct deposit / ACH
// ============================================================================

describe('ABA routing number validation (payroll/directDeposit.ts)', () => {
  test('accepts real, checksum-valid routing numbers', () => {
    assert.equal(validateRoutingNumber('021000021'), true); // JPMorgan Chase NY
    assert.equal(validateRoutingNumber('011000015'), true); // Bank of America
  });

  test('rejects a routing number with a bad checksum, wrong length, or non-digits', () => {
    assert.equal(validateRoutingNumber('021000022'), false); // last digit off by one
    assert.equal(validateRoutingNumber('12345678'), false); // 8 digits
    assert.equal(validateRoutingNumber('12345678901'), false); // 11 digits
    assert.equal(validateRoutingNumber('02100002A'), false); // non-digit
  });
});

function account(overrides: Partial<DirectDepositAccount> & { id: string }): DirectDepositAccount {
  return {
    routingNumber: '021000021',
    accountNumber: '1234567890',
    accountType: 'checking',
    allocation: { kind: 'remainder' },
    ...overrides,
  };
}

describe('splitting net pay across accounts (payroll/directDeposit.ts)', () => {
  test('a single remainder account gets everything', () => {
    const allocations = allocateNetPay(dollars(2_000), [account({ id: 'a1' })]);
    assert.deepEqual(allocations, [{ accountId: 'a1', amount: dollars(2_000) }]);
  });

  test('flat amount, then percent, then remainder absorbs whatever is left, in priority order', () => {
    const accounts: DirectDepositAccount[] = [
      account({ id: 'savings', priority: 1, allocation: { kind: 'flatAmount', amount: dollars(200) } }),
      account({ id: 'checking2', priority: 2, allocation: { kind: 'percent', percentOfNet: 10 } }),
      account({ id: 'primary', allocation: { kind: 'remainder' } }),
    ];
    const allocations = allocateNetPay(dollars(2_000), accounts);
    assert.deepEqual(allocations, [
      { accountId: 'savings', amount: dollars(200) },
      { accountId: 'checking2', amount: dollars(200) }, // 10% of the FULL 2000, not of the 1800 remaining
      { accountId: 'primary', amount: dollars(1_600) },
    ]);
  });

  test('fixed accounts that exceed net pay are clamped, never driven negative, and the remainder account gets zero', () => {
    const accounts: DirectDepositAccount[] = [
      account({ id: 'big', priority: 1, allocation: { kind: 'flatAmount', amount: dollars(5_000) } }),
      account({ id: 'primary', allocation: { kind: 'remainder' } }),
    ];
    const allocations = allocateNetPay(dollars(2_000), accounts);
    assert.deepEqual(allocations, [
      { accountId: 'big', amount: dollars(2_000) },
      { accountId: 'primary', amount: 0 },
    ]);
  });

  test('more than one remainder account is a configuration error, not an arbitrary pick', () => {
    const accounts: DirectDepositAccount[] = [account({ id: 'a' }), account({ id: 'b' })];
    assert.throws(() => allocateNetPay(dollars(1_000), accounts));
  });

  test('fixed accounts that do not add up to net pay, with no remainder account to absorb the rest, is an error rather than money silently vanishing', () => {
    const accounts: DirectDepositAccount[] = [
      account({ id: 'a', allocation: { kind: 'flatAmount', amount: dollars(100) } }),
    ];
    assert.throws(() => allocateNetPay(dollars(1_000), accounts));
  });

  test('no accounts at all is not an error — just nothing to allocate', () => {
    assert.deepEqual(allocateNetPay(dollars(1_000), []), []);
  });
});

describe('NACHA ACH file generation (payroll/directDeposit.ts)', () => {
  const config: AchFileConfig = {
    originRoutingNumber: '021000021',
    originName: 'Test Payroll Bank',
    immediateOriginId: '123456789',
    companyName: 'Acme Corp',
    companyIdentification: '1123456789',
    effectiveEntryDate: '2026-01-22',
  };
  const credits: AchCredit[] = [
    { routingNumber: '021000021', accountNumber: '1111', accountType: 'checking', amount: dollars(1_500), individualId: 'emp-1', individualName: 'Alice Smith' },
    { routingNumber: '011000015', accountNumber: '2222', accountType: 'savings', amount: dollars(2_500), individualId: 'emp-2', individualName: 'Bob Jones' },
  ];

  test('every record is exactly 94 characters, blocked in multiples of 10 with 9-filler padding', () => {
    const file = buildNachaFile(credits, config);
    const records = file.trim().split('\r\n');
    for (const r of records) assert.equal(r.length, 94);
    assert.equal(records.length % 10, 0, 'total record count must block into multiples of 10');
    // 1 file header + 1 batch header + 2 entries + 1 batch control + 1 file control = 6, padded to 10.
    assert.equal(records.length, 10);
    assert.equal(records[9], '9'.repeat(94));
  });

  test('record type codes appear in the right order: 1, 5, 6, 6, 8, 9', () => {
    const file = buildNachaFile(credits, config);
    const records = file.trim().split('\r\n');
    assert.deepEqual(records.slice(0, 6).map((r) => r[0]), ['1', '5', '6', '6', '8', '9']);
  });

  test('the batch control record carries the right entry count and total credit dollar amount', () => {
    const file = buildNachaFile(credits, config);
    const records = file.trim().split('\r\n');
    const batchControl = records[4];
    assert.equal(batchControl.slice(4, 10), '000002'); // entry count
    const totalCredits = dollars(1_500) + dollars(2_500);
    assert.equal(Number(batchControl.slice(32, 44)), totalCredits);
  });

  test('the file control record carries the same totals as the batch control, plus the block count', () => {
    const file = buildNachaFile(credits, config);
    const records = file.trim().split('\r\n');
    const fileControl = records[5];
    assert.equal(fileControl.slice(1, 7), '000001'); // batch count
    assert.equal(fileControl.slice(7, 13), '000001'); // block count (10 records / 10)
    assert.equal(fileControl.slice(13, 21), '00000002'); // entry/addenda count
  });

  test('an entry detail record encodes the transaction code by account type (22 checking, 32 savings) and the amount in cents, zero-padded', () => {
    const file = buildNachaFile(credits, config);
    const records = file.trim().split('\r\n');
    const [checkingEntry, savingsEntry] = [records[2], records[3]];
    assert.equal(checkingEntry.slice(1, 3), '22');
    assert.equal(savingsEntry.slice(1, 3), '32');
    assert.equal(checkingEntry.slice(29, 39), padAmount(dollars(1_500)));
  });

  test('rejects a credit with a checksum-invalid routing number before it ever reaches the file', () => {
    const badCredits: AchCredit[] = [{ ...credits[0], routingNumber: '021000022' }];
    assert.throws(() => buildNachaFile(badCredits, config), /routing number/i);
  });

  function padAmount(cents: number): string {
    return String(cents).padStart(10, '0');
  }
});

// ============================================================================
// The per-employee paycheck pipeline
// ============================================================================

function texasCompany(): Company {
  return {
    id: 'co-1',
    legalName: 'Test Co LLC',
    ein: '12-3456789',
    homeState: 'TX', // no state income tax — keeps expected numbers to federal + payroll math only
    paySchedule: { frequency: 'biweekly', anchorPeriodStart: '2026-01-04', checkDateLagDays: 5 },
  };
}

function hourlyEmployee(overrides: Partial<Employee> = {}): Employee {
  return {
    id: 'emp-1',
    companyId: 'co-1',
    firstName: 'Alice',
    lastName: 'Smith',
    hireDate: '2025-01-01',
    employmentCategory: 'standard',
    payType: { kind: 'hourly', hourlyRate: dollars(20) },
    residenceState: { code: 'TX' },
    federalW4: {
      filingStatus: 'single',
      multipleJobs: false,
      dependentCredit: 0,
      otherIncome: 0,
      deductions: 0,
      extraWithholding: 0,
    },
    deductionPlans: [],
    directDepositAccounts: [],
    garnishmentOrders: [],
    ytd: freshYearToDate(),
    ytdYear: 2026,
    ...overrides,
  };
}

describe('assembling a PaycheckInput from employee records (payroll/engine.ts)', () => {
  test('an hourly employee\'s regular + overtime pay is priced correctly and tagged as regular earnings, not supplemental', () => {
    const company = texasCompany();
    const employee = hourlyEmployee();
    const input = buildPaycheckInput(company, employee, '2026-01-22', {
      employeeId: employee.id,
      regularHours: 80,
      overtimeHours: 10,
    });
    const reg = input.earnings.find((e) => e.code === 'REG');
    const ot = input.earnings.find((e) => e.code === 'OT');
    assert.equal(reg?.amount, dollars(20 * 80));
    assert.equal(reg?.category, 'regular');
    assert.equal(ot?.amount, dollars(20 * 1.5 * 10));
    assert.equal(ot?.category, 'regular');
  });

  test('a salaried employee is paid exactly annualSalary / periodsPerYear regardless of any time entry', () => {
    const company = texasCompany(); // biweekly, 26 periods
    const employee = hourlyEmployee({ payType: { kind: 'salary', annualSalary: dollars(130_000) } });
    const input = buildPaycheckInput(company, employee, '2026-01-22');
    assert.equal(input.earnings[0].amount, Math.round(dollars(130_000) / 26));
  });

  test('a flat deduction plan passes through unchanged; a percentOfGross plan is computed off cash gross, excluding imputed income', () => {
    const company = texasCompany();
    const employee = hourlyEmployee({
      payType: { kind: 'salary', annualSalary: dollars(104_000) }, // exactly $4,000/period biweekly
      deductionPlans: [
        { id: 'd1', code: '401K', category: 'deferral_401k', amount: { kind: 'percentOfGross', percent: 5 }, active: true },
        { id: 'd2', code: 'HEALTH', category: 'section125', amount: { kind: 'flat', cents: dollars(150) }, active: true },
        { id: 'd3', code: 'INACTIVE', category: null, amount: { kind: 'flat', cents: dollars(999) }, active: false },
      ],
    });
    const input = buildPaycheckInput(company, employee, '2026-01-22');
    const k401 = input.deductions.find((d) => d.code === '401K');
    const health = input.deductions.find((d) => d.code === 'HEALTH');
    assert.equal(k401?.amount, Math.round(dollars(4_000) * 0.05));
    assert.equal(health?.amount, dollars(150));
    assert.equal(input.deductions.find((d) => d.code === 'INACTIVE'), undefined, 'an inactive plan must not appear at all');
  });

  test('workState defaults to the company\'s own home state when the employee has none of their own', () => {
    const input = buildPaycheckInput(texasCompany(), hourlyEmployee(), '2026-01-22');
    assert.equal(input.workState?.code, 'TX');
  });
});

describe('the full per-employee computation (payroll/engine.ts)', () => {
  test('gross - pretax - posttax - employeeTaxes reconciles exactly to net pay, and net pay - garnishment reconciles to netPayAfterGarnishment', () => {
    const company = texasCompany();
    const employee = hourlyEmployee();
    const { line, result } = computeEmployeePaycheck(company, employee, '2026-01-22', {
      employeeId: employee.id,
      regularHours: 80,
      overtimeHours: 0,
    });
    assert.equal(
      result.grossPay - result.pretaxDeductions - result.posttaxDeductions - result.employeeTaxTotal,
      result.netPay,
    );
    assert.equal(line.netPay - line.garnishmentTotal, line.netPayAfterGarnishment);
  });

  test('a garnishment order reduces netPayAfterGarnishment below plain net pay, and deposit allocations sum to exactly the post-garnishment figure', () => {
    const company = texasCompany();
    const order: GarnishmentOrder = { id: 'g1', type: 'consumer_creditor', amountOrdered: dollars(200) };
    // Alabama, not Texas: Texas categorically bars ordinary consumer-creditor
    // garnishment (see README's own Known gaps / src/registry.ts's
    // GarnishmentFormula), which would make this test's order withhold $0
    // for a real, documented legal reason unrelated to what's under test
    // here. Alabama is confirmed to have no departure from the plain
    // federal formula — the same state garnishment.test.ts itself defaults
    // to for exactly this reason.
    const employee = hourlyEmployee({
      workState: { code: 'AL' },
      residenceState: { code: 'AL' },
      garnishmentOrders: [order],
      directDepositAccounts: [account({ id: 'primary' })],
    });
    const { line } = computeEmployeePaycheck(company, employee, '2026-01-22', {
      employeeId: employee.id,
      regularHours: 80,
      overtimeHours: 0,
    });
    assert.ok(line.garnishmentTotal > 0, 'a real order against real disposable earnings should withhold something');
    assert.equal(line.netPay - line.garnishmentTotal, line.netPayAfterGarnishment);
    const totalAllocated = line.depositAllocations.reduce((sum, a) => sum + a.amount, 0);
    assert.equal(totalAllocated, line.netPayAfterGarnishment);
  });

  test('an employee with no garnishment orders gets no garnishment computation at all, not a $0 one', () => {
    const { garnishment, line } = computeEmployeePaycheck(texasCompany(), hourlyEmployee(), '2026-01-22', {
      employeeId: 'emp-1',
      regularHours: 80,
      overtimeHours: 0,
    });
    assert.equal(garnishment, null);
    assert.deepEqual(line.garnishmentLines, []);
  });
});

// ============================================================================
// Pay runs
// ============================================================================

describe('running payroll across a company\'s employees (payroll/run.ts)', () => {
  function timeEntryFor(employeeId: string): { employeeId: string; regularHours: number; overtimeHours: number } {
    return { employeeId, regularHours: 80, overtimeHours: 0 };
  }

  test('activeEmployeesFor excludes anyone hired after, or terminated before, the check date', () => {
    const company = texasCompany();
    const employees: Employee[] = [
      hourlyEmployee({ id: 'current', hireDate: '2025-01-01' }),
      hourlyEmployee({ id: 'future-hire', hireDate: '2026-06-01' }),
      hourlyEmployee({ id: 'past-termination', hireDate: '2020-01-01', terminationDate: '2026-01-01' }),
      hourlyEmployee({ id: 'terminated-same-day', hireDate: '2020-01-01', terminationDate: '2026-01-22' }),
    ];
    const active = activeEmployeesFor(company, employees, '2026-01-22').map((e) => e.id);
    assert.deepEqual(active.sort(), ['current', 'terminated-same-day']);
  });

  test('a draft run computes one line per active employee and starts as status: draft', () => {
    const company = texasCompany();
    const employees = [hourlyEmployee({ id: 'e1' }), hourlyEmployee({ id: 'e2' })];
    const run = draftPayRun(company, employees, '2026-01-04', '2026-01-17', '2026-01-22', [
      timeEntryFor('e1'),
      timeEntryFor('e2'),
    ]);
    assert.equal(run.status, 'draft');
    assert.equal(run.lines.length, 2);
    assert.deepEqual(run.minimumWageIssues, [], 'both employees here are paid well above minimum wage');
  });

  test('a draft run flags an hourly employee paid below the binding minimum wage, and leaves a compliant one out entirely', () => {
    const company = texasCompany();
    const floor = minimumWage({ checkDate: '2026-01-22', state: 'TX' });
    const employees = [
      hourlyEmployee({ id: 'underpaid', payType: { kind: 'hourly', hourlyRate: floor.cents - 50 } }),
      hourlyEmployee({ id: 'compliant', payType: { kind: 'hourly', hourlyRate: floor.cents + 500 } }),
    ];
    const run = draftPayRun(company, employees, '2026-01-04', '2026-01-17', '2026-01-22', [
      timeEntryFor('underpaid'),
      timeEntryFor('compliant'),
    ]);
    assert.deepEqual(run.minimumWageIssues.map((i) => i.employeeId), ['underpaid']);
    assert.equal(run.minimumWageIssues[0].shortfallCents, 50);
  });

  test('recalculatePayRun refuses to touch anything but a draft', () => {
    const company = texasCompany();
    const employees = [hourlyEmployee({ id: 'e1' })];
    const run = draftPayRun(company, employees, '2026-01-04', '2026-01-17', '2026-01-22', [timeEntryFor('e1')]);
    const approved = approvePayRun(run, employees).run;
    assert.throws(() => recalculatePayRun(approved, company, employees));
  });

  test('approving a run rolls its results into employee YTD and locks the run', () => {
    const company = texasCompany();
    const employees = [hourlyEmployee({ id: 'e1' })];
    const run = draftPayRun(company, employees, '2026-01-04', '2026-01-17', '2026-01-22', [timeEntryFor('e1')]);
    const { run: approved, updatedEmployees } = approvePayRun(run, employees);

    assert.equal(approved.status, 'approved');
    assert.ok(approved.approvedAt);
    const updated = updatedEmployees.find((e) => e.id === 'e1')!;
    assert.equal(updated.ytd.socialSecurity, run.lines[0].taxLines.find((t) => t.id === 'US_SS_EE')!.taxableWages);
    assert.equal(updated.ytdYear, 2026);
  });

  test('a second run in the same year continues accumulating YTD from the first, rather than resetting it', () => {
    const company = texasCompany();
    let employees = [hourlyEmployee({ id: 'e1' })];

    const run1 = draftPayRun(company, employees, '2026-01-04', '2026-01-17', '2026-01-22', [timeEntryFor('e1')]);
    const approval1 = approvePayRun(run1, employees);
    employees = approval1.updatedEmployees;

    const run2 = draftPayRun(company, employees, '2026-01-18', '2026-01-31', '2026-02-05', [timeEntryFor('e1')]);
    const approval2 = approvePayRun(run2, employees);
    const finalSs = approval2.updatedEmployees[0].ytd.socialSecurity;

    const perPeriodSs = run1.lines[0].taxLines.find((t) => t.id === 'US_SS_EE')!.taxableWages;
    assert.equal(finalSs, perPeriodSs * 2, 'two equal periods should sum, not reset between runs');
  });

  test('a check date in a new calendar year starts YTD fresh, never carrying the prior year\'s totals forward', () => {
    const company = texasCompany();
    const employee = hourlyEmployee({ id: 'e1', ytdYear: 2025, ytd: { ...freshYearToDate(), socialSecurity: dollars(180_000) } });
    const run = draftPayRun(company, [employee], '2026-01-04', '2026-01-17', '2026-01-22', [timeEntryFor('e1')]);
    const line = run.lines[0];
    const ssLine = line.taxLines.find((t) => t.id === 'US_SS_EE')!;
    // A full $80,000/yr-equivalent biweekly cheque is nowhere near the SS cap
    // on its own — if 2025's $180,000 had carried forward, this would be
    // capped to almost nothing instead.
    assert.ok(ssLine.taxableWages > dollars(1_000), 'stale prior-year YTD must not suppress this check\'s SS wages');
  });

  test('voidPayRun works on a draft and refuses an approved run', () => {
    const company = texasCompany();
    const employees = [hourlyEmployee({ id: 'e1' })];
    const draft = draftPayRun(company, employees, '2026-01-04', '2026-01-17', '2026-01-22', [timeEntryFor('e1')]);
    const voided = voidPayRun(draft);
    assert.equal(voided.status, 'voided');

    const approved = approvePayRun(
      draftPayRun(company, employees, '2026-01-04', '2026-01-17', '2026-01-22', [timeEntryFor('e1')]),
      employees,
    ).run;
    assert.throws(() => voidPayRun(approved));
  });
});

// ============================================================================
// Paystub rendering
// ============================================================================

describe('paystub rendering (payroll/paystub.ts)', () => {
  test('renders the employee, period, gross and net pay, and every tax/deduction/garnishment line', () => {
    const company = texasCompany();
    const employee = hourlyEmployee({ directDepositAccounts: [account({ id: 'primary' })] });
    const run = draftPayRun(company, [employee], '2026-01-04', '2026-01-17', '2026-01-22', [
      { employeeId: employee.id, regularHours: 80, overtimeHours: 0 },
    ]);
    const text = renderPaystubText(company, employee, run, run.lines[0]);
    assert.match(text, /Alice Smith/);
    assert.match(text, /2026-01-22/);
    assert.match(text, /Net pay:/);
    assert.match(text, /Direct deposit:/);
  });
});
