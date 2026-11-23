import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {EventEmitter} from "node:events";
import {Readable} from "node:stream";
import {journeyFixture} from "./helpers.js";
import {routeOffers} from "../src/offers.js";
import {notificationStreamHub} from "../src/notification-stream.js";

async function deliveryFixture(){
  const f=await journeyFixture({now:()=>new Date("2031-01-01T10:00:00.000Z")});
  const ownerCookie=await f.login("restaurant@calai.local","LocalRestaurant!4310"),adminCookie=await f.login("admin@calai.local","LocalAdmin!4310"),customerCookie=await f.login("customer@calai.local","LocalCustomer!4310");
  const owner=f.db.prepare("SELECT * FROM users WHERE email='restaurant@calai.local'").get(),admin=f.db.prepare("SELECT * FROM users WHERE role='admin'").get(),customer=f.db.prepare("SELECT * FROM users WHERE email='customer@calai.local'").get(),restaurant=f.db.prepare("SELECT r.* FROM restaurants r JOIN restaurant_memberships m ON m.restaurant_id=r.id WHERE m.user_id=?").get(owner.id),at=f.config.now().toISOString();
  const menu=f.db.prepare("SELECT id FROM menu_items WHERE restaurant_id=? AND available=1 LIMIT 1").get(restaurant.id);
  const orderResponse=await f.json("/api/orders",{cookie:customerCookie,method:"POST",headers:{"Idempotency-Key":"notification-surface-order"},body:{restaurantId:restaurant.id,fulfillment:"collection",paymentMethod:"mock_card",items:[{menuItemId:menu.id,quantity:1}]}});
  assert.equal(orderResponse.status,201,orderResponse.text);const orderId=orderResponse.body.data.id;
  f.db.prepare("DELETE FROM user_notifications").run();
  const add=(user,type,{restaurantId=restaurant.id,eventKey,order=null}={})=>{const id=randomUUID();f.db.prepare("INSERT INTO user_notifications(id,user_id,type,title,message,restaurant_id,event_key,order_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id,user.id,type,type,"Synthetic test notification",restaurantId,eventKey??`surface-test:${id}`,order,at);return id;};
  function incident(kind){const id=randomUUID();f.db.prepare("INSERT INTO business_device_incidents(id,restaurant_id,terminal_id,fault_code,severity,status,title,message,first_observed_at,last_observed_at,kind) VALUES(?,?,?,?,'warning','active','Test incident','Synthetic only',?,?,?)").run(id,restaurant.id,"synthetic-terminal",`test-${kind}`,at,at,kind);return id;}
  const surface=incident("surface"),printer=incident("printer");
  const health=new Map();for(const user of [owner,admin])health.set(user.id,[add(user,"surface_incident",{eventKey:`monitoring:${surface}:opened`}),add(user,"printer_incident",{eventKey:`monitoring:${printer}:opened`}),add(user,"device_incident",{eventKey:`device-incident:${printer}:opened`})]);
  const ownerMessage=add(owner,"order_message",{order:orderId}),ownerSupport=add(owner,"support_request"),ownerOrder=add(owner,"new_order",{order:orderId}),adminSupport=add(admin,"support_request"),platform=add(admin,"platform_monitoring",{restaurantId:null,eventKey:`platform-monitoring:${randomUUID()}`}),customerUpdate=add(customer,"order_status",{order:orderId});
  const normal={owner:[ownerMessage,ownerSupport,ownerOrder],admin:[adminSupport,platform],customer:[customerUpdate]};
  const web=user=>({user,sessionId:f.db.prepare("SELECT id FROM sessions WHERE user_id=? AND revoked_at IS NULL").get(user.id).id});
  const native=user=>{const id=randomUUID(),table=user.role==="admin"?"native_platform_sessions":"native_business_sessions";f.db.prepare(`INSERT INTO ${table}(id,user_id,token_hash,created_at,expires_at) VALUES(?,?,?,?,?)`).run(id,user.id,id,at,"2031-01-02T10:00:00.000Z");return{user,sessionId:id,native:true,nativeAudience:user.role==="admin"?"platform-admin":"business"};};
  async function inbox(session,path="/api/notifications"){let result;const res={writeHead(status){result={status};},end(body){result.body=JSON.parse(body);}};await routeOffers({req:{method:"GET"},res,url:new URL(path,f.config.origin),db:f.db,config:f.config,session});return result;}
  async function mark(session,id){const req=Readable.from([Buffer.from(JSON.stringify({read:true}))]);Object.assign(req,{method:"PATCH",headers:{"content-type":"application/json"}});let result;const res={writeHead(status){result={status};},end(body){result.body=JSON.parse(body);}};try{await routeOffers({req,res,url:new URL(`/api/notifications/${id}`,f.config.origin),db:f.db,config:f.config,session});return result;}catch(error){return{status:error.status};}}
  return{...f,owner,admin,customer,restaurant,ownerCookie,adminCookie,customerCookie,normal,health,add,web,native,inbox,mark,surface,printer};
}

test("web business and system-admin inboxes omit device health from rows, pagination and all unread counts; native managers retain it",async()=>{
  const f=await deliveryFixture();try{
    for(const [user,cookie,key,messageCount] of [[f.owner,f.ownerCookie,"owner",1],[f.admin,f.adminCookie,"admin",0],[f.customer,f.customerCookie,"customer",0]]){
      const response=await f.json("/api/notifications?native=true&nativeAudience=business&includeDeviceHealth=true",{cookie});assert.equal(response.status,200,response.text);
      assert.deepEqual(new Set(response.body.data.items.map(row=>row.id)),new Set(f.normal[key]));
      assert.equal(response.body.data.unreadCount,f.normal[key].length);assert.equal(response.body.data.unreadMessageCount,messageCount);
      const first=await f.json("/api/notifications?limit=1",{cookie});assert.equal(first.body.data.items.length,1);
      if(f.normal[key].length>1){assert.ok(first.body.data.nextCursor);const page=await f.json(`/api/notifications?limit=1&${new URLSearchParams(first.body.data.nextCursor)}`,{cookie});assert.equal(page.body.data.items.length,1);assert.ok(!f.health.get(user.id).includes(page.body.data.items[0].id));}
    }
    for(const user of [f.owner,f.admin]){
      const native=f.native(user),data=(await f.inbox(native)).body.data;assert.equal(data.unreadCount,f.normal[user===f.owner?"owner":"admin"].length+3);for(const id of f.health.get(user.id))assert.ok(data.items.some(row=>row.id===id));
      const hiddenId=f.health.get(user.id)[0];assert.equal((await f.mark(f.web(user),hiddenId)).status,404);assert.equal(f.db.prepare("SELECT read_at FROM user_notifications WHERE id=?").get(hiddenId).read_at,null);assert.equal((await f.mark(native,hiddenId)).status,200);
    }
    assert.equal((await f.json("/api/notifications")).status,401);
  }finally{await f.close();}
});

test("web SSE excludes health during initial replay, reconnect and live fan-out while native streams and platform monitoring stay intact",async()=>{
  const f=await deliveryFixture();let hub;try{
    hub=notificationStreamHub(f.db,{now:f.config.now,pollMs:60000,heartbeatMs:60000});
    function subscribe(session,lastEventId){const req=new EventEmitter(),res=new EventEmitter(),chunks=[];Object.assign(res,{writeHead(){},flushHeaders(){},write(chunk){chunks.push(String(chunk));return true;},end(){}});hub.subscribe({req,res,userId:session.user.id,sessionId:session.sessionId,native:session.native,nativeAudience:session.nativeAudience,lastEventId});return{req,ids:()=>[...chunks.join("").matchAll(/^id: (.+)$/gm)].map(match=>match[1])};}
    const ownerWeb=subscribe(f.web(f.owner)),ownerNative=subscribe(f.native(f.owner)),adminWeb=subscribe(f.web(f.admin)),adminNative=subscribe(f.native(f.admin));
    for(const [web,native,user,key] of [[ownerWeb,ownerNative,f.owner,"owner"],[adminWeb,adminNative,f.admin,"admin"]]){assert.deepEqual(new Set(web.ids()),new Set(f.normal[key]));for(const id of f.health.get(user.id))assert.ok(native.ids().includes(id));}
    const hidden=f.add(f.owner,"printer_incident",{eventKey:`monitoring:${f.printer}:reminder`}),visible=f.add(f.owner,"support_reply");hub.poll();assert.ok(!ownerWeb.ids().includes(hidden));assert.ok(ownerWeb.ids().includes(visible));assert.ok(ownerNative.ids().includes(hidden));
    ownerWeb.req.emit("close");const replay=subscribe(f.web(f.owner),f.health.get(f.owner.id)[0]);hub.poll();assert.ok(replay.ids().includes(visible));for(const id of [...f.health.get(f.owner.id),hidden])assert.ok(!replay.ids().includes(id));
    assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(),[]);
  }finally{hub?.close();await f.close();}
});
