import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {businessFixture} from './unified-business-test-fixture.js';
import {assertBusinessIntakeAllowed,assertBusinessOwnerSettings,businessProductState} from '../src/business-product-policy.js';

test('both cards exist before a second native account and only admin permission changes are audited',async()=>{
 const f=await businessFixture({allowEats:false});try{const before=f.db.prepare('SELECT COUNT(*) n FROM restaurants').get().n;let response=await f.call(`/api/admin/business/accounts/${f.business.id}`,{session:f.adminSession});assert.equal(response.status,200,response.text);assert.equal(response.body.data.products.calai.adminAllowed,false);assert.equal(response.body.data.products['cal-eats'].adminAllowed,false);assert.equal(response.body.data.products.calai.linked,false);response=await f.allow('calai');assert.equal(response.status,200);assert.equal(response.body.data.products.calai.adminAllowed,true);assert.equal(response.body.data.products.calai.linked,false);assert.equal(response.body.data.products.calai.readiness.ready,false);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM restaurants').get().n,before);const audit=f.db.prepare("SELECT actor_user_id,details FROM audit_events WHERE action='business_product_permission_changed' ORDER BY rowid DESC LIMIT 1").get();assert.equal(audit.actor_user_id,f.admin.id);const details=JSON.parse(audit.details);assert.equal(details.previous,false);assert.equal(details.current,true);assert.equal(details.nativeCalaiUnchanged,true);assert.equal((await f.call(`/api/admin/business/accounts/${f.business.id}/products/calai`,{method:'PATCH',body:{allowed:false}})).status,403);}finally{await f.close();}
});

test('administrator disablement during source callback prevents late activation',async()=>{
 const f=await businessFixture();try{await f.allow('calai');const proof=await f.prepare();assert.equal(proof.status,200,proof.text);let disabled=false;f.state.hook=async()=>{if(!disabled){disabled=true;assert.equal((await f.allow('calai',false)).status,200);}};const linked=await f.confirmCalai(proof);assert.equal(linked.status,403,linked.text);assert.equal(linked.body.error.code,'ADMIN_CONNECTION_PERMISSION_REQUIRED');assert.equal(f.db.prepare("SELECT COUNT(*) n FROM business_product_links WHERE product='calai'").get().n,0);assert.equal(f.db.prepare('SELECT consumed_at FROM business_connection_proofs').get().consumed_at,null);}finally{await f.close();}
});

test('proofs cannot cross user, session, restaurant, product or expiry boundaries',async()=>{
 const f=await businessFixture();try{await f.allow('calai');const proof=await f.prepare();assert.equal(proof.status,200);assert.equal((await f.confirmCalai(proof,{session:f.otherSession})).status,404);assert.equal((await f.confirmCalai(proof,{session:f.sessionFor(f.owner)})).status,409);assert.equal((await f.confirmCalai(proof,{id:randomUUID()})).status,404);const crossed=await f.call(`/api/business/accounts/${f.business.id}/cal-eats/link`,{method:'POST',body:{connectionToken:proof.body.data.connectionToken,restaurantId:f.restaurant.id,confirmLocation:true}});assert.equal(crossed.status,409);f.advance(300001);assert.equal((await f.confirmCalai(proof)).status,409);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM business_product_links WHERE product='calai'").get().n,0);}finally{await f.close();}
});

test('colliding native IDs never merge products, native logins or financial authority',async()=>{
 const f=await businessFixture();try{f.state.businessId=f.restaurant.id;f.state.id=f.owner.id;await f.allow('calai');assert.equal((await f.link()).status,200);const links=f.db.prepare('SELECT product,source_account_id FROM business_product_links WHERE business_id=? ORDER BY product').all(f.business.id);assert.equal(links.length,2);assert.equal(links[0].source_account_id,links[1].source_account_id);assert.notEqual(links[0].product,links[1].product);const signed=await f.sourceLogin();assert.equal(signed.status,200,signed.text);assert.notEqual(signed.body.data.user.id,f.owner.id);const context=await f.call('/api/business/context',{session:f.responseSession(signed)});assert.equal(context.body.data.products['cal-eats'].financialAccess,false);assert.equal(context.body.data.products.calai.financialAccess,true);}finally{await f.close();}
});

test('settings cannot smuggle service controls and permission does not mean setup is complete',async()=>{
 const f=await businessFixture();try{for(const key of ['paused','active','enabled','serviceEnabled','integrationEnabled','disable','disabled','unlink','disconnect','resume','pause','calaiEnabled','calEatsEnabled'])assert.throws(()=>assertBusinessOwnerSettings({name:'Unchanged',[key]:true}),error=>error.code==='ADMIN_SERVICE_CONTROL_REQUIRED');assert.doesNotThrow(()=>assertBusinessOwnerSettings({name:'Business',phone:'01234567890'}));f.db.prepare("UPDATE restaurants SET phone='',address='',always_open=0,opening_hours='[]' WHERE id=?").run(f.restaurant.id);const state=businessProductState(f.db,f.business.id,'cal-eats',f.config);assert.equal(state.adminAllowed,true);assert.equal(state.connected,true);assert.equal(state.readiness.ready,false);assert.ok(state.readiness.tasks.some(row=>row.code==='SETUP_CONTACT'));assert.ok(state.readiness.tasks.some(row=>row.code==='SETUP_HOURS'));}finally{await f.close();}
});

test('a revoked real session cannot finish an already verified account connection',async()=>{
 const f=await businessFixture();try{await f.allow('calai');const proof=await f.prepare();assert.equal(proof.status,200);f.db.prepare('UPDATE sessions SET revoked_at=? WHERE id=?').run(f.config.now().toISOString(),f.session.sessionId);assert.equal((await f.confirmCalai(proof)).status,401);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM business_product_links WHERE product='calai'").get().n,0);}finally{await f.close();}
});
test('concurrent confirmations of one verified proof create one connection and one linking outcome',async()=>{
 const f=await businessFixture();try{await f.allow('calai');const proof=await f.prepare();assert.equal(proof.status,200);let arrivals=0,release;const barrier=new Promise(resolve=>{release=resolve;});f.state.hook=async()=>{if(++arrivals===2)release();await barrier;};const results=await Promise.all([f.confirmCalai(proof),f.confirmCalai(proof)]);assert.ok(results.every(row=>row.status===200),JSON.stringify(results));assert.equal(f.db.prepare("SELECT COUNT(*) n FROM business_product_links WHERE business_id=? AND product='calai'").get(f.business.id).n,1);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='calai_business_linked' AND entity_id=?").get(f.business.id).n,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM business_connection_proofs WHERE consumed_at IS NOT NULL').get().n,1);}finally{await f.close();}
});

test('dashboard cannot publish a prepared response after the human account is disabled during a source read',async()=>{
 const f=await businessFixture();try{
  await f.allow('calai');assert.equal((await f.link()).status,200);
  f.state.readHook=()=>{f.db.prepare('UPDATE users SET account_enabled=0 WHERE id=?').run(f.owner.id);};
  const response=await f.call('/api/business/dashboard');
  assert.equal(response.status,403,response.text);
  assert.equal(response.body.data,undefined);
 }finally{await f.close();}
});

test('dashboard rechecks the live session and individual product scopes after awaited reads',async()=>{
 for(const mode of ['revoked_session','removed_eats_membership','removed_calai_authority']){
  const f=await businessFixture();try{
   await f.allow('calai');assert.equal((await f.link()).status,200);
   f.state.readHook=()=>{
    if(mode==='revoked_session')f.db.prepare('UPDATE sessions SET revoked_at=? WHERE id=?').run(f.config.now().toISOString(),f.session.sessionId);
    if(mode==='removed_eats_membership')f.db.prepare('DELETE FROM restaurant_memberships WHERE restaurant_id=? AND user_id=?').run(f.restaurant.id,f.owner.id);
    if(mode==='removed_calai_authority')f.db.prepare("DELETE FROM business_product_authorities WHERE business_id=? AND product='calai' AND user_id=?").run(f.business.id,f.owner.id);
   };
   const response=await f.call('/api/business/dashboard');
   if(mode==='revoked_session'){assert.equal(response.status,401,response.text);assert.equal(response.body.data,undefined);}
   else{
    assert.equal(response.status,200,response.text);const product=mode==='removed_eats_membership'?'cal-eats':'calai';
    assert.equal(response.body.data.business.products[product].financialAccess,false);
    assert.equal(response.body.data.counts[product].available,false);
    assert.equal(response.body.data.counts[product].today,null);
    assert.equal(response.body.data.orders.some(row=>row.source===product),false);
   }
  }finally{await f.close();}
 }
});

test('administrator permission alone cannot admit new orders before required restaurant setup',async()=>{
 const f=await businessFixture();try{
  f.db.prepare("UPDATE restaurants SET phone='',address='',always_open=0,opening_hours='[]' WHERE id=?").run(f.restaurant.id);
  assert.equal(businessProductState(f.db,f.business.id,'cal-eats',f.config).adminAllowed,true);
  assert.equal(businessProductState(f.db,f.business.id,'cal-eats',f.config).connected,true);
  assert.equal(businessProductState(f.db,f.business.id,'cal-eats',f.config).readiness.ready,false);
  assert.throws(()=>assertBusinessIntakeAllowed(f.db,f.restaurant.id,f.config),error=>error.status===409);
 }finally{await f.close();}
});


test('an Eats-only tablet issuer cannot delegate Calai records and revoked source proof removes tablet access immediately',async()=>{
 const f=await businessFixture();try{
  await f.allow('calai');assert.equal((await f.link()).status,200);
  const now=f.config.now().toISOString(),terminalId=randomUUID(),operatorId=randomUUID(),grantHash='synthetic-source-scope-grant';
  f.db.prepare("INSERT INTO restaurant_memberships(restaurant_id,user_id,permission,created_at) VALUES(?,?,'owner',?)").run(f.restaurant.id,f.otherOwner.id,now);
  f.db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at,principal_kind) VALUES(?,?,?,?,'restaurant',?,'terminal')").run(operatorId,'Scoped tablet',operatorId+'@terminal.invalid','!terminal',now);
  f.db.prepare("INSERT INTO business_account_memberships(business_id,user_id,permission,created_at) VALUES(?,?,'staff',?)").run(f.business.id,operatorId,now);
  f.db.prepare("INSERT INTO restaurant_memberships(restaurant_id,user_id,permission,created_at) VALUES(?,?,'staff',?)").run(f.restaurant.id,operatorId,now);
  f.db.prepare('INSERT INTO business_terminals(id,business_id,operator_user_id,name,public_key_spki,public_key_sha256,registered_by,registered_at) VALUES(?,?,?,?,?,?,?,?)').run(terminalId,f.business.id,operatorId,'Scoped tablet','synthetic-public-key','synthetic-hash',f.otherOwner.id,now);
  f.db.prepare('INSERT INTO business_terminal_grants VALUES(?,?,?,?,?,NULL)').run(grantHash,terminalId,operatorId,now,new Date(f.config.now().getTime()+600000).toISOString());
  const session={principalKind:'terminal',businessId:f.business.id,terminalId,terminalGrantHash:grantHash,calaiReadAuthorized:true,user:{id:operatorId,role:'restaurant'}};
  let context=await f.call('/api/business/context',{session});assert.equal(context.body.data.canViewEats,true);assert.equal(context.body.data.canViewCalai,false);assert.equal((await f.call('/api/business/calai/orders',{session})).status,403);
  f.db.prepare('UPDATE business_terminals SET registered_by=? WHERE id=?').run(f.owner.id,terminalId);
  context=await f.call('/api/business/context',{session});assert.equal(context.body.data.canViewCalai,true);assert.equal((await f.call('/api/business/calai/orders',{session})).status,200);assert.equal((await f.call('/api/business/calai/analytics',{session})).status,403);
  f.db.prepare("DELETE FROM business_product_authorities WHERE business_id=? AND product='calai' AND user_id=?").run(f.business.id,f.owner.id);
  context=await f.call('/api/business/context',{session});assert.equal(context.body.data.canViewCalai,false);assert.equal((await f.call('/api/business/calai/orders',{session})).status,403);assert.equal(context.body.data.products['cal-eats'].financialAccess,false);
 }finally{await f.close();}
});


test('daily Eats dashboard counts all current orders but returns at most one hundred rows across London DST boundaries',async()=>{
 const f=await businessFixture();try{
  const customer=f.db.prepare("SELECT id FROM users WHERE role='customer' LIMIT 1").get(),foreign=f.db.prepare('SELECT id,name FROM restaurants WHERE id<>? LIMIT 1').get(f.restaurant.id);
  const insert=f.db.prepare("INSERT INTO orders(id,restaurant_id,restaurant_name,customer_id,status,subtotal_minor,total_minor,commission_minor,payment_method,payment_status,fulfillment,idempotency_key,request_hash,created_at,updated_at) VALUES(?,?,?,?,'placed',100,100,7,'cash','cash_due','collection',?,?,?,?)");
  const add=(at,restaurant=f.restaurant)=>{const id=randomUUID();insert.run(id,restaurant.id,restaurant.name,customer.id,id,'synthetic-daily-range',at,at);return id;};
  f.advance(Date.parse('2031-03-30T12:00:00.000Z')-f.config.now().getTime());
  for(let n=0;n<121;n++)add(new Date(Date.parse('2031-03-30T12:00:00.000Z')+n*1000).toISOString());
  for(let n=0;n<300;n++)add(new Date(Date.parse('2031-03-28T12:00:00.000Z')+n*1000).toISOString());
  const springStart=add('2031-03-30T00:00:00.000Z'),springEnd=add('2031-03-30T22:59:59.999Z');
  const outside=[add('2031-03-29T23:59:59.999Z'),add('2031-03-30T23:00:00.000Z'),add('2031-03-30T12:00:00.000Z',foreign)];
  let response=await f.call('/api/business/dashboard',{session:f.sessionFor(f.owner)});assert.equal(response.status,200,response.text);assert.equal(response.body.data.counts['cal-eats'].today,123);assert.equal(response.body.data.orders.length,100);assert.equal(response.body.data.orders[0].sourceOrderId,springEnd);assert.equal(response.body.data.orders.some(row=>outside.includes(row.sourceOrderId)),false);assert.equal(response.body.data.orders.some(row=>row.sourceOrderId===springStart),false,'Oldest current row is outside the bounded recent window, not outside the count');
  f.advance(Date.parse('2031-10-26T12:00:00.000Z')-f.config.now().getTime());
  const autumn=[add('2031-10-25T23:00:00.000Z'),add('2031-10-26T00:30:00.000Z'),add('2031-10-26T01:30:00.000Z'),add('2031-10-26T23:59:59.999Z')];
  add('2031-10-25T22:59:59.999Z');add('2031-10-27T00:00:00.000Z');
  response=await f.call('/api/business/dashboard',{session:f.sessionFor(f.owner)});assert.equal(response.status,200,response.text);assert.equal(response.body.data.counts['cal-eats'].today,4);assert.deepEqual(response.body.data.orders.map(row=>row.sourceOrderId).sort(),autumn.sort());
 }finally{await f.close();}
});
