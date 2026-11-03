import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.ts';
import { createCompanyFromSetup } from '../src/builder/finish.ts';
import type { User } from '../src/accounts/types.ts';
import { addEmployee } from '../src/domain/employees.ts';
import { saveWeek } from '../src/domain/weekEntry.ts';
import { posReady } from './helpers.ts';
import { posPayrollReadiness, posWorkspace } from '../src/pos/readiness.ts';
import { draftPayRun, approvePayRun } from '../src/payroll/payRuns.ts';
import { PosService } from '../src/pos/service.ts';
import { decryptField } from '../src/lib/crypto.ts';
import { toastApprovalUrl, approvedToastLocation } from '../src/pos/toastPartner.ts';

const from = '2026-10-19', to = '2026-10-25';
const period = { periodStart: from, periodEnd: to, checkDate: '2026-10-30' };
function fixture() {
  const store = new Store();
  const company = createCompanyFromSetup(store, { id: 'test_owner', businessName: 'Harbor' } as User, 'restaurant', { state: 'TX', locations: [{ name: 'Main', city: 'Austin', state: 'TX' }], team: '1-10', tips: { on: true, pool: 'hours' }, frequency: { value: 'weekly', weekday: 'friday' }, contractors: { on: false } }, '2026-10-30', new Date('2026-10-30T15:00:00Z'));
  const employee = addEmployee(store, company.id, { firstName: 'Ana', lastName: 'Cruz', roleKey: 'line_cook', hireDate: '2026-01-05', payType: { kind: 'hourly', rateCents: 2000 }, ssn: '512-34-9001' });
  saveWeek(store, company, { periodStart: from, periodEnd: to, entries: [{ employeeId: employee.id, regularMinutes: 1200, chargedTipsCents: 5000 }] });
  return { store, company, employee };
}
test('web payroll requires a connected source, complete period and reconciled source records', () => {
  const { store, company } = fixture();
  assert.throws(() => draftPayRun(store, company.id, period), { code: 'pos_not_ready' });
  posReady(store, company.id, from, to);
  const original = store.posConnections.all()[0]!;
  for (const change of [{ provider: 'file' as const }, { lastError: 'Import failed' }, { lastSummary: { ...original.lastSummary!, from: '2026-10-20' } }, { lastSummary: { ...original.lastSummary!, unmapped: [{ externalId: 'x', name: 'Unmatched', minutes: 60 }] } }, { lastSummary: { ...original.lastSummary!, problems: ['Invalid clock'] } }]) {
    store.tx(() => store.posConnections.put({ ...original, ...change }));
    assert.equal(posPayrollReadiness(store, company.id, from, to).ready, false);
    assert.throws(() => draftPayRun(store, company.id, period), { code: 'pos_not_ready' });
  }
  store.tx(() => store.posConnections.put(original));
  assert.equal(posPayrollReadiness(store, company.id, from, to).ready, true);
  const shift = store.shifts.all()[0]!;
  store.tx(() => store.shifts.put({ ...shift, externalId: undefined }));
  assert.throws(() => draftPayRun(store, company.id, period), { code: 'pos_not_ready' });
});
test('imported timecards show exact integer totals and exclude another company', () => {
  const { store, company } = fixture(); posReady(store, company.id, from, to);
  const shift = store.shifts.all()[0]!;
  store.tx(() => { store.shifts.put({ ...shift, chargedTipsCents: 1234, cashTipsCents: 567 }); store.shifts.put({ ...shift, id: 'other', companyId: 'other', externalId: 'pos:square:other' }); });
  const workspace = posWorkspace(store, company.id, from, to);
  assert.deepEqual(workspace.totals, { shifts: 7, people: 1, minutes: 1200, cardTipsCents: 1234, cashTipsCents: 567 });
  assert.equal(workspace.rows[0]!.name, 'Ana Cruz');
  assert.ok(!JSON.stringify(workspace).includes('credentialsEncrypted'));
});
test('changing imported hours after review blocks approval until recalculation', () => {
  const { store, company } = fixture(); posReady(store, company.id, from, to);
  const run = draftPayRun(store, company.id, period), shift = store.shifts.all()[0]!;
  store.tx(() => store.shifts.put({ ...shift, minutes: shift.minutes + 60 }));
  assert.throws(() => approvePayRun(store, company.id, run.id, {}), { code: 'pos_changed_recalculate' });
  store.tx(() => store.posConnections.delete(store.posConnections.all()[0]!.id));
  assert.throws(() => approvePayRun(store, company.id, run.id, {}), { code: 'pos_not_ready' });
});
test('7shifts partner approval binds the company grant, uses read scopes and stores encrypted credentials', async () => {
  const { store, company } = fixture(); let now = Date.parse('2026-10-30T15:00:00Z');
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    calls.push({url,init});
    if(url.endsWith('/oauth2/token')) { const body = new URLSearchParams(String(init.body)); assert.equal(body.get('grant_type'),'client_credentials'); assert.ok(!body.get('scope')!.includes('write')); return Response.json({access_token:'fixture_token',expires_in:3600}); }
    assert.equal((init.headers as Record<string,string>)['x-company-guid'],'grant-guid-123');
    if(url.endsWith('/v2/companies')) return Response.json({data:[{id:42}]});
    return Response.json({data:[],meta:{}});
  }) as unknown as typeof fetch;
  const svc = new PosService(store, () => new Date(now), f, {}, { sevenshifts: { appId: 'fixture_client', secret: 'fixture_secret' } });
  const start = svc.oauthStart(company.id,'sevenshifts','https://app.example/callback');
  assert.equal(new URL(start.url).origin,'https://app.7shifts.com');
  const query = new URLSearchParams({state:start.state,guid:'grant-guid-123',company_id:'42'});
  const connection = await svc.oauthFinish('sevenshifts',query,company.id);
  assert.equal(connection.provider,'sevenshifts');
  assert.ok(!JSON.stringify(connection).includes('fixture_token'));
  assert.equal(JSON.parse(decryptField(store.posConnections.all()[0]!.credentialsEncrypted)).companyGuid,'grant-guid-123');
  await assert.rejects(svc.oauthFinish('sevenshifts',query,company.id));
  now += 3600_000; await svc.people(company.id);
  assert.equal(calls.filter(c=>c.url.endsWith('/oauth2/token')).length,2);
});
test('7shifts refuses wrong-account, expired and mismatched company grants', async () => {
  const {store,company} = fixture(); let now=0;
  const f = (async(url:string)=>Response.json(url.endsWith('/oauth2/token') ? {access_token:'fixture',expires_in:3600} : {data:[{id:99}]})) as unknown as typeof fetch;
  const svc=new PosService(store,()=>new Date(now),f,{}, {sevenshifts:{appId:'fixture',secret:'fixture'}});
  const query=()=> { const s=svc.oauthStart(company.id,'sevenshifts','https://app.example/callback');return new URLSearchParams({state:s.state,guid:'grant-guid-123',company_id:'42'}); };
  await assert.rejects(svc.oauthFinish('sevenshifts',query(),'other'),{code:'wrong_company'});
  const expired=query();now+=16*60_000;await assert.rejects(svc.oauthFinish('sevenshifts',expired,company.id));
  await assert.rejects(svc.oauthFinish('sevenshifts',query(),company.id),/does not match/);
  assert.equal(store.posConnections.all().length,0);
});
test('Toast accepts only an official marketplace and a unique approved location reference', async () => {
  for(const url of ['http://pos.toasttab.com/','https://toasttab.com.evil.test/','https://evil.test/','https://name@pos.toasttab.com/']) assert.throws(()=>toastApprovalUrl(url));
  assert.equal(toastApprovalUrl('https://pos.toasttab.com/integrations'),'https://pos.toasttab.com/integrations');
  const app={appId:'fixture',secret:'fixture',entryUrl:'https://pos.toasttab.com/integrations'};
  let restaurants=[{restaurantGuid:'restaurant-1',externalRestaurantRef:'other-reference'}];
  const f=(async(url:string)=>Response.json(url.includes('/login')?{token:{accessToken:'fixture'}}:restaurants)) as unknown as typeof fetch;
  await assert.rejects(approvedToastLocation(f,app,'my-reference'),/not visible/);
  restaurants=[{restaurantGuid:'restaurant-1',externalRestaurantRef:'my-reference'}];
  assert.equal((await approvedToastLocation(f,app,'my-reference')).restaurantGuid,'restaurant-1');
  restaurants.push({...restaurants[0]!});await assert.rejects(approvedToastLocation(f,app,'my-reference'),/not visible/);
});
test('Toast marketplace completion verifies labor access and keeps company references separate', async () => {
  const {store,company}=fixture(); let reference=''; let laborAllowed=false;
  const f=(async(url:string)=> {
    if(url.endsWith('/login'))return Response.json({token:{accessToken:'fixture'}});
    if(url.endsWith('/partners/v1/restaurants'))return Response.json([{restaurantGuid:'restaurant-one',externalRestaurantRef:reference}]);
    if(url.endsWith('/labor/v1/employees'))return laborAllowed?Response.json([]):new Response('{}',{status:403});
    return new Response('{}',{status:404});
  }) as unknown as typeof fetch;
  const svc=new PosService(store,()=>new Date('2026-10-30T15:00:00Z'),f,{}, {toast:{appId:'fixture',secret:'fixture',entryUrl:'https://pos.toasttab.com/integrations'}});
  const request=svc.toastStart(company.id);reference=request.reference;
  await assert.rejects(svc.toastComplete('other'));
  await assert.rejects(svc.toastComplete(company.id),/refused/);
  assert.equal(store.posConnections.all().length,0);
  laborAllowed=true;const connected=await svc.toastComplete(company.id);
  assert.equal(connected.provider,'toast');assert.ok(!JSON.stringify(connected).includes('clientSecret'));
  await assert.rejects(svc.toastComplete(company.id));
});
