import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { REQUIRED_PUBLIC_RELEASE_GATES, validateReleaseReadiness } from './release-readiness.mjs';

const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = approved => Object.fromEntries(REQUIRED_PUBLIC_RELEASE_GATES.map(key => [key, approved]));

test('readiness requires the complete fixed boolean schema and explicit approval of every gate', () => {
  const waiting = validateReleaseReadiness(manifest(false));
  assert.equal(waiting.valid, true); assert.equal(waiting.approved, false); assert.equal(waiting.pending.length, 12);
  assert.deepEqual(validateReleaseReadiness(manifest(true)), { valid: true, approved: true, pending: [], errors: [] });
});

test('empty, missing, inherited, malformed and unknown readiness gates fail closed', () => {
  const incomplete = manifest(true); delete incomplete.accountRecoveryEmailVerified;
  for (const value of [{}, incomplete, null, [], true, Object.create(manifest(true)), { ...manifest(true), extraGate: true }]) {
    const checked = validateReleaseReadiness(value); assert.equal(checked.valid, false); assert.equal(checked.approved, false); assert.ok(checked.errors.length);
  }
  for (const value of ['true', 'false', 1, 0, null, {}, []]) {
    const checked = validateReleaseReadiness({ ...manifest(true), privacyAndTermsApproved: value });
    assert.equal(checked.approved, false); assert.ok(checked.errors.some(message => message.includes('privacyAndTermsApproved')));
  }
});

test('a release requires evidence for its own platform while preserving shared launch gates', () => {
  const android = { ...manifest(true), iosLiveActivityBackgroundAndTerminalVerified: false, iosPhysicalDeviceVerified: false };
  assert.equal(validateReleaseReadiness(android, { platform: 'android' }).approved, true);
  assert.equal(validateReleaseReadiness(android, { platform: 'ios' }).approved, false);
  assert.equal(validateReleaseReadiness(android).approved, false);
  const ios = { ...manifest(true), androidPhysicalDeviceVerified: false };
  assert.equal(validateReleaseReadiness(ios, { platform: 'ios' }).approved, true);
  assert.equal(validateReleaseReadiness(ios, { platform: 'android' }).approved, false);
  for (const key of ['accountRecoveryEmailVerified', 'livePaymentsAndRestaurantPayoutsVerified', 'privacyAndTermsApproved', 'androidPhysicalDeviceVerified']) {
    const checked = validateReleaseReadiness({ ...android, [key]: false }, { platform: 'android' });
    assert.equal(checked.approved, false); assert.ok(checked.pending.includes(key));
  }
});

test('platform-specific readiness rejects unknown platforms and malformed or missing relevant evidence', () => {
  for (const platform of ['web', '', null, 'Android', '__proto__']) {
    const checked = validateReleaseReadiness(manifest(true), { platform });
    assert.equal(checked.valid, false); assert.equal(checked.approved, false);
  }
  const android = manifest(true); delete android.androidPhysicalDeviceVerified;
  assert.equal(validateReleaseReadiness(android, { platform: 'android' }).valid, false);
  const minimalAndroid = manifest(true); delete minimalAndroid.iosPhysicalDeviceVerified; delete minimalAndroid.iosLiveActivityBackgroundAndTerminalVerified;
  assert.equal(validateReleaseReadiness(minimalAndroid, { platform: 'android' }).approved, true);
  assert.equal(validateReleaseReadiness({ ...minimalAndroid, iosPhysicalDeviceVerified: 'true' }, { platform: 'android' }).valid, false);
});

test('real production preflight rejects an empty, incomplete or malformed manifest without weakening a valid fixture', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cal-eats-readiness-'));
  try {
    const target = path.join(directory, 'mobile'), script = path.join(target, 'scripts', 'store-preflight.mjs');
    await fs.mkdir(path.dirname(script), { recursive: true });
    const app = JSON.parse(await fs.readFile(path.join(mobile, 'app.json'), 'utf8'));
    const icon = path.resolve(target, app.expo.icon); assert.ok(icon.startsWith(target + path.sep));
    await fs.mkdir(path.dirname(icon), { recursive: true });
    await Promise.all([
      fs.copyFile(path.join(mobile, 'scripts', 'store-preflight.mjs'), script),
      fs.copyFile(path.join(mobile, 'scripts', 'release-readiness.mjs'), path.join(target, 'scripts', 'release-readiness.mjs')),
      fs.copyFile(path.join(mobile, 'app.json'), path.join(target, 'app.json')),
      fs.copyFile(path.join(mobile, 'eas.json'), path.join(target, 'eas.json')),
      fs.copyFile(path.resolve(mobile, app.expo.icon), icon)
    ]);
    const environment = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    const incomplete = manifest(true); delete incomplete.accountDeletionCompletedAndVerified;
    for (const { value, approved } of [{ value: {}, approved: false }, { value: incomplete, approved: false }, { value: { ...manifest(true), androidPhysicalDeviceVerified: 'true' }, approved: false }, { value: manifest(true), approved: true }]) {
      await fs.writeFile(path.join(target, 'release-readiness.json'), JSON.stringify(value));
      const run = spawnSync(process.execPath, [script, '--production'], { cwd: target, env: environment, encoding: 'utf8', timeout: 15_000 });
      assert.ifError(run.error); const report = JSON.parse(run.stdout);
      assert.equal(run.status, approved ? 0 : 1, run.stderr || run.stdout); assert.equal(report.publicReleaseReady, approved);
      if (!approved) assert.ok(report.readinessSchemaErrors.length);
    }
    const firebasePath = path.join(target, 'google-services.fixture.json');
    await fs.writeFile(firebasePath, JSON.stringify({ project_info: { project_number: '123456789' }, client: [{ client_info: { android_client_info: { package_name: 'uk.co.calai.caleats' } } }] }));
    for (const { platform, value, approved } of [
      { platform: 'android', value: { ...manifest(true), iosPhysicalDeviceVerified: false, iosLiveActivityBackgroundAndTerminalVerified: false }, approved: true },
      { platform: 'ios', value: { ...manifest(true), androidPhysicalDeviceVerified: false }, approved: true },
      { platform: 'android', value: { ...manifest(true), androidPhysicalDeviceVerified: false }, approved: false }
    ]) {
      await fs.writeFile(path.join(target, 'release-readiness.json'), JSON.stringify(value));
      const run = spawnSync(process.execPath, [script, '--production'], { cwd: target, env: { ...environment, EAS_BUILD_PLATFORM: platform, GOOGLE_SERVICES_JSON: firebasePath }, encoding: 'utf8', timeout: 15_000 });
      assert.ifError(run.error); const report = JSON.parse(run.stdout);
      assert.equal(run.status, approved ? 0 : 1, run.stderr || run.stdout); assert.equal(report.publicReleaseReady, approved); assert.equal(report.platform, platform);
    }
    await fs.writeFile(path.join(target, 'release-readiness.json'), JSON.stringify(manifest(true)));
    for (const configured of [false, true]) {
      const run = spawnSync(process.execPath, [script, '--production'], { cwd: target, env: { ...environment, CAL_EATS_BUILD_PLATFORM: 'android', ...(configured ? { GOOGLE_SERVICES_JSON: firebasePath } : {}) }, encoding: 'utf8', timeout: 15_000 });
      assert.ifError(run.error); const report = JSON.parse(run.stdout);
      assert.equal(run.status, configured ? 0 : 1, run.stderr || run.stdout);
      assert.equal(report.publicReleaseReady, configured);
      assert.equal(report.checks.find(row => row.name.includes('Firebase')).passed, configured);
    }
  } finally {
    const absolute = path.resolve(directory); assert.ok(absolute.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(absolute).startsWith('cal-eats-readiness-'));
    await fs.rm(absolute, { recursive: true, force: true });
  }
});
