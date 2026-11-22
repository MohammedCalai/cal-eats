import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createAdminAppConfig} from '../app.config.js';

const config = JSON.parse(fs.readFileSync(new URL('../app.json', import.meta.url), 'utf8')).expo;
const firebase = (packageName = 'info.calai.caleatsadmin', projectId = 'cal-eats-notifications') => ({
  project_info: {project_number: '267285017965', project_id: projectId},
  client: [{client_info: {mobilesdk_app_id: packageName === 'info.calai.caleatsadmin' ? '1:267285017965:android:806f06e062f0931dbb9664' : '1:267285017965:android:9c20cbd0e65ff71cbb9664', android_client_info: {package_name: packageName}}, api_key: [{current_key: 'TEST_ONLY_FIREBASE_CONFIGURATION_KEY'}]}],
});

function withConfigFile(value: unknown, run: (filename: string) => void) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-eats-admin-native-config-'));
  const filename = path.join(directory, 'google-services.json');
  try {
    fs.writeFileSync(filename, JSON.stringify(value));
    run(filename);
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
}

test('manager native config preserves identity and does not consume customer build variables', () => {
  assert.strictEqual(createAdminAppConfig(config, {GOOGLE_SERVICES_JSON: 'customer.json', CAL_EATS_GOOGLE_SERVICES_FILE: 'customer.json'}), config);
  assert.throws(() => createAdminAppConfig({...config, extra: {eas: {projectId: '5bf59184-c670-44f4-be78-5229cbd02300'}}}, {}), /existing approved/);
  assert.throws(() => createAdminAppConfig({...config, android: {...config.android, package: 'uk.co.calai.caleats'}}, {}), /existing approved/);
  assert.throws(() => createAdminAppConfig(config, {CAL_EATS_EXPO_OWNER: 'another-account'}), /existing approved/);
  assert.throws(() => createAdminAppConfig(config, {CAL_EATS_EAS_PROJECT_ID: '5bf59184-c670-44f4-be78-5229cbd02300'}), /existing approved/);
});

test('native configuration keeps the existing test-only distribution restriction', () => {
  assert.throws(() => createAdminAppConfig(config, {CAL_EATS_PUBLIC_RELEASE_BUILD: 'true'}), /test distribution only/);
  assert.throws(() => createAdminAppConfig(config, {EAS_BUILD_PROFILE: 'production'}), /test distribution only/);
});

test('native Android workers fail before packaging without the manager Firebase registration', () => {
  assert.throws(() => createAdminAppConfig(config, {EAS_BUILD: 'true', EAS_BUILD_PLATFORM: 'android'}), /CAL_EATS_ADMIN_GOOGLE_SERVICES_FILE/);
  assert.strictEqual(createAdminAppConfig(config, {EAS_BUILD: 'true', EAS_BUILD_PLATFORM: 'ios'}), config);
});

test('the manager Firebase file must match the registered manager package and sender', () => {
  withConfigFile(firebase(), filename => {
    const result = createAdminAppConfig(config, {CAL_EATS_ADMIN_GOOGLE_SERVICES_FILE: filename});
    assert.equal(result.android.googleServicesFile, filename);
    assert.equal(result.android.package, config.android.package);
    assert.deepEqual(result.extra, config.extra);
    assert.equal(config.android.googleServicesFile, undefined);
  });
  for (const value of [firebase('uk.co.calai.caleats'), firebase('info.calai.caleatsadmin', 'unrelated-project'), {...firebase(), client: [...firebase().client, ...firebase().client]}]) {
    withConfigFile(value, filename => assert.throws(() => createAdminAppConfig(config, {CAL_EATS_ADMIN_GOOGLE_SERVICES_FILE: filename}), /not the customer app or another sender/));
  }
});

test('official sibling clients are preserved while only the exact manager registration is selected', () => {
  const services = {...firebase(), client: [...firebase('uk.co.calai.caleats').client, ...firebase().client]};
  withConfigFile(services, filename => {
    const original = fs.readFileSync(filename);
    const result = createAdminAppConfig(config, {CAL_EATS_ADMIN_GOOGLE_SERVICES_FILE: filename});
    assert.equal(result.android.package, 'info.calai.caleatsadmin');
    assert.equal(result.extra.eas.projectId, '6282b87e-36ae-43bb-80b7-12d69108a411');
    assert.deepEqual(fs.readFileSync(filename), original);
  });
});

test('the manager client must contain an API key and invalid JSON shapes fail closed', () => {
  const missingKey = firebase();
  missingKey.client[0]!.api_key = [];
  for (const value of [missingKey, null, []]) {
    withConfigFile(value, filename => assert.throws(() => createAdminAppConfig(config, {CAL_EATS_ADMIN_GOOGLE_SERVICES_FILE: filename}), /not the customer app or another sender/));
  }
});

test('invalid Firebase files fail without exposing their contents', () => {
  withConfigFile({secret: 'never-include-this-in-errors'}, filename => {
    assert.throws(() => createAdminAppConfig(config, {CAL_EATS_ADMIN_GOOGLE_SERVICES_FILE: filename}), error => error instanceof Error && !error.message.includes('never-include'));
  });
  assert.throws(() => createAdminAppConfig(config, {CAL_EATS_ADMIN_GOOGLE_SERVICES_FILE: 'unavailable-manager-config.json'}), /missing or invalid/);
});

test('the Firebase sender and app ID must be the actual approved manager registration', () => {
  const wrongSender = firebase();
  wrongSender.project_info.project_number = '1234567890';
  wrongSender.client[0]!.client_info.mobilesdk_app_id = '1:1234567890:android:806f06e062f0931dbb9664';
  const wrongApp = firebase();
  wrongApp.client[0]!.client_info.mobilesdk_app_id = '1:267285017965:android:anotherregistration';
  for (const value of [wrongSender, wrongApp]) {
    withConfigFile(value, filename => assert.throws(() => createAdminAppConfig(config, {CAL_EATS_ADMIN_GOOGLE_SERVICES_FILE: filename}), /not the customer app or another sender/));
  }
});
