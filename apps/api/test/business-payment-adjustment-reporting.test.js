import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { openDatabase, migrateDatabase } from "../src/db/index.js";
import { paymentAdjustmentDto, listBusinessPaymentAdjustments, paymentAdjustmentCsv, buildPaymentAdjustmentStatement } from "../src/business-payment-adjustment-reporting.js";
import { buildFinanceSummary } from "../src/marketplace-reporting.js";
import { buildOrderFinancialBreakdown } from "../src/finance-details.js";
import { buildWeeklyStatementSnapshot, weeklyStatementPeriod, buildBusinessStatementEmail } from "../src/business-weekly-statements.js";

const stamp="2026-11-14T12:00:00.000Z", mode="stripe_live";
function fixture() {
  const db=openDatabase(":memory:");migrateDatabase(db);
  db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES('admin','Admin','admin@example.invalid','unused','admin',?),('customer','Customer','customer@example.invalid','unused','customer',?)").run(stamp,stamp);
  db.prepare("INSERT INTO restaurants(id,name,status,created_at) VALUES('r','Arndale','approved',?),('other','Other business','approved',?)").run(stamp,stamp);
  db.prepare("INSERT INTO provider_accounts VALUES('account','r',?,'enabled','[\"transfers\",\"card_payments\"]','[]','acct_restaurant',?,?)").run(mode,stamp,stamp);
  db.prepare("INSERT INTO stripe_account_readiness VALUES('r',?,'acct_restaurant',1,1,?)").run(mode,stamp);
  function order(id="order") {
    db.prepare("INSERT INTO orders(id,restaurant_id,restaurant_name,customer_id,status,subtotal_minor,delivery_fee_minor,total_minor,commission_minor,payment_method,payment_status,fulfillment,idempotency_key,request_hash,created_at,updated_at) VALUES(?,'r','Arndale','customer','completed',1000,0,1000,70,'card','stripe_captured','collection',?,?,?,?)").run(id,id,id,stamp,stamp);
    db.prepare("INSERT INTO order_financial_environments VALUES(?,?,'order_created',NULL,?)").run(id,mode,stamp);
    db.prepare("INSERT INTO stripe_order_payments(order_id,provider_mode,payment_intent_id,latest_charge_id,status,created_at,updated_at) VALUES(?,?,?,?,'captured',?,?)").run(id,mode,`pi_${id}`,`ch_${id}`,stamp,stamp);
  }
  function adjustment(id,{direction="deduction",amountMinor=1500,appliedMinor=0,status="confirmed",providerMode=mode,restaurantId="r",reason="Service adjustment",week="2026-11-02"}={}){
    db.prepare("INSERT INTO business_payment_adjustments(id,reference,restaurant_id,direction,amount_minor,currency,reason,effective_week_start,provider_mode,platform_account_id,destination_account_id,status,created_by_user_id,creation_key,payload_hash,applied_minor,created_at,updated_at,confirmed_at) VALUES(?,?,?,?,?,'GBP',?,?,?,'acct_platform','acct_restaurant',?,'admin',?,?,?,?,?,?)").run(id,`ADJ-${id}`,restaurantId,direction,amountMinor,reason,week,providerMode,status,id,id,appliedMinor,stamp,stamp,status==="confirmed"?stamp:null);
    return db.prepare("SELECT * FROM business_payment_adjustments WHERE id=?").get(id);
  }
  function allocation(id,adjustmentId,orderId,amountMinor,appliedMinor=amountMinor,restoredMinor=0,releasedMinor=0){
    const operationKey=`snapshot:${orderId}:${id}`,net=Math.max(930,amountMinor);
    db.prepare("INSERT INTO business_payment_settlements(order_id,restaurant_id,provider_mode,platform_account_id,destination_account_id,operation_key,original_net_minor,deduction_minor,transfer_minor,refund_ids,snapshot_hash,created_at) VALUES(?,'r',?,'acct_platform','acct_restaurant',?,?,?,?, '[]','fixture',?)").run(orderId,mode,operationKey,net,amountMinor,net-amountMinor,stamp);
    db.prepare("INSERT INTO business_payment_adjustment_allocations(id,adjustment_id,order_id,settlement_operation_key,amount_minor,applied_minor,restored_minor,released_minor,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id,adjustmentId,orderId,operationKey,amountMinor,appliedMinor,restoredMinor,releasedMinor,stamp,stamp);
    return operationKey;
  }
  function event(adjustmentId,kind,amountMinor,at="2026-11-11T12:00:00.000Z",orderId=null){db.prepare("INSERT INTO business_payment_adjustment_events VALUES(?,?,?,?,?,NULL,'{}',?)").run(randomUUID(),adjustmentId,kind,amountMinor,orderId,at);}
  return {db,order,adjustment,allocation,event};
}

test("adjustment reports separate net applied, reservations, carried balances and dated movements without crossing business or payment mode",()=>{
  const f=fixture();try{
    f.order();const a=f.adjustment("deduction",{reason:"=Visible reason"});f.allocation("allocation",a.id,"order",600,500,100);
    f.adjustment("credit",{direction:"credit",amountMinor:400,appliedMinor:400});f.adjustment("pending-credit",{direction:"credit",amountMinor:200});f.adjustment("draft",{status:"draft"});f.adjustment("testing",{providerMode:"stripe_test"});f.adjustment("other",{restaurantId:"other"});
    f.event(a.id,"deduction_applied",500,"2026-11-10T12:00:00.000Z","order");f.event(a.id,"deduction_restored",100,"2026-11-11T12:00:00.000Z","order");f.event("credit","credit_applied",400);f.event("testing","credit_applied",900);f.event(a.id,"deduction_applied",1,"2026-10-31T12:00:00.000Z","order");
    const dto=paymentAdjustmentDto(f.db,a,{asOf:stamp});assert.equal(dto.appliedMinor,400);assert.equal(dto.reservedMinor,100);assert.equal(dto.pendingMinor,1000);assert.equal(dto.carriedForwardMinor,1000);
    const result=listBusinessPaymentAdjustments(f.db,{restaurantId:"r",providerMode:mode,pageSize:2,now:new Date(stamp),includeDrafts:false});assert.equal(result.items.length,2);assert.equal(result.pagination.total,3);assert.equal(result.pagination.hasNext,true);
    assert.throws(()=>listBusinessPaymentAdjustments(f.db,{providerMode:mode,pageSize:101}),/pagination/i);assert.throws(()=>listBusinessPaymentAdjustments(f.db,{providerMode:mode,weekStart:"2026-11-14"}),/Monday/);
    const statement=buildPaymentAdjustmentStatement(f.db,{restaurantId:"r",scope:"live",from:"2026-11-09T00:00:00.000Z",toExclusive:"2026-11-16T00:00:00.000Z",asOf:stamp});
    assert.equal(statement.items.length,3);assert.equal(statement.creditsAppliedMinor,400);assert.equal(statement.deductionsAppliedMinor,500);assert.equal(statement.deductionsRestoredMinor,100);assert.equal(statement.pendingCreditMinor,200);assert.equal(statement.reservedDeductionMinor,100);assert.equal(statement.carriedForwardDeductionMinor,1000);assert.equal(statement.events.length,3);
    const csv=paymentAdjustmentCsv([dto],{asOf:stamp});assert.match(csv,/'=Visible reason/);assert.match(csv,/bankDepositConfirmed/);assert.match(csv,/"false"/);assert.match(csv,/positionGeneratedAt/);
  }finally{f.db.close();}
});

test("fully withheld earnings are not offered for a second transfer and remain separate from bank-paid history",()=>{
  const f=fixture();try{
    f.order();f.adjustment("withheld",{amountMinor:930});f.allocation("allocation","withheld","order",930);
    f.event("withheld","deduction_applied",930,stamp,"order");
    const summary=buildFinanceSummary(f.db,"r",null,{paymentProviderMode:mode});assert.equal(summary.availableMinor,0);assert.equal(summary.paidTransfersMinor,0);assert.equal(summary.bankPaidMinor,0);assert.equal(summary.commissionMinor,70);assert.equal(summary.netEarningsMinor,930);assert.equal(summary.paymentAdjustments.appliedDeductionMinor,930);
    const order=f.db.prepare("SELECT * FROM orders WHERE id='order'").get(),detail=buildOrderFinancialBreakdown(f.db,order);assert.equal(detail.commission.originalMinor,70);assert.equal(detail.earnings.currentMinor,930);assert.equal(detail.paymentAdjustments.appliedMinor,930);assert.equal(detail.paymentAdjustments.fullyWithheld,true);assert.equal(detail.settlement.state,"adjusted_from_earnings");assert.equal(detail.settlement.bankPayoutAttributed,false);
  }finally{f.db.close();}
});

test("a reservation on a held order does not consume another order's available earnings twice",()=>{
  const f=fixture();try{
    f.order("held");f.order("available");f.adjustment("reserved",{amountMinor:500});f.allocation("allocation","reserved","held",500,0);
    f.db.prepare("INSERT INTO marketplace_operations VALUES('held','order:held:settlement-eligible','r','held','settlement_eligibility','held',930,'GBP',?,NULL,NULL,'{}',?,?)").run(mode,stamp,stamp);
    const summary=buildFinanceSummary(f.db,"r",null,{paymentProviderMode:mode});assert.equal(summary.availableMinor,930);assert.equal(summary.heldMinor,930);assert.equal(summary.paymentAdjustments.reservedDeductionMinor,500);
  }finally{f.db.close();}
});

test("released pre-dispatch reservations do not withhold earnings and cancelled snapshots cannot make a revised settlement look fully withheld",()=>{
  const f=fixture();try{
    f.order();const a=f.adjustment("revised",{amountMinor:1500});
    const cancelled=f.allocation("cancelled","revised","order",930,0,0,930);
    f.db.prepare("INSERT INTO business_payment_settlement_cancellations VALUES(?,'Refund before dispatch','fixture',?)").run(cancelled,stamp);
    f.event(a.id,"deduction_released",930,stamp,"order");
    const active=f.allocation("active","revised","order",400,0,0,0);
    const dto=paymentAdjustmentDto(f.db,a,{asOf:stamp});assert.equal(dto.appliedMinor,0);assert.equal(dto.reservedMinor,400);assert.equal(dto.releasedMinor,930);assert.equal(dto.pendingMinor,1100);
    const detail=buildOrderFinancialBreakdown(f.db,f.db.prepare("SELECT * FROM orders WHERE id='order'").get());assert.equal(detail.paymentAdjustments.items.length,2);assert.equal(detail.paymentAdjustments.items.find(row=>row.settlementOperationKey===cancelled).releasedMinor,930);assert.equal(detail.paymentAdjustments.items.find(row=>row.settlementOperationKey===active).reservedMinor,400);assert.equal(detail.paymentAdjustments.transferMinor,530);assert.equal(detail.paymentAdjustments.fullyWithheld,false);
    const summary=buildFinanceSummary(f.db,"r",null,{paymentProviderMode:mode});assert.equal(summary.availableMinor,530);assert.equal(summary.paymentAdjustments.reservedDeductionMinor,400);assert.equal(summary.paymentAdjustments.releasedDeductionMinor,930);assert.equal(summary.adjustmentsMinor,0);assert.equal(summary.bankPaidMinor,0);
    const statement=buildPaymentAdjustmentStatement(f.db,{restaurantId:"r",scope:"live",from:"2026-11-09T00:00:00.000Z",toExclusive:"2026-11-16T00:00:00.000Z",asOf:stamp});assert.equal(statement.events.length,0,"Reservation releases are audit changes, not financial movements");assert.equal(statement.reservedDeductionMinor,400);assert.equal(statement.pendingDeductionMinor,1100);
  }finally{f.db.close();}
});

test("weekly CSV and email retain reasons and distinguish period movements from the generation-time position",()=>{
  const f=fixture();try{
    f.order();f.adjustment("credit",{direction:"credit",amountMinor:400,appliedMinor:400,reason:"Promotion reimbursement"});f.event("credit","credit_applied",400);
    const config={paymentProviderMode:mode,now:()=>new Date(stamp),origin:"https://fixture.invalid",orderAlertEmail:{from:"support@example.invalid"}},snapshot=buildWeeklyStatementSnapshot(f.db,"r",weeklyStatementPeriod("2026-11-16T09:00:00Z"),config);
    assert.equal(snapshot.summary.paymentAdjustments.creditsAppliedMinor,400);assert.match(snapshot.csv,/business_adjustment_credit_applied/);assert.match(snapshot.csv,/business_adjustment_position/);assert.match(snapshot.csv,/Promotion reimbursement/);assert.match(snapshot.csv,/adjustmentCarriedForwardMinor/);
    const email=buildBusinessStatementEmail({id:"statement",restaurant_id:"r",week_from:"2026-11-09",week_to:"2026-11-15",recipient:"owner@example.invalid",message_id:"fixture",csv:snapshot.csv,summary:JSON.stringify(snapshot.summary)},config);
    assert.match(email.text,/Cal-Eats credits applied this week: £4.00/);assert.match(email.text,/separate from a confirmed bank deposit/);assert.equal(snapshot.summary.bankPayoutRecordedMinor,0);
  }finally{f.db.close();}
});
