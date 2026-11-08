import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { journeyFixture } from './helpers.js';
import { routeAdminRestaurantWorkspace } from '../src/admin-restaurant-workspace.js';
import { requireRestaurantOwner } from '../src/auth/authorization.js';
import { scopedAdminRestaurantSession } from '../src/auth/admin-restaurant-scope.js';
import { adminRestaurantAvailabilityLabel } from '../../portal/src/admin-restaurant-presentation.js';

async function setup() {
 const f=await journeyFixture({now:()=>new Date('2026-01-01T10:00:00.000Z')});
 const admin={user:f.db.prepare("SELECT id,name,email,role FROM users WHERE role='admin'").get()},owner={user:f.db.prepare("SELECT id,name,email,role FROM users WHERE email='restaurant@calai.local'").get()},customer={user:f.db.prepare("SELECT id,name,email,role FROM users WHERE role='customer'").get()};
 const restaurants=f.db.prepare('SELECT * FROM restaurants ORDER BY created_at,id').all(),restaurant=restaurants.find(row=>row.status==='approved'),other=restaurants.find(row=>row.id!==restaurant.id);
 async function request(path,{session=admin,method='GET',body,key='admin-test'}={}){
  const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);Object.assign(req,{method,url:path,headers:{'content-type':'application/json','idempotency-key':key},socket:{remoteAddress:'127.0.0.1'}});
  const res={headersSent:false,statusCode:200,setHeader(){},writeHead(status){this.statusCode=status;this.headersSent=true;},end(value){this.body=value?JSON.parse(String(value)):null;this.writableEnded=true;}};
  try{const handled=await routeAdminRestaurantWorkspace({req,res,url:new URL(path,'http://localhost'),db:f.db,config:f.config,session});return{status:res.statusCode,body:res.body,handled};}catch(error){return{status:error.status||500,error};}
 }
 return{...f,admin,owner,customer,restaurant,other,request};
}

test('admin restaurant management is explicitly scoped, keeps the administrator actor and preserves menu validation',async()=>{
 const f=await setup();try{
  const root=`/api/admin/restaurants/${f.restaurant.id}/manage`,item=f.db.prepare('SELECT * FROM menu_items WHERE restaurant_id=? LIMIT 1').get(f.restaurant.id),otherItem={id:'other-tenant-item'};
  f.db.prepare('INSERT INTO menu_items(id,restaurant_id,name,description,price_minor,available,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)').run(otherItem.id,f.other.id,'Other dish','',500,f.config.now().toISOString(),f.config.now().toISOString());
  for(const session of [null,f.owner,f.customer])assert.equal((await f.request(`${root}/menu`,{session})).status,session?403:401);
  assert.equal((await f.request(`${root}/menu`)).body.data.items[0].restaurantId,f.restaurant.id);
  const updated=await f.request(`${root}/menu/${item.id}`,{method:'PATCH',body:{name:'Admin corrected dish',priceMinor:875}});assert.equal(updated.status,200);assert.equal(updated.body.data.name,'Admin corrected dish');
  assert.equal(f.db.prepare('SELECT actor_user_id FROM audit_events WHERE action=? ORDER BY rowid DESC').get('admin_restaurant_managed').actor_user_id,f.admin.user.id);
  assert.equal((await f.request(`${root}/menu/${otherItem.id}`,{method:'PATCH',body:{name:'Wrong tenant'}})).status,404);
  assert.equal((await f.request(`${root}/menu/${item.id}`,{method:'PATCH',body:{priceMinor:-1}})).status,400);
  assert.equal((await f.request(`${root}/menu/${item.id}`,{method:'PATCH',body:{restaurantId:f.other.id}})).status,400);
  assert.equal((await f.request(`${root}/printers`)).status,404);
  assert.equal((await f.request(`${root}/finance/provider-account`,{method:'POST',body:{}})).status,404);
  assert.throws(()=>requireRestaurantOwner(f.db,f.admin,f.restaurant.id),error=>error.status===403);
  assert.throws(()=>requireRestaurantOwner(f.db,scopedAdminRestaurantSession(f.admin,f.restaurant.id),f.other.id),error=>error.status===403);
  assert.throws(()=>requireRestaurantOwner(f.db,{...f.admin,restaurantAdminAccess:f.restaurant.id},f.restaurant.id),error=>error.status===403);
 }finally{await f.close();}
});

test('admin availability display follows workspace acceptingOrders for open, closed and paused restaurants',async()=>{
 const f=await setup();try{
  const path=`/api/admin/restaurants/${f.restaurant.id}/workspace`;
  async function inspect(expected,accepting){const response=await f.request(path);assert.equal(response.status,200);const restaurant=response.body.data.restaurant;assert.equal(restaurant.acceptingOrders,accepting);assert.equal(adminRestaurantAvailabilityLabel(restaurant),expected);return restaurant;}
  f.db.prepare("UPDATE restaurants SET status='approved',always_open=1,paused=0,suspended=0,archived_at=NULL,holiday_dates='[]' WHERE id=?").run(f.restaurant.id);
  const opened=await inspect('Open now',true);assert.equal(Object.hasOwn(opened,'openNow'),false,'The UI must use the canonical DTO field, not an absent alias');
  f.db.prepare("UPDATE restaurants SET always_open=0,opening_hours='[]' WHERE id=?").run(f.restaurant.id);await inspect('Closed now',false);
  f.db.prepare('UPDATE restaurants SET always_open=1,paused=1 WHERE id=?').run(f.restaurant.id);await inspect('Paused',false);
  f.db.prepare('UPDATE restaurants SET suspended=1 WHERE id=?').run(f.restaurant.id);await inspect('Suspended',false);
  f.db.prepare("UPDATE restaurants SET suspended=0,paused=0,status='pending' WHERE id=?").run(f.restaurant.id);await inspect('Pending approval',true);
  f.db.prepare('UPDATE restaurants SET archived_at=? WHERE id=?').run(f.config.now().toISOString(),f.restaurant.id);await inspect('Archived',false);
 }finally{await f.close();}
});

test('admin restaurant directory, orders and access candidates are bounded and restaurant scoped',async()=>{
 const f=await setup();try{
  const now=f.config.now().toISOString();for(let index=0;index<30;index++)f.db.prepare('INSERT INTO restaurants(id,name,status,created_at) VALUES(?,?,?,?)').run(`paging-${index}`,`Paging Restaurant ${String(index).padStart(2,'0')}`,'pending',now);
  let result=await f.request('/api/admin/restaurant-directory?q=Paging&page=2');assert.equal(result.status,200);assert.equal(result.body.data.items.length,5);assert.equal(result.body.data.pagination.total,30);assert.equal(result.body.data.pagination.page,2);
  assert.ok(result.body.data.items.every(row=>row.name.startsWith('Paging')));
  assert.equal((await f.request('/api/admin/restaurant-directory?pageSize=101')).status,400);
  const root=`/api/admin/restaurants/${f.restaurant.id}/workspace`;
  result=await f.request(root);assert.equal(result.status,200);assert.equal(result.body.data.restaurant.id,f.restaurant.id);assert.equal(result.body.data.owner.email,'restaurant@calai.local');
  result=await f.request(`${root}/access-candidates`);assert.ok(result.body.data.items.every(row=>row.id!==f.owner.user.id));assert.ok(result.body.data.items.every(row=>row.id!==f.admin.user.id&&row.id!==f.customer.user.id));
  assert.equal((await f.request(`${root}/orders?state=unknown`)).status,400);
  assert.equal((await f.request(`${root}/orders?from=2026-02-30`)).status,400);
  const cookie=await f.login('customer@calai.local','LocalCustomer!4310'),menu=f.db.prepare('SELECT * FROM menu_items WHERE restaurant_id=? AND price_minor>=1000 LIMIT 1').get(f.restaurant.id);
  const order=await f.json('/api/orders',{cookie,method:'POST',headers:{'Idempotency-Key':'admin-order-list'},body:{restaurantId:f.restaurant.id,fulfillment:'collection',paymentMethod:'mock_card',items:[{menuItemId:menu.id,quantity:1}]}});assert.equal(order.status,201,order.text);
  result=await f.request(`${root}/orders?state=live&page=1`);assert.equal(result.body.data.items.length,1);assert.equal(result.body.data.items[0].id,order.body.data.id);assert.equal(result.body.data.items[0].customerEmail,'customer@calai.local');
  assert.equal((await f.request(`/api/admin/restaurants/${f.other.id}/workspace/orders?state=live`)).body.data.items.length,0);
  assert.equal((await f.request(`${root}/orders?state=past`)).body.data.items.length,0);
 }finally{await f.close();}
});

test('delivery fees remain owner-only while administrators inspect settings and edit permitted restaurant details',async()=>{
 const f=await setup();try{
  const root=`/api/admin/restaurants/${f.restaurant.id}/manage`,workspace=`/api/admin/restaurants/${f.restaurant.id}/workspace`,read=()=>f.db.prepare('SELECT delivery_enabled,delivery_outcodes,delivery_fee_minor,min_delivery_subtotal_minor FROM restaurants WHERE id=?').get(f.restaurant.id),before=read();
  const denied=await f.request(`${root}/delivery`,{method:'PATCH',body:{enabled:true,outcodes:['LU1'],deliveryFeeMinor:1,minDeliverySubtotalMinor:0}});
  assert.equal(denied.status,403);assert.equal(denied.error.code,'OWNER_DELIVERY_SETTINGS_REQUIRED');assert.deepEqual(read(),before);
  for(const body of [{deliveryFeeMinor:1},{delivery_fee_minor:1},{delivery:{deliveryFeeMinor:1}},{minDeliverySubtotalMinor:0}])assert.equal((await f.request(`${root}/profile`,{method:'PATCH',body})).status,400);
  assert.equal((await f.request(`${root}/settings`,{method:'PATCH',body:{deliveryFeeMinor:1}})).status,404);assert.deepEqual(read(),before);
  const contact=await f.request(`${root}/profile`,{method:'PATCH',body:{phone:'01582000000'}});assert.equal(contact.status,200);assert.deepEqual(read(),before);
  const inspected=await f.request(workspace);assert.equal(inspected.status,200);assert.equal(inspected.body.data.restaurant.delivery.deliveryFeeMinor,before.delivery_fee_minor);
  const ownerCookie=await f.login('restaurant@calai.local','LocalRestaurant!4310');
  const configured=await f.json(`/api/restaurant/restaurants/${f.restaurant.id}/delivery`,{method:'PATCH',cookie:ownerCookie,body:{enabled:true,outcodes:['LU1'],deliveryFeeMinor:399,minDeliverySubtotalMinor:100}});assert.equal(configured.status,200,configured.text);assert.equal(configured.body.data.delivery.deliveryFeeMinor,399);
  assert.equal((await f.request(workspace)).body.data.restaurant.delivery.deliveryFeeMinor,399);
  const item=f.db.prepare('SELECT id FROM menu_items WHERE restaurant_id=? LIMIT 1').get(f.restaurant.id),edited=await f.request(`${root}/menu/${item.id}`,{method:'PATCH',body:{name:'Permitted admin menu correction',priceMinor:875}});assert.equal(edited.status,200);assert.equal(edited.body.data.priceMinor,875);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='admin_restaurant_managed' AND json_extract(details,'$.resource')='delivery'").get().n,0);
  assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length,0);
 }finally{await f.close();}
});

test('admin can create, edit and end restaurant-funded marketing without bypassing budgets or tenant item checks',async()=>{
 const f=await setup();try{
  const root=`/api/admin/restaurants/${f.restaurant.id}/manage/loyalty/promotions`,start='2026-01-01T10:00:00.000Z',end='2026-01-08T10:00:00.000Z',body={title:'Admin restaurant offer',message:'Local test only',offerType:'percent_off',campaignType:'percent_order',value:1000,minSubtotalMinor:1000,startsAt:start,expiresAt:end,redemptionLimit:20,budgetMinor:5000,weeklyBudgetMinor:5000,eligibleItemIds:[],eligibleCategories:[],recipientSegment:'first_order',customerIds:[],stackingPolicy:'exclusive',fundingParty:'restaurant'};
  const created=await f.request(root,{method:'POST',body,key:'admin-promotion'});assert.equal(created.status,201,created.error?.stack);const id=created.body.data.id;
  assert.equal(f.db.prepare('SELECT created_by_user_id FROM offer_campaigns WHERE id=?').get(id).created_by_user_id,f.admin.user.id);
  assert.equal((await f.request(root,{method:'POST',body,key:'admin-promotion'})).status,200);
  assert.equal((await f.request(root,{method:'POST',body:{...body,fundingParty:'platform'},key:'bad-funding'})).status,409);
  const changed=await f.request(`${root}/${id}`,{method:'PATCH',body:{title:'Updated restaurant offer'}});assert.equal(changed.status,200);assert.equal(changed.body.data.title,'Updated restaurant offer');
  assert.equal((await f.request(`/api/admin/restaurants/${f.other.id}/manage/loyalty/promotions/${id}`)).status,404);
  const list=await f.request('/api/admin/restaurant-promotions?q=Updated&page=1');assert.equal(list.body.data.items[0].id,id);assert.equal(list.body.data.pagination.total,1);
  assert.equal((await f.request(`${root}/${id}/end`,{method:'POST',body:{}})).status,200);
  assert.equal((await f.request(`/api/admin/restaurants/${f.restaurant.id}/manage/loyalty/promotions/${id}`,{method:'PATCH',body:{title:'Too late'}})).status,409);
 }finally{await f.close();}
});

test('administrator cover removal is explicit, audited and cannot delete another restaurant media through a mismatched reference',async()=>{
 const f=await setup();try{
  const ownerCookie=await f.login('restaurant@calai.local','LocalRestaurant!4310'),otherCookie=await f.login('restaurant2@calai.local','LocalRestaurant2!4310');
  const image={mimeType:'image/png',dataBase64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nXQAAAAASUVORK5CYII='};
  const first=await f.json(`/api/restaurant/restaurants/${f.restaurant.id}/cover`,{method:'POST',cookie:ownerCookie,body:image}),second=await f.json(`/api/restaurant/restaurants/${f.other.id}/cover`,{method:'POST',cookie:otherCookie,body:image});
  assert.equal(first.status,201,first.text);assert.equal(second.status,201,second.text);
  const root=`/api/admin/restaurants/${f.restaurant.id}/manage/cover`,audits=()=>f.db.prepare("SELECT * FROM audit_events WHERE action='admin_restaurant_managed' AND json_extract(details,'$.resource')='cover'").all();
  for(const session of [null,f.owner,f.customer])assert.equal((await f.request(root,{method:'DELETE',session})).status,session?403:401);
  assert.equal((await f.request(root,{method:'POST',body:image})).status,404,'The new administrative capability removes covers; it does not grant cover upload');
  assert.equal((await f.json(`/api/restaurant/restaurants/${f.other.id}/cover`,{method:'DELETE',cookie:ownerCookie})).status,404,'One restaurant owner cannot remove another restaurant cover');
  assert.equal(audits().length,0);
  f.db.prepare('UPDATE restaurants SET cover_media_id=? WHERE id=?').run(second.body.data.id,f.restaurant.id);
  const mismatch=await f.request(root,{method:'DELETE'});assert.equal(mismatch.status,404);
  assert.equal(f.db.prepare('SELECT cover_media_id FROM restaurants WHERE id=?').get(f.restaurant.id).cover_media_id,second.body.data.id,'A mismatched media owner must fail without partially clearing the cover');
  assert.ok(f.db.prepare('SELECT id FROM media_assets WHERE id=?').get(second.body.data.id));assert.equal(audits().length,0);
  f.db.prepare('UPDATE restaurants SET cover_media_id=? WHERE id=?').run(first.body.data.id,f.restaurant.id);
  const removed=await f.request(root,{method:'DELETE'});assert.equal(removed.status,200);assert.equal(removed.body.data.removed,true);
  assert.equal(f.db.prepare('SELECT cover_media_id FROM restaurants WHERE id=?').get(f.restaurant.id).cover_media_id,null);
  assert.equal(f.db.prepare('SELECT id FROM media_assets WHERE id=?').get(first.body.data.id),undefined);
  assert.equal(f.db.prepare('SELECT cover_media_id FROM restaurants WHERE id=?').get(f.other.id).cover_media_id,second.body.data.id);assert.ok(f.db.prepare('SELECT id FROM media_assets WHERE id=?').get(second.body.data.id));
  assert.equal((await f.request(`/api/admin/restaurants/${f.restaurant.id}/workspace`)).body.data.restaurant.coverImageUrl,null);
  const logged=audits();assert.equal(logged.length,1);assert.equal(logged[0].actor_user_id,f.admin.user.id);assert.equal(logged[0].entity_id,f.restaurant.id);assert.deepEqual(JSON.parse(logged[0].details),{method:'DELETE',resource:'cover'});
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{await f.close();}
});
