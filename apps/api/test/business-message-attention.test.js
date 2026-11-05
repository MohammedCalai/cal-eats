import assert from "node:assert/strict";
import test from "node:test";
import {randomUUID} from "node:crypto";
import {journeyFixture} from "./helpers.js";
import {addNotification} from "../src/offers.js";
import {migrateDatabase} from "../src/db/index.js";
import {restaurantMessageArrivalRevision} from "../src/business-message-attention.js";

test("business message attention uses actual scoped read cursors and a recipient arrival revision",async()=>{
  let clock=Date.parse("2026-01-01T01:00:00.000Z");
  const f=await journeyFixture({now:()=>new Date(clock),rateLimit:{attempts:120,windowMs:60000}});
  try{
    const owner=await f.login("restaurant@calai.local","LocalRestaurant!4310"),customer=await f.login("customer@calai.local","LocalCustomer!4310"),other=await f.login("restaurant2@calai.local","LocalRestaurant2!4310"),admin=await f.login("admin@calai.local","LocalAdmin!4310");
    const restaurant=(await f.json("/api/restaurant/restaurants",{cookie:owner})).body.data[0],foreign=(await f.json("/api/restaurant/restaurants",{cookie:other})).body.data[0],base=`/api/restaurant/restaurants/${restaurant.id}`,endpoint=`${base}/message-attention`;
    const staffCreated=await f.json(`${base}/staff`,{method:"POST",cookie:owner,body:{name:"Message staff",email:"message-staff@example.invalid",password:"MessageStaff!4310"}});assert.equal(staffCreated.status,201,staffCreated.text);
    const staff=await f.login("message-staff@example.invalid","MessageStaff!4310");
    const attention=async(cookie=owner)=>{const response=await f.json(endpoint,{cookie});assert.equal(response.status,200,response.text);return response.body.data;};
    assert.deepEqual(await attention(),{restaurantId:restaurant.id,unreadCount:0,revision:0});
    assert.equal((await f.json(endpoint)).status,401);assert.equal((await f.json(endpoint,{cookie:customer})).status,403);assert.equal((await f.json(endpoint,{cookie:admin})).status,403);assert.equal((await f.json(endpoint,{cookie:other})).status,404);
    const item=(await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0];
    const placed=await f.json("/api/orders",{method:"POST",cookie:customer,headers:{"Idempotency-Key":"attention-order"},body:{restaurantId:restaurant.id,items:[{menuItemId:item.id,quantity:1}],fulfillment:"collection",paymentMethod:"mock_card"}});assert.equal(placed.status,201,placed.text);
    const order=placed.body.data;
    const send=async(key)=>{clock+=1000;const response=await f.json(`/api/orders/${order.id}/messages`,{method:"POST",cookie:customer,headers:{"Idempotency-Key":key},body:{message:"Please check my order."}});assert.equal(response.status,201,response.text);return response.body.data;};
    const first=await send("attention-message-first"),initial=await attention();
    assert.equal(initial.unreadCount,1);assert.ok(initial.revision>0);assert.equal((await attention(staff)).unreadCount,1);
    const ownerUser=f.db.prepare("SELECT id FROM users WHERE email='restaurant@calai.local'").get(),otherUser=f.db.prepare("SELECT id FROM users WHERE email='restaurant2@calai.local'").get(),staffUser=f.db.prepare("SELECT id FROM users WHERE email='message-staff@example.invalid'").get();
    const notice=(userId,restaurantId,type)=>{const eventKey=`attention:${randomUUID()}`;addNotification(f.db,{userId,restaurantId,type,title:"Metadata only",message:"No conversation was opened.",eventKey,now:f.config.now().toISOString()});return f.db.prepare("SELECT id FROM user_notifications WHERE event_key=? AND user_id=?").get(eventKey,userId).id;};
    notice(otherUser.id,foreign.id,"order_message");notice(ownerUser.id,foreign.id,"order_message");notice(ownerUser.id,restaurant.id,"support_request");
    assert.deepEqual(await attention(),initial,"Other accounts, restaurants and support alerts do not change this message revision");
    const notification=f.db.prepare("SELECT id FROM user_notifications WHERE user_id=? AND event_key=?").get(ownerUser.id,`order-message:${first.id}`);
    assert.equal((await f.json(`/api/notifications/${notification.id}`,{method:"PATCH",cookie:owner,body:{read:true}})).status,200);
    assert.deepEqual(await attention(),initial,"Dismissing a notification does not read the actual customer message");
    const read=await f.json(`/api/orders/${order.id}/messages/read`,{method:"POST",cookie:owner,body:{lastMessageId:first.id}});assert.equal(read.status,200,read.text);
    assert.equal(read.body.data.viewerUserId,ownerUser.id);assert.equal(read.body.data.restaurantId,restaurant.id);assert.equal(read.body.data.messageAttentionRevision,initial.revision);
    assert.deepEqual(await attention(),{...initial,unreadCount:0});assert.equal((await attention(staff)).unreadCount,1,"Read cursors belong to each staff account");
    const second=await send("attention-message-second"),updated=await attention();assert.equal(updated.unreadCount,1);assert.ok(updated.revision>initial.revision);
    const staleRead=await f.json(`/api/orders/${order.id}/messages/read`,{method:"POST",cookie:owner,body:{lastMessageId:first.id}});
    assert.equal(staleRead.body.data.messageAttentionRevision,updated.revision,"A successful read carries the server's current backlog barrier even when the client observed an older revision");assert.equal(staleRead.body.data.unreadCount,1);
    assert.equal((await f.json(`/api/orders/${order.id}/messages/read`,{method:"POST",cookie:owner,body:{lastMessageId:second.id}})).status,200);
    for(const status of["accepted","preparing","ready","completed"])assert.equal((await f.json(`/api/restaurant/orders/${order.id}/status`,{method:"PATCH",cookie:owner,body:{status}})).status,200);
    const path=`${base}/customers/${order.customerId}/conversation`,started=await f.json(path,{method:"POST",cookie:owner,headers:{"Idempotency-Key":"attention-crm-start"},body:{message:"How can we help?"}});assert.equal(started.status,201,started.text);
    const staffBeforeCrm=await attention(staff);clock+=1000;
    const reply=await f.json(`/api/customer/conversations/${started.body.data.threadId}/messages`,{method:"POST",cookie:customer,headers:{"Idempotency-Key":"attention-crm-reply"},body:{message:"Please follow up with me."}});assert.equal(reply.status,201,reply.text);
    const crm=await attention();assert.equal(crm.unreadCount,1);assert.ok(crm.revision>updated.revision);
    notice(staffUser.id,restaurant.id,"customer_message");assert.deepEqual(await attention(staff),staffBeforeCrm,"Staff neither count nor re-arm for owner-only CRM messages");
    const crmRead=await f.json(`${path}/read`,{method:"POST",cookie:owner,body:{lastMessageId:reply.body.data.id}});assert.equal(crmRead.status,200);
    assert.equal(crmRead.body.data.viewerUserId,ownerUser.id);assert.equal(crmRead.body.data.restaurantId,restaurant.id);assert.equal(crmRead.body.data.messageAttentionRevision,crm.revision);
    assert.deepEqual(await attention(),{...crm,unreadCount:0});
    clock+=3*60*60*1000;
    assert.equal((await attention(staff)).unreadCount,0,"A closed support window cannot prompt for an unread chat that can no longer be opened");
    const closedRead=await f.json(`/api/orders/${order.id}/messages/read`,{method:"POST",cookie:staff,body:{lastMessageId:second.id}});assert.equal(closedRead.status,410);
    const historical=(await f.json(`${base}/dashboard?view=operations`,{cookie:staff})).body.data;
    assert.equal(historical.operations.unreadMessages,2,"Operational/history badges keep their existing unread semantics");
    f.db.prepare("UPDATE order_messages SET expires_at=? WHERE order_id=?").run(new Date(clock-1).toISOString(),order.id);
    assert.equal((await attention(staff)).unreadCount,0,"Expired message notifications must not keep the reminder active");
    const dashboard=(await f.json(`${base}/dashboard?view=operations`,{cookie:owner})).body.data;
    assert.equal(dashboard.operations.unreadMessages,(await attention()).unreadCount);
    const removed=notice(ownerUser.id,restaurant.id,"order_message"),highWater=(await attention()).revision;
    f.db.prepare("DELETE FROM user_notifications WHERE id=?").run(removed);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM business_message_arrivals WHERE notification_id=?").get(removed).n,0);
    f.db.exec("VACUUM");
    notice(ownerUser.id,restaurant.id,"order_message");
    assert.ok((await attention()).revision>highWater,"Deletion and VACUUM must not reuse an acknowledged arrival sequence");
  }finally{await f.close();}
});

test("message arrival migration backfills business recipients in original arrival order, including read notifications",async()=>{
  const f=await journeyFixture();
  try{
    const owner=f.db.prepare("SELECT id FROM users WHERE email='restaurant@calai.local'").get(),customer=f.db.prepare("SELECT id FROM users WHERE email='customer@calai.local'").get(),restaurant=f.db.prepare("SELECT restaurant_id FROM restaurant_memberships WHERE user_id=?").get(owner.id).restaurant_id;
    f.db.exec("DROP TRIGGER business_message_arrival_insert; DROP TABLE business_message_arrivals; DELETE FROM schema_migrations WHERE version=41");
    const insert=(userId,type,key)=>addNotification(f.db,{userId,restaurantId:restaurant,type,title:"Historical message",message:"Existing notification",eventKey:key,now:"2026-01-01T00:00:00.000Z"});
    insert(owner.id,"customer_message","arrival-history-first");insert(customer.id,"order_message","arrival-customer-excluded");insert(owner.id,"support_request","arrival-support-excluded");insert(owner.id,"order_message","arrival-history-second");
    f.db.prepare("UPDATE user_notifications SET read_at='2026-01-01T01:00:00.000Z' WHERE event_key='arrival-history-first'").run();
    migrateDatabase(f.db);
    const rows=f.db.prepare("SELECT a.sequence,n.event_key FROM business_message_arrivals a JOIN user_notifications n ON n.id=a.notification_id ORDER BY a.sequence").all();
    assert.deepEqual(rows.map(row=>row.event_key),["arrival-history-first","arrival-history-second"]);assert.ok(rows[1].sequence>rows[0].sequence);
    assert.equal(restaurantMessageArrivalRevision(f.db,restaurant,owner.id),rows[1].sequence);assert.equal(restaurantMessageArrivalRevision(f.db,restaurant,customer.id),0);
    assert.equal(f.db.prepare("PRAGMA foreign_key_check").get(),undefined);
  }finally{await f.close();}
});
