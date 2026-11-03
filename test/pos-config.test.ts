import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPosApps, providerSetup, posSetupWarnings } from '../src/pos/config.ts';
import { PosService } from '../src/pos/service.ts';
import { Store } from '../src/store/store.ts';

test('all four apps require complete trimmed provider credentials', () => {
  assert.deepEqual(loadPosApps({}), {});
  assert.deepEqual(loadPosApps({ SQUARE_APP_ID: 'id', SQUARE_APP_SECRET: '  ' }), {});
  const env = { SQUARE_APP_ID: ' square-id ', SQUARE_APP_SECRET: ' square-secret ', SQUARE_ENVIRONMENT: 'sandbox', CLOVER_APP_ID: 'clover-id', CLOVER_APP_SECRET: 'clover-secret', SEVENSHIFTS_CLIENT_ID: 'seven-id', SEVENSHIFTS_CLIENT_SECRET: 'seven-secret', TOAST_PARTNER_CLIENT_ID: 'toast-id', TOAST_PARTNER_CLIENT_SECRET: 'toast-secret', TOAST_PARTNER_ENTRY_URL: 'https://pos.toasttab.com/integrations' };
  const apps = loadPosApps(env);
  assert.equal(apps.square!.appId, 'square-id');
  assert.equal(apps.square!.secret, 'square-secret');
  assert.equal(Object.keys(apps).length,4);
  assert.deepEqual(posSetupWarnings(env),[]);
  const catalog = new PosService(new Store(), undefined, undefined, {}, apps).catalog('fixture');
  assert.ok(catalog.providers.every(p=>p.signIn));
  const publicView = JSON.stringify(catalog);
  for(const credential of ['square-secret','clover-secret','seven-secret','toast-secret']) assert.ok(!publicView.includes(credential));
  assert.equal(loadPosApps({...env, TOAST_PARTNER_ENTRY_URL: ''}).toast,undefined);
});
test('standard vendor credential aliases work, canonical names take precedence', () => {
  assert.deepEqual(loadPosApps({ SQUARE_APPLICATION_ID: 'square-id', SQUARE_APPLICATION_SECRET: 'square-secret', SQUARE_ENVIRONMENT: 'sandbox', CLOVER_CLIENT_ID: 'clover-id', CLOVER_CLIENT_SECRET: 'clover-secret' }),{square:{appId:'square-id',secret:'square-secret',environment:'sandbox',redirectUrl:'https://totali.tax/v1/pos/square/callback'},clover:{appId:'clover-id',secret:'clover-secret'}});
  assert.equal(loadPosApps({ SQUARE_APPLICATION_ID: 'square-id', SQUARE_APPLICATION_SECRET: 'square-secret' }).square, undefined);
  assert.equal(loadPosApps({SQUARE_APP_ID:'canonical',SQUARE_APPLICATION_ID:'alias',SQUARE_APP_SECRET:'secret',SQUARE_ENVIRONMENT:'sandbox'}).square!.appId,'canonical');
});
test('missing setup is actionable for each provider without exposing secret values', () => {
  const warnings=posSetupWarnings({SQUARE_APP_ID:'present-id'});
  assert.equal(warnings.length,4);
  assert.match(warnings.join(),/SQUARE_APP_SECRET/);
  assert.match(warnings.join(),/SEVENSHIFTS_CLIENT_SECRET/);
  assert.match(warnings.join(),/TOAST_PARTNER_ENTRY_URL/);
  assert.ok(!warnings.join().includes('present-id'));
  assert.equal(providerSetup('square').callbackPath,'/v1/pos/square/callback');
  assert.equal(providerSetup('toast').callbackPath,null);
});
