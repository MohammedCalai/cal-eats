import test from "node:test";import assert from "node:assert/strict";
import {availableDiscoveryOffer,discoveryCollections,cuisineIcon} from "../discovery-model.js";
test("discovery keeps every unique restaurant and ranks genuine time and fee data",()=>{
 const restaurants=Array.from({length:21},(_,index)=>({id:String(index),acceptingOrders:index!==0,profile:{estimatedDeliveryMinutes:30-index,estimatedCollectionMinutes:index},delivery:{deliveryFeeMinor:index*10}}));
 const groups=discoveryCollections([...restaurants,restaurants[0]],[],"delivery");assert.equal(groups.all.length,21);assert.equal(new Set(groups.all.map(r=>r.id)).size,21);assert.equal(groups.quick[0].id,"20");assert.equal(groups.lowFee[0].id,"0");assert.equal(discoveryCollections(restaurants,[],"collection").quick[0].id,"1");assert.equal(restaurants[0].id,"0");
});
test("offer shelves exclude expired, future and redeemed personalised offers",()=>{
 const now=Date.parse("2026-10-28T12:00Z"),offer={id:"available",restaurantId:"one",status:"available",startsAt:"2026-10-28T11:00Z",expiresAt:"2026-10-29T12:00Z"};
 assert.equal(availableDiscoveryOffer("one",[offer],now).id,"available");
 for(const change of [{status:"redeemed"},{startsAt:"2026-10-30T12:00Z"},{expiresAt:"2026-10-28T12:00Z"},{expiresAt:"invalid"}])assert.equal(availableDiscoveryOffer("one",[{...offer,...change}],now),null);
 assert.deepEqual(discoveryCollections([{id:"one"},{id:"two"}],[offer],"delivery",now).deals.map(r=>r.id),["one"]);assert.equal(cuisineIcon("Japanese"),"🍣");
});
