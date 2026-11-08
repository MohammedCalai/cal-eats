import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {journeyFixture} from './helpers.js';
import {addNotification} from '../src/offers.js';
import {loadCustomerPushConfig,runCustomerPush} from '../src/customer-push.js';
import {createExpoPushAdapter} from '../src/expo-push-adapter.js';

const primary='5bf59184-c670-44f4-be78-5229cbd02300',alternate='f76a2adf-34ca-438a-9208-bdb5d4e65ded';
const environment={CALAI_CUSTOMER_PUSH_ENABLED:'true',CALAI_EXPO_PUSH_ACCESS_TOKEN:'fixture-service-token',CALAI_EXPO_PUSH_IOS_PROJECT_IDS:primary,CALAI_EXPO_PUSH_ANDROID_PROJECT_IDS:`${primary},${alternate}`};
async function setup(){
 let clock=Date.parse('2026-01-01T01:00:00Z');const f=await journeyFixture({now:()=>new Date(clock),rateLimit:{attempts:100,windowMs:60000},messageEncryptionKey:Buffer.alloc(32,49).toString('base64'),customerPush:loadCustomerPushConfig(environment)});
 const login=await f.json('/api/native/auth/login',{method:'POST',body:{email:'customer@calai.local',password:'LocalCustomer!4310'}}),headers={authorization:`Bearer ${login.body.data.token}`},customerId=login.body.data.user.id,owner=await f.login('restaurant@calai.local','LocalRestaurant!4310'),restaurant=f.db.prepare("SELECT * FROM restaurants WHERE name='Calai Kitchen'").get(),ownerId=f.db.prepare("SELECT id FROM users WHERE email='restaurant@calai.local'").get().id,item=f.db.prepare('SELECT * FROM menu_items WHERE restaurant_id=? LIMIT 1').get(restaurant.id);
 const registration={installationId:randomUUID(),expoPushToken:'ExpoPushToken[unit_customer_push_token_aaaaaaaa]',platform:'ios',projectId:primary};
 const register=(body=registration,extra={headers})=>f.json('/api/native/push/devices',{method:'POST',...extra,body});
 const notice=(type,eventKey,extra={})=>{addNotification(f.db,{userId:customerId,type,title:'Private title must not leak',message:'Private address and message must not leak',eventKey,now:f.config.now().toISOString(),...extra});return f.db.prepare('SELECT * FROM user_notifications WHERE user_id=? AND event_key=?').get(customerId,eventKey);};
 const voucher=()=>{const id=randomUUID(),now=f.config.now().toISOString();f.db.prepare("INSERT INTO platform_vouchers(id,customer_id,title,message,amount_minor,expires_at,issued_by_user_id,reason,idempotency_key,request_hash,created_at,updated_at) VALUES(?,?,'Fixture credit','Private credit reason',500,?,?,'Fixture care',?,'fixture',?,?)").run(id,customerId,new Date(clock+86400000).toISOString(),ownerId,id,now,now);notice('platform_voucher',`platform-voucher:${id}:issued`);return id;};
 const offer=()=>{const id=randomUUID(),grant=randomUUID(),now=f.config.now().toISOString();f.db.prepare("INSERT INTO offer_campaigns(id,restaurant_id,created_by_user_id,idempotency_key,request_hash,title,message,menu_item_id,item_name,item_value_minor,min_subtotal_minor,expires_at,created_at,starts_at) VALUES(?,?,?,?,'fixture','Private offer','Private message',?,'Fixture free item',100,0,?,?,?)").run(id,restaurant.id,ownerId,id,item.id,new Date(clock+86400000).toISOString(),now,now);f.db.prepare("INSERT INTO offer_grants(id,campaign_id,restaurant_id,customer_id,status,created_at,updated_at) VALUES(?,?,?,?,'available',?,?)").run(grant,id,restaurant.id,customerId,now,now);notice('offer',`offer:${grant}:issued`,{offerId:grant,restaurantId:restaurant.id});return {id,grant};};
 return {f,headers,customerId,owner,ownerId,restaurant,item,registration,register,notice,voucher,offer,advance:ms=>{clock+=ms;},now:()=>new Date(clock).toISOString()};
}
const fakeTransport=calls=>({send:async(payload,{beforeSend})=>{if(!beforeSend())return {status:'cancelled'};calls.push(payload);return {status:'accepted',ticketId:randomUUID()};},receipt:async()=>({status:'receipt_confirmed'})});

test('restaurant contact block cancels queued promotional push and is rechecked immediately before dispatch',async()=>{
 const s=await setup(),calls=[];try{
  assert.equal((await s.register()).status,200);
  await s.f.json('/api/account/marketing-preferences',{method:'PATCH',headers:s.headers,body:{inAppPromotions:true,pushPromotions:true,source:'push-safety-test'}});
  const first=s.offer();
  const block=()=>s.f.json(`/api/customer-safety/restaurants/${s.restaurant.id}`,{method:'PUT',headers:s.headers,body:{blocked:true}});
  assert.equal((await block()).status,200);
  assert.equal(s.f.db.prepare('SELECT status FROM customer_push_outbox WHERE notification_id=(SELECT id FROM user_notifications WHERE offer_id=?)').get(first.grant).status,'cancelled');
  await runCustomerPush(s.f.db,s.f.config,{adapter:fakeTransport(calls)});assert.equal(calls.length,0);
  await s.f.json(`/api/customer-safety/restaurants/${s.restaurant.id}`,{method:'PUT',headers:s.headers,body:{blocked:false}});
  s.offer();
  await runCustomerPush(s.f.db,s.f.config,{adapter:fakeTransport(calls),beforeDispatch:async()=>{await block();}});
  assert.equal(calls.length,0,'An already queued offer cannot pass dispatch after a block');
  s.voucher();await runCustomerPush(s.f.db,s.f.config,{adapter:fakeTransport(calls)});
  assert.equal(calls.length,1,'Platform account/voucher notifications are still available');
 }finally{await s.f.close();}
});

test('customer iOS and Android pushes stay silent with an old app opting in and a legacy audible device row',async()=>{
 for(const platform of ['ios','android']){
  const s=await setup(),calls=[];try{
   const registered=await s.register({...s.registration,platform,soundEnabled:true});assert.equal(registered.status,200,registered.text);
   assert.equal(s.f.db.prepare('SELECT sound_enabled FROM customer_push_devices').get().sound_enabled,0);
   s.f.db.prepare('UPDATE customer_push_devices SET sound_enabled=1').run();
   s.voucher();await runCustomerPush(s.f.db,s.f.config,{adapter:fakeTransport(calls)});
   assert.equal(calls.length,1);assert.equal(calls[0].sound,undefined);assert.equal(calls[0].channelId,'cal-eats-updates-quiet');
   assert.equal(calls[0].priority,'high');assert.ok(calls[0].title&&calls[0].body&&calls[0].data.notificationId);
  }finally{await s.f.close();}
 }
});

test('native push registration protects customer/session/project boundaries, encrypted ownership and logout races',async()=>{
 const s=await setup();try{
  const cookie=await s.f.login('customer@calai.local','LocalCustomer!4310');assert.equal((await s.register(s.registration,{})).status,401);assert.equal((await s.register(s.registration,{cookie})).status,403);
  const business=await s.f.json('/api/native/business/auth/login',{method:'POST',body:{email:'restaurant@calai.local',password:'LocalRestaurant!4310'}});assert.equal((await s.register(s.registration,{headers:{authorization:`Bearer ${business.body.data.token}`}})).status,403);
  assert.equal((await s.register({...s.registration,projectId:alternate})).status,403);assert.equal((await s.register({...s.registration,expoPushToken:'not-a-token'})).status,400);
  for(const field of ['installationId','expoPushToken','projectId'])assert.equal((await s.register({...s.registration,[field]:[s.registration[field]]})).status,400,'Array values must not bypass token/ID validation');
  const registered=await s.register();assert.equal(registered.status,200,registered.text);assert.equal(registered.body.data.registered,true);assert.equal(registered.text.includes(s.registration.expoPushToken),false);
  const original=s.f.db.prepare('SELECT * FROM customer_push_devices').get();assert.ok(original.ciphertext);assert.equal(original.sound_enabled,0);assert.equal(JSON.stringify(original).includes(s.registration.expoPushToken),false);await s.register();assert.equal(s.f.db.prepare('SELECT generation FROM customer_push_devices').get().generation,original.generation);
  s.voucher();assert.equal(s.f.db.prepare("SELECT COUNT(*) n FROM customer_push_outbox WHERE status='pending'").get().n,1);
  const other=await s.f.json('/api/native/auth/register',{method:'POST',body:{name:'Other customer',email:'push-other@example.test',password:'OtherPushFixture2026!'}}),otherHeaders={authorization:`Bearer ${other.body.data.token}`};assert.equal(other.status,201);
  assert.equal((await s.register(s.registration,{headers:otherHeaders})).status,200);const rebound=s.f.db.prepare('SELECT * FROM customer_push_devices').get();assert.equal(rebound.user_id,other.body.data.user.id);assert.ok(rebound.generation>original.generation);assert.equal(s.f.db.prepare('SELECT status FROM customer_push_outbox').get().status,'cancelled');
  assert.equal((await s.f.json(`/api/native/push/devices/${s.registration.installationId}`,{method:'DELETE',headers:s.headers})).status,200);assert.equal(s.f.db.prepare('SELECT revoked_at FROM customer_push_devices').get().revoked_at,null);
  await s.f.json('/api/native/auth/logout',{method:'POST',headers:s.headers,body:{}});assert.equal(s.f.db.prepare('SELECT revoked_at FROM customer_push_devices').get().revoked_at,null,'Old account logout cannot revoke the newer binding');
  await s.f.json('/api/native/auth/logout',{method:'POST',headers:otherHeaders,body:{}});assert.ok(s.f.db.prepare('SELECT revoked_at FROM customer_push_devices').get().revoked_at);assert.equal(s.f.db.prepare('SELECT ciphertext FROM customer_push_devices').get().ciphertext,null);
 }finally{await s.f.close();}
});

test('persisted customer notifications deliver safe current actions and honor reads, ended offers, consent, messages and ratings',async()=>{
 const s=await setup(),calls=[],adapter=fakeTransport(calls);try{
  assert.equal((await s.register()).status,200);
  const placed=await s.f.json('/api/orders',{method:'POST',headers:{...s.headers,'Idempotency-Key':'push-order'},body:{restaurantId:s.restaurant.id,items:[{menuItemId:s.item.id,quantity:1}],paymentMethod:'mock_card',fulfillment:'collection'}});assert.equal(placed.status,201,placed.text);const order=placed.body.data;
  const status=async value=>{const r=await s.f.json(`/api/restaurant/orders/${order.id}/status`,{method:'PATCH',cookie:s.owner,body:{status:value}});assert.equal(r.status,200,r.text);};
  await status('accepted');s.notice('order_status',`order:${order.id}:accepted`,{orderId:order.id,restaurantId:s.restaurant.id});assert.equal(s.f.db.prepare('SELECT COUNT(*) n FROM customer_push_outbox').get().n,1,'Notification replay never duplicates a device job');
  await runCustomerPush(s.f.db,s.f.config,{adapter});assert.equal(calls.length,1);assert.deepEqual(calls[0].data,{notificationId:s.f.db.prepare("SELECT id FROM user_notifications WHERE user_id=? AND type='order_status'").get(s.customerId).id,recipientUserId:s.customerId,kind:'order',orderId:order.id});assert.equal(calls[0].sound,undefined);assert.equal(calls[0].channelId,'cal-eats-updates-quiet');
  await status('preparing');await status('ready');await runCustomerPush(s.f.db,s.f.config,{adapter});assert.equal(calls.length,2,'Only the latest order status is dispatched');
  const unread=s.notice('order_status',`order:${order.id}:ready:read-race`,{orderId:order.id,restaurantId:s.restaurant.id});await runCustomerPush(s.f.db,s.f.config,{adapter,beforeDispatch:()=>s.f.db.prepare('UPDATE user_notifications SET read_at=? WHERE id=?').run(s.now(),unread.id)});assert.equal(calls.length,2);
  await s.f.json('/api/account/marketing-preferences',{method:'PATCH',headers:s.headers,body:{inAppPromotions:true,pushPromotions:false,source:'push-test'}});s.offer();await runCustomerPush(s.f.db,s.f.config,{adapter});assert.equal(calls.length,2);
  await s.f.json('/api/account/marketing-preferences',{method:'PATCH',headers:s.headers,body:{inAppPromotions:true,pushPromotions:true,source:'push-test'}});const ended=s.offer();await runCustomerPush(s.f.db,s.f.config,{adapter,beforeDispatch:()=>s.f.db.prepare('UPDATE offer_campaigns SET expires_at=? WHERE id=?').run(s.now(),ended.id)});assert.equal(calls.length,2);
  const active=s.offer();await runCustomerPush(s.f.db,s.f.config,{adapter});assert.equal(calls.at(-1).data.offerId,active.grant);assert.equal(calls.at(-1).data.kind,'offers');
  const legacy=s.offer();s.f.db.prepare('UPDATE offer_campaigns SET starts_at=NULL WHERE id=?').run(legacy.id);await runCustomerPush(s.f.db,s.f.config,{adapter});assert.equal(calls.at(-1).data.offerId,legacy.grant,'Legacy null starts use campaign creation time');
  const future=s.offer(),scheduledAt=new Date(Date.parse(s.now())+2*86400000).toISOString();s.f.db.prepare('UPDATE offer_campaigns SET starts_at=?,expires_at=? WHERE id=?').run(scheduledAt,new Date(Date.parse(scheduledAt)+86400000).toISOString(),future.id);const beforeFuture=calls.length;await runCustomerPush(s.f.db,s.f.config,{adapter});s.advance(25*3600000);await runCustomerPush(s.f.db,s.f.config,{adapter});assert.equal(calls.length,beforeFuture,'Offers scheduled beyond 24 hours remain queued until activation');
  const revisedStart=new Date(Date.parse(s.now())+3600000).toISOString(),revisedEnd=new Date(Date.parse(s.now())+4*3600000).toISOString();s.f.db.prepare('UPDATE offer_campaigns SET starts_at=?,expires_at=? WHERE id=?').run(revisedStart,revisedEnd,future.id);const scheduled=s.f.db.prepare('SELECT o.* FROM customer_push_outbox o JOIN user_notifications n ON n.id=o.notification_id WHERE n.offer_id=?').get(future.grant);assert.equal(scheduled.available_at,revisedStart);assert.equal(scheduled.expires_at,revisedEnd);s.advance(3600001);await runCustomerPush(s.f.db,s.f.config,{adapter});assert.equal(calls.length,beforeFuture+1);assert.equal(calls.at(-1).data.offerId,future.grant);
  s.owner=await s.f.login('restaurant@calai.local','LocalRestaurant!4310');
  await s.register({...s.registration,soundEnabled:false});s.voucher();await runCustomerPush(s.f.db,s.f.config,{adapter});assert.equal(calls.at(-1).sound,undefined);assert.equal(calls.at(-1).channelId,'cal-eats-updates-quiet');
  await status('completed');await runCustomerPush(s.f.db,s.f.config,{adapter});assert.ok(calls.some(payload=>payload.body.includes('quick shop rating')));
  const message=await s.f.json(`/api/orders/${order.id}/messages`,{method:'POST',cookie:s.owner,headers:{'Idempotency-Key':'push-message'},body:{message:'Very private meal and address details'}});assert.equal(message.status,201,message.text);await runCustomerPush(s.f.db,s.f.config,{adapter});assert.equal(calls.at(-1).title,'New restaurant message');
  const conversation=await s.f.json(`/api/restaurant/restaurants/${s.restaurant.id}/customers/${s.customerId}/conversation`,{method:'POST',cookie:s.owner,headers:{'Idempotency-Key':'push-crm'},body:{message:'Private personalised conversation'}});assert.equal(conversation.status,201,conversation.text);await runCustomerPush(s.f.db,s.f.config,{adapter});assert.equal(calls.at(-1).data.conversationId,conversation.body.data.threadId);
  const help=await s.f.json('/api/support',{method:'POST',headers:s.headers,body:{subject:'Private problem',message:'Private details',orderId:order.id}});assert.equal(help.status,201,help.text);await runCustomerPush(s.f.db,s.f.config,{adapter});assert.equal(calls.at(-1).data.kind,'support');assert.equal(calls.at(-1).data.supportCaseId,help.body.data.id);
  const serialized=JSON.stringify(calls.map(({to,...payload})=>payload));for(const privateText of ['Very private','Private personalised','Private problem','Private details','Private title','Private address'])assert.equal(serialized.includes(privateText),false);
  assert.equal(s.f.db.prepare('PRAGMA foreign_key_check').all().length,0);
 }finally{await s.f.close();}
});

test('push retries transport failures and lost leases, checks receipts, retires invalid tokens and preserves unverified ticket state',async()=>{
 const s=await setup();try{
  await s.register();s.voucher();let sends=0;
  const adapter={send:async(payload,{beforeSend})=>{assert.equal(beforeSend(),true);sends++;return sends===1?{status:'retry',errorCode:'PUSH_RATE_LIMITED'}:{status:'accepted',ticketId:randomUUID()};},receipt:async()=>({status:'invalid_device',errorCode:'PUSH_DEVICE_NOT_REGISTERED'})};
  await runCustomerPush(s.f.db,s.f.config,{adapter});assert.equal(sends,1);assert.equal(s.f.db.prepare('SELECT status FROM customer_push_outbox').get().status,'failed');s.advance(61000);await Promise.all([runCustomerPush(s.f.db,s.f.config,{adapter}),runCustomerPush(s.f.db,s.f.config,{adapter})]);assert.equal(sends,2);assert.equal(s.f.db.prepare('SELECT status FROM customer_push_outbox').get().status,'accepted');
  s.advance(15*60000+1);await runCustomerPush(s.f.db,s.f.config,{adapter});assert.ok(s.f.db.prepare('SELECT revoked_at FROM customer_push_devices').get().revoked_at);assert.equal(s.f.db.prepare('SELECT status FROM customer_push_outbox').get().status,'failed');
  await s.register();s.voucher();await runCustomerPush(s.f.db,s.f.config,{adapter:{...adapter,send:async(payload,{beforeSend})=>{assert.equal(beforeSend(),true);sends++;return {status:'unknown'};}}});assert.equal(s.f.db.prepare('SELECT status FROM customer_push_outbox ORDER BY rowid DESC LIMIT 1').get().status,'unknown');s.advance(61000);await runCustomerPush(s.f.db,s.f.config,{adapter});assert.equal(sends,3);
  s.voucher();const last=s.f.db.prepare('SELECT id FROM customer_push_outbox ORDER BY rowid DESC LIMIT 1').get();s.f.db.prepare("UPDATE customer_push_outbox SET status='claimed',lease_owner='lost-worker',lease_expires_at=?,dispatch_started_at=?,attempts=1 WHERE id=?").run(new Date(Date.parse(s.now())-1).toISOString(),s.now(),last.id);await runCustomerPush(s.f.db,s.f.config,{adapter});assert.equal(s.f.db.prepare('SELECT status FROM customer_push_outbox WHERE id=?').get(last.id).status,'pending');assert.equal(sends,3);s.advance(61000);await runCustomerPush(s.f.db,s.f.config,{adapter});assert.equal(sends,4);assert.equal(s.f.db.prepare('SELECT status FROM customer_push_outbox WHERE id=?').get(last.id).status,'accepted');
  s.f.db.prepare('UPDATE native_sessions SET expires_at=?').run(new Date(Date.parse(s.now())-1).toISOString());await runCustomerPush(s.f.db,s.f.config,{adapter});assert.ok(s.f.db.prepare('SELECT revoked_at FROM customer_push_devices').get().revoked_at);
 }finally{await s.f.close();}
});

test('network and HTTP 5xx failures retry durably with stable OS identities and fresh eligibility checks',async()=>{
 const s=await setup();try{
  await s.register();s.voucher();const requests=[];
  const adapter=createExpoPushAdapter(s.f.config.customerPush,{fetchImpl:async(url,init)=>{requests.push(JSON.parse(init.body));if(requests.length===1)throw new TypeError('Fixture network outage');if(requests.length===2)return new Response('{}',{status:503});return new Response(JSON.stringify({data:{status:'ok',id:'ticket_transient_recovered'}}),{status:200});}});
  await runCustomerPush(s.f.db,s.f.config,{adapter});assert.equal(s.f.db.prepare('SELECT status FROM customer_push_outbox').get().status,'failed');s.advance(61000);await runCustomerPush(s.f.db,s.f.config,{adapter});assert.equal(s.f.db.prepare('SELECT status FROM customer_push_outbox').get().status,'failed');s.advance(121000);await runCustomerPush(s.f.db,s.f.config,{adapter});assert.equal(s.f.db.prepare('SELECT status FROM customer_push_outbox').get().status,'accepted');assert.equal(requests.length,3);
  assert.equal(new Set(requests.map(payload=>payload.collapseId)).size,1);assert.ok(requests.every(payload=>payload.tag===payload.collapseId&&payload.collapseId===payload.data.notificationId));
 }finally{await s.f.close();}
});

test('Expo adapter uses fixed authenticated endpoints and distinguishes acceptance from receipts without echoing tokens',async()=>{
 assert.deepEqual(loadCustomerPushConfig({}),{enabled:false,accessToken:'',iosProjectIds:[],androidProjectIds:[]});assert.throws(()=>loadCustomerPushConfig({...environment,CALAI_EXPO_PUSH_ACCESS_TOKEN:''}));assert.throws(()=>loadCustomerPushConfig({...environment,CALAI_EXPO_PUSH_IOS_PROJECT_IDS:'bad-project'}));
 const requests=[],settings=loadCustomerPushConfig(environment),adapter=createExpoPushAdapter(settings,{fetchImpl:async(url,init)=>{requests.push({url,init});return new Response(JSON.stringify(url.endsWith('/send')?{data:{status:'ok',id:'ticket_fixture_adapter'}}:{data:{ticket_fixture_adapter:{status:'ok'}}}),{status:200});}});
 const accepted=await adapter.send({to:'ExpoPushToken[unit_adapter_token_aaaaaaaa]',title:'Cal-Eats',data:{notificationId:randomUUID()}},{beforeSend:()=>true});assert.deepEqual(accepted,{status:'accepted',ticketId:'ticket_fixture_adapter'});assert.equal((await adapter.receipt(accepted.ticketId)).status,'receipt_confirmed');assert.deepEqual(requests.map(r=>r.url),['https://exp.host/--/api/v2/push/send','https://exp.host/--/api/v2/push/getReceipts']);assert.equal(requests[0].init.headers.Authorization,'Bearer fixture-service-token');assert.equal((await adapter.send({},{beforeSend:()=>false})).status,'cancelled');assert.equal(requests.length,2);
});
