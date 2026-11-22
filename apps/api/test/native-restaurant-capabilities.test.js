import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {businessFixture} from './unified-business-test-fixture.js';
import {createSession} from '../src/auth/sessions.js';
import {restaurantCapabilities,requireRestaurantCapability,requireRestaurantOwner} from '../src/auth/authorization.js';
import {runBusinessReportEmails} from '../src/business-report-emails.js';

async function fixture(){
 const f=await businessFixture(),created=createSession(f.db,f.owner.id,f.config),cookie='calai_session='+created.token;
 f.db.prepare("UPDATE restaurant_memberships SET permission='staff' WHERE restaurant_id=? AND user_id=?").run(f.restaurant.id,f.owner.id);
 return{...f,cookie,base:'/api/restaurant/restaurants/'+f.restaurant.id,request:async(path,options={})=>{const response=await f.request(path,{...options,cookie});return{...response,body:response.headers.get('content-type')?.includes('application/json')?JSON.parse(response.text):undefined};}};
}

test('native manager flags are independent, current and isolated from owner and source-product authority',async()=>{
 const f=await fixture();try{
  assert.equal(restaurantCapabilities(f.db,f.session,f.restaurant.id).viewOrders,true);
  assert.equal(restaurantCapabilities(f.db,f.session,f.restaurant.id).viewFinance,false);
  for(const capability of ['viewFinance','manageMenu','manageMarketing','viewDevices'])assert.throws(()=>requireRestaurantCapability(f.db,f.session,f.restaurant.id,capability),e=>e.status===403);
  f.db.prepare('UPDATE restaurant_memberships SET can_view_finance=1,can_manage_menu=1,can_manage_marketing=1,can_view_devices=1 WHERE restaurant_id=? AND user_id=?').run(f.restaurant.id,f.owner.id);
  const context=await f.call('/api/business/context');assert.equal(context.status,200,context.text);
  assert.equal(context.body.data.products['cal-eats'].financialAccess,true);assert.equal(context.body.data.products['cal-eats'].capabilities.manageMenu,true);assert.equal(context.body.data.products['cal-eats'].capabilities.viewDevices,true);
  assert.equal(context.body.data.products.calai.financialAccess,false);assert.equal(context.body.data.canViewCalai,false);assert.equal(context.body.data.canConnectProducts,false);assert.equal(context.body.data.products['cal-eats'].capabilities.manageTerminal,false);
  assert.throws(()=>requireRestaurantOwner(f.db,f.session,f.restaurant.id),e=>e.status===403);
  assert.throws(()=>requireRestaurantCapability(f.db,{...f.session,principalKind:'terminal'},f.restaurant.id,'viewFinance'),e=>e.status===403);
  assert.throws(()=>requireRestaurantCapability(f.db,f.otherSession,f.restaurant.id,'viewFinance'),e=>e.status===404);
  const dto=await f.request('/api/restaurant/restaurants');assert.equal(dto.status,200,dto.text);const own=dto.body.data.find(r=>r.id===f.restaurant.id);assert.equal(own.capabilities.viewFinance,true);assert.equal(own.capabilities.manageMenu,true);
  const admin=await f.call('/api/admin/business/accounts/'+f.business.id,{session:f.adminSession});assert.equal(admin.body.data.products['cal-eats'].financialAccess,true);assert.equal(admin.body.data.products.calai.financialAccess,false);
  f.db.prepare('UPDATE restaurant_memberships SET can_view_finance=0,can_manage_menu=0,can_manage_marketing=0,can_view_devices=0 WHERE restaurant_id=? AND user_id=?').run(f.restaurant.id,f.owner.id);
  const revoked=await f.call('/api/business/context');assert.equal(revoked.body.data.products['cal-eats'].financialAccess,false);assert.equal(revoked.body.data.products['cal-eats'].capabilities.manageMenu,false);assert.equal(revoked.body.data.products['cal-eats'].capabilities.viewDevices,false);
 }finally{await f.close();}
});

test('permitted managers can read finance and edit menu/marketing without bank, legal, device or service authority',async()=>{
 const f=await fixture();try{
  const paths=[f.base+'/finance/summary',f.base+'/finance/orders',f.base+'/finance/payouts',f.base+'/finance/statement.csv',f.base+'/dashboard/metrics.csv',f.base+'/finance/stripe/banking',f.base+'/finance/stripe/payouts',f.base+'/loyalty/promotions'];
  for(const path of paths)assert.equal((await f.request(path)).status,403,path);
  f.db.prepare('UPDATE restaurant_memberships SET can_view_finance=1,can_manage_menu=1,can_manage_marketing=1 WHERE restaurant_id=? AND user_id=?').run(f.restaurant.id,f.owner.id);
  for(const path of paths)assert.equal((await f.request(path)).status,200,path);
  const dashboard=await f.request(f.base+'/dashboard');assert.equal(dashboard.status,200,dashboard.text);assert.ok(dashboard.body.data.finance);
  const made=await f.request(f.base+'/menu',{method:'POST',body:{name:'Manager-added test meal',description:'Synthetic test item',priceMinor:500,category:'Test'}});assert.equal(made.status,201,made.text);
  const patched=await f.request(f.base+'/menu/'+made.body.data.id,{method:'PATCH',body:{available:false}});assert.equal(patched.status,200,patched.text);
  const start=f.config.now(),end=new Date(start.getTime()+86400000),campaign=await f.request(f.base+'/loyalty/promotions',{method:'POST',headers:{'Idempotency-Key':'manager-marketing-'+randomUUID()},body:{title:'Manager test offer',message:'Synthetic first order promotion',offerType:'percent_off',campaignType:'percent_order',value:10,minSubtotalMinor:0,startsAt:start.toISOString(),expiresAt:end.toISOString(),redemptionLimit:100,recipientSegment:'first_order',stackingPolicy:'exclusive',fundingParty:'restaurant'}});assert.equal(campaign.status,201,campaign.text);
  const ended=await f.request(f.base+'/loyalty/promotions/'+campaign.body.data.id+'/end',{method:'POST',body:{}});assert.equal(ended.status,200,ended.text);
  for(const [path,method,body]of [[f.base+'/finance/stripe/onboarding','POST',{}],[f.base+'/finance/commission-policy/accept','POST',{}],[f.base+'/loyalty/settings','PATCH',{regularOrderCount:3,regularWindowDays:30,lapsedAfterDays:90}],['/api/business/accounts/'+f.business.id+'/terminals/setup','POST',{}],['/api/business/accounts/'+f.business.id+'/products/cal-eats','PATCH',{active:false}]])assert.equal((await f.request(path,{method,body})).status,403,path);
  f.db.prepare('UPDATE restaurant_memberships SET can_view_finance=0,can_manage_menu=0,can_manage_marketing=0 WHERE restaurant_id=? AND user_id=?').run(f.restaurant.id,f.owner.id);
  assert.equal((await f.request(f.base+'/finance/summary')).status,403);assert.equal((await f.request(f.base+'/menu/'+made.body.data.id,{method:'PATCH',body:{available:true}})).status,403);assert.equal((await f.request(f.base+'/loyalty/promotions')).status,403);
 }finally{await f.close();}
});

test('requested report email revalidates a manager financial grant before delayed delivery',async()=>{
 const f=await fixture();try{
  f.db.prepare('UPDATE restaurant_memberships SET can_view_finance=1 WHERE restaurant_id=? AND user_id=?').run(f.restaurant.id,f.owner.id);
  const response=await f.request('/api/restaurant/report-emails',{method:'POST',headers:{'Idempotency-Key':'manager-report-'+randomUUID()},body:{reportPath:f.base+'/dashboard/metrics.csv?period=today'}});assert.equal(response.status,202,response.text);assert.equal(response.body.data.recipient,f.owner.email);
  f.db.prepare('UPDATE restaurant_memberships SET can_view_finance=0 WHERE restaurant_id=? AND user_id=?').run(f.restaurant.id,f.owner.id);
  let dispatched=0;const result=await runBusinessReportEmails(f.db,f.config,{adapter:async()=>{dispatched++;throw Error('Revoked manager must not receive a report');}});
  assert.equal(dispatched,0);assert.equal(result.cancelled,1);assert.equal(f.db.prepare('SELECT last_error FROM business_report_email_outbox WHERE id=?').get(response.body.data.id).last_error,'REPORT_PERMISSION_CHANGED');
 }finally{await f.close();}
});


test('native staff grants can be edited only by a different current owner or scoped platform administrator',async()=>{
 const f=await businessFixture();try{
  const ownerCookie='calai_session='+createSession(f.db,f.owner.id,f.config).token,staffCookie='calai_session='+createSession(f.db,f.otherOwner.id,f.config).token;
  f.db.prepare("INSERT INTO restaurant_memberships(restaurant_id,user_id,permission,created_at) VALUES(?,?,'staff',?)").run(f.restaurant.id,f.otherOwner.id,f.config.now().toISOString());
  const base='/api/restaurant/restaurants/'+f.restaurant.id,route=base+'/staff/'+f.otherOwner.id+'/capabilities',request=(path,body,cookie=ownerCookie)=>f.json(path,{method:'PATCH',cookie,body});
  for(const body of [{},{viewFinance:1},{permission:'owner'},{manageStaff:true},{role:'admin'},{viewFinance:true,calai:true}])assert.equal((await request(route,body)).status,400);
  assert.equal((await request(base+'/staff/'+f.owner.id+'/capabilities',{viewFinance:false})).status,403);
  assert.equal((await request(route,{viewFinance:true},staffCookie)).status,403);
  let response=await request(route,{viewFinance:true,viewDevices:true,manageMenu:true,manageMarketing:false});assert.equal(response.status,200,response.text);assert.equal(response.body.data.permission,'staff');assert.equal(response.body.data.capabilities.viewFinance,true);assert.equal(response.body.data.capabilities.manageTerminal,false);
  const audit=f.db.prepare("SELECT actor_user_id,details FROM audit_events WHERE action='staff_capabilities_changed' ORDER BY rowid DESC LIMIT 1").get();assert.equal(audit.actor_user_id,f.owner.id);assert.equal(JSON.parse(audit.details).previous.viewFinance,false);assert.equal(JSON.parse(audit.details).current.viewFinance,true);assert.equal(JSON.parse(audit.details).product,'cal-eats');
  f.db.prepare('UPDATE restaurant_memberships SET can_manage_staff=1 WHERE restaurant_id=? AND user_id=?').run(f.restaurant.id,f.otherOwner.id);
  assert.equal((await request(route,{manageMarketing:true},staffCookie)).status,403,'A manager grant cannot edit staff authority');
  const adminCookie='calai_session='+createSession(f.db,f.admin.id,f.config).token;
  response=await request('/api/admin/restaurants/'+f.restaurant.id+'/manage/staff/'+f.otherOwner.id+'/capabilities',{viewFinance:false},adminCookie);assert.equal(response.status,200,response.text);assert.equal(response.body.data.capabilities.viewFinance,false);
  response=await f.json('/api/admin/restaurants/'+f.restaurant.id+'/manage/staff',{cookie:adminCookie});assert.equal(response.status,200,response.text);assert.equal(response.body.data.find(row=>row.id===f.otherOwner.id).capabilities.manageMenu,true);
  assert.equal((await request(base+'/staff/'+randomUUID()+'/capabilities',{viewFinance:true})).status,404);
  assert.equal(f.db.prepare('SELECT permission FROM restaurant_memberships WHERE restaurant_id=? AND user_id=?').get(f.restaurant.id,f.otherOwner.id).permission,'staff');
 }finally{await f.close();}
});


test('menu managers can use visible bulk, ordering and item-photo tools without cover or cross-restaurant access',async()=>{
 const f=await fixture();try{
  f.db.prepare('UPDATE restaurant_memberships SET can_manage_menu=1 WHERE restaurant_id=? AND user_id=?').run(f.restaurant.id,f.owner.id);
  const bulk=await f.request(f.base+'/menu/import',{method:'POST',headers:{'Idempotency-Key':'manager-bulk-'+randomUUID()},body:{items:[{name:'Manager bulk meal',description:'Synthetic item',priceMinor:500,category:'Test',allergens:[],dietaryTags:[],modifierGroups:[]}]}});assert.equal(bulk.status,201,bulk.text);
  const item=bulk.body.data[0],all=f.db.prepare('SELECT id FROM menu_items WHERE restaurant_id=? ORDER BY sort_order').all(f.restaurant.id).map(row=>row.id).reverse();
  assert.equal((await f.request(f.base+'/menu/order',{method:'PUT',body:{itemIds:all}})).status,200);
  const foreign={id:randomUUID()},foreignRestaurant=f.db.prepare('SELECT id FROM restaurants WHERE id<>? LIMIT 1').get(f.restaurant.id),stamp=f.config.now().toISOString();
  f.db.prepare("INSERT INTO menu_items(id,restaurant_id,name,description,price_minor,available,created_at,updated_at) VALUES(?,?,'Foreign menu item','Synthetic isolation fixture',500,1,?,?)").run(foreign.id,foreignRestaurant.id,stamp,stamp);
  assert.equal((await f.request(f.base+'/menu/order',{method:'PUT',body:{itemIds:[...all.slice(1),foreign.id]}})).status,400);
  const image={mimeType:'image/png',dataBase64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nXQAAAAASUVORK5CYII='};
  const uploaded=await f.request(f.base+'/menu/'+item.id+'/photo',{method:'POST',body:image});assert.equal(uploaded.status,201,uploaded.text);
  assert.equal((await f.request(f.base+'/cover',{method:'POST',body:image})).status,403);
  assert.equal((await f.request(f.base+'/menu/'+foreign.id+'/photo',{method:'POST',body:image})).status,404);
  assert.equal((await f.request(f.base+'/menu/'+item.id+'/photo',{method:'DELETE'})).status,200);
  f.db.prepare('UPDATE restaurant_memberships SET can_manage_menu=0 WHERE restaurant_id=? AND user_id=?').run(f.restaurant.id,f.owner.id);
  assert.equal((await f.request(f.base+'/menu/import',{method:'POST',body:{items:[]},headers:{'Idempotency-Key':'revoked-manager-menu'}})).status,403);
  assert.equal((await f.request(f.base+'/menu/'+item.id+'/photo',{method:'POST',body:image})).status,403);
 }finally{await f.close();}
});
