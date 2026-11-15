import test from "node:test";
import assert from "node:assert/strict";
import { businessDeviceFixture } from "./business-device-fixture.js";
import { runCustomerPrivacyRetention } from "../src/customer-privacy.js";

async function place(f,customer,restaurant=f.restaurant,key="search-order"){
  const item=f.db.prepare("SELECT id FROM menu_items WHERE restaurant_id=? AND available=1 LIMIT 1").get(restaurant.id);
  const result=await f.json("/api/orders",{method:"POST",cookie:customer,headers:{"Idempotency-Key":key},body:{restaurantId:restaurant.id,items:[{menuItemId:item.id,quantity:1}],fulfillment:"collection",paymentMethod:"mock_card"}});
  assert.equal(result.status,201,result.text);return result.body.data;
}
const route=(restaurantId,query)=>`/api/restaurant/restaurants/${restaurantId}/orders?${new URLSearchParams(query)}`;

test("restaurant order search filters the server count and pages before returning scoped native/browser results",async()=>{
  const f=await businessDeviceFixture({withPrinter:false});try{
    const customer=await f.login("customer@calai.local","LocalCustomer!4310"),ids=[];
    for(let index=0;index<3;index++)ids.push((await place(f,customer,f.restaurant,`search-pagination-${index}`)).id);
    ids.forEach((id,index)=>f.db.prepare("UPDATE orders SET customer_name=?,customer_phone=?,delivery_address=?,created_at=? WHERE id=?").run(index===2?"Other customer":"Alex Harper","07123456789",JSON.stringify({line1:"14 Market Road",line2:"Flat Two",city:"Luton",postcode:"LU1 5QQ"}),`2026-01-0${index+1}T01:00:00.000Z`,id));
    const first=await f.json(route(f.restaurant.id,{q:"  aLeX  ",page:1,pageSize:1}),{cookie:f.owner});
    assert.equal(first.status,200,first.text);assert.equal(first.body.data.pagination.total,2);assert.equal(first.body.data.pagination.totalPages,2);assert.equal(first.body.data.pagination.hasNext,true);assert.deepEqual(first.body.data.items.map(row=>row.id),[ids[1]]);
    const second=await f.json(route(f.restaurant.id,{q:"Alex",page:2,pageSize:1}),{headers:await f.nativeLogin()});assert.equal(second.status,200,second.text);assert.deepEqual(second.body.data.items.map(row=>row.id),[ids[0]]);assert.equal(second.body.data.pagination.hasNext,false);
    for(const q of [`#${ids[1].slice(0,8).toUpperCase()}`,"07123456789","Market Road","Flat Two","Luton","LU1 5QQ"]){const result=await f.json(route(f.restaurant.id,{q,page:1,pageSize:25}),{cookie:f.owner});assert.equal(result.status,200,result.text);assert.ok(result.body.data.items.some(row=>row.id===ids[1]),q);}
    const ranged=await f.json(route(f.restaurant.id,{q:"Alex",from:"2026-01-02",to:"2026-01-02",status:"placed",page:1,pageSize:25}),{cookie:f.owner});assert.equal(ranged.status,200,ranged.text);assert.equal(ranged.body.data.pagination.total,1);assert.equal(ranged.body.data.items[0].id,ids[1]);
    const otherOwner=await f.login("restaurant2@calai.local","LocalRestaurant2!4310"),other=(await f.json("/api/restaurant/restaurants",{cookie:otherOwner})).body.data[0];
    assert.equal((await f.json(`/api/restaurant/restaurants/${other.id}/menu`,{method:"POST",cookie:otherOwner,body:{name:"Other restaurant meal",priceMinor:1000}})).status,201);
    assert.equal((await f.json(`/api/restaurant/restaurants/${other.id}/profile`,{method:"PATCH",cookie:otherOwner,body:{phone:"07000000000"}})).status,200);
    const admin=await f.login("admin@calai.local","LocalAdmin!4310"),approved=await f.json(`/api/admin/restaurants/${other.id}/approval`,{method:"PATCH",cookie:admin,body:{status:"approved"}});assert.equal(approved.status,200,approved.text);
    await f.enrollRestaurant({restaurantId:other.id,cookie:otherOwner});const foreign=await place(f,customer,other,"search-foreign");f.db.prepare("UPDATE orders SET customer_name='Alex Harper' WHERE id=?").run(foreign.id);
    const scoped=await f.json(route(f.restaurant.id,{q:"Alex",page:1,pageSize:25}),{cookie:f.owner});assert.equal(scoped.body.data.pagination.total,2);assert.ok(scoped.body.data.items.every(row=>row.restaurantId===f.restaurant.id));
    assert.equal((await f.json(route(other.id,{q:"Alex",page:1}),{cookie:f.owner})).status,404);assert.equal((await f.json(route(f.restaurant.id,{q:"Alex",page:1}),{cookie:customer})).status,403);
  }finally{await f.close();}
});

test("order search escapes literal patterns, rejects unbounded filters and cannot recover minimized contacts from customer profiles",async()=>{
  const f=await businessDeviceFixture({withPrinter:false,customerPrivacy:{enabled:true,version:"order-search-retention",approvedAt:"2025-01-01T00:00:00.000Z",approvalReference:"Isolated order search retention regression"}});try{
    const customer=await f.login("customer@calai.local","LocalCustomer!4310"),orders=[];
    for(let index=0;index<3;index++)orders.push(await place(f,customer,f.restaurant,`search-literal-${index}`));
    const names=["100% regular","under_score","Back\\Road"];
    orders.forEach((order,index)=>f.db.prepare("UPDATE orders SET customer_name=?,customer_phone='',delivery_instructions='SearchOnlyPrivateNote',allergy_notes='SearchOnlyPrivateAllergy' WHERE id=?").run(names[index],order.id));
    for(const [q,index]of [["%",0],["_",1],["\\",2]]){const result=await f.json(route(f.restaurant.id,{q,page:1}),{cookie:f.owner});assert.equal(result.status,200,result.text);assert.equal(result.body.data.pagination.total,1);assert.equal(result.body.data.items[0].id,orders[index].id);}
    for(const q of ["' OR 1=1 --","SearchOnlyPrivateNote","SearchOnlyPrivateAllergy"]){const result=await f.json(route(f.restaurant.id,{q,page:1}),{cookie:f.owner});assert.equal(result.status,200,result.text);assert.equal(result.body.data.pagination.total,0);}
    for(const query of [`q=${"x".repeat(101)}`,"q=first&q=second","q=bad%00input"]){const result=await f.json(`/api/restaurant/restaurants/${f.restaurant.id}/orders?${query}`,{cookie:f.owner});assert.equal(result.status,400,result.text);}
    const retained=orders[0];f.db.prepare("UPDATE users SET name='RetainedContactNeedle' WHERE id=?").run(retained.customerId);
    f.db.prepare("UPDATE orders SET customer_name='RetainedContactNeedle',customer_phone='07999999999',delivery_address=?,status='completed',updated_at='2025-08-01T00:00:00.000Z' WHERE id=?").run(JSON.stringify({line1:"RetainedAddressNeedle",city:"Luton",postcode:"LU1 5QQ"}),retained.id);
    assert.equal(runCustomerPrivacyRetention(f.db,f.config).orderContacts,1);
    const visible=await f.json(route(f.restaurant.id,{q:retained.id,page:1}),{cookie:f.owner});assert.equal(visible.body.data.pagination.total,1);assert.equal(visible.body.data.items[0].customerName,"");assert.equal(visible.body.data.items[0].deliveryAddress,null);
    for(const q of ["RetainedContactNeedle","RetainedAddressNeedle","07999999999"]){const result=await f.json(route(f.restaurant.id,{q,page:1}),{cookie:f.owner});assert.equal(result.status,200,result.text);assert.equal(result.body.data.pagination.total,0,q);}
  }finally{await f.close();}
});
