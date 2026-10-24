import test from "node:test";
import assert from "node:assert/strict";
import { AUTH_SUBMIT_SELECTOR, availabilityMessage, canDeliver, cartLines, cartTotals, currentSelections, estimatedMargin, money, nextOrderStatuses, orderItemPayload, outwardPostcode, recognisedCommission, restaurantMatches, safeCsvCell, serializeModifierRows, serializeOpeningRows, validateModifierSelection } from "../model.js";

test("money formats integer pence as GBP", () => assert.equal(money(1250), "£12.50"));
test("outward postcode accepts complete and outward-only UK postcodes", () => {
  assert.equal(outwardPostcode("lu1 2ab"), "LU1");
  assert.equal(outwardPostcode("LU2"), "LU2");
  assert.equal(outwardPostcode("nope"), "");
});
test("restaurant filtering honours name and exact delivery outcode", () => {
  const restaurant = { name: "Calai Kitchen", profile: { cuisine: "Levantine", description: "Fresh mezze" }, delivery: { enabled: true, outcodes: ["LU1"] } };
  assert.equal(restaurantMatches(restaurant, "kitchen", "LU1 2AB"), true);
  assert.equal(restaurantMatches(restaurant, "mezze", "LU1 2AB"), true);
  assert.equal(restaurantMatches(restaurant, "levantine", "LU1 2AB"), true);
  assert.equal(restaurantMatches(restaurant, "pizza", "LU1"), false);
  assert.equal(restaurantMatches(restaurant, "", "LU2"), false);
  assert.equal(restaurantMatches(restaurant, "", "LU2", "collection"), true);
});
test("cart totals use server-like integer arithmetic", () => {
  const lines = cartLines([{ id: "a", priceMinor: 450 }, { id: "b", priceMinor: 1200 }], { a: 2, b: 1 });
  assert.deepEqual(cartTotals(lines, "delivery", { deliveryFeeMinor: 250 }), { subtotalMinor: 2100, deliveryFeeMinor: 250, totalMinor: 2350 });
});
test("delivery eligibility reports area and minimum failures", () => {
  const delivery = { enabled: true, outcodes: ["LU1"], minDeliverySubtotalMinor: 1000 };
  assert.match(canDeliver(delivery, "LU2 1AA", 1200).reason, /outside/);
  assert.match(canDeliver(delivery, "LU1 1AA", 900).reason, /£1.00/);
  assert.equal(canDeliver(delivery, "LU1 1AA", 1000).ok, true);
});
test("order transitions differ for collection and delivery", () => {
  assert.deepEqual(nextOrderStatuses({ status: "placed", fulfillment: "collection" }), ["accepted", "rejected"]);
  assert.deepEqual(nextOrderStatuses({ status: "ready", fulfillment: "delivery" }), ["out_for_delivery"]);
  assert.deepEqual(nextOrderStatuses({ status: "ready", fulfillment: "collection" }), ["completed"]);
});
test("CSV guard neutralises spreadsheet formulas", () => {
  assert.equal(safeCsvCell("=SUM(A1:A2)"), "'=SUM(A1:A2)");
  assert.equal(safeCsvCell("normal"), "normal");
});
test("modifier selections add server-owned option prices to every quantity", () => {
  const item = { id: "meal", priceMinor: 1000, modifierGroups: [{ id: "size", name: "Size", minSelections: 1, maxSelections: 1, options: [{ id: "large", name: "Large", priceMinor: 250, available: true }] }] };
  const [line] = cartLines([item], { meal: 2 }, { meal: { size: ["large"] } });
  assert.equal(line.modifierTotalMinor, 250);
  assert.equal(line.lineTotalMinor, 2500);
  assert.deepEqual(line.modifiers, [{ groupId: "size", optionIds: ["large"] }]);
});
test("required and unavailable modifier choices are rejected", () => {
  const item = { modifierGroups: [{ id: "base", name: "Base", minSelections: 1, maxSelections: 1, options: [{ id: "rice", available: true }, { id: "chips", available: false }] }] };
  assert.equal(validateModifierSelection(item, {}).ok, false);
  assert.equal(validateModifierSelection(item, { base: ["chips"] }).ok, false);
  assert.equal(validateModifierSelection(item, { base: ["rice"] }).ok, true);
});
test("optional single-choice modifiers can return to no selection", () => {
  const item = { id:"meal", priceMinor:1000, modifierGroups:[{id:"sauce",name:"Sauce",minSelections:0,maxSelections:1,options:[{id:"chilli",priceMinor:50,available:true}]}] };
  assert.equal(validateModifierSelection(item, {sauce:[]}).ok, true);
  const [line] = cartLines([item], {meal:1}, {meal:{sauce:[]}});
  assert.equal(line.lineTotalMinor, 1000);
  assert.deepEqual(line.modifiers, []);
});
test("availability explains suspended, paused and closed restaurants", () => {
  assert.match(availabilityMessage({ suspended: true }), /suspended/);
  assert.match(availabilityMessage({ profile: { paused: true } }), /paused/);
  assert.equal(availabilityMessage({ acceptingOrders: true, profile: { collectionEnabled: true } }), "");
});
test("estimated margin subtracts only user-entered costs", () => {
  assert.deepEqual(estimatedMargin(700, { processing: 120, payout: 30 }), { grossCommissionMinor: 700, totalCostsMinor: 150, estimatedMarginMinor: 550 });
});
test("order payload preserves selected modifier IDs", () => {
  assert.deepEqual(orderItemPayload([{ id: "meal", quantity: 2, modifiers: [{ groupId: "size", optionIds: ["large"] }] }]), [{ menuItemId: "meal", quantity: 2, modifiers: [{ groupId: "size", optionIds: ["large"] }] }]);
});
test("reorder keeps only currently available valid selections", () => {
  const item = { modifierGroups: [{ id: "size", name: "Size", minSelections: 1, maxSelections: 1, options: [{ id: "large", available: true }, { id: "old", available: false }] }] };
  assert.deepEqual(currentSelections(item, [{ groupId: "size", optionId: "large" }]), { size: ["large"] });
  assert.deepEqual(currentSelections(item, [{ groupId: "size", optionId: "old" }]), {});
});
test("manual auth selector accepts explicit and implicit submit buttons", () => {
  assert.match(AUTH_SUBMIT_SELECTOR, /button\[type=submit\]/);
  assert.match(AUTH_SUBMIT_SELECTOR, /button:not\(\[type\]\)/);
});
test("recognised commission uses earnings and refunds but excludes settlements", () => {
  assert.equal(recognisedCommission([{kind:"commission_mock",amountMinor:700},{kind:"commission_cash_receivable",amountMinor:350},{kind:"commission_mock_refund",amountMinor:-70},{kind:"cash_settlement",amountMinor:200}]), 980);
});
test("opening-hour rows preserve multiple and overnight intervals", () => {
  assert.deepEqual(serializeOpeningRows([{day:"1",open:"09:00",close:"14:00"},{day:"1",open:"18:00",close:"01:00"}]), [{day:1,open:"09:00",close:"14:00"},{day:1,open:"18:00",close:"01:00"}]);
});
test("modifier rows preserve IDs and convert extra pounds to pence", () => {
  assert.deepEqual(serializeModifierRows([{id:"sauce",name:"Sauce",minSelections:"0",maxSelections:"1",options:[{id:"chilli",name:"Chilli mayo",extraPrice:"0.50",available:true}]}]), [{id:"sauce",name:"Sauce",minSelections:0,maxSelections:1,options:[{id:"chilli",name:"Chilli mayo",priceMinor:50,available:true}]}]);
});
