import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** Every state with an income tax that has an exemptPretax list also records what its agency says about it. */
const NOT_RECORDED_HERE = new Set(['CA', 'NJ', 'PA']); // documented in their own exemptPretaxComment / exemptComment

const states = 'AL AR AZ CO CT DC DE GA HI IA ID IL IN KS KY LA MA MD ME MI MN MO MS MT NC ND NE NM NY OH OK OR RI SC UT VA VT WI WV'.split(' ');

for (const st of states) {
  test(`${st}: pretaxVerification is recorded and cites a result`, () => {
    const d = JSON.parse(readFileSync(new URL(`../data/states/${st}-2026.json`, import.meta.url), 'utf8'));
    assert.ok(Array.isArray(d.exemptPretax) && d.exemptPretax.length > 0, 'exemptPretax list present');
    assert.equal(d.pretaxVerification?.checkedOn, '2026-10-18');
    assert.ok(typeof d.pretaxVerification.result === 'string' && d.pretaxVerification.result.length > 40);
    assert.ok(Array.isArray(d.pretaxVerification.sources));
  });
}

test('CA, NJ and PA keep their own documented deviations from federal treatment', () => {
  const load = (st: string) => JSON.parse(readFileSync(new URL(`../data/states/${st}-2026.json`, import.meta.url), 'utf8'));
  assert.ok(!load('CA').exemptPretax.includes('hsa'));
  assert.deepEqual(load('NJ').exemptPretax, ['deferral_401k', 'commuter']);
  for (const c of ['deferral_401k', 'deferral_403b', 'deferral_457', 'deferral_simple', 'commuter']) {
    assert.ok(!load('PA').exemptPretax.includes(c), c);
  }
  assert.equal(NOT_RECORDED_HERE.size, 3);
});
