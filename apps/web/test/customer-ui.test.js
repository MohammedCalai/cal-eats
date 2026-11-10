import test from "node:test";
import assert from "node:assert/strict";
import {customerIcon,customerReceiptHtml} from "../customer-ui.js";
test("customer receipt keeps saved prices, discount and refund and escapes supplied content",()=>{
 const html=customerReceiptHtml({id:"order-123",restaurantName:'<img src=x onerror=alert(1)>',createdAt:'2026-10-29T12:00Z',status:'completed',fulfillment:'delivery',paymentStatus:'stripe_partially_refunded',grossFoodMinor:1250,restaurantDiscountMinor:250,subtotalMinor:1000,deliveryFeeMinor:150,totalMinor:1150,refundedTotalMinor:300,items:[{name:'<Bowl>',quantity:1,lineTotalMinor:1250},{name:'Gift',quantity:1,lineTotalMinor:0,isOfferItem:true}]});
 assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<img'));assert.ok(html.includes('&lt;Bowl&gt;'));for(const value of ['£12.50','−£2.50','£10.00','£1.50','£11.50','£3.00','Free offer'])assert.ok(html.includes(value));assert.ok(!html.includes('VAT'));assert.ok(html.includes('/api/orders/order-123/receipt.pdf'));assert.ok(html.includes('Download PDF receipt'));assert.ok(!html.includes('print-jobs'));
});
test("navigation icons are fixed accessible SVGs rather than arbitrary markup",()=>{for(const name of ['discover','orders','offers','messages','account','basket']){assert.match(customerIcon(name),/aria-hidden="true"/);assert.match(customerIcon(name),/viewBox="0 0 24 24"/);}assert.equal(customerIcon('<script>'),customerIcon('discover'));});

test("a fully voucher-funded scheduled receipt separates restaurant value from customer payment",()=>{
 const html=customerReceiptHtml({id:"voucher-order",restaurantName:"Kitchen",createdAt:"2026-11-04T12:00:00Z",scheduledFor:"2026-11-05T18:00:00Z",status:"placed",fulfillment:"delivery",paymentStatus:"voucher_reserved",subtotalMinor:1350,deliveryFeeMinor:275,totalMinor:1625,customerPayableMinor:0,platformVoucherMinor:1625,items:[]});
 assert.match(html,/<dt>Order value<\/dt><dd>£16.25/);assert.match(html,/<dt>Cal-Eats voucher<\/dt><dd>−£16.25/);assert.match(html,/<dt>Your total<\/dt><dd>£0.00/);assert.match(html,/Scheduled delivery/);assert.match(html,/5 Nov 2026/);assert.ok(html.includes('/api/orders/voucher-order/receipt"'));assert.ok(html.includes('Open printable receipt'));
});
