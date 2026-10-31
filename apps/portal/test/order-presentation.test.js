import test from "node:test";
import assert from "node:assert/strict";
import { orderDatePreset, orderDestination, orderReprintLabel } from "../src/order-presentation.js";
test("delivery and collection emphasise the destination while keeping reference last",()=>{
 const order={id:"abcdefgh-rest",customerName:"Amina",fulfillment:"delivery",deliveryAddress:{line1:"10 Demo Road",city:"Luton",postcode:"LU1 2AB"}};
 assert.equal(orderDestination(order),"10 Demo Road, Luton, LU1 2AB");assert.equal(orderReprintLabel(order),"Delivery · 10 Demo Road, Luton, LU1 2AB · Amina · #ABCDEFGH");assert.equal(orderDestination({...order,fulfillment:"collection"}),"Amina");assert.equal(orderDestination({...order,deliveryAddress:null}),"Delivery address unavailable");
});
test("order presets use London date and Monday week boundaries across BST",()=>{
 assert.deepEqual(orderDatePreset("today",new Date("2026-06-01T23:30:00Z")),{from:"2026-06-02",to:"2026-06-02"});
 assert.deepEqual(orderDatePreset("last_week",new Date("2026-10-26T12:00:00Z")),{from:"2026-10-19",to:"2026-10-25"});
 assert.deepEqual(orderDatePreset("all"),{from:"",to:""});
});
