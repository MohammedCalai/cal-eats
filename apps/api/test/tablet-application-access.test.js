import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,sign} from 'node:crypto';
import {Readable} from 'node:stream';
import {createServer} from 'node:http';
import {createApp} from '../src/app.js';
import {tabletModeWatch} from '../src/tablet-mode-watch.js';
import {DatabaseSync} from 'node:sqlite';
import {businessFixture} from './unified-business-test-fixture.js';
import {enrolRegisteredTablet} from './registered-tablet-fixture.js';
import {routeTabletFleet} from '../src/tablet-fleet.js';
import {tabletProductMigration73} from '../src/tablet-product-migration.js';
import {tabletApplicationProducts} from '../src/tablet-product-policy.js';
import {pairingCanonical} from '../../terminal-auth/src/protocol.js';
import {assertBusinessIntakeAllowed} from '../src/business-product-policy.js';
import {ensureBusinessForRestaurant} from '../src/unified-business.js';

async function fixture(t, options){
  const f=await businessFixture(options);t.after(()=>f.close());
  const adminCookie=await f.login('admin@calai.local','LocalAdmin!4310');
  const secured=await f.json('/api/auth/password',{method:'POST',cookie:adminCookie,body:{currentPassword:'LocalAdmin!4310',newPassword:'SecureTabletProducts!4310'}});assert.equal(secured.status,200,secured.text);
  Object.assign(f.adminSession,f.sessionFor(f.admin));
  const adminSession=f.adminSession,ownerCookie=await f.login('restaurant@calai.local','LocalRestaurant!4310');
  async function fleet(path='',{method='GET',body,session=adminSession,directoryReader,installerBuilder}={}){
    const target='/api/admin/tablets'+path,req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);Object.assign(req,{method,url:target,headers:{origin:f.config.origin,...(body===undefined?{}:{'content-type':'application/json'})}});
    let result;const res={writeHead(status,headers){result={status,headers};},end(value){result={...result,text:String(value??'')};}};
    try{const handled=await routeTabletFleet({req,res,url:new URL(target,f.config.origin),db:f.db,config:f.config,session,directoryReader,installerBuilder});if(!handled&&!result)result={status:404,text:'{}'};}catch(error){result={status:error.status??500,text:JSON.stringify({error:{code:error.code,message:error.message}})};}
    return{...result,body:result.headers?.['Content-Type']==='application/octet-stream'?null:JSON.parse(result.text)};
  }
  return{...f,fleet,adminSession,ownerCookie};
}

test('additive application policy preserves existing defaults and intersects product rights without changing native records',()=>{
  const db=new DatabaseSync(':memory:');try{
    db.exec('CREATE TABLE admin_tablets(id TEXT PRIMARY KEY,terminal_id TEXT,business_id TEXT,archived_at TEXT);');db.exec("INSERT INTO admin_tablets VALUES('tablet','terminal','business',NULL)");db.exec(tabletProductMigration73.sql);
    const products={calai:{active:false,linked:true},'cal-eats':{active:true,linked:true}};
    assert.deepEqual(db.prepare('SELECT application_products FROM admin_tablets').get().application_products,null);
    assert.equal(tabletApplicationProducts(db,'terminal','business',products)['cal-eats'].active,true);
    db.prepare("UPDATE admin_tablets SET application_products='calai'").run();
    const scoped=tabletApplicationProducts(db,'terminal','business',products);assert.equal(scoped.calai.active,false,'A tablet selection never enables a globally unavailable product');assert.equal(scoped['cal-eats'].active,false);assert.equal(scoped['cal-eats'].nativeLinked,true);assert.deepEqual(products['cal-eats'],{active:true,linked:true});
    assert.equal(tabletApplicationProducts(db,'terminal','other-business',products)['cal-eats'].active,true,'An unrelated assignment is not applied to another identity');
    assert.throws(()=>db.prepare("UPDATE admin_tablets SET application_products='admin'").run(),/CHECK constraint/);
  }finally{db.close();}
});

test('real directory read is admin-only, bounded, rechecks authority, and assignment never enrols or grants an account',async t=>{
  const f=await fixture(t),managedId=randomUUID(),entraId=randomUUID(),items=Array.from({length:23},(_,i)=>({intuneManagedDeviceId:i===0?managedId:randomUUID(),entraDeviceId:i===0?entraId:randomUUID(),serialNumber:'SYNTHETIC-'+i,displayName:'Directory tablet '+i,manufacturer:'Microsoft',model:'Surface Go',lastContactAt:f.config.now().toISOString()}));
  let reads=0;const directoryReader=async()=>{reads++;return{items,complete:false,truncated:true,collectedAt:f.config.now().toISOString(),source:'microsoft_graph'};};
  for(const session of[f.session,null,{...f.adminSession,nativeAudience:'business'}]){const result=await f.fleet('/directory',{session,directoryReader});assert.ok([401,403].includes(result.status));}assert.equal(reads,0);
  const page=await f.fleet('/directory?page=2&pageSize=20',{directoryReader});assert.equal(page.status,200,page.text);assert.equal(page.body.data.items.length,3);assert.equal(page.body.data.complete,false);assert.equal(page.body.data.truncated,true);assert.equal(page.body.data.pagination.total,23);assert.equal(page.headers['Cache-Control'],'private, no-store');
  const before=f.db.prepare('SELECT COUNT(*) n FROM business_terminals').get().n,businessBefore=f.db.prepare('SELECT * FROM business_product_permissions ORDER BY business_id,product').all(),record=await f.fleet('/directory/'+managedId,{method:'POST',body:{displayName:'Kitchen Surface',businessId:f.business.id,applicationProducts:'cal-eats'},directoryReader});
  assert.equal(record.status,201,record.text);assert.equal(record.body.data.applicationProducts,'cal-eats');assert.equal(record.body.data.mapping.intuneManagedDeviceId,managedId);assert.equal(record.body.data.mapping.entraDeviceId,entraId);assert.equal(record.body.data.registration,null);assert.equal(record.body.data.applicationAccess.paired,false);assert.equal(record.body.data.applicationAccess.windowsStartupChanged,false);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM business_terminals').get().n,before);assert.deepEqual(f.db.prepare('SELECT * FROM business_product_permissions ORDER BY business_id,product').all(),businessBefore);
  assert.equal((await f.fleet('/directory/'+randomUUID(),{method:'POST',body:{displayName:'Invented',businessId:f.business.id,applicationProducts:'cal-eats'},directoryReader})).status,404);
  assert.equal((await f.fleet('/directory/'+managedId,{method:'POST',body:{displayName:'Duplicate',businessId:f.business.id,applicationProducts:'cal-eats'},directoryReader})).status,409);
  assert.equal((await f.fleet('/directory/'+items[1].intuneManagedDeviceId,{method:'POST',body:{displayName:'No rights',businessId:f.business.id,applicationProducts:'both'},directoryReader})).body.error.code,'TABLET_PRODUCT_NOT_READY');
  const linked=await f.fleet('/directory',{directoryReader});assert.equal(linked.body.data.items[0].fleetRecord.id,record.body.data.id);
  assert.equal((await f.fleet('/directory',{directoryReader:async()=>{f.db.prepare('UPDATE sessions SET revoked_at=? WHERE id=?').run(f.config.now().toISOString(),f.adminSession.sessionId);return{items:[],complete:true};}})).status,401);
});

test('device product command is atomic, refreshes valid grant scope, preserves live fulfilment and cannot bypass scope, proof or quarantine',async t=>{
  const f=await fixture(t);assert.equal((await f.allow('calai')).status,200);assert.equal((await f.link()).status,200);
  const tablet=await enrolRegisteredTablet(f,{ownerCookie:f.ownerCookie}),id=tablet.terminalId;
  const original=(await f.fleet('/'+id)).body.data,permissions=f.db.prepare('SELECT * FROM business_product_permissions ORDER BY business_id,product').all();
  const change=(mode,expectedRevision=original.revision,extra={})=>f.fleet('/'+id+'/configuration',{method:'POST',body:{expectedRevision,displayName:'Kitchen tablet',businessId:f.business.id,applicationProducts:mode,...extra}});
  assert.equal((await f.fleet('/'+id+'/configuration',{method:'POST',session:f.session,body:{expectedRevision:1,displayName:'Owner cannot change policy',businessId:f.business.id,applicationProducts:'calai'}})).status,403);
  const first=await change('cal-eats');assert.equal(first.status,200,first.text);assert.equal(first.body.data.applicationProducts,'cal-eats');assert.equal((await tablet.json('/api/auth/me')).status,200,'An existing valid grant receives fresh scope without a manual reconnect');
  let context=(await tablet.json('/api/business/context')).body.data;assert.equal(context.products.calai.linked,false);assert.equal(context.products.calai.nativeLinked,true);assert.equal(context.products['cal-eats'].linked,true);assert.equal((await tablet.json('/api/business/calai/orders')).status,403);
  const receiptPath=`/api/business/accounts/${f.business.id}/surface/heartbeat`,receipt=revision=>tablet.json(receiptPath,{method:'POST',body:{state:'configuration_received',configurationTabletId:id,configurationRevision:revision}});
  assert.equal(context.tabletConfiguration.status,'waiting_for_tablet');assert.equal(context.tabletConfiguration.revision,2);
  assert.equal((await f.json(receiptPath,{method:'POST',cookie:f.ownerCookie,body:{state:'configuration_received',configurationTabletId:id,configurationRevision:2}})).status,403,'A human account cannot acknowledge a tablet configuration');
  assert.equal((await tablet.json(receiptPath,{method:'POST',body:{state:'configuration_received',configurationTabletId:id,configurationRevision:2,applied:true}})).status,400);
  const staleRow=(await f.fleet('',{method:'POST',body:{displayName:'Another tablet row',businessId:f.business.id}})).body.data;assert.equal((await f.fleet('/'+staleRow.id,{method:'PATCH',body:{expectedRevision:1,displayName:'Another tablet row revision two'}})).status,200);
  assert.equal((await tablet.json(receiptPath,{method:'POST',body:{state:'configuration_received',configurationTabletId:staleRow.id,configurationRevision:2}})).status,409,'Another tablet row at the same revision cannot be acknowledged');
  const received=await receipt(2);assert.equal(received.status,200,received.text);assert.equal(received.body.data.tabletConfiguration.status,'received');f.advance(1000);assert.equal((await receipt(2)).body.data.tabletConfiguration.receivedAt,received.body.data.tabletConfiguration.receivedAt);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM tablet_application_receipts').get().n,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM surface_application_presence').get().n,0,'Configuration receipt is not ordering application presence');
  assert.equal((await f.call('/api/business/calai/orders')).status,200,'Legitimate remote human owner access stays separate');
  const concurrent=await Promise.all([change('both',2),change('cal-eats',2)]);assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='tablet_application_access_updated'").get().n,2);
  assert.equal((await receipt(2)).status,409,'A previous revision cannot acknowledge a newer selection');assert.equal((await tablet.json('/api/business/context')).body.data.tabletConfiguration.status,'waiting_for_tablet');
  let record=(await f.fleet('/'+id)).body.data;
  const customer=f.db.prepare("SELECT id FROM users WHERE role='customer' LIMIT 1").get().id,order=randomUUID(),at=f.config.now().toISOString();
  f.db.prepare("INSERT INTO orders(id,restaurant_id,restaurant_name,customer_id,status,currency,subtotal_minor,total_minor,commission_minor,payment_method,payment_status,fulfillment,idempotency_key,request_hash,created_at,updated_at) VALUES(?,?,?,?,'accepted','GBP',400,400,28,'mock_card','paid','collection',?,?,?,?)").run(order,f.restaurant.id,f.restaurant.name,customer,randomUUID(),'SYNTHETIC_TEST',at,at);
  for(const status of['placed','accepted','preparing','ready','out_for_delivery']){f.db.prepare('UPDATE orders SET status=? WHERE id=?').run(status,order);assert.equal((await change('calai',record.revision)).body.error.code,'TABLET_ACTIVE_ORDERS',status);}
  assert.equal((await change('both',record.revision,{businessId:randomUUID()})).status,404);assert.equal((await change('both',record.revision,{terminalId:randomUUID()})).status,400);
  f.db.prepare("UPDATE orders SET status='completed' WHERE id=?").run(order);
  const root=`/api/restaurant/restaurants/${f.restaurant.id}/printers`,printerResult=await f.json(root,{method:'POST',cookie:f.ownerCookie,body:{name:'Synthetic kitchen printer',enabled:true}});assert.equal(printerResult.status,201,printerResult.text);const printer=printerResult.body.data;
  const code=await f.json(`${root}/${printer.id}/pairing-code`,{method:'POST',cookie:f.ownerCookie,body:{}}),paired=await f.json('/api/devices/pair',{method:'POST',body:{code:code.body.data.code,name:'Synthetic printer transport'}});assert.equal(paired.status,201,paired.text);const deviceHeaders={authorization:'Bearer '+paired.body.data.token},claim=()=>f.json('/api/devices/jobs/claim',{method:'POST',headers:deviceHeaders,body:{}});
  assert.equal((await f.json('/api/devices/heartbeat',{method:'POST',headers:deviceHeaders,body:{printerReachable:true,transport:'tcp-escpos'}})).status,200);
  const pending=await tablet.json(`${root}/${printer.id}/test-receipt`,{method:'POST',body:{requestId:randomUUID()}});assert.equal(pending.status,201,pending.text);assert.equal((await change('calai',record.revision)).body.error.code,'TABLET_PRINT_JOBS_PENDING');
  const dispatched=(await claim()).body.data.job;assert.equal(dispatched.id,pending.body.data.id);const acknowledge=()=>f.json(`/api/devices/jobs/${dispatched.id}/ack`,{method:'POST',headers:deviceHeaders,body:{claimToken:dispatched.claimToken,outcome:'uncertain'}});assert.equal((await acknowledge()).status,200);
  const switched=await change('calai',record.revision);assert.equal(switched.status,200,switched.text);await tablet.session();
  context=(await tablet.json('/api/business/context')).body.data;assert.equal(context.products['cal-eats'].linked,false);assert.equal(context.canViewEats,false);assert.equal((await tablet.json('/api/restaurant/orders/pending-confirmation')).status,403);assert.equal((await tablet.json(`/api/restaurant/orders/${order}/status`,{method:'PATCH',body:{status:'completed'}})).status,403);assert.equal((await tablet.json('/api/business/calai/orders')).status,200);
  assert.throws(()=>assertBusinessIntakeAllowed(f.db,f.restaurant.id,f.config),error=>error.code==='TABLET_PRODUCT_INACTIVE','Checkout rechecks active tablet mode instead of accepting new Eats work after mode removal');
  assert.deepEqual(f.db.prepare('SELECT * FROM business_product_permissions ORDER BY business_id,product').all(),permissions);
  const otherRestaurantId=f.db.prepare('SELECT id FROM restaurants WHERE id<>?').get(f.restaurant.id).id;
  f.db.prepare("UPDATE restaurants SET status='approved',collection_enabled=1 WHERE id=?").run(otherRestaurantId);
  f.db.prepare("INSERT INTO menu_items(id,restaurant_id,name,description,price_minor,available,created_at,updated_at,category,allergens,dietary_tags,modifier_groups) SELECT ?,?,name,description,price_minor,available,created_at,updated_at,category,allergens,dietary_tags,modifier_groups FROM menu_items WHERE restaurant_id=? LIMIT 1").run(randomUUID(),otherRestaurantId,f.restaurant.id);
  const otherBusiness=ensureBusinessForRestaurant(f.db,otherRestaurantId,f.config);
  f.db.prepare("UPDATE business_product_permissions SET allowed=1 WHERE business_id=? AND product='cal-eats'").run(otherBusiness.id);
  const customerCookie=await f.login('customer@calai.local','LocalCustomer!4310');
  const listings=await f.json('/api/restaurants?fulfillment=delivery',{cookie:customerCookie});
  assert.equal(listings.status,200,listings.text);
  const blockedListing=listings.body.data.find(row=>row.id===f.restaurant.id),availableListing=listings.body.data.find(row=>row.id===otherRestaurantId);
  assert.equal(blockedListing.acceptingOrders,false);
  assert.equal(blockedListing.schedulingAvailable,false);
  assert.equal(blockedListing.closedReason,'Not taking orders right now');
  assert.equal(availableListing.acceptingOrders,true,'One tablet selection must not hide another restaurant');
  assert.doesNotMatch(listings.text,/tablet/i,'Customer browse never exposes tablet setup details');
  const menu=await f.json(`/api/restaurants/${f.restaurant.id}/menu`,{cookie:customerCookie});
  assert.equal(menu.status,200,menu.text);
  assert.equal(menu.body.data.restaurant.acceptingOrders,false);
  assert.doesNotMatch(menu.text,/tablet/i);
  const item=f.db.prepare('SELECT id FROM menu_items WHERE restaurant_id=? LIMIT 1').get(f.restaurant.id);
  const orderBody={restaurantId:f.restaurant.id,items:[{menuItemId:item.id,quantity:1}],fulfillment:'collection'};
  const quote=await f.json('/api/orders/quote',{method:'POST',cookie:customerCookie,body:orderBody});
  assert.equal(quote.status,409,quote.text);
  assert.equal(quote.body.error.code,'TABLET_PRODUCT_INACTIVE');
  assert.doesNotMatch(quote.body.error.message,/tablet/i,'Checkout reports customer-safe wording');
  const checkout=await f.json('/api/orders',{method:'POST',cookie:customerCookie,headers:{'Idempotency-Key':'blocked-tablet-mode-customer'},body:{...orderBody,paymentMethod:'mock_card'}});
  assert.equal(checkout.status,409,checkout.text);
  assert.equal(checkout.body.error.code,'TABLET_PRODUCT_INACTIVE');
  assert.doesNotMatch(checkout.body.error.message,/tablet/i);
  assert.equal(context.eatsRestaurantId,f.restaurant.id);assert.equal((await receipt(context.tabletConfiguration.revision)).body.error.code,'CALAI_WORKSPACE_REQUIRED','The Eats workspace cannot acknowledge the original Calai display');
  f.db.prepare("INSERT INTO device_print_jobs(id,printer_id,order_id,operation_key,receipt,status,created_at,updated_at) VALUES(?,?,?,?,?,'queued',?,?)").run(randomUUID(),printer.id,order,randomUUID(),JSON.stringify({testReceipt:true}),at,at);
  assert.equal((await claim()).body.data.job,null,'A delayed Eats job cannot dispatch after the active tablet excludes Eats');assert.equal((await acknowledge()).status,200,'Existing acknowledgements can still reconcile after a mode switch');
  f.db.prepare("DELETE FROM business_product_authorities WHERE business_id=? AND product='calai'").run(f.business.id);assert.equal((await tablet.json('/api/business/calai/orders')).status,403,'Device mode never creates native owner proof');
  const enabledAgain=await change('cal-eats',switched.body.data.revision);assert.equal(enabledAgain.status,200,enabledAgain.text);const reenabled=(await tablet.json('/api/business/context')).body.data;assert.equal(reenabled.products['cal-eats'].allowedOnTablet,true);assert.equal((await tablet.json('/api/restaurant/orders/pending-confirmation')).status,200,'A grant created during Calai-only retains native location identity for later Eats activation');
  record=(await f.fleet('/'+id)).body.data;const revoked=await f.fleet('/'+id+'/disable',{method:'POST',body:{expectedRevision:record.revision,reason:'Retire the synthetic test tablet'}});assert.equal(revoked.status,200,revoked.text);assert.equal((await change('cal-eats',revoked.body.data.revision)).body.error.code,'TABLET_HANDOFF_PENDING');assert.equal((await tablet.json('/api/auth/me')).status,403);
});

test('opening Calai requires the exact authorised tablet and current Calai-only assignment', async t => {
  const f = await fixture(t);
  assert.equal((await f.allow('calai')).status, 200);
  assert.equal((await f.link({ session: f.adminSession })).status, 200);
  const tablet = await enrolRegisteredTablet(f, { ownerCookie: f.ownerCookie });
  const { terminalId } = tablet;
  const route = '/api/business/accounts/' + f.business.id + '/surface/heartbeat';
  const configure = async (mode, expectedRevision) => {
    const result = await f.fleet('/' + terminalId + '/configuration', { method: 'POST', body: {
      expectedRevision, displayName: 'Kitchen tablet', businessId: f.business.id, applicationProducts: mode
    } });
    assert.equal(result.status, 200, result.text);
    return result.body.data.revision;
  };
  const body = (revision, extra = {}) => ({
    state: 'open_calai', configurationTabletId: terminalId, configurationRevision: revision, ...extra
  });
  const openCalai = data => tablet.json(route, { method: 'POST', body: data });
  const receiptCount = () => f.db.prepare('SELECT COUNT(*) n FROM tablet_application_receipts').get().n;

  const both = await configure('both', 1);
  assert.equal((await openCalai(body(both))).body.error.code, 'TABLET_CONFIGURATION_CHANGED');
  const watch = {method:'POST',body:{state:'watch_configuration'}};
  assert.equal((await f.json(route,{...watch,cookie:f.ownerCookie})).status,403,'An owner browser cannot subscribe as the tablet');
  const issued = await tablet.json(route,watch);
  assert.equal(issued.status,200,issued.text);
  assert.equal(issued.body.data.tabletConfiguration.revision,both);
  const wait = {method:'POST',body:{ticket:issued.body.data.ticket}};
  const additional = await tablet.json(route,watch);
  const server = createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  const host = '127.0.0.1:'+server.address().port, origin='http://'+host;
  server.on('request',createApp({db:f.db,config:{...f.config,expectedHost:host,origin}}));
  const socketWait = fetch(origin+'/api/business/tablet-mode-watch',{
    method:'POST',headers:{'content-type':'application/json',Origin:origin},
    body:JSON.stringify({ticket:additional.body.data.ticket}),signal:AbortSignal.timeout(7000)
  });
  const deadline=Date.now()+5000, hub=tabletModeWatch(f.db);
  while (!hub.listening(terminalId) && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(hub.listening(terminalId),true,'The real server accepted the outstanding device-specific wake request');
  const current = await configure('calai', both);
  assert.deepEqual(await (await socketWait).json(),{data:{check:true}},'A real connected socket wakes after the administrative Save commits');
  const wake = await f.json('/api/business/tablet-mode-watch',wait);
  assert.deepEqual(wake.body,{data:{check:true}},'A committed Save before the listener attaches still wakes it, with no mode or user data');
  assert.equal((await f.json('/api/business/tablet-mode-watch',wait)).status,403,'The wake ticket works once');
  assert.equal((await tablet.json(route,watch)).body.data.tabletConfiguration.revision,current);
  const unsigned = await f.json(route, { method: 'POST', cookie: f.ownerCookie, body: body(current) });
  assert.equal(unsigned.status, 403);
  assert.equal((await openCalai(body(both))).body.error.code, 'TABLET_CONFIGURATION_CHANGED');
  assert.equal((await openCalai(body(current, { configurationTabletId: randomUUID() }))).body.error.code, 'TABLET_CONFIGURATION_CHANGED');
  assert.equal((await openCalai(body(current, { destination: 'https://example.invalid' }))).status, 400);
  assert.equal((await openCalai(body(current))).body.error.code, 'CALAI_AUTHORITY_REQUIRED');
  assert.equal(receiptCount(), 0);

  assert.equal((await f.link()).status, 200);
  const approval = await f.json('/api/business/accounts/' + f.business.id + '/terminals/calai-authorization', {
    method: 'POST', cookie: f.ownerCookie, body: { expectedTerminalId: terminalId },
  });
  assert.equal(approval.status, 200, approval.text);
  const currentContext = (await tablet.json('/api/business/context')).body.data;
  const rendered = body(current,{state:'calai_rendered',nativeAccountId:currentContext.products.calai.sourceAccountId});
  const first = tablet.options(route, { method: 'POST', body: body(current) });
  const allowed = await f.json(route, first);
  assert.equal(allowed.status, 200, allowed.text);
  assert.equal(allowed.headers.get('cache-control'), 'private, no-store');
  assert.equal(allowed.headers.has('set-cookie'), false);
  assert.equal(allowed.body.data.tabletConfiguration.receivedAt,null,'Opening sign-in cannot confirm the native business display');
  assert.equal((await openCalai({...rendered,nativeAccountId:'another-restaurant'})).body.error.code,'CALAI_ACCOUNT_MISMATCH');
  const actual = await openCalai(rendered);
  assert.deepEqual(actual.body, { data: { tabletConfiguration: {
    tabletId: terminalId, revision: current, selection: 'calai', status: 'received',
    receivedAt: f.config.now().toISOString()
  } } });
  assert.equal((await f.json(route, first)).body.error.code, 'TERMINAL_REQUEST_REPLAYED');
  f.advance(1000);
  assert.deepEqual((await openCalai(rendered)).body, actual.body, 'The current receipt is idempotent');
  assert.equal(receiptCount(), 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM surface_application_presence').get().n, 0);

  assert.equal((await f.allow('calai', false)).status, 200);
  assert.equal((await openCalai(body(current))).body.error.code, 'TABLET_PRODUCT_NOT_READY');
  assert.equal((await f.allow('calai', true)).status, 200);
  const calaiLink = f.db.prepare("UPDATE business_product_links SET status=? WHERE business_id=? AND product='calai'");
  calaiLink.run('inactive', f.business.id);
  assert.equal((await openCalai(body(current))).body.error.code, 'TABLET_PRODUCT_NOT_READY');
  calaiLink.run('active', f.business.id);
  const other = await f.call('/api/business/context', { session: f.otherSession });
  assert.equal(other.status, 200, other.text);
  const move = await f.fleet('/' + terminalId + '/reassign', { method: 'POST', body: {
    expectedRevision: current, businessId: other.body.data.id,
    confirmQuarantine: true, reason: 'Move the synthetic test Surface'
  } });
  assert.equal(move.status, 200, move.text);
  assert.equal((await openCalai(body(current))).status, 403);
  assert.equal(receiptCount(), 1);
});

test('native Both launches only for the designated tablet and records a receipt only after presentation', async t => {
  const tabletId = randomUUID(), f = await fixture(t, {nativeBothTabletId: tabletId});
  assert.equal((await f.allow('calai')).status, 200);
  assert.equal((await f.link()).status, 200);
  const tablet = await enrolRegisteredTablet(f, {ownerCookie: f.ownerCookie});
  const route = '/api/business/accounts/' + f.business.id + '/surface/heartbeat';
  const configure = async (id, expectedRevision) => {
    const result = await f.fleet('/' + id + '/configuration', {method:'POST',body:{
      expectedRevision, displayName:'Kitchen tablet', businessId:f.business.id, applicationProducts:'both'
    }});
    assert.equal(result.status, 200, result.text);
    return result.body.data.revision;
  };
  const revision = await configure(tablet.terminalId, 1);
  const body = (state, id=tabletId) => ({state, configurationTabletId:id, configurationRevision:revision});
  const send = (state, id) => tablet.json(route, {method:'POST',body:body(state, id)});
  const count = () => f.db.prepare('SELECT COUNT(*) n FROM tablet_application_receipts').get().n;
  assert.equal((await send('open_both', tablet.terminalId)).body.error.code, 'TABLET_CONFIGURATION_CHANGED');
  assert.equal((await tablet.json('/api/business/context')).body.data.nativeBothLaunch, undefined);
  // Inventory identity and signed terminal identity can be distinct.
  f.db.prepare('UPDATE admin_tablets SET id=? WHERE terminal_id=?').run(tabletId, tablet.terminalId);
  const oldReceivedAt = f.config.now().toISOString();
  f.db.prepare('INSERT INTO tablet_application_receipts VALUES(?,?,?,?,?)').run(tabletId,revision,tablet.terminalId,f.business.id,oldReceivedAt);
  f.advance(1000);
  const currentContext=(await tablet.json('/api/business/context')).body.data;
  assert.equal(currentContext.nativeBothLaunch, true);
  assert.equal(currentContext.tabletConfiguration.receivedAt, null, 'An existing standalone receipt does not prove native presentation');
  assert.equal((await f.json('/api/business/context', {cookie:f.ownerCookie})).body.data.nativeBothLaunch, undefined);
  assert.equal((await f.json(route, {method:'POST',cookie:f.ownerCookie,body:body('both_rendered')})).status, 403);
  assert.equal((await send('configuration_received')).body.error.code, 'COMBINED_WORKSPACE_REQUIRED');
  const launch = await send('open_both');
  assert.equal(launch.status, 200, launch.text);
  assert.equal(launch.body.data.tabletConfiguration.receivedAt, null);
  assert.equal(count(), 1);
  const stale = await tablet.json(route, {method:'POST',body:{...body('both_rendered'),configurationRevision:revision-1}});
  assert.equal(stale.body.error.code, 'TABLET_CONFIGURATION_CHANGED');
  const rendered=await send('both_rendered');assert.equal(rendered.status, 200, rendered.text);
  assert.notEqual(rendered.body.data.tabletConfiguration.receivedAt,oldReceivedAt);
  assert.deepEqual((await send('both_rendered')).body, rendered.body);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='native_both_rendered'").get().n,1);
  assert.equal(count(), 1);
  assert.equal((await f.allow('calai', false)).status, 200);
  assert.equal((await send('open_both')).body.error.code, 'TABLET_PRODUCT_NOT_READY');
  assert.equal((await send('both_rendered')).body.error.code, 'TABLET_PRODUCT_NOT_READY');
});

function signedPair(document){const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),publicKeySpki=keys.publicKey.export({type:'spki',format:'der'}).toString('base64');return{terminalId:document.terminalId,code:document.code,deviceName:'Synthetic physical tablet',publicKeySpki,challengeSignature:sign('sha256',Buffer.from(pairingCanonical({...document,publicKeySpki})),{key:keys.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url')};}

test('existing registration and delayed signed pairing recheck mode readiness and active work before activating a saved selection',async t=>{
 const f=await fixture(t);assert.equal((await f.allow('calai')).status,200);assert.equal((await f.link()).status,200);
 const tablet=await enrolRegisteredTablet(f,{ownerCookie:f.ownerCookie}),record=(await f.fleet('',{method:'POST',body:{displayName:'Unpaired physical Surface',businessId:f.business.id,serialNumber:'LATE-ACTIVATION-001'}})).body.data;
 const configured=await f.fleet('/'+record.id+'/configuration',{method:'POST',body:{expectedRevision:1,displayName:record.displayName,businessId:f.business.id,applicationProducts:'calai'}});assert.equal(configured.status,200,configured.text);
 const setup=await f.fleet('/'+record.id+'/enrolment',{method:'POST',body:{expectedRevision:2,confirmReplaceTerminalId:tablet.terminalId}});assert.equal(setup.status,201,setup.text);
 const order=randomUUID(),customer=f.db.prepare("SELECT id FROM users WHERE role='customer' LIMIT 1").get().id,at=f.config.now().toISOString();f.db.prepare("INSERT INTO orders(id,restaurant_id,restaurant_name,customer_id,status,currency,subtotal_minor,total_minor,commission_minor,payment_method,payment_status,fulfillment,idempotency_key,request_hash,created_at,updated_at) VALUES(?,?,?,?,'accepted','GBP',400,400,28,'mock_card','paid','collection',?,?,?,?)").run(order,f.restaurant.id,f.restaurant.name,customer,randomUUID(),'SYNTHETIC_LATE_ORDER',at,at);
 const link=()=>f.fleet('/'+record.id+'/registration',{method:'POST',body:{expectedRevision:2,terminalId:tablet.terminalId,confirmSamePhysicalDevice:true}}),body=signedPair(setup.body.data.enrolment),pair=()=>f.json('/api/terminal-devices/pair',{method:'POST',body});
 assert.equal((await link()).body.error.code,'TABLET_ACTIVE_ORDERS');assert.equal((await pair()).body.error.code,'TABLET_ACTIVE_ORDERS');assert.equal(f.db.prepare('SELECT revoked_at FROM business_terminals WHERE id=?').get(tablet.terminalId).revoked_at,null);assert.equal(f.db.prepare('SELECT consumed_at FROM business_terminal_pairings WHERE terminal_id=?').get(body.terminalId).consumed_at,null);
 f.db.prepare("UPDATE orders SET status='completed' WHERE id=?").run(order);assert.equal((await f.allow('calai',false)).status,200);assert.equal((await link()).body.error.code,'TABLET_PRODUCT_NOT_READY');assert.equal((await pair()).body.error.code,'TABLET_PRODUCT_NOT_READY');assert.equal((await f.allow('calai',true)).status,200);
 const completed=await pair();assert.equal(completed.status,201,completed.text);assert.ok(f.db.prepare('SELECT revoked_at FROM business_terminals WHERE id=?').get(tablet.terminalId).revoked_at);assert.equal((await f.fleet('/'+record.id)).body.data.registration.terminalId,body.terminalId);
});

test('first-connection package is private, serial-bound, rollback-safe and supports genuinely verified Calai-only business without a stub Eats account',async t=>{
 const f=await fixture(t);f.config.origin='https://eats.calai.info';t.mock.method(Date,'now',()=>f.config.now().getTime());
 const source=await f.registerSource({allowed:true}),record=(await f.fleet('',{method:'POST',body:{displayName:'Calai-only Surface',businessId:source.id,serialNumber:'CALAI-ONLY-001'}})).body.data,restaurants=f.db.prepare('SELECT COUNT(*) n FROM restaurants').get().n;
 const download=(options={})=>f.fleet('/'+record.id+'/setup-package',{method:'POST',body:{expectedRevision:1,confirmReplaceTerminalId:null},...options});
 assert.equal((await download()).body.error.code,'TABLET_PAIRED_SETUP_NOT_READY','A native reference and admin permission do not create native owner proof');assert.equal((await f.link({id:source.id,session:f.adminSession})).status,200);
 let row=(await f.fleet('/'+record.id)).body.data;assert.equal(row.business.eatsRestaurantId,null);assert.equal(row.actions.canDownloadPairedSetup,true);
 const before=f.db.prepare('SELECT COUNT(*) n FROM business_terminal_pairings').get().n,audits=f.db.prepare('SELECT COUNT(*) n FROM audit_events').get().n;
 assert.equal((await download({installerBuilder(){throw Error('SYNTHETIC_BUILD_FAILURE');}})).status,500);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM business_terminal_pairings').get().n,before);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM audit_events').get().n,audits);
 const packageResult=await download();assert.equal(packageResult.status,200,packageResult.text);assert.equal(packageResult.headers['Cache-Control'],'private, no-store');assert.match(packageResult.headers['Content-Disposition'],/attachment; filename="CalEats-Tablet-Setup.ps1"/);
 const encoded=packageResult.text.match(/\$TerminalEmbeddedEnrolmentBase64='([^']+)'/)?.[1];assert.ok(encoded);const setup=JSON.parse(Buffer.from(encoded,'base64').toString('utf8'));assert.equal(setup.businessId,source.id);assert.equal(Object.keys(setup).length,8);assert.ok(packageResult.text.includes("$TerminalBoundSerial='CALAI-ONLY-001'"));assert.equal(JSON.stringify(f.db.prepare('SELECT details FROM audit_events').all()).includes(setup.code),false);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM restaurants').get().n,restaurants);assert.equal((await f.fleet('/'+record.id)).body.data.registration,null,'Download alone is not signed pairing');
 const paired=await f.json('/api/terminal-devices/pair',{method:'POST',body:signedPair(setup)});assert.equal(paired.status,201,paired.text);assert.equal((await download()).body.error.code,'TABLET_REVISION_CHANGED');row=(await f.fleet('/'+record.id)).body.data;assert.equal(row.actions.canDownloadPairedSetup,false);assert.equal(row.business.eatsRestaurantId,null);
});
