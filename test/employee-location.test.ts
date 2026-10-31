import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.ts';
import { addEmployee, updateEmployee } from '../src/domain/employees.ts';
import { ApiError } from '../src/lib/errors.ts';
import { newCompany } from './helpers.ts';

const base = { firstName: 'Ana', lastName: 'Cruz', roleKey: 'server', hireDate: '2026-01-05', payType: { kind: 'hourly', rateCents: 1500 } };

test('a person is placed at one of the business\'s locations, and a location in another state is taxed there', () => {
  const store = new Store();
  const { company } = newCompany(store, { homeState: 'MI' });
  store.tx(() => store.companies.put({ ...company, locations: [{ name: 'Detroit', city: 'Detroit', state: 'MI' }, { name: 'Toledo', city: 'Toledo', state: 'OH' }] }));
  const a = addEmployee(store, company.id, { ...base, location: 'detroit', tags: { department: 'Front of house' } });
  assert.equal(a.location, 'Detroit');
  assert.equal(a.tags?.department, 'Front of house');
  assert.equal(a.workState.code, 'MI');
  const b = addEmployee(store, company.id, { ...base, lastName: 'Two', location: 'Toledo' });
  assert.equal(b.workState.code, 'OH', 'the work state follows the location');
  assert.throws(() => addEmployee(store, company.id, { ...base, location: 'Atlantis' }), (e: unknown) => e instanceof ApiError && /not one of your locations/.test(e.message));
  assert.throws(() => addEmployee(store, company.id, { ...base, tags: { crew: '<b>x</b>' } }), ApiError);
  const c = updateEmployee(store, company.id, a.id, { location: 'Toledo', tags: {} });
  assert.equal(c.location, 'Toledo');
  assert.equal(c.tags, undefined);
});

test('a seasonal person has a season, and an end before the start is refused', () => {
  const store = new Store();
  const { company } = newCompany(store);
  const e = addEmployee(store, company.id, { ...base, season: { start: '2026-06-01', end: '2026-09-15' } });
  assert.deepEqual(e.season, { start: '2026-06-01', end: '2026-09-15' });
  assert.throws(() => addEmployee(store, company.id, { ...base, lastName: 'Two', season: { start: '2026-09-01', end: '2026-06-01' } }), ApiError);
  assert.equal(updateEmployee(store, company.id, e.id, { season: null }).season, undefined);
});
