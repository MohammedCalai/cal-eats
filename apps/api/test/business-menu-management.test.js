import test from "node:test";
import assert from "node:assert/strict";
import {journeyFixture} from "./helpers.js";
import {menuBatchItems,mealDealGroups} from "../../../packages/contracts/src/menu-tools.js";
import {randomUUID} from "node:crypto";

test("owners can batch-add dishes, save meal choices and nutrition, and customers can quote multiple items",async()=>{
 const f=await journeyFixture();try{
  const owner=await f.login("restaurant@calai.local","LocalRestaurant!4310"),customer=await f.login("customer@calai.local","LocalCustomer!4310");
  const restaurant=(await f.json('/api/restaurant/restaurants',{cookie:owner})).body.data[0],root=`/api/restaurant/restaurants/${restaurant.id}/menu`;
  const items=menuBatchItems([{name:"Test starter",price:"2.50",category:"Starters"},{name:"Test rice",price:"3.25",category:"Rice"}]);
  const batch={method:"POST",cookie:owner,headers:{"Idempotency-Key":"menu-multiple-test"},body:{items}};
  const saved=await f.json(root+'/import',batch);assert.equal(saved.status,201,saved.text);const replay=await f.json(root+'/import',batch);assert.equal(replay.status,200);assert.deepEqual(replay.body.data.map(row=>row.id),saved.body.data.map(row=>row.id));
  const choices=mealDealGroups([{name:"Starter",category:"Starters"},{name:"Rice",category:"Rice"},{name:"Vegetable side",category:"Vegetable"},{name:"Chicken curry",category:"Curries"}],randomUUID);
  const created=await f.json(root,{method:"POST",cookie:owner,body:{name:"Meal deal test",priceMinor:875,category:"Meal Deals",description:"Full menu description. ".repeat(50),productType:"meal",energyKcal:650,energyKj:2720,allergens:["milk"],dietaryTags:[],modifierGroups:choices}});
  assert.equal(created.status,201,created.text);const meal=created.body.data;assert.equal(meal.productType,"meal");assert.equal(meal.energyKcal,650);assert.equal(meal.modifierGroups.length,4);
  const renamed=await f.json(`${root}/${meal.id}`,{method:"PATCH",cookie:owner,body:{name:"Updated meal deal"}});assert.equal(renamed.body.data.energyKcal,650);
  const invalid=await f.json(`${root}/${meal.id}`,{method:"PATCH",cookie:owner,body:{energyKcal:-1}});assert.equal(invalid.status,400);
  const body={restaurantId:restaurant.id,fulfillment:"collection",items:[{menuItemId:meal.id,quantity:2,modifiers:choices.map(group=>({groupId:group.id,optionIds:[group.options[0].id]}))},{menuItemId:saved.body.data[0].id,quantity:1}]};
  const quote=await f.json('/api/orders/quote',{method:"POST",cookie:customer,body});assert.equal(quote.status,200,quote.text);assert.equal(quote.body.data.totalMinor,2000);
  const missing=await f.json('/api/orders/quote',{method:"POST",cookie:customer,body:{...body,items:[{menuItemId:meal.id,quantity:1}]}});assert.equal(missing.status,409);
  const denied=await f.json(root,{method:"POST",cookie:customer,body:{name:"No access",priceMinor:100}});assert.equal(denied.status,403);
  const publicMenu=(await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data;assert.equal(publicMenu.items.find(row=>row.id===meal.id).energyKj,2720);assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length,0);
 }finally{await f.close();}
});
