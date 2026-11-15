import test from 'node:test';
import assert from 'node:assert/strict';
import {businessDeviceFixture} from './business-device-fixture.js';
import {businessOperationsHealth,reconcileBusinessDeviceHealth,assertTabletOrderingAvailable} from '../src/business-device-health.js';
import {restaurantAvailability} from '../src/availability.js';
import {randomUUID} from 'node:crypto';

test('distinct, evidence-based printer incidents deduplicate and require two fresh recovery checks',async()=>{
  const f=await businessDeviceFixture();try{
    const health=()=>businessOperationsHealth(f.db,f.config,f.restaurant.id);
    assert.equal((await f.report()).status,200);assert.equal(health().printer.label,'No reported printer fault');assert.equal(health().printer.physicalReadinessKnown,false);
    assert.equal((await f.report('needs_attention','tcp_connect',['out_of_paper'])).status,400,'TCP connection does not establish paper status');
    assert.equal((await f.report('ready','windows_spooler',[],{physicalReadinessKnown:true})).status,400,'A queue is not physical readiness evidence');
    assert.equal((await f.report('ready','none')).status,400,'No diagnostics cannot establish readiness');
    assert.equal((await f.report('needs_attention','windows_spooler',['out_of_paper'])).status,200);
    const incident=health().incidents.find(i=>i.faultCode==='out_of_paper');assert.equal(incident.status,'active');
    await f.report('needs_attention','windows_spooler',['out_of_paper']);assert.equal(health().incidents.filter(i=>i.faultCode==='out_of_paper').length,1);
    await f.report('unknown','none');assert.equal(health().incidents.find(i=>i.id===incident.id).status,'active','Unsupported diagnostics cannot prove recovery');
    const marked=await f.json(`/api/restaurant/incidents/${incident.id}/read`,{method:'PATCH',cookie:f.owner,body:{read:true}});assert.equal(marked.status,200);assert.equal(health().incidents.find(i=>i.id===incident.id).status,'active');
    assert.ok(f.db.prepare('SELECT read_at FROM user_notifications WHERE event_key=?').get(`device-incident:${incident.id}:opened`).read_at,'Incident read also clears the existing bell notice');
    f.advance(15000);await f.pulse();const observedAt=f.config.now().toISOString();await f.report('ready','windows_spooler');await f.report('ready','windows_spooler',[],{observedAt:observedAt.replace('Z','+00:00')});reconcileBusinessDeviceHealth(f.db,f.config,f.restaurant.id);assert.equal(health().incidents.find(i=>i.id===incident.id).status,'active','Re-sending or reformatting one observation is not two checks');
    f.advance(15000);await f.pulse();await f.report('ready','windows_spooler');assert.equal(health().incidents.find(i=>i.id===incident.id).status,'resolved');
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM user_notifications WHERE event_key=?").get(`device-incident:${incident.id}:opened`).n,1);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM user_notifications WHERE event_key=?").get(`device-incident:${incident.id}:resolved`).n,1);
    const owner=f.db.prepare("SELECT id FROM users WHERE email='restaurant@calai.local'").get();assert.equal(businessOperationsHealth(f.db,f.config,f.restaurant.id,owner.id).incidents.find(i=>i.id===incident.id).readAt,null,'Recovery is a new unread update');
    const notice=f.db.prepare('SELECT id FROM user_notifications WHERE event_key=?').get(`device-incident:${incident.id}:resolved`);assert.equal((await f.json(`/api/notifications/${notice.id}`,{method:'PATCH',cookie:f.owner,body:{read:true}})).status,200);assert.ok(businessOperationsHealth(f.db,f.config,f.restaurant.id,owner.id).incidents.find(i=>i.id===incident.id).readAt,'Reading the bell update synchronises incident history');
    assert.equal(f.db.prepare('SELECT tablet_offline_blocked_at FROM restaurants WHERE id=?').get(f.restaurant.id).tablet_offline_blocked_at,null,'Printer-only faults never pause ordering');
  }finally{await f.close();}
});

test('unreachable confirmation, service outages and tablet outages remain separate and recovery preserves manual pause',async()=>{
  const f=await businessDeviceFixture();try{
    const health=()=>businessOperationsHealth(f.db,f.config,f.restaurant.id),reconcile=()=>reconcileBusinessDeviceHealth(f.db,f.config,f.restaurant.id);
    await f.report('unreachable','tcp_connect',['connection_failed']);assert.equal(health().incidents.length,0);
    f.advance(15000);await f.pulse();await f.report('unreachable','tcp_connect',['connection_failed']);assert.equal(health().incidents.length,0);
    f.advance(15000);await f.pulse();await f.report('unreachable','tcp_connect',['connection_failed']);assert.equal(health().incidents.find(i=>i.faultCode==='printer_unreachable').status,'active');
    // Keep only ordering-screen presence fresh, allowing the independent service report to expire.
    f.advance(45000);await f.pulse();f.advance(16000);reconcile();assert.equal(health().printer.label,'Printing service offline');assert.equal(health().incidents.find(i=>i.faultCode==='printing_service_offline').status,'active');
    f.advance(45000);reconcile();assert.equal(health().printer.label,'Tablet offline — printer status unavailable');assert.equal(health().bridge.status,'unknown');
    assert.throws(()=>assertTabletOrderingAvailable(f.db,f.config,f.restaurant.id),e=>e.code==='ORDERING_TABLET_UNAVAILABLE');
    f.db.prepare('UPDATE restaurants SET paused=1 WHERE id=?').run(f.restaurant.id);
    await f.pulse();await f.report();assert.ok(f.db.prepare('SELECT tablet_offline_blocked_at FROM restaurants WHERE id=?').get(f.restaurant.id).tablet_offline_blocked_at);
    f.advance(15000);await f.pulse();await f.report();const restaurant=f.db.prepare('SELECT * FROM restaurants WHERE id=?').get(f.restaurant.id);assert.equal(restaurant.tablet_offline_blocked_at,null);assert.equal(restaurant.paused,1);assert.equal(restaurantAvailability(restaurant,f.config.now()).acceptingOrders,false);
  }finally{await f.close();}
});

test('health endpoints reject stale, foreign-printer and forged observations and isolate incident access',async()=>{
  const f=await businessDeviceFixture();try{
    assert.equal((await f.json('/api/terminal-devices/health',{method:'POST',cookie:f.owner,body:{bridgeVersion:'x',printer:{id:f.printerId,state:'ready',source:'tcp_connect',faults:[],physicalReadinessKnown:false,observedAt:f.config.now().toISOString()}}})).status,403);
    assert.equal((await f.report('ready','tcp_connect',[],{id:'foreign-printer'})).status,404);
    assert.equal((await f.report('ready','tcp_connect',[],{observedAt:'2025-01-01T00:00:00.000Z'})).status,409);
    assert.equal((await f.report('ready','tcp_connect',[],{observedAt:new Date(f.config.now().getTime()-59000).toISOString()})).status,200);
    f.advance(2000);assert.equal(businessOperationsHealth(f.db,f.config,f.restaurant.id).bridge.status,'online');assert.equal(businessOperationsHealth(f.db,f.config,f.restaurant.id).printer.state,'unknown','Receiving an old observation must not extend its diagnostic freshness');
    await f.report('needs_attention','windows_spooler',['cover_open']);const incident=businessOperationsHealth(f.db,f.config,f.restaurant.id).incidents[0];
    const foreign=f.db.prepare('SELECT id FROM restaurants WHERE id<>? LIMIT 1').get(f.restaurant.id);assert.equal((await f.json(`/api/restaurant/restaurants/${foreign.id}/operations-health`,{cookie:f.owner})).status,404);
    const customer=await f.login('customer@calai.local','LocalCustomer!4310');assert.equal((await f.json(`/api/restaurant/incidents/${incident.id}/read`,{method:'PATCH',cookie:customer,body:{read:true}})).status,403);
  }finally{await f.close();}
});

test('sample receipt failures are included in authoritative queue counts and durable incidents',async()=>{
  const f=await businessDeviceFixture();try{
    const stamp=f.config.now().toISOString(),id=randomUUID(),user=f.db.prepare("SELECT id FROM users WHERE email='restaurant@calai.local'").get();
    f.db.prepare("INSERT INTO printer_test_jobs(id,printer_id,restaurant_id,request_id,requested_by_user_id,receipt,status,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,'failed',?,?,?)").run(id,f.printerId,f.restaurant.id,randomUUID(),user.id,'{}',new Date(f.config.now().getTime()+60000).toISOString(),stamp,stamp);
    await f.report('unknown','none');const health=businessOperationsHealth(f.db,f.config,f.restaurant.id);assert.equal(health.jobs.failed,1);assert.equal(health.jobs.lastOutcome.id,id);assert.equal(health.incidents[0].faultCode,'print_failed');assert.match(health.incidents[0].title,/Test receipt/);assert.equal(health.incidents[0].orderId,undefined);
    assert.equal(f.db.prepare('SELECT tablet_offline_blocked_at FROM restaurants WHERE id=?').get(f.restaurant.id).tablet_offline_blocked_at,null);
  }finally{await f.close();}
});

test('new enrollment waits for initial service evidence without a false opening alert',async()=>{
  const f=await businessDeviceFixture();try{
    let health=reconcileBusinessDeviceHealth(f.db,f.config,f.restaurant.id);assert.equal(health.tablet.isReady,true);assert.equal(health.bridge.status,'unknown');assert.match(health.printer.label,/first printing service report/);assert.equal(health.incidents.length,0);
    f.advance(61000);await f.pulse();health=reconcileBusinessDeviceHealth(f.db,f.config,f.restaurant.id);assert.equal(health.bridge.status,'offline');assert.equal(health.incidents.find(i=>i.faultCode==='printing_service_offline').status,'active');
  }finally{await f.close();}
});

test('fresh service reports remain distinct from an unavailable ordering screen',async()=>{
  const f=await businessDeviceFixture();try{
    await f.report();f.advance(61000);assert.equal((await f.report()).status,200,'Headless health does not need an operator grant');
    const health=businessOperationsHealth(f.db,f.config,f.restaurant.id);assert.equal(health.tablet.isReady,false);assert.equal(health.bridge.status,'online','Fresh service contact is known independently');assert.equal(health.printer.state,'unknown');assert.equal(health.printer.label,'Tablet offline — printer status unavailable');assert.deepEqual(health.incidents.filter(i=>i.status==='active').map(i=>i.faultCode),['tablet_offline']);
    assert.throws(()=>assertTabletOrderingAvailable(f.db,f.config,f.restaurant.id),e=>e.code==='ORDERING_TABLET_UNAVAILABLE');
  }finally{await f.close();}
});
