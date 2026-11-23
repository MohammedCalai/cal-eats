import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createTabletManagementGraphAdapter,loadTabletManagementConfig} from '../src/tablet-management-graph.js';

const NOW=Date.parse('2031-01-01T12:00:00.000Z');
const settings=(options={})=>loadTabletManagementConfig({enabled:true,tenantId:randomUUID(),clientId:randomUUID(),certificateThumbprint:'a'.repeat(64),privateKey:'TEST_ONLY',...options},{});
const device=(overrides={})=>({id:randomUUID(),azureADDeviceId:randomUUID(),serialNumber:'SYNTHETIC-SERIAL',deviceName:'Synthetic Windows tablet',manufacturer:'Microsoft',model:'Surface Go',operatingSystem:'Windows',lastSyncDateTime:new Date(NOW-60000).toISOString(),...overrides});
const json=body=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
function network(pages,{config=settings(),...options}={}){
 const calls=[];let authCalls=0;
 const adapter=createTabletManagementGraphAdapter(config,{now:()=>NOW,clientFactory:async()=>({acquireTokenByClientCredential:async request=>{authCalls++;assert.deepEqual(request.scopes,['https://graph.microsoft.com/.default']);return{accessToken:'TEST_ONLY'};}}),fetchImpl:async(url,init)=>{calls.push(url);assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.equal(init.headers.Authorization,'Bearer TEST_ONLY');const page=pages[calls.length-1];return typeof page==='function'?page(url,init):json(page);},...options});
 return{adapter,calls,authCalls:()=>authCalls};
}
function next(url,extra={}){const target=new URL(url);target.searchParams.set('$skiptoken','next-page');for(const [key,value] of Object.entries(extra))target.searchParams.set(key,value);return target.href;}

test('Windows directory uses existing read-only certificate token and returns only bounded device metadata',async()=>{
 const raw=device({userPrincipalName:'PRIVATE_EMAIL',emailAddress:'PRIVATE_EMAIL',userId:'PRIVATE_OWNER'}),other=device({deviceName:'Other Windows tablet',serialNumber:null,azureADDeviceId:null});
 const n=network([url=>json({value:[raw],'@odata.nextLink':next(url)}),{value:[other]}]);
 const result=await n.adapter.listWindowsDevices();
 assert.equal(n.calls.length,2);assert.equal(n.authCalls(),1);assert.equal(result.complete,true);assert.equal(result.truncated,false);assert.equal(result.collectedAt,new Date(NOW).toISOString());assert.equal(result.source,'microsoft_graph');
 const first=new URL(n.calls[0]);assert.equal(first.origin,'https://graph.microsoft.com');assert.equal(first.pathname,'/v1.0/deviceManagement/managedDevices');assert.equal(first.searchParams.get('$filter'),"operatingSystem eq 'Windows'");assert.equal(first.searchParams.get('$top'),'100');assert.equal(first.searchParams.get('$select'),'id,azureADDeviceId,serialNumber,deviceName,manufacturer,model,operatingSystem,lastSyncDateTime');
 assert.deepEqual(result.items[0],{intuneManagedDeviceId:raw.id,entraDeviceId:raw.azureADDeviceId,serialNumber:'SYNTHETIC-SERIAL',displayName:'Synthetic Windows tablet',manufacturer:'Microsoft',model:'Surface Go',lastContactAt:raw.lastSyncDateTime});
 assert.equal(result.items[1].entraDeviceId,null);assert.equal(result.items[1].serialNumber,null);assert.equal(JSON.stringify(result).includes('PRIVATE_'),false);assert.equal('total' in result,false);
});

test('bounded directory returns explicit incomplete state without inventing a total or reading extra pages',async()=>{
 const n=network([url=>json({value:[device()],'@odata.nextLink':next(url)})],{config:settings({maxPages:1})});
 const result=await n.adapter.listWindowsDevices();assert.equal(n.calls.length,1);assert.equal(result.items.length,1);assert.equal(result.complete,false);assert.equal(result.truncated,true);assert.equal('total' in result,false);
 const empty=await network([{value:[]}]).adapter.listWindowsDevices();assert.deepEqual(empty.items,[]);assert.equal(empty.complete,true);
});

test('provider pagination cannot change Graph origin, collection, Windows filter, selected fields or paging bounds',async()=>{
 const attacks=[
  url=>next(url).replace('https://graph.microsoft.com','https://attacker.invalid'),
  url=>next(url).replace('/v1.0/deviceManagement/managedDevices','/v1.0/users'),
  url=>next(url,{'$filter':"operatingSystem eq 'Android'"}),
  url=>next(url,{'$select':'id,userPrincipalName'}),
  url=>next(url,{'$top':'1000'}),
  url=>next(url,{'$skip':'-1'}),
  url=>next(url,{'$expand':'users'}),
  url=>next(url,{'$skiptoken':'bad\nvalue'}),
  url=>next(url)+'&%24top=100',
  url=>next(url)+'#fragment',
  url=>next(url)+'\n',
  url=>next(url).replace('https://','https://user@')
 ];
 for(const attack of attacks){const n=network([url=>json({value:[device()],'@odata.nextLink':attack(url)})]);await assert.rejects(n.adapter.listWindowsDevices(),error=>error.code==='GRAPH_URL_REJECTED');assert.equal(n.calls.length,1);}
 const malformed=network([{value:[],'@odata.nextLink':{url:'https://attacker.invalid'}}]);await assert.rejects(malformed.adapter.listWindowsDevices(),error=>error.code==='GRAPH_URL_REJECTED');
});

test('directory rejects repeated devices and pagination loops instead of silently treating them as complete',async()=>{
 const raw=device(),duplicate=network([url=>json({value:[raw],'@odata.nextLink':next(url)}),{value:[raw]}]);
 await assert.rejects(duplicate.adapter.listWindowsDevices(),error=>error.code==='GRAPH_DIRECTORY_DEVICE_REPEATED');assert.equal(duplicate.calls.length,2);
 const loop=network([url=>json({value:[],'@odata.nextLink':url})]);await assert.rejects(loop.adapter.listWindowsDevices(),error=>error.code==='GRAPH_DIRECTORY_PAGE_REPEATED');assert.equal(loop.calls.length,1);
});

test('directory validates Windows records and metadata while permitting explicitly unavailable optional fields',async()=>{
 for(const invalid of [{id:'../../bad'},{azureADDeviceId:'invalid'},{operatingSystem:'Android'},{deviceName:'bad\u0000name'},{serialNumber:'x'.repeat(121)},{model:{name:'invalid'}},{lastSyncDateTime:'2031-01-02T12:00:00Z'}]){
  const n=network([{value:[device(invalid)]}]);await assert.rejects(n.adapter.listWindowsDevices(),error=>['GRAPH_DIRECTORY_DEVICE_INVALID','GRAPH_EVIDENCE_TIME_INVALID'].includes(error.code));
 }
 for(const body of [{value:{}},{value:Array.from({length:101},()=>device())},{wrong:[]}])await assert.rejects(network([body]).adapter.listWindowsDevices(),error=>error.code==='GRAPH_RESPONSE_INVALID');
 const result=await network([{value:[device({deviceName:null,manufacturer:null,model:null,serialNumber:null,lastSyncDateTime:null})]}]).adapter.listWindowsDevices();assert.equal(result.items[0].displayName,null);assert.equal(result.items[0].lastContactAt,null);
});

test('disabled or denied directory connection fails closed and never reads provider error content',async()=>{
 const disabled=network([],{config:loadTabletManagementConfig({},{})});await assert.rejects(disabled.adapter.listWindowsDevices(),error=>error.code==='GRAPH_NOT_CONFIGURED');assert.equal(disabled.authCalls(),0);assert.equal(disabled.calls.length,0);
 const denied=network([()=>({status:403,text:()=>{throw Error('sensitive provider response must not be read');}})]);await assert.rejects(denied.adapter.listWindowsDevices(),error=>error.code==='GRAPH_PERMISSION_REQUIRED'&&!error.message.includes('TEST_ONLY'));assert.equal(denied.calls.length,1);
});

test('directory reuses bounded provider body handling and the whole-operation timeout',async()=>{
 const html=network([()=>new Response('<html>wrong response</html>',{headers:{'content-type':'text/html'}})]);await assert.rejects(html.adapter.listWindowsDevices(),error=>error.code==='GRAPH_RESPONSE_CONTENT_TYPE');
 let cancelled=false;const stalled=network([],{collectionTimeoutMs:10,fetchImpl:async(_url,{signal})=>{signal.addEventListener('abort',()=>{cancelled=true;},{once:true});return new Promise(()=>{});}});await assert.rejects(stalled.adapter.listWindowsDevices(),error=>error.code==='GRAPH_COLLECTION_TIMEOUT'&&error.retry===true);assert.equal(cancelled,true);
});
