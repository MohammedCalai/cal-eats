import assert from 'node:assert/strict';
import test from 'node:test';
import {acceptsRenderedBoth, calaiTabletAssignment, openAssignedCalai, ownerCombinedWorkspaceLink, workspaceEntry} from '../src/calai-tablet-startup.js';

const businessId = '11111111-1111-4111-8111-111111111111';
const terminalId = '22222222-2222-4222-8222-222222222222';
const tabletId = '33333333-3333-4333-8333-333333333333';
const tabletConfiguration = {tabletId, revision: 4, selection: 'calai'};
const terminal = {status: 'ready', paired: true, context: {principalKind: 'terminal', terminalId, businessId}};
const context = {
  id: businessId, principalKind: 'terminal', tabletConfiguration, canViewCalai: true,
  products: {calai: {active: true, linked: true, allowedOnTablet: true, readiness: {ready: true}}},
};

test('a verified owner can intentionally open the native combined view without a tablet identity', () => {
  const owner = {principalKind:'human',ownerCombinedWorkspace:true};
  const workspace = {mode:'both',embedded:false,terminal:{status:'connection_unavailable'}};
  const link = ownerCombinedWorkspaceLink(owner,workspace);
  assert.equal(link,'https://calai.info/owner/dashboard?workspace=both');
  assert.equal(new URL(link).hash,'');
  assert.equal(ownerCombinedWorkspaceLink({...owner,ownerCombinedWorkspace:false},workspace),null);
  assert.equal(ownerCombinedWorkspaceLink({...owner,principalKind:'terminal'},workspace),null);
  for (const change of [{mode:'cal-eats'},{mode:'calai'},{embedded:true},{terminal:{status:'ready'}},{terminal:{status:'connecting'}}])
    assert.equal(ownerCombinedWorkspaceLink(owner,{...workspace,...change}),null);
});

const owner = {id:businessId,principalKind:'human',ownerCombinedWorkspace:true};
const coldOwner = {business:owner,mode:'both',terminal:{status:'unchecked'},dashboard:true,
  embedded:false,tabletWindow:true,signed:null,freshHumanContext:true,combinedRequested:true};

test('a dual-product owner cookie cannot open the retired dashboard or choose a tablet product during restart', () => {
  for (const status of ['unchecked','connecting','connection_unavailable','permission_required','permission_denied','revoked']) {
    const result = workspaceEntry({...coldOwner,terminal:{status}});
    assert.deepEqual(result,{mode:'cal-eats',waitForTablet:true});
  }
  assert.equal(workspaceEntry({...coldOwner,tabletWindow:false,terminal}).waitForTablet,true);
  assert.equal(workspaceEntry({...coldOwner,terminal,signed:{...context,id:tabletId}}).waitForTablet,true);
  assert.equal(workspaceEntry({...coldOwner,terminal,signed:{...context,principalKind:'human'}}).waitForTablet,true);
  assert.equal(workspaceEntry({...coldOwner,terminal,signed:{...context,tabletConfiguration:null}}).waitForTablet,true);
  assert.equal(workspaceEntry({...coldOwner,terminal:{...terminal,context:{...terminal.context,terminalId:'x'}},signed:context}).waitForTablet,true);
});

test('fresh signed single modes, combined handoff, and embedded Both keep distinct entry paths', () => {
  for (const selection of ['cal-eats','calai','both']) {
    const signed={...context,nativeBothLaunch:true,tabletConfiguration:{...tabletConfiguration,selection}};
    const result=workspaceEntry({...coldOwner,mode:selection,terminal,signed});
    assert.deepEqual(result,{mode:selection==='both' ? 'cal-eats' : selection});
    assert.equal(calaiTabletAssignment(terminal,signed,businessId)?.selection ?? null,selection==='cal-eats'?null:selection);
    if(selection==='both') assert.equal(workspaceEntry({...coldOwner,terminal,signed:{...signed,nativeBothLaunch:false}}).combinedUnavailable,true);
  }
  assert.deepEqual(workspaceEntry({...coldOwner,embedded:true}),{mode:'both'});
});

test('ordinary owner access stays in Eats and explicitly opening Both uses only its verified human link', () => {
  const browse={...coldOwner,tabletWindow:false,terminal:{status:'permission_required'},combinedRequested:false};
  assert.deepEqual(workspaceEntry(browse),{mode:'cal-eats',ownerLink:'https://calai.info/owner/dashboard?workspace=both',openOwnerWorkspace:false});
  assert.equal(workspaceEntry({...browse,combinedRequested:true}).openOwnerWorkspace,true);
  for(const input of [{business:{...owner,ownerCombinedWorkspace:false}},{freshHumanContext:false},
    {mode:'calai'},{mode:'cal-eats'},{terminal:{status:'connecting'}}]) {
    assert.equal(workspaceEntry({...browse,...input,combinedRequested:true}).openOwnerWorkspace,false);
  }
  assert.deepEqual(workspaceEntry({...browse,dashboard:false}),{mode:'cal-eats'});
  assert.equal(workspaceEntry({...browse,business:{...owner,ownerCombinedWorkspace:false,canViewEats:false,canViewCalai:true}}).mode,'calai');
});

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
