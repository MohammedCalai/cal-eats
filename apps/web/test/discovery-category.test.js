import assert from "node:assert/strict";
import test from "node:test";
import { discoveryFeedHtml, discoveryHeroHtml } from "../discovery-ui.js";
import { discoveryCollections } from "../discovery-model.js";

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
