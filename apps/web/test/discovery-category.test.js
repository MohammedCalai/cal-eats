import assert from "node:assert/strict";
import test from "node:test";
import { discoveryFeedHtml, discoveryHeroHtml } from "../discovery-ui.js";
import { discoveryCollections } from "../discovery-model.js";
import { canPreviewDiscoveryRestaurant,restaurantBrowseFulfillment } from "../discovery-model.js";

const restaurant = {id:"one",name:"Blue Kitchen",profile:{cuisine:"British",estimatedDeliveryMinutes:25},delivery:{enabled:true,deliveryFeeMinor:0},acceptingOrders:true};
const state = {restaurants:[restaurant],offers:[],search:"",postcode:"",fulfillment:"delivery",discoverCollection:"free-delivery"};
test("a category has its own page heading and back control, with discovery tools hidden", () => {
  assert.equal(discoveryHeroHtml(state), "");
  const html = discoveryFeedHtml(state);
  assert.ok(html.includes("<h1>Free delivery</h1>")); assert.ok(html.includes("Back to browse"));
  assert.equal(html.includes("discovery-shelf"), false);
  const empty = discoveryFeedHtml({...state,restaurants:[]});
  assert.ok(empty.includes("<h1>Free delivery</h1>")); assert.ok(empty.includes("Back to browse"));
});
test("directory offer eligibility works beyond the bounded offers inbox and ratings use actual counts", () => {
  const row = {...restaurant,availableOfferId:"later-grant",ratingCount:4,ratingAverage:4.5};
  assert.equal(discoveryCollections([row],[]).deals.length,1);
  const html = discoveryFeedHtml({...state,restaurants:[row],discoverCollection:"offers"});
  assert.ok(html.includes('data-offer="later-grant"')); assert.ok(html.includes("★ 4.5"));
  assert.equal(discoveryFeedHtml(state).includes("restaurant-rating"),false);
});

test("outside-area delivery previews stay disabled with a narrow collection-only detail exception",()=>{
 const delivery={...restaurant,id:"delivery-only",profile:{...restaurant.profile,collectionEnabled:false}},both={...restaurant,id:"delivery-and-collection",profile:{...restaurant.profile,collectionEnabled:true}},collection={...restaurant,id:"collection-only",name:"Paused Collection Kitchen",profile:{...restaurant.profile,paused:true,collectionEnabled:true},delivery:{enabled:false,outcodes:[],deliveryFeeMinor:0},acceptingOrders:false};
 const unavailable={...state,discoverCollection:"all",restaurants:[delivery,both,collection],serviceArea:{available:false,headline:"Delivery unavailable here",message:"Outside the current delivery area."}};
 const html=discoveryFeedHtml(unavailable),button=id=>html.match(new RegExp(`<button[^>]*data-id="${id}"[^>]*>`))?.[0];
 assert.ok(html.includes('class="unavailable-preview"'),'Existing grey preview wrapper remains');
 for(const row of [delivery,both]){assert.ok(button(row.id)?.includes('disabled aria-disabled="true"'));assert.equal(canPreviewDiscoveryRestaurant(row,"delivery",false),false);}
 assert.ok(button(collection.id));assert.equal(button(collection.id).includes('disabled'),false);assert.ok(html.includes("Not taking orders right now"));assert.ok(html.includes("Collection only"));assert.equal(canPreviewDiscoveryRestaurant(collection,"delivery",false),true);assert.equal(restaurantBrowseFulfillment(collection,"delivery"),"collection");
 assert.equal(canPreviewDiscoveryRestaurant(undefined,"delivery",false),false,'Unknown deep links cannot bypass the unavailable area');
 const collectionMode=discoveryFeedHtml({...unavailable,fulfillment:"collection"});assert.ok(collectionMode.match(/<button[^>]*data-id="collection-only"[^>]*>/)?.[0].includes('disabled aria-disabled="true"'),'The existing unavailable-area Collection-mode rule is unchanged');
 assert.equal(canPreviewDiscoveryRestaurant(collection,"collection",false),false);
 assert.equal(canPreviewDiscoveryRestaurant(delivery,"delivery",true),true);
});
