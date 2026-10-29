import assert from "node:assert/strict";
import test from "node:test";
import { journeyFixture } from "./helpers.js";
import { customerOrderHistoryCutoff, customerOrderIsVisible, enforceCustomerOrderHistory } from "../src/customer-order-history.js";
import { linkOrderHelpToPlatform } from "../src/support-cases.js";
import { buildCustomerEmail, runCustomerTransactionalEmails } from "../src/customer-emails.js";

const NOW=new Date("2026-01-01T01:00:00.000Z");
async function setup(){
  const f=await journeyFixture({now:()=>NOW,orderAlertEmail:{mode:"local",from:"caleats-support@calai.info"}});
  const customer=await f.login("customer@calai.local","LocalCustomer!4310"),owner=await f.login("restaurant@calai.local","LocalRestaurant!4310"),admin=await f.login("admin@calai.local","LocalAdmin!4310"),other=await f.login("restaurant2@calai.local","LocalRestaurant2!4310");
  const restaurant=(await f.json("/api/restaurant/restaurants",{cookie:owner})).body.data[0],item=(await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0];let n=0;
  return {...f,customer,owner,admin,other,restaurant,async place(){const result=await f.json("/api/orders",{method:"POST",cookie:customer,headers:{"Idempotency-Key":`history-support-order-${n++}`},body:{restaurantId:restaurant.id,items:[{menuItemId:item.id,quantity:1}],paymentMethod:"mock_card",fulfillment:"collection"}});assert.equal(result.status,201,result.text);return result.body.data;}};
}

test("90-day customer window is strict at the cutoff while active orders stay visible",()=>{
  const cutoff=customerOrderHistoryCutoff(NOW),at=Date.parse(cutoff);
  assert.equal(customerOrderIsVisible({status:"completed",created_at:new Date(at-1).toISOString()},NOW),false);
  assert.equal(customerOrderIsVisible({status:"completed",created_at:cutoff},NOW),false);
  assert.equal(customerOrderIsVisible({status:"completed",created_at:new Date(at+1).toISOString()},NOW),true);
  assert.equal(customerOrderIsVisible({status:"preparing",created_at:"2020-01-01T00:00:00.000Z"},NOW),true);
});

test("customer history lists and saved order/case URLs enforce the same window, preserving business/admin retention",async()=>{
  const f=await setup();try{
    const old=await f.place(),recent=await f.place(),active=await f.place();
    const opened=await f.json("/api/refund-cases",{method:"POST",cookie:f.customer,body:{orderId:old.id,reason:"other",description:"Original help request"}});assert.equal(opened.status,201,opened.text);
    const cutoff=customerOrderHistoryCutoff(NOW);
    f.db.prepare("UPDATE orders SET created_at=?,status='completed' WHERE id=?").run(cutoff,old.id);
    f.db.prepare("UPDATE orders SET created_at=?,status='completed' WHERE id=?").run(new Date(Date.parse(cutoff)+1).toISOString(),recent.id);
    f.db.prepare("UPDATE orders SET created_at='2020-01-01T00:00:00.000Z',status='preparing' WHERE id=?").run(active.id);
    const orders=(await f.json("/api/orders",{cookie:f.customer})).body.data;assert.deepEqual(new Set(orders.map(o=>o.id)),new Set([recent.id,active.id]));
    const user={id:old.customerId,role:"customer"};
    for(const path of [`/api/orders/${old.id}`,`/api/orders/${old.id}/receipt`,`/api/orders/${old.id}/checkout`,`/api/orders/${old.id}/payment/refresh`,`/api/orders/${old.id}/messages`,`/api/refund-cases/${opened.body.data.id}`,`/api/refund-cases/${opened.body.data.id}/evidence/x`,`/api/refund-cases/${opened.body.data.id}/proposals/p/respond`])assert.throws(()=>enforceCustomerOrderHistory({url:new URL(path,"http://local"),db:f.db,config:f.config,session:{user}}),e=>e.status===404);
    assert.equal((await f.json(`/api/orders/${old.id}`,{cookie:f.customer})).status,404);
    assert.equal((await f.json(`/api/orders/${old.id}/receipt`,{cookie:f.customer})).status,404);
    assert.equal((await f.json(`/api/refund-cases/${opened.body.data.id}`,{cookie:f.customer})).status,404);
    assert.equal((await f.json("/api/refund-cases",{cookie:f.customer})).body.data.items.length,0);
    assert.equal((await f.json(`/api/orders/${old.id}`,{cookie:f.owner})).status,200);
    assert.equal((await f.json(`/api/orders/${old.id}`,{cookie:f.admin})).status,200);
    assert.equal((await f.json(`/api/orders/${old.id}`,{cookie:f.other})).status,404);
    assert.equal((await f.json("/api/refund-cases",{method:"POST",cookie:f.customer,body:{orderId:old.id,reason:"quality",description:"Too old"}})).status,404);
  }finally{await f.close();}
});

test("order help creates one linked platform conversation and one support mailbox email without replacing restaurant remedy",async()=>{
  const f=await setup();try{
    const order=await f.place(),request={method:"POST",cookie:f.customer,body:{orderId:order.id,reason:"missing_items",description:"Private missing item details"}};
    const created=await f.json("/api/refund-cases",request);assert.equal(created.status,201,created.text);const refundCase=created.body.data;
    assert.equal(refundCase.status,"awaiting_restaurant");assert.equal(refundCase.supportCaseId,refundCase.id);
    const listed=await f.json("/api/admin/support?page=1&assignedTo=platform",{cookie:f.admin});assert.equal(listed.body.data.total,1);assert.equal(listed.body.data.items[0].refundCaseId,refundCase.id);
    const support=(await f.json(`/api/support/${refundCase.supportCaseId}`,{cookie:f.admin})).body.data;assert.equal(support.message,request.body.description);assert.equal(support.assignedTo,"platform");
    assert.equal((await f.json(`/api/support/${support.id}`,{cookie:f.owner})).status,404);assert.equal((await f.json(`/api/support/${support.id}`,{cookie:f.other})).status,404);
    const rawCase=f.db.prepare("SELECT * FROM refund_cases WHERE id=?").get(refundCase.id),rawOrder=f.db.prepare("SELECT * FROM orders WHERE id=?").get(order.id);
    linkOrderHelpToPlatform(f.db,rawCase,rawOrder,NOW.toISOString());
    const rows=f.db.prepare("SELECT * FROM customer_transactional_email_outbox WHERE support_case_id=?").all(support.id);assert.equal(rows.length,1);assert.equal(rows[0].recipient,"support@calai.info");
    const mail=buildCustomerEmail(rows[0],f.config);assert.ok(mail.text.includes(`/business/admin/support?case=${support.id}`));assert.equal(mail.text.includes(request.body.description),false);
    let count=0;const sent=await runCustomerTransactionalEmails(f.db,f.config,{adapter:async(message,{beforeSend})=>{assert.equal(message.to,"support@calai.info");assert.equal(beforeSend(),true);count++;return {status:"sent"};}});assert.equal(sent.sent,1);await runCustomerTransactionalEmails(f.db,f.config,{adapter:async()=>{count++;return{status:"sent"};}});assert.equal(count,1);
    assert.equal((await f.json("/api/refund-cases",request)).status,409);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM support_cases WHERE id=?").get(support.id).n,1);
    const reply=await f.json(`/api/support/${support.id}/messages`,{method:"POST",cookie:f.admin,headers:{"Idempotency-Key":"platform-help-answer-1"},body:{message:"Private platform answer"}});assert.equal(reply.status,201,reply.text);
    const customerThread=(await f.json(`/api/support/${support.id}`,{cookie:f.customer})).body.data;assert.equal(customerThread.messages[0].message,"Private platform answer");assert.equal(customerThread.refundCaseId,refundCase.id);
    assert.equal((await f.json(`/api/restaurant/restaurants/${f.restaurant.id}/refund-cases/${refundCase.id}`,{cookie:f.owner})).body.data.status,"awaiting_restaurant");
    const counts=(await f.json("/api/restaurants")).body.data.find(r=>r.id===f.restaurant.id);assert.equal(counts.completedOrderCountLast30Days,0);
    f.db.prepare("UPDATE orders SET status='completed' WHERE id=?").run(order.id);assert.equal((await f.json("/api/restaurants")).body.data.find(r=>r.id===f.restaurant.id).completedOrderCountLast30Days,1);
  }finally{await f.close();}
});
