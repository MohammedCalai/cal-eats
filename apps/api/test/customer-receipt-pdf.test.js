import test from "node:test";
import assert from "node:assert/strict";
import {PDFParse} from "pdf-parse";
import {journeyFixture} from "./helpers.js";
import {createCustomerReceiptPdf,receiptPdfFilename} from "../src/customer-receipt-pdf.js";
import {customerOrderHistoryCutoff} from "../src/customer-order-history.js";
async function readPdf(buffer){const parser=new PDFParse({data:new Uint8Array(buffer)});try{return await parser.getText();}finally{await parser.destroy();}}

test("completed PDF preserves saved customer amounts and text without merchant finance or personal notes; access and history cannot be bypassed",async()=>{
  const now=new Date("2026-01-01T01:00:00Z"),f=await journeyFixture({now:()=>now,orderAlertEmail:{mode:"off"}});
  try{
    const customer=await f.login("customer@calai.local","LocalCustomer!4310"),owner=await f.login("restaurant@calai.local","LocalRestaurant!4310"),other=await f.login("restaurant2@calai.local","LocalRestaurant2!4310"),admin=await f.login("admin@calai.local","LocalAdmin!4310");
    const restaurant=(await f.json("/api/restaurant/restaurants",{cookie:owner})).body.data[0],item=(await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0];
    const placed=await f.json("/api/orders",{method:"POST",cookie:customer,headers:{"Idempotency-Key":"pdf-receipt-check"},body:{restaurantId:restaurant.id,items:[{menuItemId:item.id,quantity:2}],fulfillment:"collection",paymentMethod:"mock_card"}});assert.equal(placed.status,201,placed.text);
    const id=placed.body.data.id,path=`/api/orders/${id}/receipt.pdf`;
    assert.equal((await f.request(path)).status,401);assert.equal((await f.json(path,{cookie:customer})).body.error.code,"RECEIPT_NOT_READY");assert.equal((await f.request(path,{cookie:other})).status,404);
    f.db.prepare("UPDATE orders SET status='completed',payment_status='stripe_captured',gross_food_minor=2000,restaurant_discount_minor=500,subtotal_minor=1500,delivery_fee_minor=250,total_minor=1750,customer_payable_minor=1250,platform_voucher_minor=500,allergy_notes='Secret allergy note',customer_email='private@example.invalid',delivery_address=? WHERE id=?").run(JSON.stringify({line1:"42 Private Road",postcode:"LU1 1AA"}),id);
    f.db.prepare("UPDATE order_items SET name='Café Ελληνικά 中文',quantity=2,unit_price_minor=1000,selected_modifiers=? WHERE order_id=?").run(JSON.stringify([{name:"Extra mint"}]),id);
    const result=await f.request(path,{cookie:customer});assert.equal(result.status,200);assert.equal(result.headers.get("content-type"),"application/pdf");assert.equal(result.headers.get("cache-control"),"private, no-store");assert.equal(result.headers.get("x-content-type-options"),"nosniff");assert.match(result.headers.get("content-disposition"),/^attachment; filename="Cal-Eats-receipt-[a-z0-9-]+\.pdf"$/);assert.equal(result.bodyBuffer.subarray(0,5).toString(),"%PDF-");
    const pdf=await readPdf(result.bodyBuffer);for(const value of ["Café","Ελληνικά","[U+4E2D]","Extra mint","£20.00","-£5.00","£15.00","£2.50","£17.50","£12.50","Card payment received"])assert.ok(pdf.text.includes(value),value);
    assert.doesNotMatch(pdf.text,/commission|provider fee|VAT|Secret allergy|private@example|Private Road/i);
    assert.equal((await f.request(path,{cookie:owner})).status,200);assert.equal((await f.request(path,{cookie:admin})).status,200);
    f.db.prepare("UPDATE users SET role='customer' WHERE email='restaurant2@calai.local'").run();assert.equal((await f.request(path,{cookie:other})).status,404);
    f.db.prepare("UPDATE orders SET created_at=? WHERE id=?").run(customerOrderHistoryCutoff(now),id);assert.equal((await f.request(path,{cookie:customer})).status,404);assert.equal((await f.request(path,{cookie:owner})).status,200);
  }finally{await f.close();}
});

test("long item snapshots paginate cleanly and filenames/output are bounded",async()=>{
  const order={id:"sample-order",restaurantName:"Cal-Eats Sample Kitchen",createdAt:"2026-11-10T12:00Z",fulfillment:"collection",paymentStatus:"cash_collected",subtotalMinor:5000,deliveryFeeMinor:0,totalMinor:5000,items:Array.from({length:50},(_,i)=>({name:`Dish ${i+1} with a carefully prepared selection`,quantity:1,lineTotalMinor:100,selectedModifiers:[{name:"Mild spices, extra vegetables, rice and a freshly prepared sauce"}]}))};
  const buffer=await createCustomerReceiptPdf(order),pdf=await readPdf(buffer);assert.ok(pdf.pages.length>1);assert.ok(pdf.text.includes("Dish 1"));assert.ok(pdf.text.includes("Dish 50"));assert.ok(pdf.text.includes("£50.00"));assert.ok(buffer.length<2*1024*1024);
  assert.equal(receiptPdfFilename('a"\r\nHeader: value/../../'),"Cal-Eats-receipt-aHeadervalue.pdf");
  await assert.rejects(createCustomerReceiptPdf({...order,items:Array(101).fill(order.items[0])}),/limit/);
});
