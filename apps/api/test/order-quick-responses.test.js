import assert from "node:assert/strict";
import test from "node:test";
import {DEFAULT_QUICK_RESPONSES,quickResponsesForOrder} from "../src/order-messaging.js";
test("predefined order replies match delivery or collection and keep restaurant-written messages",()=>{
 const delivery=quickResponsesForOrder(DEFAULT_QUICK_RESPONSES,"delivery"),collection=quickResponsesForOrder(DEFAULT_QUICK_RESPONSES,"collection");
 assert.ok(delivery.includes("Your order is ready for dispatch."));assert.equal(delivery.includes("Your order is ready for collection."),false);
 assert.equal(collection.includes("Your driver is on the way."),false);assert.equal(collection.filter(text=>text==="Your order is ready for collection.").length,1);
 assert.deepEqual(quickResponsesForOrder(["Please call us about your allergy notes."],"delivery"),["Please call us about your allergy notes."]);
});
