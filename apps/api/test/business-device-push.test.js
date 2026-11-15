import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {businessDeviceFixture} from './business-device-fixture.js';
import {runBusinessDevicePush} from '../src/business-device-push.js';

const project='6282b87e-36ae-43bb-80b7-12d69108a411';
const config={businessPush:{enabled:true,accessToken:'local-test-adapter-only',iosProjectIds:[project],androidProjectIds:[project]}};
const registration=(installationId=randomUUID(),suffix='abcdefghijklmno')=>({installationId,expoPushToken:`ExpoPushToken[${suffix}]`,platform:'android',projectId:project});
const register=(f,headers,body)=>f.json('/api/native/business/push/devices',{method:'POST',headers,body});

test('business registration is native/session/project scoped, encrypted, idempotent and cleared on logout',async()=>{
  const f=await businessDeviceFixture(config);try{
    const headers=await f.nativeLogin(),body=registration();
    assert.equal((await f.json('/api/native/business/push/devices',{method:'POST',cookie:f.owner,body})).status,403);
    assert.equal((await register(f,headers,{...body,projectId:randomUUID()})).status,403);
    assert.equal((await register(f,headers,body)).status,200);
    const old=f.db.prepare('SELECT * FROM business_push_devices').get();assert.ok(old.ciphertext&&!old.ciphertext.includes(body.expoPushToken));assert.equal(old.generation,1);
    await f.report('needs_attention','windows_spooler',['cover_open']);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM business_incident_push_outbox').get().n,1);
    await register(f,headers,body);assert.equal(f.db.prepare('SELECT generation FROM business_push_devices').get().generation,1);assert.equal(f.db.prepare('SELECT status FROM business_incident_push_outbox').get().status,'pending');
    const logout=await f.json('/api/native/auth/logout',{method:'POST',headers,body:{}});assert.equal(logout.status,200,logout.text);
    const retired=f.db.prepare('SELECT * FROM business_push_devices').get();assert.ok(retired.revoked_at);assert.equal(retired.ciphertext,null);assert.equal(f.db.prepare('SELECT status FROM business_incident_push_outbox').get().status,'cancelled');
    assert.equal((await register(f,headers,body)).status,401);
  }finally{await f.close();}
});

test('one opening and recovery push per phone excludes customer details and repeated reports',async()=>{
  const f=await businessDeviceFixture(config);try{
    const headers=await f.nativeLogin();await register(f,headers,registration());await register(f,headers,registration(randomUUID(),'otherphoneabcdefghijk'));
    await f.report('needs_attention','windows_spooler',['out_of_paper']);await f.report('needs_attention','windows_spooler',['out_of_paper']);
    const sent=[],adapter={send:async(payload,{beforeSend})=>{assert.equal(beforeSend(),true);sent.push(payload);return {status:'accepted',ticketId:`ticket_id_${sent.length}`};},receipt:async()=>({status:'receipt_confirmed'})};
    const first=await runBusinessDevicePush(f.db,f.config,{adapter});assert.equal(first.accepted,2);assert.equal(sent.length,2);assert.ok(sent.every(p=>p.data.restaurantId===f.restaurant.id&&p.data.kind==='device_incident'));assert.ok(!JSON.stringify(sent).includes('Cades'));assert.equal(new Set(sent.map(p=>p.to)).size,2);
    await runBusinessDevicePush(f.db,f.config,{adapter});assert.equal(sent.length,2);
    f.advance(15000);await f.pulse();await f.report('ready','windows_spooler');f.advance(15000);await f.pulse();await f.report('ready','windows_spooler');
    assert.equal((await runBusinessDevicePush(f.db,f.config,{adapter})).accepted,2);assert.equal(sent.length,4);assert.ok(sent.slice(2).every(p=>p.title.startsWith('Connection restored')));
    f.advance(15*60000);assert.equal((await runBusinessDevicePush(f.db,f.config,{adapter})).receiptConfirmed,4);
  }finally{await f.close();}
});

test('delivery refusal/failure retains incident, retries known rejection and does not repeat uncertain dispatch',async()=>{
  const f=await businessDeviceFixture(config);try{
    const headers=await f.nativeLogin();await register(f,headers,registration());await f.report('needs_attention','windows_spooler',['cover_open']);
    let calls=0;const adapter={send:async(payload,{beforeSend})=>{assert.equal(beforeSend(),true);calls++;return {status:'retry',errorCode:calls===1?'PUSH_RATE_LIMITED':'PUSH_NETWORK_RETRY'};},receipt:async()=>({status:'pending'})};
    assert.equal((await runBusinessDevicePush(f.db,f.config,{adapter})).failed,1);assert.equal(f.db.prepare('SELECT status FROM business_device_incidents').get().status,'active');
    f.advance(30001);assert.equal((await runBusinessDevicePush(f.db,f.config,{adapter})).unknown,1);f.advance(3600000);await runBusinessDevicePush(f.db,f.config,{adapter});assert.equal(calls,2);assert.equal(f.db.prepare('SELECT status FROM business_incident_push_outbox').get().status,'unknown');
  }finally{await f.close();}
});

test('closed overnight pushes stay quiet, and losing restaurant membership cancels delivery',async()=>{
  const f=await businessDeviceFixture(config);try{
    const headers=await f.nativeLogin();await register(f,headers,registration());f.db.prepare('UPDATE restaurants SET paused=1 WHERE id=?').run(f.restaurant.id);
    await f.report('needs_attention','windows_spooler',['out_of_paper']);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM business_device_incidents').get().n,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM business_incident_push_outbox').get().n,0);
    f.db.prepare('UPDATE restaurants SET paused=0 WHERE id=?').run(f.restaurant.id);await f.report('needs_attention','windows_spooler',['out_of_paper']);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM business_incident_push_outbox').get().n,1);
    f.db.prepare("DELETE FROM restaurant_memberships WHERE restaurant_id=? AND user_id=(SELECT id FROM users WHERE email='restaurant@calai.local')").run(f.restaurant.id);
    let sent=false;const adapter={send:async()=>{sent=true;return {status:'accepted',ticketId:'should_not_send'};},receipt:async()=>({status:'pending'})};assert.equal((await runBusinessDevicePush(f.db,f.config,{adapter})).cancelled,1);assert.equal(sent,false);assert.equal(f.db.prepare('SELECT status FROM business_device_incidents').get().status,'active');
  }finally{await f.close();}
});

test('an old invalid-token receipt cannot retire a newly registered token generation',async()=>{
  const f=await businessDeviceFixture(config);try{
    const headers=await f.nativeLogin(),body=registration();await register(f,headers,body);await f.report('needs_attention','windows_spooler',['cover_open']);
    const adapter={send:async(payload,{beforeSend})=>{assert.equal(beforeSend(),true);return {status:'accepted',ticketId:'old_generation_ticket'};},receipt:async()=>({status:'invalid_device'})};
    assert.equal((await runBusinessDevicePush(f.db,f.config,{adapter})).accepted,1);
    const rotated={...body,installationId:body.installationId.toUpperCase(),expoPushToken:'ExpoPushToken[rotatedbusinessphone]'};assert.equal((await register(f,headers,rotated)).status,200);
    f.advance(15*60000+1);await runBusinessDevicePush(f.db,f.config,{adapter});const device=f.db.prepare('SELECT * FROM business_push_devices').get();assert.equal(device.generation,2);assert.equal(device.revoked_at,null);assert.ok(device.ciphertext);
  }finally{await f.close();}
});
