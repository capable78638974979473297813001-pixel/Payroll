import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { calculatePaycheck } from '../src/calculate.ts';
import type { PaycheckInput } from '../src/types.ts';
import { resolveJurisdiction, toCertificateFields, type CensusGeographies } from '../geocode/resolve.ts';
import { ohioJeddDecision, resolveLocalityCandidates } from '../geocode/index.ts';

/**
 * The 2026-10-08 "right codes, still wrong tax" list: engine logic that picked
 * wrong with good inputs (A), and inputs that were missing or misplaced
 * without anything saying so (B). $3,000 weekly checks unless noted.
 */

const pay = (
  state: string,
  certificate: Record<string, unknown>,
  extra: Partial<PaycheckInput> = {},
  checkDate = '2026-06-15',
): PaycheckInput => ({
  checkDate,
  payFrequency: 'weekly',
  earnings: [{ code: 'REG', category: 'regular', amount: 300000 }],
  deductions: [],
  federalW4: { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 },
  ytd: { socialSecurity: 0, medicare: 0, futa: 0 },
  workState: { code: state, certificate } as PaycheckInput['workState'],
  ...extra,
});
const line = (r: ReturnType<typeof calculatePaycheck>, id: string) => r.taxes.find((t) => t.id === id);

describe('A1 Pennsylvania LST goes to the principal worksite', () => {
  test('lstPSD overrides the paycheck work PSD for the LST only', () => {
    const base = { workPSD: '100401', residencePSD: '880000' }; // Adams Twp: $10 LST
    assert.equal(line(calculatePaycheck(pay('PA', base)), 'PA_LST')?.amount, 19); // $10 / 52, rounded down
    const r = calculatePaycheck(pay('PA', { ...base, lstPSD: '460101' })); // Abington Twp: $52 LST
    assert.equal(line(r, 'PA_LST')?.amount, 100);
    assert.match(line(r, 'PA_EIT')!.detail!, /PSD 100401/); // EIT still follows the work PSD
  });

  test('an unknown lstPSD is reported, not silently dropped', () => {
    const r = calculatePaycheck(pay('PA', { workPSD: '100401', residencePSD: '880000', lstPSD: '999999' }));
    assert.match(line(r, 'PA_LST')!.detail!, /NOT MODELLED/);
  });
});

describe('A2 more than one locality at once', () => {
  test('Kansas City work and St. Louis residence owe both earnings taxes', () => {
    const r = calculatePaycheck(pay('MO', { localities: ['Kansas City', 'St. Louis'] }));
    assert.equal(line(r, 'KC_EARN')?.amount, 3000);
    assert.equal(line(r, 'STL_EARN')?.amount, 3000);
  });

  test('a single locality still works as before', () => {
    const r = calculatePaycheck(pay('MO', { locality: 'Kansas City' }));
    assert.equal(line(r, 'KC_EARN')?.amount, 3000);
    assert.equal(line(r, 'STL_EARN'), undefined);
  });

  test('the resolver keeps both Missouri cities instead of refusing', () => {
    const r = resolveLocalityCandidates(new Set(['Kansas City', 'St. Louis']), 'MO');
    assert.deepEqual(r.localities, ['Kansas City', 'St. Louis']);
    assert.equal(r.conflictMessage, null);
  });

  test("a locality of another state isn't put on this certificate, and the resolver says so", () => {
    const r = resolveLocalityCandidates(new Set(['Kansas City', 'Wilmington']), 'MO');
    assert.equal(r.locality, 'Kansas City');
    assert.equal(r.localities, undefined);
    assert.match(r.conflictMessage!, /Wilmington/);
  });

  test('two West Virginia fee cities at once is a real clash and sets neither', () => {
    const r = resolveLocalityCandidates(new Set(['Charleston', 'Huntington']), 'WV');
    assert.equal(r.locality, undefined);
    assert.ok(r.conflictMessage);
  });
});

describe('A3 Ohio JEDD map and rate table disagree', () => {
  test('a polygon Ohio marks inactive while the rate table has the zone in force is flagged, not dropped silently', () => {
    const d = ohioJeddDecision({
      found: { attempted: true, jedd: { name: 'WARREN - CHAMPION JEDD', jeddId: '9155', active: false }, candidates: [{ name: 'WARREN - CHAMPION JEDD', jeddId: '9155', active: false }] },
      checkDate: '2026-06-15',
      counties: ['Trumbull County'],
      places: [],
      municipalityMatched: false,
    });
    assert.equal(d.workJEDDId, null);
    assert.match(d.reasons[0], /marks .* as inactive/);
  });

  test('an inactive polygon whose zone the table has ended stays quiet', () => {
    const d = ohioJeddDecision({
      found: { attempted: true, jedd: { name: 'JEFFERSON TOWNSHIP-WHITEHALL JEDD', jeddId: '9123', active: false } },
      checkDate: '2026-06-15',
      counties: [],
      places: [],
      municipalityMatched: false,
    });
    assert.deepEqual(d.reasons, []);
  });
});

describe('A4 data the engine now reads', () => {
  test('West Virginia out-of-state construction employers pay 8.5%, then 7.975% from 2026-07-01', () => {
    const before = calculatePaycheck(pay('WV', {}, { employer: { suiIndustry: { WV: 'out_of_state_construction' } } }, '2026-06-26'));
    assert.equal(line(before, 'WV_SUI_ER')?.amount, 25500); // 8.5% of $3,000
    const after = calculatePaycheck(pay('WV', {}, { employer: { suiIndustry: { WV: 'out_of_state_construction' } } }, '2026-07-10'));
    assert.equal(line(after, 'WV_SUI_ER')?.amount, 23925); // 7.975%
  });

  test('a supplied unemployment rate that looks like a percent is flagged', () => {
    const r = calculatePaycheck(pay('OH', {}, { employer: { stateUnemploymentRate: { OH: 3.1 } } }));
    assert.equal(r.notices?.find((n) => n.taxId === 'OH_SUI_ER')?.tier, 'conflicting_sources');
  });

  test('a normal supplied rate is not flagged', () => {
    const r = calculatePaycheck(pay('OH', {}, { employer: { stateUnemploymentRate: { OH: 0.031 } } }));
    assert.equal(r.notices?.find((n) => n.taxId === 'OH_SUI_ER'), undefined);
  });
});

describe('A7 Pennsylvania single PSD checked against the school district', () => {
  const geo: CensusGeographies = {
    state: 'PA',
    incorporatedPlaces: [],
    countySubdivisions: ['Abington township'],
    counties: ['Montgomery County'],
  };

  test('the matching district: matched, no warning', () => {
    const r = resolveJurisdiction(geo, '2026-06-15', 'Abington School District');
    assert.equal(r.paJurisdiction?.entry?.psdCode, '460101');
    assert.equal(r.paJurisdiction?.warning, undefined);
  });

  test('a different district at the point: still matched, but with a warning', () => {
    const r = resolveJurisdiction(geo, '2026-06-15', 'Cheltenham School District');
    assert.equal(r.paJurisdiction?.entry?.psdCode, '460101');
    assert.match(r.paJurisdiction!.warning!, /Cheltenham/);
  });
});

describe('A9 / B16 Ohio JEDD annual wage caps', () => {
  const jedd = (checkDate: string, ytd?: number) =>
    calculatePaycheck(
      pay('OH', { workJEDDId: '9101' }, ytd === undefined ? {} : { ytd: { socialSecurity: 0, medicare: 0, futa: 0, localIncomeTax: { OH_JEDD_9101: ytd } } }, checkDate),
    );

  test('a cap on file for another year is still applied (2025 check, 2026 cap), with a notice', () => {
    const r = jedd('2025-06-13', 140_488_00);
    assert.equal(line(r, 'OH_JEDD')?.amount, 0);
    assert.match(r.notices!.find((n) => n.taxId === 'OH_JEDD')!.note, /that cap was applied/);
  });

  test('on course to pass the cap with no YTD supplied: a notice', () => {
    const r = jedd('2026-06-15');
    assert.match(r.notices!.find((n) => n.taxId === 'OH_JEDD')!.note, /no year-to-date district wages/);
  });

  test('YTD supplied: no notice', () => {
    const r = jedd('2026-06-15', 50_000_00);
    assert.equal(r.notices?.find((n) => n.taxId === 'OH_JEDD'), undefined);
  });
});

describe('A12 / B16 Kentucky', () => {
  test('a city and county pair says the KRS 68.197 credit was assumed', () => {
    const r = calculatePaycheck(pay('KY', { workCity: 'Bowling Green', workCounty: 'Warren County' }));
    assert.match(r.notices!.find((n) => n.taxId === 'KY_LOCAL')!.note, /KRS 68\.197/);
  });

  test('a capped city on course to pass its cap with no YTD: a notice', () => {
    const r = calculatePaycheck(pay('KY', { workCity: 'Bardwell' }));
    assert.match(r.notices!.find((n) => n.taxId === 'KY_LOCAL')!.note, /annual cap/);
  });
});

describe('A13 Ohio construction new employers', () => {
  test('5.85%, not 2.85%', () => {
    const r = calculatePaycheck(pay('OH', {}, { employer: { suiIndustry: { OH: 'construction' } } }));
    assert.equal(line(r, 'OH_SUI_ER')?.amount, 17550);
    assert.equal(line(calculatePaycheck(pay('OH', {})), 'OH_SUI_ER')?.amount, 8550);
  });
});

describe('A10 Ohio SDIT is a residence tax', () => {
  test('only the residence address sets schoolDistrictCode', () => {
    const geo: CensusGeographies = { state: 'OH', incorporatedPlaces: ['Bluffton village'], countySubdivisions: [], counties: ['Allen County'] };
    const r = resolveJurisdiction(geo, '2026-06-15', 'Bluffton Exempted Village School District');
    assert.equal(toCertificateFields(r, 'work').schoolDistrictCode, undefined);
    assert.equal(toCertificateFields(r, 'residence').schoolDistrictCode, '0203');
  });
});

describe('B1 Pennsylvania residence PSD', () => {
  test('missing: a notice that only the nonresident rate was used', () => {
    const r = calculatePaycheck(pay('PA', { workPSD: '460101' }));
    assert.match(r.notices!.find((n) => n.taxId === 'PA_EIT')!.note, /No certificate\.residencePSD/);
  });

  test("'880000' (out of state): no notice", () => {
    const r = calculatePaycheck(pay('PA', { workPSD: '460101', residencePSD: '880000' }));
    assert.equal(r.notices?.find((n) => n.taxId === 'PA_EIT'), undefined);
  });

  test('a code not in the registry: a notice', () => {
    const r = calculatePaycheck(pay('PA', { workPSD: '460101', residencePSD: '123456' }));
    assert.match(r.notices!.find((n) => n.taxId === 'PA_EIT')!.note, /not in the PSD registry/);
  });
});

describe('B4 / B5 / B7 misplaced or contradictory inputs', () => {
  test('local fields only on the residence certificate are reported', () => {
    const r = calculatePaycheck(
      pay('PA', { workPSD: '460101' }, { residenceState: { code: 'PA', certificate: { residencePSD: '460101' } } as PaycheckInput['residenceState'] }),
    );
    assert.ok(r.warnings?.some((w) => /residencePSD/.test(w) && /workState\.certificate only/.test(w)));
  });

  test('nonresident with no residence state is reported', () => {
    const r = calculatePaycheck(pay('MD', { nonresident: true, county: 'Montgomery' }));
    assert.ok(r.warnings?.some((w) => /input\.residenceState is absent/.test(w)));
  });

  test('nonresident while living in the same state is reported', () => {
    const r = calculatePaycheck(
      pay('DC', { nonresident: true }, { residenceState: { code: 'DC' } as PaycheckInput['residenceState'] }),
    );
    assert.ok(r.warnings?.some((w) => /residenceState is the same state/.test(w)));
  });
});

describe('B16 Oregon Metro / Multnomah triggers', () => {
  const big = (ytd?: Record<string, number>) =>
    calculatePaycheck({
      ...pay('OR', { metroDistrict: true, multnomahCounty: true }),
      earnings: [{ code: 'REG', category: 'regular', amount: 1_000_000 }], // $10,000 a week
      ...(ytd ? { ytd: { socialSecurity: 0, medicare: 0, futa: 0, localIncomeTax: ytd } } : {}),
    });

  test('on course to pass the trigger with no YTD: both lines say so', () => {
    const r = big();
    assert.match(r.notices!.find((n) => n.taxId === 'OR_METRO_SHS')!.note, /OR_METRO/);
    assert.match(r.notices!.find((n) => n.taxId === 'OR_MULTNOMAH_PFA')!.note, /OR_MULTNOMAH/);
  });

  test('YTD supplied past the trigger: taxed, no notice', () => {
    const r = big({ OR_METRO: 200_000_00, OR_MULTNOMAH: 250_000_00 });
    assert.ok(r.taxes.find((t) => t.id === 'OR_METRO_SHS')!.amount > 0);
    assert.equal(r.notices?.find((n) => n.taxId === 'OR_METRO_SHS'), undefined);
  });
});

describe('B6 Maryland resident with no recognized county', () => {
  test('the maximum local rate is withheld, with a notice', () => {
    const r = calculatePaycheck(pay('MD', { county: 'Nowhere' }));
    assert.match(r.notices!.find((n) => n.taxId === 'MD_SIT')!.note, /no recognized Maryland county/);
  });
});

describe('B19 Colorado OPT without this month\'s compensation', () => {
  test('nothing computed, and the line says why', () => {
    const r = calculatePaycheck(pay('CO', { locality: 'Denver' }));
    assert.match(r.notices!.find((n) => n.taxId.endsWith('_OPT_EE'))!.note, /localMonthlyCompensation/);
  });
});
