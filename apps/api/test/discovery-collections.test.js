import assert from "node:assert/strict";
import test from "node:test";
import { journeyFixture } from "./helpers.js";

test("category filtering and popularity ranking cover the whole directory before 50-row pagination", async () => {
  const f = await journeyFixture();
  try {
    const customer = await f.login("customer@calai.local", "LocalCustomer!4310");
    const customerId = f.db.prepare("SELECT id FROM users WHERE email='customer@calai.local'").get().id;
    const insert = f.db.prepare("INSERT INTO restaurants(id,name,status,created_at,cuisine,collection_enabled,delivery_enabled,delivery_outcodes,delivery_fee_minor,estimated_delivery_minutes) VALUES(?,?,'approved',?,'Category test',1,1,'[\"LU1\"]',199,35)");
    for (let index=0;index<56;index++) insert.run(`category-${String(index).padStart(3,"0")}`,`Category ${String(index).padStart(3,"0")}`,"2026-01-01T00:00:00.000Z");
    f.db.prepare("UPDATE restaurants SET delivery_fee_minor=0,estimated_delivery_minutes=5 WHERE id='category-055'").run();
    const route = "/api/restaurants?cuisine=Category%20test&fulfillment=delivery";
    assert.equal((await f.json(route)).body.data.length,50);
    const free = await f.json(route+"&collection=free-delivery");
    assert.equal(free.status,200,free.text); assert.deepEqual(free.body.data.map(row=>row.id),["category-055"]);
    assert.equal(free.body.pagination.hasNext,false);
    assert.equal((await f.json(route+"&collection=quick")).body.data[0].id,"category-055");
    const timestamp="2026-01-01T00:30:00.000Z";
    f.db.prepare("INSERT INTO orders(id,restaurant_id,restaurant_name,customer_id,status,subtotal_minor,total_minor,commission_minor,payment_method,payment_status,fulfillment,idempotency_key,request_hash,created_at,updated_at) VALUES('popular-category','category-055','Category 055',?,'completed',100,100,7,'mock_card','captured','collection','category-popular','test',?,?)").run(customerId,timestamp,timestamp);
    const popular = await f.json(route+"&collection=popular");
    assert.deepEqual(popular.body.data.map(row=>row.id),["category-055"]);
    const ownerId=f.db.prepare("SELECT id FROM users WHERE email='restaurant@calai.local'").get().id;
    f.db.prepare("INSERT INTO menu_items(id,restaurant_id,name,description,price_minor,available,created_at,updated_at) VALUES('category-gift','category-055','Side','',100,1,?,?)").run(timestamp,timestamp);
    f.db.prepare("INSERT INTO offer_campaigns(id,restaurant_id,created_by_user_id,idempotency_key,request_hash,title,message,menu_item_id,item_name,item_value_minor,min_subtotal_minor,expires_at,created_at,starts_at,recipient_segment) VALUES('category-offer','category-055',?,'category-campaign','test','Your side','Enjoy','category-gift','Side',100,0,'2026-01-08T00:00:00.000Z',?,?,'selected')").run(ownerId,timestamp,timestamp);
    f.db.prepare("INSERT INTO offer_grants(id,campaign_id,restaurant_id,customer_id,status,created_at,updated_at) VALUES('category-grant','category-offer','category-055',?,'available',?,?)").run(customerId,timestamp,timestamp);
    assert.equal((await f.json(route+"&collection=offers",{cookie:customer})).body.data.length,0);
    await f.json("/api/account/preferences",{method:"PATCH",cookie:customer,body:{merchantOffers:true}});
    const offers=await f.json(route+"&collection=offers",{cookie:customer});
    assert.equal(offers.status,200,offers.text); assert.deepEqual(offers.body.data.map(row=>row.id),["category-055"]);
    assert.equal(offers.body.data[0].availableOfferId,"category-grant");
    assert.equal((await f.json(route+"&collection=offers")).body.data.length,0);
    f.db.prepare("UPDATE offer_grants SET dismissed_at=? WHERE id='category-grant'").run(timestamp);
    assert.equal((await f.json(route+"&collection=offers",{cookie:customer})).body.data.length,0);
    for (const query of ["collection=made-up","sort=made-up"]) assert.equal((await f.json(route+"&"+query)).status,400);
  } finally { await f.close(); }
});
