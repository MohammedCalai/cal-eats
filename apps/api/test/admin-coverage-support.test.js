import assert from 'node:assert/strict';
import test from 'node:test';
import { journeyFixture } from './helpers.js';
import { outsideServiceAreaCopy } from '../src/service-areas.js';

async function identities(f){
 const admin=await f.login('admin@calai.local','LocalAdmin!4310'),owner=await f.login('restaurant@calai.local','LocalRestaurant!4310'),other=await f.login('restaurant2@calai.local','LocalRestaurant2!4310'),customer=await f.login('customer@calai.local','LocalCustomer!4310');
 const restaurant=(await f.json('/api/restaurant/restaurants',{cookie:owner})).body.data[0],foreign=(await f.json('/api/restaurant/restaurants',{cookie:other})).body.data[0];return{admin,owner,other,customer,restaurant,foreign};
}

test('admin coverage map only geocodes bounded configured areas, caches failures and returns fixed customer copy',async()=>{
 const calls=new Map();let running=0,maximum=0;
 const f=await journeyFixture({serviceAreaMapProvider:async code=>{calls.set(code,(calls.get(code)||0)+1);running++;maximum=Math.max(maximum,running);await new Promise(resolve=>setImmediate(resolve));running--;if(code==='LU3')throw Error('Provider is unavailable');return code==='LU4'?{latitude:200,longitude:-.4}:{latitude:51.8,longitude:-.4};}});
 try{
  const {admin,owner,customer}=await identities(f),codes=Array.from({length:21},(_,index)=>`LU${index+1}`);
  const save=await f.json('/api/admin/service-areas',{cookie:admin,method:'PUT',body:{mode:'custom',outcodes:codes}});assert.equal(save.status,200,save.text);
  for(const cookie of [undefined,owner,customer])assert.equal((await f.json('/api/admin/service-areas/map?outcodes=LU1',{cookie})).status,cookie?403:401);
  assert.equal(calls.size,0,'Unprivileged lookups must not contact the location provider');
  for(const query of ['',codes.join(','),'ZZ9','LU1,ZZ9']){const response=await f.json(`/api/admin/service-areas/map?outcodes=${encodeURIComponent(query)}`,{cookie:admin});assert.equal(response.status,400,response.text);}
  assert.equal(calls.size,0,'Invalid or unconfigured requests must not geocode');
  const map=await f.json(`/api/admin/service-areas/map?outcodes=${encodeURIComponent(codes.slice(0,20).join(','))}`,{cookie:admin});assert.equal(map.status,200,map.text);assert.equal(map.body.data.items.length,20);assert.ok(maximum<=4,'Provider requests are limited to four concurrent lookups');
  assert.equal(map.body.data.items.find(item=>item.outcode==='LU3').mapped,false);assert.equal(map.body.data.items.find(item=>item.outcode==='LU4').mapped,false);assert.equal(map.body.data.items.find(item=>item.outcode==='LU1').mapped,true);
  assert.equal('latitude' in map.body.data.items.find(item=>item.outcode==='LU3'),false);
  const repeat=await f.json('/api/admin/service-areas/map?outcodes=LU1,LU3,LU4,LU1',{cookie:admin});assert.equal(repeat.status,200);assert.equal(repeat.body.data.items.length,3);for(const code of ['LU1','LU3','LU4'])assert.equal(calls.get(code),1,'Successful and failed lookups are cached');
  f.db.prepare("UPDATE service_area_settings SET headline='Legacy custom heading',message='Legacy custom message' WHERE id=1").run();
  const settings=(await f.json('/api/admin/service-areas',{cookie:admin})).body.data,publicCopy=(await f.json('/api/service-availability?postcode=EH1')).body.data;
  for(const value of [settings,publicCopy]){assert.equal(value.headline,outsideServiceAreaCopy.headline);assert.equal(value.message,outsideServiceAreaCopy.message);}
  const changed=await f.json('/api/admin/service-areas',{cookie:admin,method:'PUT',body:{mode:'custom',outcodes:['LU1'],headline:'Editable message'}});assert.equal(changed.status,400);assert.equal(changed.body.error.code,'OUTSIDE_AREA_MESSAGE_FIXED');
  assert.deepEqual((await f.json('/api/admin/service-areas',{cookie:admin})).body.data.outcodes,codes.sort(),'Rejected copy edit must not alter coverage');
  const mapSettings=settings.mapAreas.find(area=>area.outcode==='LU21');assert.equal(mapSettings.enabled,true);assert.equal(mapSettings.operating,false,'An enabled area without restaurant coverage is not operating');
 }finally{await f.close();}
});

test('admin support queues separate platform and restaurant requests, filter by business and preserve tenant access',async()=>{
 const f=await journeyFixture();try{
  const {admin,owner,other,customer,restaurant,foreign}=await identities(f);
  async function create(cookie,key,body){const response=await f.json('/api/support',{cookie,method:'POST',headers:{'Idempotency-Key':key},body});assert.equal(response.status,201,response.text);return response.body.data;}
  const businessA=await create(owner,'triage-business-a',{subject:'Business A needs support',message:'Private A business request',restaurantId:restaurant.id}),businessB=await create(other,'triage-business-b',{subject:'Business B needs support',message:'Private B business request',restaurantId:foreign.id}),general=await create(customer,'triage-customer-general',{subject:'Customer account help',message:'Private customer account request'});
  const menu=f.db.prepare('SELECT * FROM menu_items WHERE restaurant_id=? AND price_minor>=1000 LIMIT 1').get(restaurant.id),created=await f.json('/api/orders',{cookie:customer,method:'POST',headers:{'Idempotency-Key':'triage-help-order'},body:{restaurantId:restaurant.id,fulfillment:'collection',paymentMethod:'mock_card',items:[{menuItemId:menu.id,quantity:1}]}});assert.equal(created.status,201,created.text);
  const orderHelp=await create(customer,'triage-customer-order',{subject:'Order timing question',message:'Private restaurant order request',orderId:created.body.data.id});
  const list=(query,cookie=admin)=>{const params=new URLSearchParams({page:'1',pageSize:'25'});for(const [key,value] of new URLSearchParams(query))params.set(key,value);return f.json(`/api/admin/support?${params}`,{cookie});};
  let page=await list('assignedTo=platform&status=open&waitingFor=team');assert.equal(page.status,200,page.text);assert.equal(page.body.data.total,3);assert.deepEqual(new Set(page.body.data.items.map(item=>item.id)),new Set([businessA.id,businessB.id,general.id]));
  page=await list('assignedTo=restaurant&status=open&waitingFor=team');assert.equal(page.body.data.total,1);assert.equal(page.body.data.items[0].id,orderHelp.id);
  page=await list(`restaurant=${restaurant.id}`);assert.equal(page.body.data.total,2);assert.deepEqual(new Set(page.body.data.items.map(item=>item.id)),new Set([businessA.id,orderHelp.id]));
  for(const query of ['assignedTo=other','waitingFor=nobody','pageSize=101','restaurant='+'x'.repeat(101)])assert.equal((await list(query)).status,400);
  for(const cookie of [owner,other,customer]){assert.equal((await list('',cookie)).status,403);assert.equal((await f.json('/api/admin/support/overview',{cookie})).status,403);}
  const foreignList=await f.json(`/api/restaurant/restaurants/${foreign.id}/support?page=1&restaurant=${restaurant.id}&assignedTo=restaurant`,{cookie:other});assert.equal(foreignList.status,200);assert.equal(foreignList.body.data.total,0);
  const ownList=await f.json(`/api/support?page=1&restaurant=${foreign.id}`,{cookie:owner});assert.equal(ownList.body.data.total,0);
  for(const id of [businessA.id,orderHelp.id,general.id])assert.equal((await f.json(`/api/support/${id}`,{cookie:other})).status,404);
  const reply=await f.json(`/api/support/${businessA.id}/messages`,{cookie:admin,method:'POST',headers:{'Idempotency-Key':'triage-admin-answer'},body:{message:'We have checked your request.'}});assert.equal(reply.status,201,reply.text);
  assert.equal((await f.json(`/api/support/${general.id}`,{cookie:admin,method:'PATCH',body:{status:'resolved'}})).status,200);
  const overview=await f.json('/api/admin/support/overview',{cookie:admin});assert.equal(overview.status,200,overview.text);assert.deepEqual(overview.body.data,{total:4,needsPlatformReply:1,needsRestaurantReply:1,awaitingRequester:1,resolved:1});
  page=await list('status=open&waitingFor=customer');assert.equal(page.body.data.total,1);assert.equal(page.body.data.items[0].id,businessA.id);
  page=await list('status=resolved&waitingFor=none');assert.equal(page.body.data.total,1);assert.equal(page.body.data.items[0].id,general.id);
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{await f.close();}
});
