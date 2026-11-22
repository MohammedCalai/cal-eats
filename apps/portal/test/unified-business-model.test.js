import test from "node:test";
import assert from "node:assert/strict";
import { productPresentation, businessNavigation, counterPresentation, connectionConfirmation, safeNativeLink, accountDirectoryQuery, productControlLabel, operationalTabletFor,terminalSetupDocument,businessToolPermissions,canConnectBusinessProduct } from "../src/unified-business-model.js";
import {ownerNavigation,ownerMobileNavigation} from "../src/model.js";
const product = (id, extra = {}) => ({ linked:true,nativeAccountId:id,adminAllowed:true,readiness:{ready:true,tasks:[]},effectiveStatus:"ready",...extra });
test("native owners can connect permitted products without administrator service controls; staff and tablets cannot",()=>{
  const owner={principalKind:"human",canManageProducts:false,canConnectProducts:true,products:{calai:product("calai-native",{linked:false,readiness:{ready:false,tasks:[]},effectiveStatus:"setup_required"}),"cal-eats":product("eats-native")}};
  assert.equal(canConnectBusinessProduct(owner,"calai"),true,"The actual native owner DTO has administrator controls disabled");
  assert.equal(canConnectBusinessProduct(owner,"cal-eats"),true,"An owner can verify an existing permitted connection");
  for(const candidate of [{...owner,canConnectProducts:false},{...owner,canConnectProducts:undefined},{...owner,canManageProducts:true,canConnectProducts:false},{...owner,principalKind:"terminal"}]){
    for(const kind of ["calai","cal-eats"])assert.equal(canConnectBusinessProduct(candidate,kind),false);
  }
  assert.equal(canConnectBusinessProduct({...owner,products:{...owner.products,calai:product("native",{adminAllowed:false})}},"calai"),false,"An owner's connection authority cannot bypass administrator disablement");
  assert.equal(canConnectBusinessProduct({...owner,products:{...owner.products,calai:product("native",{canConnect:false})}},"calai"),false);
  assert.equal(canConnectBusinessProduct(owner,"arbitrary-product"),false);
  assert.equal(owner.canManageProducts,false,"Connection visibility does not add service enable/disable controls");
});
test("independent native staff tool permissions expose only permitted tools and keep banking, legal and settings with owners",()=>{
 const ordinary=businessToolPermissions({permission:"staff"});assert.ok(Object.values(ordinary).every(value=>value===false));
 const manager=businessToolPermissions({permission:"staff",capabilities:{viewFinance:true,manageMenu:true,manageMarketing:true,viewDevices:true}});
 assert.equal(manager.viewFinance,true);assert.equal(manager.manageMenu,true);assert.equal(manager.manageMarketing,true);assert.equal(manager.manageBank,false);assert.equal(manager.manageSettings,false);assert.equal(manager.manageStaff,false);assert.equal(manager.acceptOrders,false);
 const paths=ownerNavigation("staff",manager).map(([,path])=>path);assert.ok(paths.includes("/owner/earnings"));assert.ok(paths.includes("/owner/offers"));assert.ok(paths.includes("/owner/printers"));for(const path of["/owner/settings","/owner/agreement","/owner/customers","/owner/inbox"])assert.ok(!paths.includes(path));
 assert.ok(ownerMobileNavigation("staff",manager).some(([,path])=>path==="/owner/offers"));
 assert.ok(!ownerNavigation("staff").some(([,path])=>["/owner/earnings","/owner/offers","/owner/printers"].includes(path)));
 for(const principal of [{permission:"owner",principalKind:"terminal",capabilities:{viewFinance:true,manageMenu:true,manageMarketing:true}},{permission:"staff",capabilities:{viewFinance:"true",manageMenu:1,manageMarketing:"yes"}}])assert.ok(Object.values(businessToolPermissions(principal)).every(value=>value===false));
 const owner=businessToolPermissions({permission:"owner"});assert.equal(owner.manageBank,true);assert.equal(owner.manageSettings,true);assert.equal(owner.acceptOrders,false);
});
test("one-use tablet download is scoped, short-lived and contains only reviewed enrolment fields",()=>{
 const now=Date.parse("2026-11-22T12:00:00Z"),scope={businessId:"restaurant-a",apiOrigin:"https://eats.calai.info",now},setup={schemaVersion:1,product:"calai-business-terminal",businessId:scope.businessId,apiBaseUrl:scope.apiOrigin,terminalId:"11111111-1111-4111-8111-111111111111",code:"a".repeat(32),challenge:"b".repeat(43),expiresAt:new Date(now+600000).toISOString(),privateServerToken:"must not download"};
 const result=JSON.parse(terminalSetupDocument(setup,scope));assert.equal(result.privateServerToken,undefined);assert.equal(result.terminalId,setup.terminalId);
 for(const mutation of [{businessId:"another-restaurant"},{apiBaseUrl:"https://attacker.invalid"},{expiresAt:new Date(now).toISOString()},{expiresAt:new Date(now+3600000).toISOString()},{code:"arbitrary"},{product:"other-app"}])assert.throws(()=>terminalSetupDocument({...setup,...mutation},scope),/could not be verified/);
});
test("an actual ready terminal matches both the native restaurant and association before presenting processing controls",()=>{
 const state={status:"ready",context:{principalKind:"terminal",businessId:"location-a",restaurantId:"restaurant-a"}};
 assert.equal(operationalTabletFor("location-a","restaurant-a",state),true);
 for(const [businessId,restaurantId,snapshot]of[["location-b","restaurant-a",state],["location-a","restaurant-b",state],["location-a","restaurant-a",{...state,status:"offline"}],["location-a","restaurant-a",{...state,context:{...state.context,principalKind:"human"}}]])assert.equal(operationalTabletFor(businessId,restaurantId,snapshot),false);
});
test("permission, native connection and setup remain independent and neither absent account becomes ready",()=>{
  assert.equal(productPresentation({products:{}},"cal-eats").usable,false);
  for(const change of [{adminAllowed:false},{linked:false},{readiness:{ready:false}},{effectiveStatus:"unavailable"},{nativeAccountId:null}])assert.equal(productPresentation({products:{calai:product("native",change)}},"calai").usable,false);
  assert.equal(productPresentation({products:{calai:product("native")}},"calai").usable,true);
  assert.equal(productPresentation({products:{calai:product("native")}},"calai").financialAccess,false);
});
test("colliding product account references stay labelled separately and Calai navigation precedes Cal-Eats",()=>{
  const business={products:{calai:product("same-id"),"cal-eats":product("same-id")}};
  const groups=businessNavigation(business,[["Dashboard","/owner/dashboard"],["Orders","/owner/orders"]]);
  assert.deepEqual(groups.map(row=>row.title),["Workspace","Calai","Cal-Eats"]);
  assert.equal(groups[2].items.filter(([,path])=>path==="/owner/dashboard").length,0);
  business.products.calai.adminAllowed=false;
  assert.deepEqual(businessNavigation(business,[["Orders","/owner/orders"]]).map(row=>row.title),["Workspace","Cal-Eats"]);
});
test("an unavailable source is not displayed as zero and a genuine zero remains zero",()=>{
  assert.equal(counterPresentation({today:0,available:false},"calai").value,"Unavailable");
  assert.equal(counterPresentation({today:null,available:true},"calai").value,"Unavailable");
  assert.equal(counterPresentation({today:0,available:true},"cal-eats").value,"0");
  assert.equal(counterPresentation({today:-1,available:true},"cal-eats").available,false);
});
test("account linking requires verified proof and explicit branch confirmation and sends no password",()=>{
  const proof={connectionToken:"server-proof",sourceAccount:{id:"native-owner-account",name:"Correct branch"}};
  assert.throws(()=>connectionConfirmation("calai",proof,false),/confirm/);
  assert.throws(()=>connectionConfirmation("calai",{sourceAccount:{id:"arbitrary"}},true),/Verify/);
  assert.deepEqual(connectionConfirmation("calai",proof,true),{connectionToken:"server-proof",expectedBusinessId:"native-owner-account",confirmLocation:true});
  assert.deepEqual(connectionConfirmation("cal-eats",proof,true),{connectionToken:"server-proof",restaurantId:"native-owner-account",confirmLocation:true});
  assert.equal(connectionConfirmation("calai",{...proof,mergeRequired:{businessId:"verified-existing-workspace"}},true).confirmMergeBusinessId,"verified-existing-workspace");
  assert.throws(()=>connectionConfirmation("calai",{...proof,mergeRequired:{businessId:null}},true),/Verify/);
});
test("native links cannot redirect account or statement flows to an arbitrary host",()=>{
  for(const value of ["javascript:alert(1)","https://calai.info.attacker.test/","https://user:secret@calai.info/","//calai.info/","https://eats.calai.info/owner/settings"])assert.equal(safeNativeLink(value),null);
  assert.equal(safeNativeLink("https://calai.info/owner/settings"),"https://calai.info/owner/settings");
});
test("admin directory scopes product filters and control labels remain distinct",()=>{
  const query=new URLSearchParams(accountDirectoryQuery({q:"  native account  ",product:"both",page:-3}));
  assert.equal(query.get("q"),"native account");assert.equal(query.get("product"),"both");assert.equal(query.get("page"),"1");
  assert.equal(new URLSearchParams(accountDirectoryQuery({product:"all"})).has("product"),false);
  assert.equal(productControlLabel("calai"),"Allow Calai connection in the combined workspace");assert.equal(productControlLabel("cal-eats"),"Enable Cal-Eats");
});
