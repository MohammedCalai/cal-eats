import test from "node:test";
import assert from "node:assert/strict";
import {journeyFixture} from "./helpers.js";

test("live checkout blocks cash even with an older cash preference; owners cannot enable it, while test cash remains available",async()=>{
  for(const mode of ["local_simulator","stripe_test","stripe_live"]){
    const stripe=mode!=="local_simulator";
    const f=await journeyFixture({orderAlertEmail:{mode:"off"},liveOnboardingRestaurantIds:[],...(stripe?{paymentProviderMode:mode,paymentProvider:{mode},stripePlatformAccountId:"acct_cardonlyfixture",paymentProviderWebhookSecret:"whsec_platform_cardonlyfixture",paymentProviderConnectWebhookSecret:"whsec_connect_cardonlyfixture"}:{}),...(mode==="stripe_live"?{runMode:"hosted-preview",nodeEnv:"production",origin:"https://eats.example.test",livePaymentsEnabled:true}: {})});
    const json=(route,options={})=>f.json(route,{...options,headers:{origin:f.config.origin,...options.headers}});
    const login=async(email,password)=>{const result=await json("/api/auth/login",{method:"POST",body:{email,password}});assert.equal(result.status,200,result.text);return result.headers.get("set-cookie").split(";",1)[0];};
    try{
      const owner=await login("restaurant@calai.local","LocalRestaurant!4310"),customer=await login("customer@calai.local","LocalCustomer!4310");
      const restaurant=(await json("/api/restaurant/restaurants",{cookie:owner})).body.data[0],profile=`/api/restaurant/restaurants/${restaurant.id}/profile`;
      assert.equal((await json(profile,{method:"PATCH",cookie:owner,body:{cashEnabled:false}})).status,200);
      const enabled=await json(profile,{method:"PATCH",cookie:owner,body:{cashEnabled:true}});
      const payment=(await json("/api/payments/config")).body.data;
      if(mode==="stripe_live"){
        assert.equal(enabled.status,409,enabled.text);assert.equal(enabled.body.error.code,"LIVE_CARD_ONLY");
        assert.equal(f.db.prepare("SELECT cash_enabled FROM restaurants WHERE id=?").get(restaurant.id).cash_enabled,0);
        assert.equal(payment.cashAvailable,false);
        // A pre-launch preference must never bypass the live checkout restriction.
        f.db.prepare("UPDATE restaurants SET cash_enabled=1 WHERE id=?").run(restaurant.id);
      }else{assert.equal(enabled.status,200,enabled.text);assert.equal(payment.cashAvailable,true);}
      const item=(await json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0];
      const before=Object.fromEntries(["orders","ledger_entries","marketplace_operations"].map(table=>[table,f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n]));
      const placed=await json("/api/orders",{method:"POST",cookie:customer,headers:{"Idempotency-Key":`cash-policy-${mode}`},body:{restaurantId:restaurant.id,items:[{menuItemId:item.id,quantity:1}],fulfillment:"collection",paymentMethod:"cash"}});
      if(mode==="stripe_live"){
        assert.equal(placed.status,409,placed.text);assert.equal(placed.body.error.code,"LIVE_CARD_ONLY");
        for(const [table,count]of Object.entries(before))assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,count,`No ${table} mutation for refused cash checkout`);
        const admin=await login("admin@calai.local","LocalAdmin!4310"),report=(await json("/api/admin/finance/payment-launch",{cookie:admin})).body.data;
        assert.equal(report.checks.find(row=>row.id==="cash_collection").state,"ready");assert.equal(report.paymentPolicy.cardOnly,true);assert.equal(report.commission.cashCommissionCollection,"disabled");
      }else{assert.equal(placed.status,201,placed.text);assert.equal(placed.body.data.paymentMethod,"cash");}
    }finally{await f.close();}
  }
});
