import assert from "node:assert/strict";
import test from "node:test";
import {randomUUID} from "node:crypto";
import {journeyFixture} from "./helpers.js";
import {adminUnconfirmedOrders,adminUserDirectory,adminOrderDirectory,routeAdminWorkspace} from "../src/admin-workspace.js";
import {adminFinanceSummary,adminFinanceRecords} from "../src/admin-finance-workspace.js";
import {buildFinanceSummary} from "../src/marketplace-reporting.js";

const url = path => new URL(path,"http://127.0.0.1:4310");
async function setup(){
  const f=await journeyFixture({now:()=>new Date("2026-01-01T01:05:00.000Z")});
  const owner=await f.login("restaurant@calai.local","LocalRestaurant!4310"),customer=await f.login("customer@calai.local","LocalCustomer!4310"),restaurant=(await f.json("/api/restaurant/restaurants",{cookie:owner})).body.data[0],item=(await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0];
  const response=await f.json("/api/orders",{method:"POST",cookie:customer,headers:{"Idempotency-Key":"workspace-order"},body:{restaurantId:restaurant.id,items:[{menuItemId:item.id,quantity:1}],paymentMethod:"cash",fulfillment:"collection"}});assert.equal(response.status,201,response.text);
  return{...f,owner,customer,order:response.body.data,restaurant};
}

test("admin queue includes every unconfirmed order with bounded, stable pages and separates unpaid from overdue",async()=>{
  const f=await setup();try{
    const original=f.db.prepare("SELECT * FROM orders WHERE id=?").get(f.order.id),columns=Object.keys(original),insert=f.db.prepare(`INSERT INTO orders (${columns.join(",")}) VALUES(${columns.map(()=>"?").join(",")})`);
    for(let i=0;i<29;i++){const row={...original,id:randomUUID(),idempotency_key:`waiting-${i}`,created_at:new Date(Date.parse(original.created_at)-i*1000).toISOString()};insert.run(...columns.map(c=>row[c]));}
    const payment={...original,id:randomUUID(),idempotency_key:"waiting-payment",payment_method:"card",payment_status:"stripe_pending",merchant_visible_at:null,confirmation_due_at:null};insert.run(...columns.map(c=>payment[c]));
    const now=new Date("2026-01-01T01:08:00.000Z"),first=adminUnconfirmedOrders(f.db,url("/api/admin/workspace/unconfirmed-orders?pageSize=12"),now),second=adminUnconfirmedOrders(f.db,url("/api/admin/workspace/unconfirmed-orders?pageSize=12&page=2"),now),third=adminUnconfirmedOrders(f.db,url("/api/admin/workspace/unconfirmed-orders?pageSize=12&page=3"),now);
    assert.deepEqual(first.summary,{total:31,needsConfirmation:30,overdue:30,awaitingPayment:1});assert.equal(first.items.length,12);assert.equal(first.pagination.totalPages,3);assert.equal(new Set([...first.items,...second.items,...third.items].map(x=>x.id)).size,31);assert.equal(third.items.at(-1).confirmationState,"awaiting_payment");
    const unpaid=adminUnconfirmedOrders(f.db,url("/api/admin/workspace/unconfirmed-orders?state=payment"),now);assert.equal(unpaid.items.length,1);assert.equal(unpaid.items[0].id,payment.id);assert.equal(unpaid.items[0].confirmationOverdue,false);
    const literal=adminUnconfirmedOrders(f.db,url("/api/admin/workspace/unconfirmed-orders?q=%25"),now);assert.equal(literal.pagination.total,0);
    const confirmed=await f.json(`/api/restaurant/orders/${f.order.id}/status`,{method:"PATCH",cookie:f.owner,body:{status:"accepted"}});assert.equal(confirmed.status,200,confirmed.text);assert.equal(adminUnconfirmedOrders(f.db,url("/api/admin/workspace/unconfirmed-orders"),now).summary.needsConfirmation,29);
    assert.throws(()=>adminUnconfirmedOrders(f.db,url("/api/admin/workspace/unconfirmed-orders?page=0"),now),e=>e.code==="VALIDATION_ERROR");assert.throws(()=>adminUnconfirmedOrders(f.db,url("/api/admin/workspace/unconfirmed-orders?state=invalid"),now),e=>e.code==="VALIDATION_ERROR");
  }finally{await f.close();}
});

test("directory filters before paging, numbers rows across pages and never exposes password/session columns",async()=>{
  const f=await setup();try{
    const original=f.db.prepare("SELECT * FROM users WHERE role='customer'").get(),columns=Object.keys(original),insert=f.db.prepare(`INSERT INTO users (${columns.join(",")}) VALUES(${columns.map(()=>"?").join(",")})`);
    for(let i=0;i<30;i++){const row={...original,id:randomUUID(),name:`Paged Customer ${i}`,email:`paged-${i}@example.invalid`,account_enabled:i===29?0:1};insert.run(...columns.map(c=>row[c]));}
    const first=adminUserDirectory(f.db,url("/api/admin/workspace/users?role=customer&q=Paged&pageSize=25")),second=adminUserDirectory(f.db,url("/api/admin/workspace/users?role=customer&q=Paged&pageSize=25&page=2"));
    assert.equal(first.pagination.total,30);assert.equal(first.items[0].number,1);assert.equal(second.items[0].number,26);assert.equal(second.items.at(-1).number,30);assert.equal(new Set([...first.items,...second.items].map(x=>x.id)).size,30);assert.ok(first.items.every(row=>!Object.hasOwn(row,"password_hash")&&!Object.hasOwn(row,"passwordHash")));
    const disabled=adminUserDirectory(f.db,url("/api/admin/workspace/users?access=disabled&q=Paged"));assert.equal(disabled.pagination.total,1);assert.equal(disabled.items[0].enabled,false);
    assert.equal(adminUserDirectory(f.db,url("/api/admin/workspace/users?q=%25")).pagination.total,0);assert.throws(()=>adminUserDirectory(f.db,url("/api/admin/workspace/users?pageSize=1000")),e=>e.code==="VALIDATION_ERROR");
  }finally{await f.close();}
});

test("workspace routes are administrator-only and operation lists are bounded",async()=>{
  const f=await setup();try{
    const admin=f.db.prepare("SELECT id,name,email,role FROM users WHERE role='admin'").get(),customer=f.db.prepare("SELECT id,name,email,role FROM users WHERE role='customer'").get();
    async function read(path,session={user:admin}){let status,body;const res={writeHead(code){status=code;},end(value){body=JSON.parse(value);}};await routeAdminWorkspace({req:{method:"GET"},res,url:url(path),db:f.db,config:f.config,session});return{status,body};}
    await assert.rejects(()=>read("/api/admin/workspace/users",{user:customer}),e=>e.status===403);await assert.rejects(()=>read("/api/admin/workspace/dashboard",null),e=>e.status===401);
    const dashboard=await read("/api/admin/workspace/dashboard?from=2026-01-01&to=2026-01-01");assert.equal(dashboard.status,200);assert.equal(dashboard.body.data.orders.count,0);assert.equal(Object.hasOwn(dashboard.body.data,"providerCostMinor"),false);
    for(const kind of["jobs","audit","deletions","integrations"]){const response=await read(`/api/admin/workspace/operations?kind=${kind}&pageSize=2`);assert.equal(response.status,200,kind);assert.ok(response.body.data.items.length<=2);assert.equal(response.body.data.pagination.pageSize,2);}
  }finally{await f.close();}
});

test("order directory filters in SQL and a deep link loads an order outside the first page",async()=>{
  const f=await setup();try{
    const original=f.db.prepare("SELECT * FROM orders WHERE id=?").get(f.order.id),columns=Object.keys(original),insert=f.db.prepare(`INSERT INTO orders (${columns.join(",")}) VALUES(${columns.map(()=>"?").join(",")})`);
    const target={...original,id:randomUUID(),idempotency_key:"older-order",created_at:"2025-12-20T12:00:00.000Z",scheduled_for:"2026-01-01T18:00:00.000Z"};insert.run(...columns.map(c=>target[c]));
    for(let i=0;i<55;i++){const row={...original,id:randomUUID(),idempotency_key:`directory-order-${i}`};insert.run(...columns.map(c=>row[c]));}
    const first=adminOrderDirectory(f.db,url("/api/admin/workspace/orders?pageSize=25"),f.config),third=adminOrderDirectory(f.db,url("/api/admin/workspace/orders?pageSize=25&page=3"),f.config);assert.equal(first.pagination.total,57);assert.equal(first.items.length,25);assert.equal(third.items.at(-1).id,target.id);assert.equal(third.items[0].number,51);
    assert.equal(adminOrderDirectory(f.db,url(`/api/admin/workspace/orders?q=${target.id.slice(0,8)}`),f.config).items[0].id,target.id);
    assert.equal(adminOrderDirectory(f.db,url("/api/admin/workspace/orders?from=2026-01-01&to=2026-01-01"),f.config).pagination.total,56);
    assert.equal(adminOrderDirectory(f.db,url("/api/admin/workspace/orders?status=completed"),f.config).pagination.total,0);
    assert.equal(adminOrderDirectory(f.db,url("/api/admin/workspace/orders?fulfillment=delivery"),f.config).pagination.total,0);
    assert.equal(adminOrderDirectory(f.db,url(`/api/admin/workspace/orders?restaurantId=${f.restaurant.id}`),f.config).pagination.total,57);
    assert.throws(()=>adminOrderDirectory(f.db,url("/api/admin/workspace/orders?from=2026-02-31"),f.config),e=>e.code==="VALIDATION_ERROR");
    const admin=f.db.prepare("SELECT id,name,email,role FROM users WHERE role='admin'").get();let body;const res={writeHead(){},end(value){body=JSON.parse(value);}};await routeAdminWorkspace({req:{method:"GET"},res,url:url(`/api/admin/workspace/orders/${target.id}`),db:f.db,config:f.config,session:{user:admin}});assert.equal(body.data.id,target.id);assert.equal(body.data.scheduledFor,target.scheduled_for);
  }finally{await f.close();}
});

test("paged finance totals agree with saved finance records and platform vouchers reduce platform margin only",async()=>{
  const f=await setup();try{
    assert.equal((await f.json(`/api/restaurant/orders/${f.order.id}/status`,{method:"PATCH",cookie:f.owner,body:{status:"accepted"}})).status,200);
    const before=adminFinanceSummary(f.db,url("/api/admin/workspace/finance/summary?from=2026-01-01&to=2026-01-01&pageSize=1"));assert.equal(before.items.length,1);assert.equal(before.pagination.total,2);
    const expected=buildFinanceSummary(f.db,f.restaurant.id,url("/api/admin/workspace/finance/summary?from=2026-01-01&to=2026-01-01"));assert.equal(before.totals.grossSalesMinor,expected.grossSalesMinor);assert.equal(before.totals.commissionMinor,expected.commissionMinor);assert.equal(before.totals.providerCostMinor,expected.providerCostMinor);
    f.db.prepare("UPDATE marketplace_operations SET amount_minor=amount_minor-200 WHERE order_id=? AND kind='cash_order_accepted'").run(f.order.id);
    const stamp=f.config.now().toISOString();f.db.prepare("INSERT INTO marketplace_operations(id,operation_key,restaurant_id,order_id,kind,status,amount_minor,currency,provider_mode,metadata,created_at,updated_at) VALUES(?,?,?,?,?,'confirmed',200,'GBP','local_simulator','{}',?,?)").run(randomUUID(),`test-voucher:${f.order.id}`,f.restaurant.id,f.order.id,"platform_voucher_credit",stamp,stamp);
    const after=adminFinanceSummary(f.db,url("/api/admin/workspace/finance/summary?from=2026-01-01&to=2026-01-01"));assert.equal(after.totals.grossSalesMinor,before.totals.grossSalesMinor);assert.equal(after.totals.commissionMinor,before.totals.commissionMinor);assert.equal(after.totals.platformVoucherCostMinor,200);assert.equal(after.totals.marginMinor,before.totals.marginMinor-200);
    assert.equal(adminFinanceSummary(f.db,url("/api/admin/workspace/finance/summary?q=Second")).totals.grossSalesMinor,0);assert.equal(adminFinanceSummary(f.db,url("/api/admin/workspace/finance/summary?from=2026-01-02")).totals.grossSalesMinor,0);
    for(const kind of["exceptions","contracts","statements"]){const records=adminFinanceRecords(f.db,url("/api/admin/workspace/finance/records?pageSize=1"),kind);assert.ok(records.items.length<=1);assert.equal(records.pagination.pageSize,1);}
  }finally{await f.close();}
});
