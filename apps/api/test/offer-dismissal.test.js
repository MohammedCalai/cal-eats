import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import test from "node:test";
import {journeyFixture} from "./helpers.js";

async function setup(f){
  const owner=await f.login("restaurant@calai.local","LocalRestaurant!4310"),customer=await f.login("customer@calai.local","LocalCustomer!4310");
  const restaurant=(await f.json("/api/restaurant/restaurants",{cookie:owner})).body.data[0],customerId=f.db.prepare("SELECT id FROM users WHERE email=?").get("customer@calai.local").id,ownerId=f.db.prepare("SELECT id FROM users WHERE email=?").get("restaurant@calai.local").id;
  await f.json("/api/account/preferences",{method:"PATCH",cookie:customer,body:{merchantOffers:true}});
  const registration=await f.json("/api/auth/register",{method:"POST",body:{name:"Second customer",email:"second-inbox@example.test",password:"SeparateCustomer!4310"}}),otherId=registration.body.data.user.id,other=await f.login("second-inbox@example.test","SeparateCustomer!4310");
  await f.json("/api/account/preferences",{method:"PATCH",cookie:other,body:{merchantOffers:true}});
  const items=(await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items,paid=items.find(item=>item.priceMinor>=1000),gift=items.find(item=>item.id!==paid.id&&!item.modifierGroups?.some(group=>group.minSelections>0));
  function grant({recipient=customerId,personal=true,status="available",expires="2026-02-01T00:00:00.000Z",campaignId=null}={}){
    const id=randomUUID(),campaign=campaignId||randomUUID(),now="2026-01-01T00:00:00.000Z";
    if(!campaignId){f.db.prepare("INSERT INTO offer_campaigns(id,restaurant_id,created_by_user_id,idempotency_key,request_hash,title,message,menu_item_id,item_name,item_value_minor,min_subtotal_minor,expires_at,created_at,recipient_segment,campaign_rules) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(campaign,restaurant.id,ownerId,campaign,campaign,"A thank-you side","Free side with a paid purchase",gift.id,gift.name,gift.priceMinor,0,expires,now,personal?"selected":"regular",JSON.stringify({audienceSegment:personal?"selected":"regular"}));}
    f.db.prepare("INSERT INTO offer_grants(id,campaign_id,restaurant_id,customer_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(id,campaign,restaurant.id,recipient,status,now,now);
    return{id,campaignId:campaign};
  }
  return{owner,customer,customerId,other,otherId,restaurant,paid,grant};
}

test("offer dismissal is per customer, durable, idempotent and cannot be reused by checkout",async()=>{
  const f=await journeyFixture();try{
    const s=await setup(f),first=s.grant(),other=s.grant({recipient:s.otherId,campaignId:first.campaignId});
    assert.equal((await f.json(`/api/offers/${first.id}`,{method:"PATCH",cookie:s.other,body:{dismissed:true}})).status,404);
    for(let attempt=0;attempt<2;attempt++)assert.equal((await f.json(`/api/offers/${first.id}`,{method:"PATCH",cookie:s.customer,body:{dismissed:true}})).status,200);
    const stored=f.db.prepare("SELECT * FROM offer_grants WHERE id=?").get(first.id);assert.ok(stored.dismissed_at);assert.equal(stored.status,"available");assert.equal(f.db.prepare("SELECT COUNT(*) n FROM offer_grants WHERE campaign_id=?").get(first.campaignId).n,2);
    const freshSession=await f.login("customer@calai.local","LocalCustomer!4310");assert.deepEqual((await f.json("/api/offers?limit=20&scope=active",{cookie:freshSession})).body.data.items,[]);
    assert.equal((await f.json("/api/offers?limit=20&scope=active",{cookie:s.other})).body.data.items[0].id,other.id);
    assert.equal((await f.json(`/api/offers/${first.id}`,{cookie:s.customer})).status,404);
    assert.equal((await f.json(`/api/offers/${first.id}`,{method:"PATCH",cookie:s.customer,body:{viewed:true}})).status,404);
    const quote=await f.json("/api/orders/quote",{method:"POST",cookie:s.customer,body:{restaurantId:s.restaurant.id,items:[{menuItemId:s.paid.id,quantity:1}],fulfillment:"collection",offerId:first.id}});assert.equal(quote.body.error.code,"OFFER_UNAVAILABLE");
    f.db.prepare("UPDATE offer_campaigns SET recipient_segment='first_order' WHERE id=?").run(first.campaignId);
    assert.deepEqual((await f.json(`/api/promotions?restaurantId=${s.restaurant.id}`,{cookie:s.customer})).body.data,[]);
    assert.equal((await f.json(`/api/promotions/${first.campaignId}/claim`,{method:"POST",cookie:s.customer,body:{}})).body.error.code,"OFFER_DISMISSED");
  }finally{await f.close();}
});

test("active offer pages stay bounded and deterministic across ties, expiry and a dismissed cursor",async()=>{
  const f=await journeyFixture();try{
    const s=await setup(f);for(let i=0;i<5;i++)s.grant({personal:i<3});s.grant({status:"redeemed"});s.grant({expires:"2025-12-31T00:00:00.000Z"});
    const first=(await f.json("/api/offers?limit=2&scope=active",{cookie:s.customer})).body.data;assert.equal(first.items.length,2);assert.equal(first.hasMore,true);assert.ok(first.items.every(item=>item.recipientSegment==="selected"));
    const cursor=first.nextCursor;await f.json(`/api/offers/${cursor}`,{method:"PATCH",cookie:s.customer,body:{dismissed:true}});
    const seen=first.items.filter(item=>item.id!==cursor).map(item=>item.id);let after=cursor;while(after){const result=await f.json(`/api/offers?limit=2&scope=active&after=${after}`,{cookie:s.customer});assert.equal(result.status,200,result.text);assert.ok(result.body.data.items.length<=2);seen.push(...result.body.data.items.map(item=>item.id));after=result.body.data.nextCursor;}
    assert.equal(seen.length,4);assert.equal(new Set(seen).size,4);assert.equal(seen.includes(cursor),false);
    assert.equal((await f.json(`/api/offers?limit=2&after=${cursor}`,{cookie:s.other})).status,404);
    assert.equal((await f.json("/api/offers?limit=101",{cookie:s.customer})).status,400);
    for(let i=0;i<101;i++)s.grant();assert.equal((await f.json("/api/offers",{cookie:s.customer})).body.data.length,100);
  }finally{await f.close();}
});

test("offers reserved on an order cannot be dismissed or lose their reservation",async()=>{
  const f=await journeyFixture();try{
    const s=await setup(f),grant=s.grant(),placed=await f.json("/api/orders",{method:"POST",cookie:s.customer,headers:{"Idempotency-Key":"reserved-customer-offer"},body:{restaurantId:s.restaurant.id,items:[{menuItemId:s.paid.id,quantity:1}],paymentMethod:"mock_card",fulfillment:"collection",offerId:grant.id}});assert.equal(placed.status,201,placed.text);
    const before=f.db.prepare("SELECT * FROM offer_grants WHERE id=?").get(grant.id),denied=await f.json(`/api/offers/${grant.id}`,{method:"PATCH",cookie:s.customer,body:{dismissed:true}});assert.equal(denied.status,409);assert.equal(denied.body.error.code,"OFFER_IN_ORDER");const after=f.db.prepare("SELECT * FROM offer_grants WHERE id=?").get(grant.id);assert.equal(after.dismissed_at,null);assert.equal(after.status,"reserved");assert.equal(after.reserved_order_id,before.reserved_order_id);assert.equal(after.reserved_discount_minor,before.reserved_discount_minor);
    await f.json(`/api/restaurant/orders/${placed.body.data.id}/status`,{method:"PATCH",cookie:s.owner,body:{status:"rejected"}});assert.equal((await f.json(`/api/offers/${grant.id}`,{method:"PATCH",cookie:s.customer,body:{dismissed:true}})).status,200);assert.ok(f.db.prepare("SELECT offer_grant_id FROM orders WHERE id=?").get(placed.body.data.id).offer_grant_id);
  }finally{await f.close();}
});
