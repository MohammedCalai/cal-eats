import assert from 'node:assert/strict';
import test from 'node:test';
import {nativeWatch,nativeOrigin,publishNativeMode,startTabletModeWatch} from '../src/tablet-mode-watch.js';

const businessId='b0000000-0000-4000-8000-000000000001',tabletId='a0000000-0000-4000-8000-000000000002';
const terminalId='c0000000-0000-4000-8000-000000000003',nonce='d0000000-0000-4000-8000-000000000004';
const requestMode={type:'cal-eats-workspace:watch-mode',version:1,hostMode:'both',businessId,tabletId,nonce};
const ready={linked:true,active:true,allowedOnTablet:true,readiness:{ready:true}};
const status=()=>({paired:true,status:'ready',context:{principalKind:'terminal',terminalId,businessId}});
function setup(hostMode,selection,options={}) {
  const observed={tabletId,selection,revision:24},messages=[],writes=[];
  const context={id:businessId,principalKind:'terminal',tabletConfiguration:observed,nativeBothLaunch:true,
    products:{calai:{...ready,sourceAccountId:'native-restaurant'},'cal-eats':ready},canViewCalai:true,canViewEats:true,...options.context};
  const args={challenge:{...requestMode,hostMode,...options.challenge},observed,status,signal:new AbortController().signal,
    request:async(path,init)=>{if(path==='/api/business/context')return context;
      writes.push(JSON.parse(init.body));return {tabletConfiguration:options.confirmed||observed};},publish:m=>messages.push(m)};
  return {run:()=>publishNativeMode(args),args,messages,writes};
}
test('the registered host challenge requires matching window, origin, device scope and a fresh nonce',()=>{
  const parent={}, event={source:parent,origin:nativeOrigin,data:requestMode};
  assert.equal(nativeWatch(event,parent),requestMode);
  for(const invalid of [{source:{}},{origin:'https://elsewhere.invalid'},...['businessId','tabletId','nonce','hostMode'].map(k=>({data:{...requestMode,[k]:'wrong'}}))])
    assert.equal(nativeWatch({...event,...invalid},parent),null);
});
test('native and combined hosts switch only on current signed context, including back to standalone Eats',async()=>{
  for(const hostMode of ['both','calai']) for(const selection of ['both','calai','cal-eats']){
    const s=setup(hostMode,selection);await s.run();
    assert.deepEqual(s.messages,[{type:'cal-eats-workspace:mode',version:1,businessId,tabletId,revision:24,selection,nonce}]);
    const expected=hostMode===selection||selection==='cal-eats'?[]:[selection==='both'?'open_both':'confirm_calai_launch'];
    assert.deepEqual(s.writes.map(w=>w.state),expected);
  }
  for(const overrides of [{context:{id:tabletId}}, {context:{principalKind:'human'}},{context:{canViewCalai:false}},
    {challenge:{tabletId:businessId}},{context:{tabletConfiguration:{tabletId,revision:23,selection:'both'}}},
    {confirmed:{tabletId,revision:25,selection:'both'}}]){
    const s=setup('calai','both',overrides);await s.run();assert.equal(s.messages.length,0);
  }
  const unauthorizedEats=setup('both','cal-eats',{context:{canViewEats:false}});await unauthorizedEats.run();
  assert.equal(unauthorizedEats.messages.length,0);
});
test('Calai receipt requires the selected authenticated native tenant to have actually rendered',async()=>{
  for(const renderedTenantId of [undefined,'another','native-restaurant']){
    const s=setup('calai','calai',{challenge:{renderedTenantId}});await s.run();
    assert.equal(s.writes.length,renderedTenantId==='native-restaurant'?1:0);
    if(s.writes.length)assert.deepEqual(s.writes[0],{state:'calai_rendered',configurationTabletId:tabletId,configurationRevision:24,nativeAccountId:'native-restaurant'});
  }
});
test('Save wakes an existing listener for a fresh signed read and disposal discards a delayed response',async()=>{
  const tasks=[],observed=[], ticket='x'.repeat(43);let revision=1,readCount=0,release;
  const stop=startTabletModeWatch({read:async()=>{readCount++;return {ticket,tabletConfiguration:{tabletId,selection:'both',revision}};},
    observed:async cfg=>observed.push(cfg.revision),wait:()=>new Promise(resolve=>{release=resolve;}),
    schedule:(fn,delay)=>{tasks.push({fn,delay});return tasks.length;},cancel:()=>{}});
  await new Promise(setImmediate); assert.deepEqual(observed,[1]);assert.equal(tasks.length,0);
  revision=2;release();await new Promise(setImmediate);assert.equal(tasks[0].delay,0);void tasks.shift().fn();
  await new Promise(setImmediate);assert.deepEqual(observed,[1,2]);assert.equal(readCount,2);
  stop();release();await new Promise(setImmediate);assert.equal(tasks.length,0);
});
