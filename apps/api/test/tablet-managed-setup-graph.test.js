import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createTabletManagedSetupGraph, loadTabletManagedSetupSettings } from '../src/tablet-managed-setup-graph.js';

const scriptRoot = '/beta/deviceManagement/deviceManagementScripts';
const graph = 'https://graph.microsoft.com';
const start = Date.parse('2026-11-23T13:00:00Z');
const requestedAt = new Date(start - 60000).toISOString();
const binding = { managedDeviceId: randomUUID(), entraDeviceId: randomUUID(), directoryObjectId: randomUUID(), groupId: randomUUID(), serialNumber: 'TEST-SERIAL-0001' };
const config = { enabled: true, tenantId: randomUUID(), clientId: randomUUID(), certificateThumbprint: 'a'.repeat(64), privateKeyFile: './isolated-key.pem', targets: [binding] };
const body = { jobId: randomUUID(), managedDeviceId: binding.managedDeviceId, entraDeviceId: binding.entraDeviceId,
  serialNumber: binding.serialNumber, scriptContent: 'Write-Output "Synthetic offline test"\r\n' };
const stamp = new Date(start - 1000).toISOString();
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

function fixture(options = {}) {
  const state = {
    calls: [], log: [], scripts: [], modern: [], legacy: [], runs: [], missingCreateResponse: false,
    managed: { id: binding.managedDeviceId, azureADDeviceId: binding.entraDeviceId, serialNumber: binding.serialNumber, operatingSystem: 'Windows', managementState: 'managed' },
    directory: { id: binding.directoryObjectId, deviceId: binding.entraDeviceId, accountEnabled: true, trustType: 'AzureAd' },
    group: { id: binding.groupId, securityEnabled: true, mailEnabled: false, groupTypes: [], membershipRule: null, isAssignableToRole: null },
    members: { value: [{ id: binding.directoryObjectId, '@odata.type': '#microsoft.graph.device' }] }
  };
  const auth = () => ({ accessToken: 'offline-fixture-token', authority: `https://login.microsoftonline.com/${config.tenantId}/`, tenantId: '' });
  const mock = async (url, options) => {
    const { pathname, origin, searchParams } = new URL(url), { method } = options;
    assert.equal(origin, graph);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer offline-fixture-token');
    assert.ok(options.signal instanceof AbortSignal);
    state.calls.push({ url, method, sent: options.body ? JSON.parse(options.body) : null });
    if (state.responseOverride) {
      const result = await state.responseOverride(pathname, method, searchParams);
      if (result) return result;
    }
    if (pathname === `/v1.0/deviceManagement/managedDevices/${binding.managedDeviceId}`) return json(state.managed);
    if (pathname === `/v1.0/devices/${binding.directoryObjectId}`) return json(state.directory);
    if (pathname === `/v1.0/groups/${binding.groupId}`) return json(state.group);
    if (pathname === `/beta/groups/${binding.groupId}/members`) return json(state.members);
    if (pathname === scriptRoot && method === 'GET') return json({ value: state.scripts.map(({ id, displayName }) => ({ id, displayName })) });
    if (pathname === scriptRoot && method === 'POST') {
      state.log.push('create');
      const script = { ...JSON.parse(options.body), id: randomUUID(), lastModifiedDateTime: requestedAt };
      state.scripts.push(script);
      if (state.missingCreateResponse) throw new Error('This provider error cannot escape the adapter.');
      return json(script, 201);
    }
    const [scriptId, action] = pathname.slice(scriptRoot.length + 1).split('/');
    const script = state.scripts.find(entry => entry.id === scriptId);
    if (!script) return json({ error: { message: 'Do not copy provider errors.' } }, 404);
    if (action === 'assignments') return json({ value: state.modern });
    if (action === 'groupAssignments') return json({ value: state.legacy });
    if (action === 'deviceRunStates') return json({ value: state.runs });
    if (action === 'assign' && method === 'POST') {
      state.log.push('assign');
      const command = JSON.parse(options.body);
      assert.deepEqual(command, { deviceManagementScriptGroupAssignments: [], deviceManagementScriptAssignments: [{
        '@odata.type': '#microsoft.graph.deviceManagementScriptAssignment',
        target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId: binding.groupId }
      }] });
      state.modern = command.deviceManagementScriptAssignments;
      return new Response(null, { status: 204 });
    }
    assert.equal(method, 'GET');
    return json(script);
  };
  const settings = loadTabletManagedSetupSettings(config, {});
  const adapter = createTabletManagedSetupGraph(settings, { now: () => start, fetchImpl: mock,
    clientFactory: async () => ({ async acquireTokenByClientCredential(request) {
      assert.deepEqual(request.scopes, [`${graph}/.default`]);
      return state.auth ? state.auth : auth();
    } }), ...options });
  const dispatch = (extra = {}) => adapter.dispatch({ ...body, ...extra, ...(extra.allowCreate && !extra.beginCreate ? {
    beginCreate() { state.log.push('begin'); return true; }
  } : {}) });
  const observe = (extra = {}) => adapter.observe({ ...body, requestedAt, scriptId: state.scripts[0]?.id, ...extra });
  return { state, adapter, dispatch, observe };
}

test('managed provisioning defaults disabled and requires separate certificate settings plus exact pinned device/group triples', async () => {
  const disabled = loadTabletManagedSetupSettings({}, {});
  assert.equal(disabled.enabled, false);
  let touched = false;
  const adapter = createTabletManagedSetupGraph(disabled, { fetchImpl: () => { touched = true; } });
  await assert.rejects(adapter.dispatch(body), { code: 'MANAGED_SETUP_GRAPH_NOT_CONFIGURED' });
  assert.equal(touched, false);
  const settings = loadTabletManagedSetupSettings({}, {
    CAL_EATS_MANAGED_SETUP_ENABLED: 'true', CAL_EATS_MANAGED_SETUP_TENANT_ID: config.tenantId,
    CAL_EATS_MANAGED_SETUP_CLIENT_ID: config.clientId, CAL_EATS_MANAGED_SETUP_CERTIFICATE_THUMBPRINT_SHA256: config.certificateThumbprint,
    CAL_EATS_MANAGED_SETUP_PRIVATE_KEY_FILE: config.privateKeyFile, CAL_EATS_MANAGED_SETUP_TARGETS_JSON: JSON.stringify([binding])
  });
  assert.equal(settings.targets.get(binding.managedDeviceId).directoryObjectId, binding.directoryObjectId);
  assert.throws(() => loadTabletManagedSetupSettings(config, { CAL_EATS_INTUNE_CLIENT_ID: config.clientId }), { code: 'MANAGED_SETUP_GRAPH_CREDENTIAL_NOT_SEPARATE' });
  assert.throws(() => loadTabletManagedSetupSettings(config, { CAL_EATS_INTUNE_CERTIFICATE_THUMBPRINT_SHA256: config.certificateThumbprint.toUpperCase() }), { code: 'MANAGED_SETUP_GRAPH_CREDENTIAL_NOT_SEPARATE' });
  assert.throws(() => loadTabletManagedSetupSettings({ ...config, targets: [binding, { ...binding, managedDeviceId: randomUUID() }] }, {}), { code: 'MANAGED_SETUP_GRAPH_SETTINGS_INVALID' });
});

test('dispatch verifies the Windows device and isolated group, creates once after durable authorisation and checks the recorded assignment', async () => {
  const f = fixture();
  await assert.rejects(f.dispatch(), { code: 'MANAGED_SETUP_GRAPH_CREATE_UNCONFIRMED', retry: true });
  await assert.rejects(f.dispatch({ allowCreate: true, beginCreate: () => false }), { code: 'MANAGED_SETUP_GRAPH_CREATE_BLOCKED' });
  assert.ok(f.state.calls.every(call => call.method === 'GET'));
  const sent = await f.dispatch({ allowCreate: true, beforeAssign: async () => { f.state.log.push('authority'); return true; } });
  assert.deepEqual(f.state.log, ['begin', 'create', 'authority', 'assign']);
  assert.equal(sent.scriptId, f.state.scripts[0].id);
  assert.equal(Buffer.from(f.state.scripts[0].scriptContent, 'base64').toString('utf8'), body.scriptContent);
  assert.deepEqual(await f.dispatch(), sent);
  assert.equal(f.state.calls.filter(call => call.method === 'POST').length, 2);
  assert.ok(f.state.calls.every(call => !/syncDevice|\/members\/|\/restart/.test(call.url)));
});

test('a potentially accepted create is reconciled by exact name/bytes without a second create', async () => {
  const f = fixture(); f.state.missingCreateResponse = true;
  await assert.rejects(f.dispatch({ allowCreate: true }), error => error.code === 'MANAGED_SETUP_GRAPH_NETWORK' && error.ambiguousCreate && !error.message.includes('provider error'));
  assert.equal(f.state.scripts.length, 1);
  assert.equal((await f.dispatch()).scriptId, f.state.scripts[0].id);
  assert.deepEqual(f.state.log, ['begin', 'create', 'assign']);
  f.state.scripts.push({ ...f.state.scripts[0], id: randomUUID() });
  await assert.rejects(f.dispatch(), { code: 'MANAGED_SETUP_GRAPH_SCRIPT_AMBIGUOUS' });
  assert.equal(f.state.calls.filter(call => call.method === 'POST').length, 2);
});

test('late Graph visibility is retriable and a changed group is rechecked immediately before assignment', async () => {
  const f = fixture();
  f.state.responseOverride = (route, method) => method === 'GET' && route === `${scriptRoot}/${f.state.scripts[0]?.id}` ? json({}, 404) : null;
  await assert.rejects(f.dispatch({ allowCreate: true }), error => error.code === 'MANAGED_SETUP_GRAPH_NOT_FOUND' && error.retry && error.scriptId === f.state.scripts[0].id);
  f.state.responseOverride = null;
  assert.equal((await f.dispatch()).scriptId, f.state.scripts[0].id);
  assert.deepEqual(f.state.log, ['begin', 'create', 'assign']);
  const unsafe = fixture();
  unsafe.state.responseOverride = (route, method) => route.endsWith('/members') && method === 'GET' && unsafe.state.log.includes('create')
    ? json({ value: [{ '@odata.type': '#microsoft.graph.device', id: randomUUID() }] }) : null;
  await assert.rejects(unsafe.dispatch({ allowCreate: true }), { code: 'MANAGED_SETUP_GRAPH_GROUP_UNSAFE' });
  assert.deepEqual(unsafe.state.log, ['begin', 'create']);
});

test('writes are denied for changed physical, group, tenant and package scope', async () => {
  for (const issue of ['foreign-member', 'extra-member', 'dynamic', 'paginated', 'management-state', 'foreign-tenant', 'business-guard']) {
    const f = fixture();
    if (issue === 'foreign-member') f.state.members.value[0].id = randomUUID();
    if (issue === 'extra-member') f.state.members.value.push({ id: randomUUID(), '@odata.type': '#microsoft.graph.servicePrincipal' });
    if (issue === 'dynamic') { f.state.group.groupTypes.push('DynamicMembership'); f.state.group.membershipRule = 'synthetic member filter'; }
    if (issue === 'paginated') f.state.members['@odata.nextLink'] = 'https://private.invalid/path';
    if (issue === 'management-state') f.state.managed.managementState = 'retirePending';
    if (issue === 'foreign-tenant') f.state.auth = { accessToken: 'invalid-tenant-token', authority: `https://login.microsoftonline.com/${randomUUID()}/` };
    const expected = {
      'foreign-member': 'GROUP_UNSAFE', 'extra-member': 'SCOPE_AMBIGUOUS', dynamic: 'GROUP_UNSAFE', paginated: 'SCOPE_AMBIGUOUS',
      'management-state': 'TARGET_MISMATCH', 'foreign-tenant': 'IDENTITY_REQUIRED', 'business-guard': 'ASSIGNMENT_BLOCKED'
    };
    await assert.rejects(f.dispatch({ allowCreate: true, beforeAssign: () => false }), { code: `MANAGED_SETUP_GRAPH_${expected[issue]}` });
    assert.ok(f.state.calls.every(call => !call.url.endsWith('/assign')));
    if (issue !== 'business-guard') assert.ok(f.state.calls.every(call => call.method === 'GET'));
  }
  const f = fixture();
  await assert.rejects(f.dispatch({ managedDeviceId: randomUUID(), allowCreate: true }), { code: 'MANAGED_SETUP_GRAPH_TARGET_MISMATCH' });
  await assert.rejects(f.dispatch({ scriptContent: 'invalid \0 script', allowCreate: true }), { code: 'MANAGED_SETUP_GRAPH_SCRIPT_INVALID' });
  await f.dispatch({ allowCreate: true });
  f.state.scripts[0].scriptContent = Buffer.from('different content').toString('base64');
  await assert.rejects(f.dispatch({ allowCreate: true }), { code: 'MANAGED_SETUP_GRAPH_SCRIPT_MISMATCH' });
  assert.equal(f.state.calls.filter(call => call.method === 'POST').length, 2);
});

test('observe returns only the fresh successful exact-device result after validating immutable script and assignment', async () => {
  const f = fixture(); await f.dispatch({ allowCreate: true });
  const resultMessage = '{"synthetic":"public result fixture"}';
  assert.equal(await f.observe(), null);
  const run = { id: randomUUID(), managedDevice: { id: binding.managedDeviceId }, runState: 'success', lastStateUpdateDateTime: stamp, resultMessage };
  f.state.runs = [{ ...run, runState: 'pending' }];
  assert.equal(await f.observe(), null);
  f.state.runs = [{ ...run, lastStateUpdateDateTime: new Date(start - 61000).toISOString() }];
  assert.equal(await f.observe(), null);
  f.state.runs = [run];
  assert.deepEqual(await f.observe(), { resultMessage, observedAt: stamp });
  f.state.runs = [{ ...run, managedDevice: { id: randomUUID() } }];
  await assert.rejects(f.observe(), { code: 'MANAGED_SETUP_GRAPH_RUN_SCOPE_MISMATCH' });
  f.state.runs = [run, run];
  await assert.rejects(f.observe(), { code: 'MANAGED_SETUP_GRAPH_SCOPE_AMBIGUOUS' });
  f.state.runs = [run];
  f.state.modern[0].target = { '@odata.type': '#microsoft.graph.allDevicesAssignmentTarget' };
  await assert.rejects(f.observe(), { code: 'MANAGED_SETUP_GRAPH_ASSIGNMENT_UNSAFE' });
  assert.equal(f.state.calls.filter(call => call.method === 'POST').length, 2);
});

test('malicious continuation and stalled authorisation never initiate a write', async () => {
  const paging = fixture(); paging.state.responseOverride = (pathname, method) => pathname === scriptRoot && method === 'GET'
    ? json({ value: [], '@odata.nextLink': 'https://other.invalid/beta/deviceManagement/deviceManagementScripts?$skiptoken=private' }) : null;
  await assert.rejects(paging.dispatch({ allowCreate: true }), { code: 'MANAGED_SETUP_GRAPH_PAGING_INVALID' });
  assert.ok(paging.state.calls.every(call => call.method === 'GET'));
  const stalled = fixture({ timeoutMs: 30 });
  let resolve;
  await assert.rejects(stalled.dispatch({ allowCreate: true, beginCreate: () => new Promise(go => { resolve = go; }) }), { code: 'MANAGED_SETUP_GRAPH_DEADLINE', retry: true });
  resolve?.(true);
  await new Promise(go => setImmediate(go));
  assert.ok(stalled.state.calls.every(call => call.method === 'GET'));
});
