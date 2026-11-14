import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import vm from "node:vm";

test("the business application collects contact details without a password while customer signup retains its password",()=>{
  const source=readFileSync(new URL("../app.js",import.meta.url),"utf8"),start=source.indexOf("function renderAuth(note"),end=source.indexOf("\nfunction renderForgotPassword",start);
  assert.ok(start>=0&&end>start);
  const main={innerHTML:""},context={main,state:{runtime:{demoShortcuts:false}},document:{body:{dataset:{}},querySelector(){return{};}},location:{search:"?view=register-restaurant"},preserveCustomerWebFlow:()=>true,stopPolling(){},mountCustomerLegal:()=>({close(){}}),api(){},e:value=>String(value)};
  vm.runInNewContext(source.slice(start,end)+";renderAuth();",context);
  const business=main.innerHTML.match(/<form[^>]+id="restaurant-register-form"[\s\S]*?<\/form>/)?.[0],customer=main.innerHTML.match(/<form[^>]+id="register-form"[\s\S]*?<\/form>/)?.[0];
  assert.ok(business);assert.ok(customer);
  for(const name of ["name","restaurantName","address","mobile","email"])assert.ok(business.includes(`name="${name}"`));
  assert.doesNotMatch(business,/type="password"|name="password"|Set new password/);assert.match(business,/prepare your business login/);assert.match(business,/72 hours/);
  assert.match(customer,/name="password"/);assert.match(customer,/data-customer-legal/);
});
