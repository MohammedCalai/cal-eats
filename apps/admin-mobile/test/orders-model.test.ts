import test from "node:test";
import assert from "node:assert/strict";
import {customerEtaDisplay,orderEtaLabel,type BusinessOrder} from "../src/orders-model.ts";
import {companionRequestAllowed,ownerAppDestination} from "../src/companion-policy.ts";
import {healthLabel,incidentNeedsAttention,type OperationsHealth} from "../src/operations-health.ts";
test("order details remain readable while every tablet processing/print mutation is rejected",()=>{
 assert.equal(companionRequestAllowed("/api/orders/order-1"),true);
 for(const [url,method] of [["/api/restaurant/orders/order-1/status","PATCH"],["/api/restaurant/orders/order-1/preparation","PATCH"],["/api/orders/order-1/status","POST"],["/api/orders","POST"],["/api/restaurant/restaurants/r1/printers","GET"],["/api/orders/order-1/print","POST"],["/api/restaurant/restaurants/r1/dashboard/orders.csv?period=today","GET"]])assert.equal(companionRequestAllowed(url!,method),false,url);
 assert.equal(companionRequestAllowed("/api/orders/order-1/messages","POST"),true);
 assert.equal(companionRequestAllowed("/api/orders/order-1/messages/read","PATCH"),true);
 assert.equal(companionRequestAllowed("/api/restaurant/incidents/incident-1/read","PATCH"),true);
 assert.equal(companionRequestAllowed("/api/restaurant/report-emails","POST"),true);
});
test("push links can open only safe detail destinations; unknown restaurant scope has no destination",()=>{
 assert.deepEqual(ownerAppDestination({kind:"device_incident",incidentId:"fault-123",restaurantId:"r1"}),{screen:"devices",restaurantId:"r1",id:"fault-123"});
 assert.deepEqual(ownerAppDestination({kind:"confirm_order",orderId:"order-1",restaurantId:"r1",action:"accepted"}),{screen:"orders",restaurantId:"r1",id:"order-1"});
 assert.equal(ownerAppDestination({orderId:"order-1"}),null);
 assert.equal(ownerAppDestination({restaurantId:"../r2",orderId:"order-1"}),null);
});
test("incident read state cannot make an active fault healthy, and missing evidence stays unknown",()=>{
 assert.equal(incidentNeedsAttention({status:"active",readAt:"2026-11-15T10:00:00Z"} as OperationsHealth["incidents"][number]),true);
 assert.equal(incidentNeedsAttention({status:"resolved",readAt:null} as OperationsHealth["incidents"][number]),false);
 assert.equal(healthLabel(undefined),"Not confirmed");
 assert.equal(orderEtaLabel({fulfillment:"collection"}),"Ready for collection estimate");
 assert.equal(customerEtaDisplay({fulfillment:"delivery",customerEtaAt:null} as BusinessOrder),"Not confirmed yet");
});