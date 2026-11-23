import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { journeyFixture } from './helpers.js';
import { readSession } from '../src/auth/sessions.js';
import { runTabletManagedSetup } from '../src/tablet-managed-setup.js';
import { requestCanonical } from '../../terminal-auth/src/protocol.js';

const endpoint = '/api/terminal-devices/managed-enrolment';
function keyPair() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    publicKeySpki: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    sign: value => sign('sha256', Buffer.from(value), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
  };
}

async function fixture(t) {
  let clock = Date.parse('2031-01-01T12:00:00.000Z');
  const f = await journeyFixture({ now: () => new Date(clock), rateLimit: { attempts: 200, windowMs: 60_000 } });
  t.after(() => f.close());
  const admin = await f.login('admin@calai.local', 'LocalAdmin!4310');
  const secured = await f.json('/api/auth/password', { method: 'POST', cookie: admin, body: { currentPassword: 'LocalAdmin!4310', newPassword: 'SecureManagedSetup!4310' } });
  assert.equal(secured.status, 200, secured.text);
  const owner = await f.login('restaurant@calai.local', 'LocalRestaurant!4310');
  const { id: businessId, eatsRestaurantId: restaurantId } = (await f.json('/api/business/context', { cookie: owner })).body.data;
  const actor = readSession(f.db, admin.split('=')[1], f.config).user;
  const tabletId = randomUUID(), managedDeviceId = randomUUID(), entraDeviceId = randomUUID(), groupId = randomUUID(), directoryObjectId = randomUUID();
  const serialNumber = 'DEVICE-0001', script = 'synthetic test adapter script';
  f.db.prepare(`INSERT INTO admin_tablets(id,display_name,serial_number,business_id,intune_managed_device_id,entra_device_id,
    lifecycle_state,created_by,created_at,updated_at,application_products) VALUES(?,?,?,?,?,?,'assigned',?,?,?,'cal-eats')`)
    .run(tabletId, 'Synthetic tablet', serialNumber, businessId, managedDeviceId, entraDeviceId, actor.id, f.config.now().toISOString(), f.config.now().toISOString());
  f.config.tabletManagedSetup = { enabled: true, targets: new Map([[managedDeviceId, { groupId, directoryObjectId, entraDeviceId, serialNumber }]]), buildInstaller: args => {
    assert.equal(args.targetSerial, serialNumber);
    assert.equal(args.entraDeviceId, entraDeviceId);
    return script;
  } };
  const save = (revision = 1, cookie = admin) => f.json(`/api/admin/tablets/${tabletId}/configuration`, { method: 'POST', cookie,
    body: { expectedRevision: revision, businessId, applicationProducts: 'cal-eats', displayName: 'Synthetic tablet' } });
  const get = () => f.db.prepare('SELECT * FROM tablet_managed_setups WHERE tablet_id=?').get(tabletId);
  const state = () => f.json(`/api/admin/tablets/${tabletId}`, { cookie: admin }).then(result => result.body.data);
  const post = body => f.json(endpoint, { method: 'POST', body });
  const graph = { calls: 0, async dispatch(request) {
    this.calls += 1;
    assert.equal(request.managedDeviceId, managedDeviceId);
    assert.equal(request.entraDeviceId, entraDeviceId);
    assert.equal(request.scriptContent, script);
    assert.equal(request.allowCreate, true);
    assert.equal(request.beginCreate(), true);
    assert.equal(request.beforeAssign(), true);
    return { scriptId: randomUUID() };
  }, async observe() { return null; } };
  return { ...f, businessId, restaurantId, actor, tabletId, save, post, get, state, admin, owner, graph,
    advance(ms) { clock += ms; }, run(adapter = graph) { return runTabletManagedSetup(f.db, f.config, { graph: adapter }); } };
}

function evidence(job, key, observedAt, overrides = {}) {
  const { publicKeySpki } = key;
  const signature = key.sign(`Cal-Eats managed terminal evidence v1\n${job.id}\n${publicKeySpki}`);
  return { observedAt, resultMessage: 'CAL_EATS_MANAGED_SETUP_V1:' + Buffer.from(JSON.stringify({ jobId: job.id, publicKeySpki, signature, ...overrides })).toString('base64url') };
}

test('fleet Save provisions once, only the key verified by Intune can activate, and a registered tablet can sign in', async t => {
  const f = await fixture(t), keys = keyPair(), otherKey = keyPair();
  assert.equal((await f.save(1, f.owner)).status, 403);
  assert.equal(f.get(), undefined);
  const saved = await f.save();
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.body.data.managedSetup.state, 'waiting');
  const job = f.get(), jobId = job.id, publicKeySpki = keys.publicKeySpki;
  assert.equal((await f.post({ jobId, publicKeySpki: otherKey.publicKeySpki })).status, 202);
  assert.equal(f.get().verified_key_hash, null);
  assert.equal((await f.json(`/api/business/accounts/${f.businessId}/terminals/setup`, { method: 'POST', cookie: f.owner, body: {} })).body.error.code, 'MANAGED_SETUP_PENDING');
  assert.equal((await f.json(`/api/business/accounts/${f.businessId}/terminals/revoke`, { method: 'POST', cookie: f.owner, body: {} })).body.error.code, 'MANAGED_SETUP_PENDING');
  assert.equal((await f.json('/api/business/context', { cookie: f.owner })).body.data.managedTabletAwaitingConnection, true);
  await Promise.all([f.run(), f.run()]);
  assert.equal(f.graph.calls, 1);
  assert.equal((await f.state()).managedSetup.state, 'in_progress');
  const revised = await f.save(saved.body.data.revision);
  assert.equal(revised.status, 200, revised.text);
  assert.equal(f.get().id, jobId);
  assert.equal(f.get().record_revision, revised.body.data.revision);
  assert.equal((await f.post({ jobId, publicKeySpki })).status, 202);
  f.advance(61_000);
  f.graph.observe = async () => evidence(job, keys, f.config.now().toISOString());
  await f.run();
  assert.equal(f.get().state, 'verified');
  assert.equal((await f.post({ jobId, publicKeySpki: otherKey.publicKeySpki })).status, 202);
  const { challenge } = (await f.post({ jobId, publicKeySpki })).body.data;
  const challengeInput = `Cal-Eats managed terminal activation v1\n${jobId}\n${challenge}\n${publicKeySpki}`;
  assert.equal((await f.post({ jobId, publicKeySpki, challenge, signature: otherKey.sign(challengeInput) })).status, 409);
  const body = { jobId, publicKeySpki, challenge, signature: keys.sign(challengeInput) };
  const attempts = await Promise.all([f.post(body), f.post(body)]);
  for (const result of attempts) { assert.equal(result.status, 201, result.text); assert.equal(result.body.data.terminalId, jobId); }
  assert.equal(f.db.prepare('SELECT COUNT(*) count FROM business_terminals WHERE business_id=?').get(f.businessId).count, 1);
  const fleet = await f.state();
  assert.equal(fleet.managedSetup.state, 'registered');
  assert.equal(fleet.applicationAccess.configuration.receivedAt, null);
  const target = `/api/terminal-devices/${jobId}/operator-session`, timestamp = String(f.config.now().getTime()), nonce = randomBytes(24).toString('base64url');
  const login = await f.json(target, { method: 'POST', body: {}, headers: {
    'x-cal-eats-terminal-id': jobId, 'x-cal-eats-terminal-timestamp': timestamp, 'x-cal-eats-terminal-nonce': nonce,
    'x-cal-eats-terminal-signature': keys.sign(requestCanonical({ terminalId: jobId, timestamp, nonce, method: 'POST', target, body: '{}' }))
  } });
  assert.equal(login.status, 201, login.text);
  assert.equal(login.body.data.businessId, f.businessId);
  assert.equal(login.body.data.restaurantId, f.restaurantId);
  const again = await f.save(fleet.revision);
  assert.equal(again.status, 200, again.text);
  assert.equal(f.get().id, jobId);
  assert.equal(f.graph.calls, 1);
});

test('uncertain Graph creation is reconciled without another POST, and mismatched run evidence cannot enrol', async t => {
  const f = await fixture(t), keys = keyPair();
  assert.equal((await f.save()).status, 200);
  const job = f.get(), scriptId = randomUUID();
  await f.run({ async dispatch(request) {
    assert.equal(request.allowCreate, true);
    assert.equal(request.beginCreate(), true);
    throw Object.assign(new Error('simulated reply loss'), { retry: true });
  } });
  f.advance(61_000);
  await f.run({ async dispatch(request) { assert.equal(request.allowCreate, false); return { scriptId }; } });
  f.advance(61_000);
  await f.run({ async observe(input) {
    assert.equal(input.scriptId, scriptId);
    return evidence(job, keys, f.config.now().toISOString(), { jobId: randomUUID() });
  } });
  assert.equal((await f.state()).managedSetup.state, 'attention');
  assert.equal((await f.post({ jobId: job.id, publicKeySpki: keys.publicKeySpki })).status, 202);
  assert.equal(f.db.prepare('SELECT COUNT(*) count FROM business_terminals').get().count, 0);
  const retried = await f.save((await f.state()).revision);
  assert.equal(retried.status, 200, retried.text);
  assert.equal(f.get().id, job.id);
  assert.equal(f.get().script_id, scriptId);
  await f.run({ async observe() { return evidence(job, keys, f.config.now().toISOString()); } });
  assert.equal(f.get().state, 'verified');
});

test('revoking the requesting administrator or changing assignment denies activation of a verified job', async t => {
  for (const condition of ['administrator', 'revision', 'expired', 'stale proof', 'quarantined']) await t.test(condition, async t => {
    const f = await fixture(t), keys = keyPair();
    assert.equal((await f.save()).status, 200);
    const job = f.get();
    await f.run();
    f.advance(61_000);
    f.graph.observe = async () => evidence(job, keys, f.config.now().toISOString());
    await f.run();
    const assertion = { jobId: job.id, publicKeySpki: keys.publicKeySpki };
    const { challenge } = (await f.post(assertion)).body.data;
    const signature = keys.sign(`Cal-Eats managed terminal activation v1\n${job.id}\n${challenge}\n${keys.publicKeySpki}`);
    if (condition === 'administrator') f.db.prepare('UPDATE users SET account_enabled=0 WHERE id=?').run(f.actor.id);
    if (condition === 'revision') f.db.prepare('UPDATE admin_tablets SET revision=revision+1 WHERE id=?').run(f.tabletId);
    if (condition === 'expired') f.advance(73 * 60 * 60_000);
    if (condition === 'stale proof') f.advance(6 * 60_000);
    if (condition === 'quarantined') f.db.prepare("UPDATE admin_tablets SET lifecycle_state='disabled',authority_blocked_at=? WHERE id=?").run(f.config.now().toISOString(), f.tabletId);
    assert.equal((await f.post({ ...assertion, challenge, signature })).status, condition === 'quarantined' ? 410 : 202);
    assert.equal(f.db.prepare('SELECT COUNT(*) count FROM business_terminals').get().count, 0);
  });
});
