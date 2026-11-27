import assert from 'node:assert/strict';
import test from 'node:test';
import {acceptsRenderedBoth, calaiTabletAssignment, openAssignedCalai} from '../src/calai-tablet-startup.js';

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
      assert.deepEqual(JSON.parse(options.body), {state: 'confirm_calai_launch', configurationTabletId: tabletId, configurationRevision: 4});
      return {tabletConfiguration, destination: 'https://untrusted.example'};
    }}), true);
  assert.deepEqual(destinations, [`https://calai.info/auth/login?workspace=calai&tabletWorkspace=1#tablet=${businessId}.${tabletId}`]);
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

test('pilot Both requires two ready authorised products and launches only its fixed combined host', async () => {
  const both = {...tabletConfiguration, selection:'both'};
  const scoped = {...context, nativeBothLaunch:true, tabletConfiguration:both, canViewEats:true,
    products:{...context.products, 'cal-eats':context.products.calai}};
  const assignment = calaiTabletAssignment(terminal, scoped, businessId);
  assert.equal(assignment.authorised, true);
  assert.equal(calaiTabletAssignment(terminal, {...scoped,canViewEats:false}, businessId).authorised, false);
  assert.equal(calaiTabletAssignment(terminal, {...scoped,products:context.products}, businessId).authorised, false);
  assert.equal(calaiTabletAssignment(terminal, {...scoped,nativeBothLaunch:false}, businessId), null);
  assert.equal(calaiTabletAssignment(terminal, {...scoped,principalKind:'human'}, businessId), null);
  const signal = new AbortController().signal, destinations = [];
  const launch = confirmation => openAssignedCalai({assignment, signal, isCurrent:()=>true,
    replace:url=>destinations.push(url), request:(path, options)=>{
      assert.deepEqual(JSON.parse(options.body), {state:'open_both',configurationTabletId:tabletId,configurationRevision:4});
      return {tabletConfiguration:confirmation,destination:'https://wrong.invalid'};
    }});
  await assert.rejects(launch(tabletConfiguration), /could not be confirmed/);
  assert.equal(await launch(both), true);
  assert.deepEqual(destinations, [`https://calai.info/owner/dashboard?workspace=both&tabletWorkspace=1#tablet=${businessId}.${tabletId}`]);
  const parent={}, origin='https://calai.info';
  const data={type:'cal-eats-workspace:both-rendered',version:1,businessId,tabletId,revision:4};
  const event={data,source:parent,origin};
  assert.equal(acceptsRenderedBoth(event,parent,origin,assignment), true);
  for (const other of [{...event,source:{}},{...event,origin:'https://other.invalid'},{...event,data:{...data,revision:5}},
    {...event,data:{...data,businessId:terminalId}}, {...event,data:{...data,tabletId:terminalId}}, {...event,data:{...data,type:'cal-eats-workspace:host-message-audio'}}]) {
    assert.equal(acceptsRenderedBoth(other,parent,origin,assignment), false);
  }
});
