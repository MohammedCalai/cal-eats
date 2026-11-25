import assert from 'node:assert/strict';
import test from 'node:test';
import {calaiTabletAssignment, openAssignedCalai} from '../src/calai-tablet-startup.js';

const businessId = '11111111-1111-4111-8111-111111111111';
const terminalId = '22222222-2222-4222-8222-222222222222';
const tabletId = '33333333-3333-4333-8333-333333333333';
const tabletConfiguration = {tabletId, revision: 4, selection: 'calai'};
const terminal = {status: 'ready', paired: true, context: {principalKind: 'terminal', terminalId, businessId}};
const context = {
  id: businessId, principalKind: 'terminal', tabletConfiguration, canViewCalai: true,
  products: {calai: {active: true, linked: true, allowedOnTablet: true, readiness: {ready: true}}},
};

test('only a paired tablet with an exact signed Calai-only assignment can launch Calai', () => {
  assert.equal(calaiTabletAssignment(terminal, context, businessId).authorised, true);
  assert.equal(calaiTabletAssignment(terminal, {...context, canViewCalai: false}, businessId).authorised, false);
  assert.equal(calaiTabletAssignment(terminal, {...context, principalKind: 'human'}, businessId), null);
  assert.equal(calaiTabletAssignment({...terminal, status: 'offline'}, context, businessId), null);
  assert.equal(calaiTabletAssignment({...terminal, paired: false}, context, businessId), null);
  assert.equal(calaiTabletAssignment(terminal, context, tabletId), null);
  for (const selection of ['cal-eats', 'both', null]) {
    assert.equal(calaiTabletAssignment(terminal, {...context, tabletConfiguration: {...tabletConfiguration, selection}}, businessId), null);
  }
});

test('successful launch checks the revision and opens the fixed original Calai sign-in without credentials', async () => {
  const signal = new AbortController().signal, destinations = [];
  const assignment = calaiTabletAssignment(terminal, context, businessId);
  assert.equal(await openAssignedCalai({assignment, signal, isCurrent: () => true, replace: url => destinations.push(url),
    request: (path, options) => {
      assert.equal(path, `/api/business/accounts/${businessId}/surface/heartbeat`);
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), {state: 'open_calai', configurationTabletId: tabletId, configurationRevision: 4});
      return {tabletConfiguration, destination: 'https://untrusted.example'};
    }}), true);
  assert.deepEqual(destinations, ['https://calai.info/auth/login']);
});

test('changed scope, cancelled startup and mismatched or rejected checks do not launch', async () => {
  const assignment = calaiTabletAssignment(terminal, context, businessId);
  const abort = new AbortController();
  let current = true, launched = false;
  const options = {assignment, signal: abort.signal, isCurrent: () => current, replace: () => { launched = true; }};
  await assert.rejects(openAssignedCalai({...options, request: async () => ({tabletConfiguration: {...tabletConfiguration, revision: 5}})}), /could not be confirmed/);
  await assert.rejects(openAssignedCalai({...options, request: async () => { throw Error('Tablet access revoked'); }}), /revoked/);
  assert.equal(await openAssignedCalai({...options, request: async () => { current = false; return {tabletConfiguration}; }}), false);
  current = true;
  assert.equal(await openAssignedCalai({...options, request: async () => { abort.abort(); return {tabletConfiguration}; }}), false);
  assert.equal(launched, false);
});
