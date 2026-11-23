import test from "node:test";
import assert from "node:assert/strict";
import { canPrintOrderReceipt, orderReceiptPrincipal, orderDatePreset, orderDestination, orderReprintLabel } from "../src/order-presentation.js";
test("delivery and collection emphasise the destination while keeping reference last",()=>{
 const order={id:"abcdefgh-rest",customerName:"Amina",fulfillment:"delivery",deliveryAddress:{line1:"10 Demo Road",city:"Luton",postcode:"LU1 2AB"}};
 assert.equal(orderDestination(order),"10 Demo Road, Luton, LU1 2AB");assert.equal(orderReprintLabel(order),"Delivery · 10 Demo Road, Luton, LU1 2AB · Amina · #ABCDEFGH");assert.equal(orderDestination({...order,fulfillment:"collection"}),"Amina");assert.equal(orderDestination({...order,deliveryAddress:null}),"Delivery address unavailable");
});
test("order presets use London date and Monday week boundaries across BST",()=>{
 assert.deepEqual(orderDatePreset("today",new Date("2026-06-01T23:30:00Z")),{from:"2026-06-02",to:"2026-06-02"});
 assert.deepEqual(orderDatePreset("last_week",new Date("2026-10-26T12:00:00Z")),{from:"2026-10-19",to:"2026-10-25"});
 assert.deepEqual(orderDatePreset("all"),{from:"",to:""});
});
test("receipt shortcut only offers a confirmed Cal-Eats order in the current restaurant", () => {
  const order = { id: "a", restaurantId: "this-restaurant" };
  for (const status of ["accepted", "preparing", "ready", "out_for_delivery", "completed"]) {
    assert.equal(canPrintOrderReceipt({ ...order, status }, "this-restaurant"), true);
  }
  for (const status of ["placed", "rejected", "cancelled", "expired"]) {
    assert.equal(canPrintOrderReceipt({ ...order, status }, "this-restaurant"), false);
  }
  assert.equal(canPrintOrderReceipt({ ...order, status: "completed", source: "calai" }, "this-restaurant"), false);
  assert.equal(canPrintOrderReceipt({ ...order, status: "completed" }, "another-restaurant"), false);
});
test("receipt transport prefers a registered tablet and otherwise requires the current business owner", () => {
  const business = {
    id: "business", eatsRestaurantId: "restaurant", principalKind: "human",
    canConnectProducts: true, canViewEats: true, products: { "cal-eats": { active: true } },
  };
  assert.equal(orderReceiptPrincipal(business, "restaurant", "owner", false), "owner");
  assert.equal(orderReceiptPrincipal(business, "restaurant", "staff", true), "terminal");
  assert.equal(orderReceiptPrincipal(business, "restaurant", "staff", false), null);
  assert.equal(orderReceiptPrincipal({ ...business, canConnectProducts: false }, "restaurant", "owner", false), null);
  assert.equal(orderReceiptPrincipal({ ...business, principalKind: "terminal" }, "restaurant", "owner", false), null);
  assert.equal(orderReceiptPrincipal(business, "another", "owner", true), null);
  const disabled = { ...business, products: { "cal-eats": { active: true, allowedOnTablet: false } } };
  assert.equal(orderReceiptPrincipal(disabled, "restaurant", "owner", true), null);
});
