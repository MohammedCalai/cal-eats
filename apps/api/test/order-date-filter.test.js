import test from "node:test";
import assert from "node:assert/strict";
import {journeyFixture} from "./helpers.js";
test("restaurant order date range filters before pagination using London DST boundaries",async()=>{
 const f=await journeyFixture();try{
  const owner=await f.login("restaurant@calai.local","LocalRestaurant!4310"),customer=await f.login("customer@calai.local","LocalCustomer!4310");
  const restaurant=(await f.json("/api/restaurant/restaurants",{cookie:owner})).body.data[0],item=(await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0],ids=[];
  for(let index=0;index<3;index++){const reply=await f.json("/api/orders",{method:"POST",cookie:customer,headers:{"Idempotency-Key":`date-range-${index}`},body:{restaurantId:restaurant.id,items:[{menuItemId:item.id,quantity:1}],paymentMethod:"mock_card",fulfillment:"collection"}});assert.equal(reply.status,201,reply.text);ids.push(reply.body.data.id);}
  ["2026-03-29T00:00:00.000Z","2026-03-29T22:59:59.000Z","2026-03-29T23:00:00.000Z"].forEach((date,index)=>f.db.prepare("UPDATE orders SET created_at=? WHERE id=?").run(date,ids[index]));
  const root=`/api/restaurant/restaurants/${restaurant.id}/orders`,first=await f.json(root+"?from=2026-03-29&to=2026-03-29&page=1&pageSize=1",{cookie:owner});
  assert.equal(first.status,200,first.text);assert.equal(first.body.data.pagination.total,2);assert.equal(first.body.data.items.length,1);assert.equal(first.body.data.items[0].id,ids[1]);
  const second=await f.json(root+"?from=2026-03-29&to=2026-03-29&page=2&pageSize=1",{cookie:owner});assert.equal(second.body.data.items[0].id,ids[0]);
  assert.equal((await f.json(root+"?from=2026-03-30&to=2026-03-29",{cookie:owner})).status,400);
 }finally{await f.close();}
});
