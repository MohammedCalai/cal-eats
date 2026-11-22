import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash,generateKeyPairSync,sign} from 'node:crypto';
import {journeyFixture} from './helpers.js';
import {createTabletManagementGraphAdapter,loadTabletManagementConfig,createBoundedMicrosoftIdentityNetwork} from '../src/tablet-management-graph.js';
import {runTabletManagementRefresh} from '../src/tablet-management.js';
import {pairingCanonical} from '../../terminal-auth/src/protocol.js';
const NOW=Date.parse('2031-01-01T12:00:00.000Z'),at=new Date(NOW).toISOString(),scriptBytes=Buffer.from('reviewed test-only script payload'),hash=createHash('sha256').update(scriptBytes).digest('hex');
const scriptId=randomUUID(),managedId=randomUUID(),entraId=randomUUID();
const settings=()=>loadTabletManagementConfig({enabled:true,tenantId:randomUUID(),clientId:randomUUID(),certificateThumbprint:'a'.repeat(64),privateKey:'TEST_ONLY',approvedScripts:[{id:scriptId,sha256:hash,parser:'startup_pilot_v3'}]},{});
const row=()=>({id:randomUUID(),revision:1,intune_managed_device_id:managedId,entra_device_id:entraId,serial_number:'SYNTHETIC-SERIAL-001',startup_profile_id:scriptId});
function network({device={},script={},run={},nextLink=null,onGet}={}){
 const calls=[];
 const adapter=createTabletManagementGraphAdapter(settings(),{now:()=>NOW,clientFactory:async()=>({acquireTokenByClientCredential:async options=>{assert.deepEqual(options.scopes,['https://graph.microsoft.com/.default']);return{accessToken:'TEST_ONLY'};}}),fetchImpl:async(url,options)=>{
  calls.push(url);assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(new URL(url).origin,'https://graph.microsoft.com');onGet?.(url);
  let body;if(url.includes('/managedDevices/'))body={id:managedId,azureADDeviceId:entraId,serialNumber:'SYNTHETIC-SERIAL-001',lastSyncDateTime:at,...device};
  else if(!url.includes('/deviceRunStates'))body={id:scriptId,scriptContent:scriptBytes.toString('base64'),lastModifiedDateTime:'2031-01-01T11:00:00.000Z',...script};
  else body={value:[{id:'run-state-001',runState:'success',managedDevice:{id:managedId},lastStateUpdateDateTime:at,resultMessage:JSON.stringify({Status:'AlreadyCorrect',Changed:false,Serial:'SYNTHETIC-SERIAL-001'}),...run}],...(nextLink?{'@odata.nextLink':nextLink}:{})};
  return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
 }});return{adapter,calls};
}
test('read-only Graph collector validates device, approved payload and actual unchanged execution without claiming application or physical state',async()=>{
 const n=network(),evidence=await n.adapter.collect(row());assert.equal(n.calls.length,3);assert.equal(evidence.identityMatched,true);assert.equal(evidence.execution.status,'AlreadyCorrect');assert.equal(evidence.execution.changed,false);assert.equal(evidence.physicalStartupVerified,false);assert.equal(evidence.applicationPresenceVerified,false);assert.equal(evidence.scriptSha256,hash);
 for(const options of [{device:{azureADDeviceId:randomUUID()}},{script:{scriptContent:Buffer.from('unknown').toString('base64')}},{run:{lastStateUpdateDateTime:'2030-12-31T12:00:00.000Z'}},{run:{resultMessage:'{"Status":"AlreadyCorrect"'}},{run:{resultMessage:JSON.stringify({Status:'AlreadyCorrect',Changed:false})}},{run:{resultMessage:JSON.stringify({Status:'AlreadyCorrect',Changed:false,Serial:'OTHER-SERIAL'})}}])await assert.rejects(network(options).adapter.collect(row()),e=>/^GRAPH_/.test(e.code));
 const pending=await network({run:{runState:'pending'}}).adapter.collect(row());assert.equal(pending.execution,null);
 const badNext=network({run:{managedDevice:{id:randomUUID()}},nextLink:'https://attacker.invalid/steal'});await assert.rejects(badNext.adapter.collect(row()),e=>e.code==='GRAPH_URL_REJECTED');assert.equal(badNext.calls.length,3);
 const wrongPath=network({run:{managedDevice:{id:randomUUID()}},nextLink:'https://graph.microsoft.com/beta/deviceManagement/deviceManagementScripts/'+randomUUID()+'/deviceRunStates?$top=100'});await assert.rejects(wrongPath.adapter.collect(row()),e=>e.code==='GRAPH_URL_REJECTED');assert.equal(wrongPath.calls.length,3);
 let calls=0;await assert.rejects(network({onGet(){calls++;}}).adapter.collect({...row(),intune_managed_device_id:'../../bad'}),e=>e.code==='GRAPH_NOT_CONFIGURED');assert.equal(calls,0);
});
test('Graph JSON responses are stream-bounded and reject wrong media types before parsing',async()=>{
 let cancelled=false;const factory=async()=>({acquireTokenByClientCredential:async()=>({accessToken:'TEST_ONLY'})});
 const huge=createTabletManagementGraphAdapter(settings(),{clientFactory:factory,fetchImpl:async()=>new Response(new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(1048576));},cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}})});
 await assert.rejects(huge.collect(row()),e=>e.code==='GRAPH_RESPONSE_TOO_LARGE');assert.equal(cancelled,true);
 const html=createTabletManagementGraphAdapter(settings(),{clientFactory:factory,fetchImpl:async()=>new Response('<html>Not Graph JSON</html>',{headers:{'content-type':'text/html'}})});await assert.rejects(html.collect(row()),e=>e.code==='GRAPH_RESPONSE_CONTENT_TYPE');
});
test('Graph permission failure never leaks provider response or attempts a management mutation',async()=>{
 let calls=0;const adapter=createTabletManagementGraphAdapter(settings(),{clientFactory:async()=>({acquireTokenByClientCredential:async()=>({accessToken:'TEST_ONLY'})}),fetchImpl:async(_url,init)=>{calls++;assert.equal(init.method,'GET');return{status:403,text:async()=>{throw Error('must not read sensitive error');}};}});
 await assert.rejects(adapter.collect(row()),e=>e.code==='GRAPH_PERMISSION_REQUIRED'&&!e.message.includes('TEST_ONLY'));assert.equal(calls,1);
 assert.equal(loadTabletManagementConfig({},{}).enabled,false);assert.throws(()=>loadTabletManagementConfig({enabled:true},{}),/certificate identity/);
});
test('identity and whole-collection deadlines cancel supported HTTP work and bound a nonresolving auth provider',async()=>{
 let graphCalls=0;
 const stalled=createTabletManagementGraphAdapter(settings(),{clientFactory:async()=>({acquireTokenByClientCredential:()=>new Promise(()=>{})}),authTimeoutMs:10,collectionTimeoutMs:100,fetchImpl:async()=>{graphCalls++;throw Error('must not fetch');}});
 await assert.rejects(stalled.collect(row()),e=>e.code==='GRAPH_AUTH_TIMEOUT'&&e.retry===true);assert.equal(graphCalls,0);
 let cancelled=false;const identity=createBoundedMicrosoftIdentityNetwork({timeoutMs:10,fetchImpl:async(_url,{signal})=>{signal.addEventListener('abort',()=>{cancelled=true;},{once:true});return new Promise(()=>{});}});
 await assert.rejects(identity.sendPostRequestAsync('https://login.microsoftonline.com/example/oauth2/v2.0/token',{body:'TEST_ONLY'}),e=>e.code==='GRAPH_AUTH_TIMEOUT'&&e.retry===true);assert.equal(cancelled,true);
 let graphCancelled=false;const collection=createTabletManagementGraphAdapter(settings(),{clientFactory:async()=>({acquireTokenByClientCredential:async()=>({accessToken:'TEST_ONLY'})}),collectionTimeoutMs:10,fetchImpl:async(_url,{signal})=>{signal.addEventListener('abort',()=>{graphCancelled=true;},{once:true});return new Promise(()=>{});}});
 await assert.rejects(collection.collect(row()),e=>e.code==='GRAPH_COLLECTION_TIMEOUT'&&e.retry===true);assert.equal(graphCancelled,true);
 const bodyFailure=createTabletManagementGraphAdapter(settings(),{clientFactory:async()=>({acquireTokenByClientCredential:async()=>({accessToken:'TEST_ONLY'})}),fetchImpl:async()=>new Response(new ReadableStream({start(controller){controller.error(Error('simulated interrupted provider body'));}}),{headers:{'content-type':'application/json'}})});
 await assert.rejects(bodyFailure.collect(row()),e=>e.code==='GRAPH_NETWORK_ERROR'&&e.retry===true);
});
async function fixture(t){
 let clock=NOW;const f=await journeyFixture({now:()=>new Date(clock),tabletManagement:settings(),rateLimit:{attempts:1000,windowMs:60000}});t.after(()=>f.close());
 const admin=await f.login('admin@calai.local','LocalAdmin!4310'),owner=await f.login('restaurant@calai.local','LocalRestaurant!4310');assert.equal((await f.json('/api/auth/password',{method:'POST',cookie:admin,body:{currentPassword:'LocalAdmin!4310',newPassword:'SecureManagementAdmin!4310'}})).status,200);
 const business=(await f.json('/api/business/context',{cookie:owner})).body.data;
 const call=(path='',options={})=>f.json('/api/admin/tablets'+path,{cookie:admin,...options});
 const create=async(body={})=>{const response=await call('',{method:'POST',body:{displayName:'Synthetic central inventory',businessId:business.id,intuneManagedDeviceId:managedId,entraDeviceId:entraId,serialNumber:'SYNTHETIC-SERIAL-001',startupProfileId:scriptId,...body}});assert.equal(response.status,201,response.text);return response.body.data;};
 return{...f,admin,owner,business,call,create,advance(seconds){clock+=seconds*1000;}};
}
test('a timed-out authentication cycle releases the worker and its durable read job can recover on a later bounded retry',async t=>{
 const f=await fixture(t),record=await f.create();await f.call(`/${record.id}/management/refresh`,{method:'POST',body:{expectedRevision:1}});
 const stalled=createTabletManagementGraphAdapter(f.config.tabletManagement,{clientFactory:async()=>({acquireTokenByClientCredential:()=>new Promise(()=>{})}),authTimeoutMs:10,collectionTimeoutMs:100});
 const first=await runTabletManagementRefresh(f.db,f.config,{adapter:stalled});assert.equal(first.retried,1);f.advance(31);
 const recovered=await runTabletManagementRefresh(f.db,f.config,{adapter:network().adapter});assert.equal(recovered.completed,1);assert.equal((await f.call(`/${record.id}`)).body.data.management.latestRefresh.status,'completed');
});
test('durable refresh deduplicates, records trusted read evidence separately, retains it after a failed refresh and cancels an awaited stale inventory',async t=>{
 const f=await fixture(t),record=await f.create(),request=()=>f.call(`/${record.id}/management/refresh`,{method:'POST',body:{expectedRevision:1}});
 const [a,b]=await Promise.all([request(),request()]);assert.equal(a.status,202,a.text);assert.equal(a.body.data.job.id,b.body.data.job.id);
 let result=await runTabletManagementRefresh(f.db,f.config,{adapter:network().adapter});assert.equal(result.completed,1);
 let state=(await f.call(`/${record.id}`)).body.data;assert.equal(state.management.latestRefresh.status,'completed');assert.equal(state.management.evidence.execution.status,'AlreadyCorrect');assert.equal(state.startup.appliedAt,null);assert.equal(state.startup.receivedAt,null);
 f.advance(31);assert.equal((await request()).status,202);result=await runTabletManagementRefresh(f.db,f.config,{adapter:{collect:async()=>{throw Object.assign(new Error('sensitive value'),{code:'GRAPH_PERMISSION_REQUIRED'});}}});assert.equal(result.failed,1);
 state=(await f.call(`/${record.id}`)).body.data;assert.equal(state.management.evidence.execution.status,'AlreadyCorrect');assert.equal(state.management.latestRefresh.errorCode,'GRAPH_PERMISSION_REQUIRED');assert.equal(JSON.stringify(state).includes('sensitive value'),false);
 f.advance(31);await request();result=await runTabletManagementRefresh(f.db,f.config,{adapter:{collect:async current=>{f.db.prepare('UPDATE admin_tablets SET revision=revision+1 WHERE id=?').run(record.id);return network().adapter.collect(current);}}});assert.equal(result.cancelled,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM tablet_management_observations').get().n,1);
});
test('read-only refresh retries bounded transient failures, recovers an expired read lease, and rejects authority removed during await',async t=>{
 const f=await fixture(t),record=await f.create(),url=`/${record.id}/management/refresh`;await f.call(url,{method:'POST',body:{expectedRevision:1}});
 let count=0;const retry={collect:async()=>{count++;throw Object.assign(Error('do not leak details'),{code:'GRAPH_NETWORK_ERROR',retry:true});}};
 assert.equal((await runTabletManagementRefresh(f.db,f.config,{adapter:retry})).retried,1);assert.equal((await runTabletManagementRefresh(f.db,f.config,{adapter:retry})).retried,0);assert.equal(count,1);f.advance(31);
 f.db.prepare("UPDATE tablet_management_refresh_jobs SET status='running',lease_owner='crashed-reader',lease_expires_at=?").run(new Date(NOW-1000).toISOString());
 const result=await runTabletManagementRefresh(f.db,f.config,{adapter:{collect:async current=>{f.db.prepare("UPDATE users SET account_enabled=0 WHERE role='admin'").run();return network().adapter.collect(current);}}});assert.equal(result.cancelled,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM tablet_management_observations').get().n,0);
});
function signedPair(document){const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),publicKeySpki=keys.publicKey.export({type:'spki',format:'der'}).toString('base64');return{terminalId:document.terminalId,code:document.code,deviceName:'Synthetic physical key',publicKeySpki,challengeSignature:sign('sha256',Buffer.from(pairingCanonical({...document,publicKeySpki})),{key:keys.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url')};}
test('central administrator issues exact-row one-use setup; signed pairing attaches atomically and secrets never enter detail/audit',async t=>{
 const f=await fixture(t),record=await f.create(),before=f.db.prepare('SELECT COUNT(*) n FROM business_terminals').get().n;
 const issued=await f.call(`/${record.id}/enrolment`,{method:'POST',body:{expectedRevision:1,confirmReplaceTerminalId:null}});assert.equal(issued.status,201,issued.text);assert.equal(issued.headers.get('cache-control'),'private, no-store');
 const document=issued.body.data.enrolment;assert.equal(f.db.prepare('SELECT COUNT(*) n FROM business_terminals').get().n,before);
 let detail=(await f.call(`/${record.id}`)).body.data;assert.equal(detail.latestEnrolment.status,'issued');assert.equal(JSON.stringify(detail).includes(document.code),false);assert.equal(JSON.stringify(f.db.prepare('SELECT details FROM audit_events').all()).includes(document.challenge),false);
 const installer=await f.request(`/api/admin/tablets/${record.id}/installer`,{cookie:f.admin});assert.equal(installer.status,200);assert.match(installer.text,/CalEats/i);
 const body=signedPair(document),paired=await f.json('/api/terminal-devices/pair',{method:'POST',body});assert.equal(paired.status,201,paired.text);const repeated=await f.json('/api/terminal-devices/pair',{method:'POST',body});assert.equal(repeated.status,201,repeated.text);
 detail=(await f.call(`/${record.id}`)).body.data;assert.equal(detail.registration.terminalId,document.terminalId);assert.equal(detail.latestEnrolment.status,'paired');assert.equal(detail.revision,2);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM business_terminals').get().n,before+1);assert.equal(detail.actions.currentTerminalId,document.terminalId);
 assert.equal((await f.call(`/${record.id}/enrolment`,{method:'POST',body:{expectedRevision:2,confirmReplaceTerminalId:null}})).status,409);
 assert.equal((await f.call(`/${record.id}/enrolment`,{cookie:f.owner,method:'POST',body:{expectedRevision:2,confirmReplaceTerminalId:document.terminalId}})).status,403);
 const replacement=await f.call(`/${record.id}/enrolment`,{method:'POST',body:{expectedRevision:2,confirmReplaceTerminalId:document.terminalId}});assert.equal(replacement.status,201,replacement.text);assert.equal(f.db.prepare('SELECT revoked_at FROM business_terminals WHERE id=?').get(document.terminalId).revoked_at,null,'Issuing a replacement does not revoke the working tablet early');
 const replaced=await f.json('/api/terminal-devices/pair',{method:'POST',body:signedPair(replacement.body.data.enrolment)});assert.equal(replaced.status,201,replaced.text);assert.ok(f.db.prepare('SELECT revoked_at FROM business_terminals WHERE id=?').get(document.terminalId).revoked_at);assert.equal((await f.call(`/${record.id}`)).body.data.registration.terminalId,replacement.body.data.enrolment.terminalId);
});
test('central setup is denied for Calai-only and quarantined records and delayed pairing fails after revision edits',async t=>{
 const f=await fixture(t),record=await f.create();let issued=await f.call(`/${record.id}/enrolment`,{method:'POST',body:{expectedRevision:1,confirmReplaceTerminalId:null}});const body=signedPair(issued.body.data.enrolment);
 await f.call(`/${record.id}`,{method:'PATCH',body:{expectedRevision:1,displayName:'Changed before physical pairing'}});assert.equal((await f.json('/api/terminal-devices/pair',{method:'POST',body})).status,409);
 await f.call(`/${record.id}/disable`,{method:'POST',body:{expectedRevision:2,reason:'Keep disabled for maintenance'}});assert.equal((await f.call(`/${record.id}/enrolment`,{method:'POST',body:{expectedRevision:3,confirmReplaceTerminalId:null}})).status,409);
 const business=randomUUID(),now=f.config.now().toISOString();f.db.prepare('INSERT INTO business_accounts(id,name,created_at,updated_at) VALUES(?,?,?,?)').run(business,'Native Calai-only',now,now);
 const other=await f.create({businessId:business,intuneManagedDeviceId:null,entraDeviceId:null,serialNumber:null,startupProfileId:null}),shops=f.db.prepare('SELECT COUNT(*) n FROM restaurants').get().n;
 assert.equal(other.actions.canIssueSetup,false);assert.equal((await f.call(`/${other.id}/enrolment`,{method:'POST',body:{expectedRevision:1,confirmReplaceTerminalId:null}})).status,409);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM restaurants').get().n,shops);
});
