import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import test from "node:test";
import {journeyFixture} from "./helpers.js";
import {seedDemoData} from "../src/seed.js";
import {restaurantReadiness} from "../src/readiness.js";

test("local seed prepares only reserved synthetic businesses and preserves administrator disablement on rerun",async t=>{
  const f=await journeyFixture();t.after(()=>f.close());
  const merchant=f.db.prepare("SELECT r.id FROM restaurants r JOIN restaurant_memberships m ON m.restaurant_id=r.id JOIN users u ON u.id=m.user_id WHERE u.email='restaurant@calai.local'").get();
  const link=f.db.prepare("SELECT business_id FROM business_product_links WHERE product='cal-eats' AND restaurant_id=?").get(merchant.id);
  assert.ok(link);assert.equal(restaurantReadiness(f.db,merchant.id).ready,true);
  assert.equal(f.db.prepare("SELECT allowed FROM business_product_permissions WHERE business_id=? AND product='cal-eats'").get(link.business_id).allowed,1);
  assert.equal(f.db.prepare("SELECT allowed FROM business_product_permissions WHERE business_id=? AND product='calai'").get(link.business_id).allowed,0);
  f.db.prepare("UPDATE business_product_permissions SET allowed=0 WHERE business_id=? AND product='cal-eats'").run(link.business_id);
  const unrelated=randomUUID();f.db.prepare("INSERT INTO restaurants(id,name,status,created_at) VALUES(?,'Unrelated local restaurant','pending',?)").run(unrelated,f.config.now().toISOString());
  await seedDemoData(f.db,f.config.now());
  assert.equal(f.db.prepare("SELECT allowed FROM business_product_permissions WHERE business_id=? AND product='cal-eats'").get(link.business_id).allowed,0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM business_product_links WHERE restaurant_id=?").get(unrelated).n,0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM business_product_links WHERE restaurant_id=?").get(merchant.id).n,1);
  assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(),[]);
});

test("policy tests can opt out of demo product authorisation and hosted seeding remains forbidden",async t=>{
  const f=await journeyFixture({configureSeedBusinesses:false});t.after(()=>f.close());
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM business_product_links").get().n,0);
  await assert.rejects(seedDemoData(f.db,f.config.now(),{runMode:"hosted-preview"}),/only in local mode/);
});
