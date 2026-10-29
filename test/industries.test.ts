import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSettingsConsistent, catalog, checklistFor, getIndustry, settingsFromProfile } from '../src/industries/index.ts';
import { hasStateRuleset } from '../engine/src/registry.ts';

const niches = getIndustry('restaurant').niches;

test('every niche is internally consistent: the roles its policy names exist', () => {
  for (const n of niches) assert.doesNotThrow(() => assertSettingsConsistent(settingsFromProfile(n)), n.id);
});

test('every niche\'s defaults obey the tip rules they will be enforced under', () => {
  for (const n of niches) {
    const roles = new Map(n.roles.map((r) => [r.key, r]));
    const { policy } = n;
    for (const key of policy.pool.roles) assert.equal(roles.get(key)!.manager, false, `${n.id}: a manager is in the tip pool (${key})`);
    if (policy.takesTipCredit) {
      for (const key of policy.pool.roles) assert.equal(roles.get(key)!.tipped, 'customarily', `${n.id}: with a tip credit, pool role ${key} must be customarily tipped`);
      for (const t of policy.tipOuts) assert.equal(roles.get(t.toRole)!.tipped, 'customarily', `${n.id}: with a tip credit, tip-out '${t.id}' must go to a customarily tipped role`);
    }
    for (const t of policy.tipOuts) {
      assert.equal(roles.get(t.toRole)!.manager, false, `${n.id}: tip-out '${t.id}' goes to a manager`);
      assert.ok(t.bps > 0 && t.bps <= 10_000, `${n.id}: tip-out '${t.id}' has a nonsense percentage`);
    }
    for (const key of policy.serviceChargeRoles) assert.ok(roles.has(key));
    if (policy.serviceCharge === 'distribute_to_staff') assert.ok(policy.serviceChargeRoles.length > 0, `${n.id}: a distributed service charge needs recipients`);
  }
});

test('every niche has a manager role who is excluded from pools, and role keys are unique', () => {
  for (const n of niches) {
    assert.ok(n.roles.some((r) => r.manager), `${n.id} has no manager role`);
    assert.equal(new Set(n.roles.map((r) => r.key)).size, n.roles.length, `${n.id} repeats a role key`);
    assert.ok(n.roles.filter((r) => r.manager).every((r) => r.poolPoints === 0), `${n.id}: managers carry pool points`);
  }
});

test('every checklist item says whether it was verified, with sources and a date when it was', () => {
  for (const n of niches) {
    const ids = new Set<string>();
    for (const item of n.checklist) {
      assert.ok(!ids.has(item.id), `${n.id}: duplicate checklist id ${item.id}`);
      ids.add(item.id);
      assert.notEqual(item.verified, undefined, `${n.id}/${item.id} does not say whether it was verified`);
      if (item.verified) {
        assert.match(item.verified.on, /^\d{4}-\d{2}-\d{2}$/);
        assert.ok(item.verified.sources.length > 0, `${n.id}/${item.id} claims verification without a source`);
      }
      for (const st of item.states ?? []) assert.ok(hasStateRuleset(st, '2026-06-01'), `${item.id} names a state the engine does not cover: ${st}`);
    }
  }
});

test('state-specific items reach only companies in that state', () => {
  const full = niches.find((n) => n.id === 'full_service')!;
  const ids = (st: string) => checklistFor(full, st).map((i) => i.id);
  assert.ok(ids('NY').includes('ny_hospitality_pay'));
  assert.ok(!ids('TX').includes('ny_hospitality_pay'));
  assert.ok(ids('AK').includes('ak_overtime') && ids('NV').includes('nv_overtime') && ids('CO').includes('co_overtime'));
  assert.ok(ids('CA').includes('ca_daily_overtime') && ids('CA').includes('ca_meal_rest'));
  assert.ok(!ids('TX').some((i) => i.startsWith('ca_') || i.startsWith('ny_')));
});

test('only restaurant is available; the other industries are planned and carry no niches', () => {
  assert.deepEqual(catalog.filter((i) => i.status === 'available').map((i) => i.id), ['restaurant']);
  assert.ok(catalog.filter((i) => i.status === 'planned').every((i) => i.niches.length === 0));
});
