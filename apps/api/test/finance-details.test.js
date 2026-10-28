import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { journeyFixture } from "./helpers.js";
import { createStripeTestAdapter } from "../src/payments/stripe-test.js";
import { buildWeeklyStatementSnapshot, weeklyStatementPeriod } from "../src/business-weekly-statements.js";

async function setup(f) {
  const owner=await f.login("restaurant@calai.local","LocalRestaurant!4310"),customer=await f.login("customer@calai.local","LocalCustomer!4310"),other=await f.login("restaurant2@calai.local","LocalRestaurant2!4310");
  const restaurant=(await f.json("/api/restaurant/restaurants",{cookie:owner})).body.data[0],otherRestaurant=(await f.json("/api/restaurant/restaurants",{cookie:other})).body.data[0];
  const item=(await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0];
  return{owner,customer,other,restaurant,otherRestaurant,item,root:`/api/restaurant/restaurants/${restaurant.id}/finance`};
}

test("owner order breakdown preserves promotion/commission/refund snapshots and excludes other roles",async()=>{
  const f=await journeyFixture({rateLimit:{attempts:30,windowMs:60000}});
  try{
    const s=await setup(f),create=async key=>{const response=await f.json("/api/orders",{method:"POST",cookie:s.customer,headers:{"Idempotency-Key":key},body:{restaurantId:s.restaurant.id,items:[{menuItemId:s.item.id,quantity:1}],paymentMethod:"mock_card",fulfillment:"collection"}});assert.equal(response.status,201,response.text);return response.body.data;};
    const order=await create("breakdown-discount");
    const snapshot={title:"Your ten percent offer",offerType:"percent_off",fundingParty:"restaurant",allocations:[{menuItemId:s.item.id,name:"Original bowl",grossMinor:2000,discountMinor:200,netMinor:1800}]};
    f.db.prepare("UPDATE orders SET status='completed',payment_status='mock_captured',gross_food_minor=2000,restaurant_discount_minor=200,subtotal_minor=1800,total_minor=1800,commission_minor=126,contract_rate_bps=700,commission_base='food',promotion_snapshot=? WHERE id=?").run(JSON.stringify(snapshot),order.id);
    f.db.prepare("UPDATE order_items SET name='Original bowl',unit_price_minor=2000,base_price_minor=1900,selected_modifiers=? WHERE order_id=?").run(JSON.stringify([{name:"Original extra",priceMinor:100}]),order.id);
    f.db.prepare("INSERT INTO refunds(id,order_id,actor_user_id,idempotency_key,request_hash,food_amount_minor,delivery_amount_minor,reason,mode,commission_reversal_minor,created_at) VALUES(?,?,?,?,?,500,0,'Fixture refund','simulated_card',35,?)").run(randomUUID(),order.id,f.db.prepare("SELECT id FROM users WHERE email='restaurant@calai.local'").get().id,"breakdown-refund","fixture",f.config.now().toISOString());
    f.db.prepare("UPDATE menu_items SET name='Changed menu name',price_minor=9999 WHERE id=?").run(s.item.id);
    const response=await f.json(`${s.root}/orders/${order.id}/breakdown`,{cookie:s.owner});assert.equal(response.status,200,response.text);
    const detail=response.body.data;
    assert.equal(detail.items[0].name,"Original bowl");assert.equal(detail.items[0].modifiers[0].priceMinor,100);
    assert.equal(detail.totals.grossFoodMinor,2000);assert.equal(detail.totals.restaurantDiscountMinor,200);assert.equal(detail.totals.foodChargedMinor,1800);
    assert.equal(detail.promotion.title,"Your ten percent offer");assert.equal(detail.promotion.allocations[0].netMinor,1800);
    assert.equal(detail.commission.commissionableMinor,1800);assert.equal(detail.commission.originalMinor,126);assert.equal(detail.commission.reversedMinor,35);assert.equal(detail.commission.retainedMinor,91);
    assert.equal(detail.earnings.originalMinor,1674);assert.equal(detail.earnings.currentMinor,1209);assert.equal(detail.earnings.refundImpactMinor,465);assert.equal(detail.earnings.providerFeeChargedToRestaurantMinor,0);
    assert.equal(detail.settlement.bankPayoutAttributed,false);assert.equal(detail.settlement.state,"simulated");
    assert.equal((await f.json(`${s.root}/orders/${order.id}/breakdown`,{cookie:s.customer})).status,403);
    assert.equal((await f.json(`${s.root}/orders/${order.id}/breakdown`,{cookie:s.other})).status,404);
    const staffId=randomUUID(),owner=f.db.prepare("SELECT password_hash FROM users WHERE email='restaurant@calai.local'").get();
    f.db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,'restaurant',?)").run(staffId,"Staff","finance-staff@example.invalid",owner.password_hash,f.config.now().toISOString());
    f.db.prepare("INSERT INTO restaurant_memberships(restaurant_id,user_id,permission,created_at) VALUES(?,?,'staff',?)").run(s.restaurant.id,staffId,f.config.now().toISOString());
    const staff=await f.login("finance-staff@example.invalid","LocalRestaurant!4310");assert.equal((await f.json(`${s.root}/orders/${order.id}/breakdown`,{cookie:staff})).status,403);
    const gift=await create("breakdown-free-item");
    f.db.prepare("UPDATE orders SET status='accepted',payment_status='mock_captured',offer_snapshot=? WHERE id=?").run(JSON.stringify({title:"Free side",offerType:"free_item",itemValueMinor:400}),gift.id);
    f.db.prepare("INSERT INTO order_items(id,order_id,menu_item_id,name,unit_price_minor,quantity,base_price_minor,selected_modifiers,allergens,category,is_offer_item) VALUES(?,?,?,'Free side',0,1,400,'[]','[]','Sides',1)").run(randomUUID(),gift.id,s.item.id);
    const free=(await f.json(`${s.root}/orders/${gift.id}/breakdown`,{cookie:s.owner})).body.data;
    assert.equal(free.promotion.freeItemRetailValueMinor,400);assert.equal(free.promotion.discountMinor,0);assert.equal(free.promotion.freeItems[0].quantity,1);
    assert.equal(free.earnings.currentMinor,free.totals.customerChargedMinor-free.commission.originalMinor,"Free retail value must not be deducted a second time");
    const pending=await create("breakdown-pending");const unconfirmed=(await f.json(`${s.root}/orders/${pending.id}/breakdown`,{cookie:s.owner})).body.data;assert.equal(unconfirmed.earnings.confirmed,false);assert.equal(unconfirmed.earnings.currentMinor,0);assert.equal(unconfirmed.commission.retainedMinor,0);
  }finally{await f.close();}
});

test("masked bank details and paged payout dates are owner/mode/account scoped",async()=>{
  const f=await journeyFixture();
  try{
    const s=await setup(f);
    let externalReads=0,payoutReads=0,collision=false;
    const rawBank={id:"ba_fixture",bankName:"Fixture Bank",last4:"6789",country:"GB",currency:"GBP",status:"verified",defaultForCurrency:true,accountNumber:"1234567890123456",routingNumber:"112233"};
    const adapter={retrievePlatformAccount:async()=>({ok:true,status:"confirmed",providerReference:"acct_platform",mode:"stripe_test"}),refreshConnectedAccount:async()=>({ok:true,status:"confirmed",providerReference:"acct_restaurant",chargesEnabled:true,payoutsEnabled:true,bankAccounts:[rawBank],bankDetailsAvailable:true}),listExternalBankAccounts:async()=>{externalReads++;return{ok:true,providerReference:"acct_restaurant",items:[rawBank]};},listPayouts:async input=>{payoutReads++;return{ok:true,items:[{providerReference:collision?"po_other":input.startingAfter?"po_second":"po_first",amountMinor:1000,currency:"GBP",paymentState:input.startingAfter?"pending":"paid",createdAt:"2025-12-31T00:00:00.000Z",arrivalAt:"2026-01-02T00:00:00.000Z"}],hasMore:!input.startingAfter};}};
    const inactive=(await f.json(`${s.root}/stripe/banking`,{cookie:s.owner})).body.data;assert.equal(inactive.connected,false);assert.equal(inactive.canManageBankDetails,false);assert.deepEqual(inactive.bankAccounts,[]);
    Object.assign(f.config,{paymentProviderMode:"stripe_test",stripePlatformAccountId:"acct_platform",paymentProviderWebhookSecret:"whsec_fixture",paymentProviderConnectWebhookSecret:"whsec_connect",stripeProvider:adapter,paymentProvider:adapter});
    const stamp=f.config.now().toISOString();
    f.db.prepare("INSERT OR REPLACE INTO provider_accounts VALUES(?,?,'stripe_test','enabled','[]','[]','acct_restaurant',?,?)").run(randomUUID(),s.restaurant.id,stamp,stamp);
    const bank=await f.json(`${s.root}/stripe/banking`,{cookie:s.owner});assert.equal(bank.status,200,bank.text);assert.equal(bank.body.data.bankAccounts[0].last4,"6789");assert.equal(bank.body.data.canManageBankDetails,true);assert.equal(externalReads,1);
    assert.equal(bank.text.includes("1234567890123456"),false);assert.equal(bank.text.includes("112233"),false);assert.equal(bank.text.includes("routingNumber"),false);
    assert.equal((await f.json(`${s.root}/stripe/banking`,{cookie:s.customer})).status,403);assert.equal((await f.json(`${s.root}/stripe/banking`,{cookie:s.other})).status,404);assert.equal(externalReads,1);
    const first=await f.json(`${s.root}/stripe/payouts?pageSize=1`,{cookie:s.owner});assert.equal(first.status,200,first.text);assert.equal(first.body.data.nextCursor,"po_first");assert.equal(first.body.data.items[0].paidAt,null);assert.equal(first.body.data.items[0].expectedArrivalAt,"2026-01-02T00:00:00.000Z");
    f.db.prepare("INSERT INTO provider_events(id,provider,provider_event_id,event_type,object_type,object_id,provider_account_reference,restaurant_id,payload_fingerprint,normalized_payload,provider_created_at,status,available_at,created_at,updated_at) VALUES(?,'stripe_test',?,'payout.paid','payout','po_first','acct_restaurant',?,'fixture','{}','2026-01-01T00:50:00.000Z','completed',?,?,?)").run(randomUUID(),`evt_${randomUUID()}`,s.restaurant.id,stamp,stamp,stamp);
    const paid=(await f.json(`${s.root}/stripe/payouts?pageSize=1`,{cookie:s.owner})).body.data.items[0];assert.equal(paid.paidAt,"2026-01-01T00:50:00.000Z");assert.notEqual(paid.paidAt,paid.expectedArrivalAt);
    const second=(await f.json(`${s.root}/stripe/payouts?pageSize=1&startingAfter=po_first`,{cookie:s.owner})).body.data;assert.equal(second.items[0].id,"po_second");assert.equal(second.hasMore,false);assert.equal(second.nextCursor,null);
    f.db.prepare("INSERT INTO stripe_connected_payouts VALUES('po_other',?,'acct_other',1000,'paid',NULL,NULL,?,?)").run(s.otherRestaurant.id,stamp,stamp);
    const reads=payoutReads;assert.equal((await f.json(`${s.root}/stripe/payouts?startingAfter=po_other`,{cookie:s.owner})).status,404);assert.equal(payoutReads,reads);
    collision=true;assert.equal((await f.json(`${s.root}/stripe/payouts`,{cookie:s.owner})).body.error.code,"STRIPE_PAYOUT_BINDING_MISMATCH");assert.equal(f.db.prepare("SELECT restaurant_id FROM stripe_connected_payouts WHERE id='po_other'").get().restaurant_id,s.otherRestaurant.id);
    f.db.prepare("UPDATE provider_accounts SET provider_mode='stripe_live' WHERE restaurant_id=?").run(s.restaurant.id);assert.equal((await f.json(`${s.root}/stripe/banking`,{cookie:s.owner})).body.error.code,"STRIPE_MODE_MISMATCH");
  }finally{await f.close();}
});

test("Stripe adapter discards full bank numbers and preserves provider payout date/currency facts",async()=>{
  const responses=[{id:"acct_fixture",object:"account",charges_enabled:true,payouts_enabled:true,external_accounts:{data:[{id:"ba_fixture",object:"bank_account",bank_name:"Fixture bank",last4:"6789",country:"GB",currency:"gbp",routing_number:"112233",account_holder_name:"Private holder",account_number:"1234567890123456"}]}},{object:"list",data:[{id:"ba_fixture",object:"bank_account",last4:"6789",routing_number:"112233",currency:"gbp",country:"GB"}]},{object:"list",data:[{id:"po_fixture",object:"payout",livemode:false,status:"paid",amount:500,currency:"gbp",created:1767139200,arrival_date:1767312000}],has_more:false}];
  const adapter=createStripeTestAdapter({secretKey:"rk_test_fixture",allowTestTransport:true,fetchImpl:async()=>({ok:true,status:200,json:async()=>responses.shift()})});
  const account=await adapter.refreshConnectedAccount({accountId:"acct_fixture"});assert.equal(account.bankAccounts[0].last4,"6789");assert.equal(JSON.stringify(account).includes("112233"),false);assert.equal(JSON.stringify(account).includes("Private holder"),false);
  const banks=await adapter.listExternalBankAccounts({accountId:"acct_fixture"});assert.equal(banks.items[0].last4,"6789");assert.equal(JSON.stringify(banks).includes("routing_number"),false);
  const payouts=await adapter.listPayouts({accountId:"acct_fixture",limit:1});assert.equal(payouts.items[0].currency,"GBP");assert.ok(payouts.items[0].createdAt);assert.ok(payouts.items[0].arrivalAt);assert.equal("paidAt"in payouts.items[0],false);
});

test("real offer checkout producers retain discount/free-item snapshots in owner breakdown and weekly CSV",async()=>{
  let stamp=Date.parse("2026-01-01T01:00:00.000Z");
  const f=await journeyFixture({now:()=>new Date(stamp),sessionHours:24*30,rateLimit:{attempts:30,windowMs:60000}});
  try{
    const s=await setup(f),admin=await f.login("admin@calai.local","LocalAdmin!4310");
    const place=async(key,offerId)=>{const response=await f.json("/api/orders",{method:"POST",cookie:s.customer,headers:{"Idempotency-Key":key},body:{restaurantId:s.restaurant.id,items:[{menuItemId:s.item.id,quantity:1}],paymentMethod:"mock_card",fulfillment:"collection",...(offerId?{offerId}:{})}});assert.equal(response.status,201,response.text);return response.body.data;};
    const complete=async order=>{for(const status of["accepted","preparing","ready","completed"])assert.equal((await f.json(`/api/restaurant/orders/${order.id}/status`,{method:"PATCH",cookie:s.owner,body:{status}})).status,200);};
    const history=await place("real-offer-history");await complete(history);
    assert.equal((await f.json("/api/account/marketing-preferences",{method:"PATCH",cookie:s.customer,body:{inAppPromotions:true,pushPromotions:false,source:"finance-integration"}})).status,200);
    const offer=async(title,offerType,value)=>{
      const response=await f.json(`${s.root.replace('/finance','')}/loyalty/promotions`,{method:"POST",cookie:s.owner,headers:{"Idempotency-Key":title.replaceAll(' ','-')},body:{title,message:"Restaurant-funded finance walkthrough",offerType,value,menuItemId:offerType==="free_item"?s.item.id:null,minSubtotalMinor:0,startsAt:"2026-01-01T00:00:00.000Z",expiresAt:"2026-01-10T00:00:00.000Z",redemptionLimit:1,budgetMinor:100000,eligibleItemIds:[s.item.id],eligibleCategories:[],recipientSegment:"selected",customerIds:[history.customerId],stackingPolicy:"exclusive",fundingParty:"restaurant"}});
      assert.equal(response.status,201,response.text);
      const grant=(await f.json("/api/offers",{cookie:s.customer})).body.data.find(row=>row.campaignId===response.body.data.id);assert.ok(grant);return grant;
    };
    const percent=await offer("Actual ten percent","percent_off",1000),discounted=await place("real-discounted-order",percent.id);await complete(discounted);
    const discount=Math.floor(s.item.priceMinor/10),detail=(await f.json(`${s.root}/orders/${discounted.id}/breakdown`,{cookie:s.owner})).body.data;
    assert.equal(detail.promotion.title,"Actual ten percent");assert.equal(detail.promotion.offerType,"percent_off");assert.equal(detail.promotion.discountMinor,discount);assert.equal(detail.commission.originalMinor,discounted.commissionMinor);
    assert.equal(detail.totals.foodChargedMinor,s.item.priceMinor-discount);assert.equal(detail.promotion.allocations[0].discountMinor,discount);
    const editPrice=async price=>assert.equal((await f.json(`${s.root.replace('/finance','')}/menu/${s.item.id}`,{method:"PATCH",cookie:s.owner,body:{priceMinor:price}})).status,200);
    await editPrice(s.item.priceMinor+500);
    const freeOffer=await offer("Actual free side","free_item",0);
    await editPrice(s.item.priceMinor+800);
    const gifted=await place("real-free-order",freeOffer.id);assert.equal((await f.json(`/api/restaurant/orders/${gifted.id}/status`,{method:"PATCH",cookie:s.owner,body:{status:"accepted"}})).status,200);
    const free=(await f.json(`${s.root}/orders/${gifted.id}/breakdown`,{cookie:s.owner})).body.data;
    assert.equal(free.promotion.offerType,"free_item");assert.equal(free.promotion.freeItemRetailValueMinor,s.item.priceMinor+500,"Free item retail value comes from the granted offer, not today's higher menu price");assert.equal(free.promotion.discountMinor,0);assert.equal(free.items.filter(row=>row.isOfferItem).length,1);
    assert.equal(free.earnings.currentMinor,gifted.totalMinor-gifted.commissionMinor);
    stamp=Date.parse("2026-01-08T01:00:00.000Z");
    const refunded=await f.json(`/api/admin/orders/${discounted.id}/refunds`,{method:"POST",cookie:admin,headers:{"Idempotency-Key":"real-promotion-refund"},body:{foodAmountMinor:100,deliveryAmountMinor:0,reason:"Fixture item correction"}});assert.equal(refunded.status,201,refunded.text);
    const after=(await f.json(`${s.root}/orders/${discounted.id}/breakdown`,{cookie:s.owner})).body.data;assert.equal(after.totals.refundedFoodMinor,100);assert.equal(after.earnings.currentMinor,discounted.totalMinor-100-after.commission.retainedMinor);assert.equal(after.promotion.title,"Actual ten percent");
    const statement=buildWeeklyStatementSnapshot(f.db,s.restaurant.id,weeklyStatementPeriod("2026-01-05T09:00:00.000Z"),f.config);
    const rows=statement.csv.trim().split("\r\n").map(line=>[...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map(match=>match[1].replaceAll('""','"'))),headers=rows.shift();
    assert.ok(rows.every(row=>row.length===headers.length));
    const pricing=rows.find(row=>row[0]==="order_placed"&&row[2]===discounted.id),giftPricing=rows.find(row=>row[0]==="order_placed"&&row[2]===gifted.id);
    assert.equal(pricing[headers.indexOf("promotionTitle")],"Actual ten percent");assert.equal(Number(pricing[headers.indexOf("restaurantDiscountMinor")]),discount);assert.equal(Number(pricing[headers.indexOf("originalCommissionMinor")]),discounted.commissionMinor);
    assert.equal(Number(giftPricing[headers.indexOf("freeItemRetailValueMinor")]),s.item.priceMinor+500);assert.equal(statement.summary.refundsMinor,0,"Next-week refund must not be folded into the earlier weekly cashflow");
  }finally{await f.close();}
});
