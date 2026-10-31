import test from "node:test";
import assert from "node:assert/strict";
import {journeyFixture} from "./helpers.js";

test("campaign editing is owner scoped, sends no new offers, and ending preserves reserved order confirmation",async()=>{
 const f=await journeyFixture({now:()=>new Date("2026-01-01T01:00:00.000Z")});
 try{
  const owner=await f.login("restaurant@calai.local","LocalRestaurant!4310"),other=await f.login("restaurant2@calai.local","LocalRestaurant2!4310"),customer=await f.login("customer@calai.local","LocalCustomer!4310");
  const restaurant=(await f.json("/api/restaurant/restaurants",{cookie:owner})).body.data[0],item=(await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items.find(item=>item.priceMinor>500);
  await f.json("/api/account/marketing-preferences",{method:"PATCH",cookie:customer,body:{inAppPromotions:true,pushPromotions:false,source:"campaign-test"}});
  const base=`/api/restaurant/restaurants/${restaurant.id}/loyalty/promotions`;
  const created=await f.json(base,{method:"POST",cookie:owner,headers:{"Idempotency-Key":"manage-campaign"},body:{title:"Welcome",message:"Ten percent for your first order",campaignType:"percent_order",offerType:"percent_off",value:1000,minSubtotalMinor:0,startsAt:"2026-01-01T00:00:00Z",expiresAt:"2026-01-10T00:00:00Z",redemptionLimit:10,budgetMinor:100000,eligibleItemIds:[],eligibleCategories:[],recipientSegment:"first_order",customerIds:[],stackingPolicy:"exclusive",fundingParty:"restaurant"}});
  assert.equal(created.status,201,created.text);const id=created.body.data.id,path=`${base}/${id}`;
  const claim=await f.json(`/api/promotions/${id}/claim`,{method:"POST",cookie:customer,body:{}});assert.equal(claim.status,200,claim.text);
  const offerId=claim.body.data.id,placed=await f.json("/api/orders",{method:"POST",cookie:customer,headers:{"Idempotency-Key":"reserved-before-end"},body:{restaurantId:restaurant.id,items:[{menuItemId:item.id,quantity:1}],fulfillment:"collection",paymentMethod:"mock_card",offerId}});
  assert.equal(placed.status,201,placed.text);const order=placed.body.data;
  const before=f.db.prepare("SELECT total_minor,commission_minor,promotion_snapshot FROM orders WHERE id=?").get(order.id),grants=f.db.prepare("SELECT COUNT(*) n FROM offer_grants").get().n,notifications=f.db.prepare("SELECT COUNT(*) n FROM user_notifications").get().n;
  assert.equal((await f.json(path,{cookie:other})).status,404);
  assert.equal((await f.json(path,{method:"PATCH",cookie:customer,body:{title:"Wrong"}})).status,403);
  assert.equal((await f.json(path,{method:"PATCH",cookie:owner,body:{offerValue:1}})).status,400);
  assert.equal((await f.json(path,{method:"PATCH",cookie:owner,body:{budgetMinor:1}})).body.error.code,"CAMPAIGN_COMMITTED");
  const edited=await f.json(path,{method:"PATCH",cookie:owner,body:{title:"Welcome again",message:"Updated campaign copy",expiresAt:"2026-01-12T00:00:00Z",redemptionLimit:12}});assert.equal(edited.status,200,edited.text);assert.equal(edited.body.data.title,"Welcome again");
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM offer_grants").get().n,grants);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM user_notifications").get().n,notifications);
  const ended=await f.json(`${path}/end`,{method:"POST",cookie:owner,body:{}});assert.equal(ended.status,200,ended.text);
  assert.equal(f.db.prepare("SELECT status FROM offer_grants WHERE id=?").get(offerId).status,"reserved");
  assert.equal((await f.json(`/api/promotions/${id}/claim`,{method:"POST",cookie:customer,body:{}})).status,404);
  assert.equal((await f.json(path,{method:"PATCH",cookie:owner,body:{title:"Reopen"}})).body.error.code,"CAMPAIGN_ENDED");
  const confirmed=await f.json(`/api/restaurant/orders/${order.id}/status`,{method:"PATCH",cookie:owner,body:{status:"accepted",estimatedReadyAt:"2026-01-01T01:30:00Z"}});assert.equal(confirmed.status,200,confirmed.text);
  assert.deepEqual(f.db.prepare("SELECT total_minor,commission_minor,promotion_snapshot FROM orders WHERE id=?").get(order.id),before);
  for(const status of ["preparing","ready","completed"]){const result=await f.json(`/api/restaurant/orders/${order.id}/status`,{method:"PATCH",cookie:owner,body:{status}});assert.equal(result.status,200,result.text);}
  assert.equal(f.db.prepare("SELECT status FROM offer_grants WHERE id=?").get(offerId).status,"redeemed");
 }finally{await f.close();}
});
