import test from "node:test";
import assert from "node:assert/strict";
import {createStripeTestAdapter,StripeTestConfigurationError} from "../src/payments/stripe-test.js";

test("adjustment credit uses a standalone funded transfer with exact metadata, never an order source charge",async()=>{
  const requests=[],input={adjustmentId:"adjustment-fixture",restaurantId:"restaurant-fixture",accountId:"acct_restaurant",amountMinor:700,operationKey:"business-adjustment:stripe_test:adjustment-fixture",transferGroup:"adjustment:adjustment-fixture",idempotencyKey:"business-adjustment:stripe_test:adjustment-fixture"};
  const adapter=createStripeTestAdapter({secretKey:"rk_test_mock_only",allowTestTransport:true,baseUrl:"https://mock.invalid",fetchImpl:async(url,init)=>{requests.push({path:url.pathname,init});return new Response(JSON.stringify(url.pathname==="/v1/balance"?{object:"balance",livemode:false,available:[{currency:"gbp",amount:700},{currency:"usd",amount:99000}]}:{id:"tr_adjustment",object:"transfer",livemode:false,amount:700,currency:"gbp",destination:"acct_restaurant",source_transaction:null,transfer_group:input.transferGroup,metadata:{operation_key:input.operationKey,adjustment_id:input.adjustmentId,restaurant_id:input.restaurantId,purpose:"business_adjustment_credit"}}),{status:200,headers:{"content-type":"application/json"}});}});
  assert.deepEqual(await adapter.retrieveAvailableBalance(),{ok:true,status:"confirmed",mode:"stripe_test",currency:"GBP",availableMinor:700});const result=await adapter.createAdjustmentTransfer(input),fields=new URLSearchParams(requests[1].init.body);
  assert.equal(requests[1].path,"/v1/transfers");assert.equal(requests[1].init.headers["Idempotency-Key"],input.idempotencyKey);assert.equal(fields.get("amount"),"700");assert.equal(fields.get("source_transaction"),null);assert.equal(fields.get("metadata[order_id]"),null);assert.equal(fields.get("metadata[purpose]"),"business_adjustment_credit");assert.equal(result.operationKey,input.operationKey);assert.equal(result.adjustmentId,input.adjustmentId);assert.equal(result.restaurantId,input.restaurantId);assert.equal(result.destinationAccountId,input.accountId);
  await assert.rejects(()=>adapter.createAdjustmentTransfer({...input,transferGroup:"order:unrelated"}),TypeError);
});
test("available funding response refuses a wrong provider mode or invalid amount",async()=>{
  for(const response of[{object:"balance",livemode:true,available:[{currency:"gbp",amount:700}]},{object:"balance",livemode:false,available:[{currency:"gbp",amount:7.5}]}]){
    const adapter=createStripeTestAdapter({secretKey:"rk_test_mock_only",fetchImpl:async()=>new Response(JSON.stringify(response),{status:200})});await assert.rejects(()=>adapter.retrieveAvailableBalance(),StripeTestConfigurationError);
  }
});
