import test from "node:test";import assert from "node:assert/strict";
import { journeyFixture } from "./helpers.js";
test("admin service areas govern new orders, keep replay safe, and expose scoped recent addresses",async()=>{
 const f=await journeyFixture({locationProvider:async()=>({postcode:"LU1 2AB",admin_district:"Luton"}),rateLimit:{attempts:30,windowMs:60000}});
 try{
  const owner=await f.login("restaurant@calai.local","LocalRestaurant!4310"),customer=await f.login("customer@calai.local","LocalCustomer!4310"),admin=await f.login("admin@calai.local","LocalAdmin!4310");
  const restaurant=(await f.json("/api/restaurant/restaurants",{cookie:owner})).body.data[0],item=(await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0];
  f.db.prepare("UPDATE restaurants SET delivery_enabled=1,delivery_outcodes='[\"LU1\"]',address='Test restaurant, Luton LU1 2AB' WHERE id=?").run(restaurant.id);
  assert.equal((await f.json("/api/service-availability?postcode=LU12AB")).body.data.available,true);
  assert.equal((await f.json("/api/service-availability?postcode=EH11AA")).body.data.available,false);
  const settings={mode:"custom",outcodes:["LU1"],headline:"We’re not delivering to your area yet",message:"We’re expanding—check back soon for restaurants near you."};
  for(const cookie of [customer,owner])assert.equal((await f.json("/api/admin/service-areas",{method:"PUT",cookie,body:settings})).status,403);
  assert.equal((await f.json("/api/admin/service-areas",{method:"PUT",cookie:admin,body:settings})).status,200);
  const body={restaurantId:restaurant.id,items:[{menuItemId:item.id,quantity:2}],fulfillment:"delivery",deliveryAddress:{line1:"10 Fictional Demo Road",city:"Luton",postcode:"LU1 2AB"},paymentMethod:"mock_card"};
  const order=await f.json("/api/orders",{method:"POST",cookie:customer,headers:{"Idempotency-Key":"coverage-order"},body});assert.equal(order.status,201,order.text);
  const recent=(await f.json("/api/account/recent-addresses",{cookie:customer})).body.data;assert.equal(recent.length,1);assert.equal(recent[0].postcode,"LU1 2AB");
  assert.equal((await f.json("/api/account/recent-addresses",{cookie:owner})).status,403);assert.equal((await f.json("/api/account/recent-addresses")).status,401);
  await f.json("/api/admin/service-areas",{method:"PUT",cookie:admin,body:{...settings,outcodes:["WD5"]}});
  const quote={...body};delete quote.paymentMethod;assert.equal((await f.json("/api/orders/quote",{method:"POST",cookie:customer,body:quote})).body.error.code,"SERVICE_AREA_UNAVAILABLE");
  assert.equal((await f.json("/api/orders",{method:"POST",cookie:customer,headers:{"Idempotency-Key":"new-outside-area"},body})).body.error.code,"SERVICE_AREA_UNAVAILABLE");
  assert.equal((await f.json("/api/orders",{method:"POST",cookie:customer,headers:{"Idempotency-Key":"coverage-order"},body})).body.data.id,order.body.data.id);
  const gps=await f.json("/api/location/postcode",{method:"POST",body:{latitude:51.88,longitude:-.42,consent:true}});assert.equal(gps.status,200,gps.text);assert.equal(gps.body.data.postcode,"LU1 2AB");assert.equal("latitude" in gps.body.data,false);
  assert.equal((await f.json("/api/location/postcode",{method:"POST",body:{latitude:51.88,longitude:-.42,consent:false}})).status,400);
 }finally{await f.close();}
});
