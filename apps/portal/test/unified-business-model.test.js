import test from "node:test";
import assert from "node:assert/strict";
import { applyTabletProductAccess, businessWorkspaceMode, canUseCalaiWorkspaceTools, calaiWorkspaceReadPath, productPresentation, businessNavigation, counterPresentation, connectionConfirmation, safeNativeLink, accountDirectoryQuery, productControlLabel, operationalTabletFor,terminalSetupDocument,businessToolPermissions,canConnectBusinessProduct,calaiTabletAuthorizationPath,canLoadEatsRestaurantWorkspace } from "../src/unified-business-model.js";
import {ownerNavigation,ownerMobileNavigation} from "../src/model.js";
import { dashboardOrderActivity, dashboardOrderProducts } from "../src/unified-business-model.js";
const product = (id, extra = {}) => ({ linked:true,nativeAccountId:id,adminAllowed:true,readiness:{ready:true,tasks:[]},effectiveStatus:"ready",...extra });
test("linked Calai tools require current account permission and a matching workspace", () => {
  const business = { principalKind: "terminal", canViewCalai: true, products: { calai: product("native") } };
  assert.equal(canUseCalaiWorkspaceTools(business, "calai"), true);
  assert.equal(canUseCalaiWorkspaceTools(business, "both"), true);
  assert.equal(canUseCalaiWorkspaceTools(business, "cal-eats"), false);
  assert.equal(canUseCalaiWorkspaceTools({ ...business, canViewCalai: false }, "calai"), false);
  assert.equal(canUseCalaiWorkspaceTools({ ...business, products: { calai: product("native", { allowedOnTablet: false }) } }, "both"), false);
});
test("Both previews only supported Calai reads and leaves tablet permissions intact", () => {
  const business = { principalKind: "human", canViewCalai: true, products: { calai: product("native") } };
  assert.equal(calaiWorkspaceReadPath("agents", business, "both"), "/api/business/calai/agents");
  assert.equal(calaiWorkspaceReadPath("item-management", business, "both"), "/api/business/calai/menu");
  assert.equal(calaiWorkspaceReadPath("orders", business, "calai"), "/api/business/calai/orders");
  assert.equal(calaiWorkspaceReadPath("settings", { ...business, principalKind: "terminal" }, "both"), "/api/business/calai/hours");
  for (const section of ["agents", "item-management", "calls", "test-voice", "printer"]) {
    assert.equal(calaiWorkspaceReadPath(section, { ...business, principalKind: "terminal" }, "both"), null);
  }
  for (const section of ["calls", "test-voice", "printer", "../admin"]) {
    assert.equal(calaiWorkspaceReadPath(section, business, "both"), null);
  }
  assert.equal(calaiWorkspaceReadPath("agents", business, "calai"), null);
  assert.equal(calaiWorkspaceReadPath("orders", business, "cal-eats"), null);
  assert.equal(calaiWorkspaceReadPath("orders", { ...business, canViewCalai: false }, "both"), null);
});
test("dashboard order sources respect each product and signed tablet selection", () => {
  const business = {
    id: "branch", eatsRestaurantId: "eats", canViewEats: true, canViewCalai: true,
    products: { calai: product("native"), "cal-eats": product("eats") },
  };
  assert.deepEqual(dashboardOrderProducts(business), ["calai", "cal-eats"]);
  assert.deepEqual(dashboardOrderProducts({ ...business, eatsRestaurantId: null }), ["calai"]);
  assert.deepEqual(dashboardOrderProducts({ ...business, canViewCalai: false }), ["cal-eats"]);
  assert.deepEqual(dashboardOrderProducts({ ...business, products: {
    ...business.products, calai: product("native", { allowedOnTablet: false }),
  } }), ["cal-eats"]);
  assert.deepEqual(dashboardOrderProducts({ ...business, products: {
    ...business.products, calai: product("native", { effectiveStatus: "unavailable", readiness: { ready: false } }),
  } }), ["calai", "cal-eats"]);
});
test("dashboard keeps a known count and rows when the other source is unavailable", () => {
  const products = ["calai", "cal-eats"];
  const calai = { source: "calai", id: "calai:same" };
  const eats = { source: "cal-eats", id: "cal-eats:same" };
  const value = {
    business: { id: "branch" }, counterPeriod: "today",
    counts: { calai: { today: 1, available: true }, "cal-eats": { today: 1, available: true } },
    orders: [calai, eats],
  };
  assert.equal(dashboardOrderActivity(value, "branch", products).total, 2);
  assert.deepEqual(dashboardOrderActivity(value, "branch", ["calai"]).rows, [calai]);
  assert.deepEqual(dashboardOrderActivity(value, "other-branch", products).rows, []);
  value.counts.calai = { today: 0, available: false };
  assert.deepEqual(dashboardOrderActivity(value, "branch", products), {
    counters: [{ product: "calai", count: null }, { product: "cal-eats", count: 1 }], total: null, rows: [eats],
  });
});
test("Calai-only mode does not depend on the denied Cal-Eats restaurants request", () => {
  const business = { eatsRestaurantId: "restaurant-a", canViewEats: true, products: {
    "cal-eats": { allowedOnTablet: true },
  } };
  assert.equal(canLoadEatsRestaurantWorkspace(business), true);
  assert.equal(canLoadEatsRestaurantWorkspace({ ...business, canViewEats: false, principalKind: "terminal" }), false);
  assert.equal(canLoadEatsRestaurantWorkspace({ ...business, products: {
    "cal-eats": { allowedOnTablet: false },
  } }), false, "The signed tablet projection can restrict a human owner session too");
  assert.equal(canLoadEatsRestaurantWorkspace({ ...business, eatsRestaurantId: null }), false);
});
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
test("only the verified business owner can start the tablet approval check, including in Cal-Eats-only mode", () => {
  const owner = { id:"location-a", principalKind:"human", canConnectProducts:true, canViewCalai:true, canManageProducts:false,
    products:{calai:product("native-a",{allowedOnTablet:false})} };
  assert.equal(calaiTabletAuthorizationPath(owner), "/api/business/accounts/location-a/terminals/calai-authorization");
  for (const change of [{principalKind:"terminal"}, {canConnectProducts:false}, {canViewCalai:false}, {canManageProducts:true}, {id:null}]) {
    assert.equal(calaiTabletAuthorizationPath({...owner,...change}), null);
  }
  for (const change of [{linked:false}, {adminAllowed:false}, {readiness:{ready:false}}, {effectiveStatus:"unavailable"}]) {
    assert.equal(calaiTabletAuthorizationPath({...owner, products:{calai:product("native-a",change)}}), null);
  }
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
test("product selection on a paired tablet changes navigation without changing owner permissions", () => {
  const owner = { id: "location-a", principalKind: "human", products: {
    calai: product("native-a"), "cal-eats": product("restaurant-a", { financialAccess: true }),
  } };
  const signed = { id: "location-a", principalKind: "terminal", products: {
    calai: { allowedOnTablet: true }, "cal-eats": { allowedOnTablet: false, financialAccess: false },
  } };
  const navigation = [["Orders", "/owner/orders"], ["Earnings", "/owner/earnings"]];
  const current = applyTabletProductAccess(owner, signed);
  assert.deepEqual(businessNavigation(current, navigation), [{ title: "", items: [
    ["Dashboard", "/owner/dashboard"], ["Agents", "/owner/calai/agents"],
    ["Test Call Window", "/owner/calai/test-voice"], ["Call Summary", "/owner/calai/calls"],
    ["Order list", "/owner/calai/orders"], ["Item Management", "/owner/calai/item-management"],
    ["Printer Management", "/owner/calai/printer"], ["Settings", "/owner/calai/settings"],
  ] }]);
  assert.equal(current.principalKind, "human");
  assert.equal(current.products["cal-eats"].financialAccess, true);
  assert.equal(owner.products["cal-eats"].allowedOnTablet, undefined);
  assert.equal(applyTabletProductAccess(owner, { ...signed, id: "location-b" }), owner);
  assert.equal(applyTabletProductAccess(owner, { ...signed, principalKind: "human" }), owner);
  const eatsOnly = applyTabletProductAccess(owner, { ...signed, products: {
    calai: { allowedOnTablet: false }, "cal-eats": { allowedOnTablet: true },
  } });
  assert.deepEqual(businessNavigation(eatsOnly, navigation)[0].items.map(([, path]) => path), [
    "/owner/dashboard", "/owner/orders", "/owner/earnings",
  ]);
});
test("the tablet layout follows the assigned products when one connection is unavailable", () => {
  const business = { products: {
    calai: product("native", { effectiveStatus: "unavailable" }),
    "cal-eats": product("eats"),
  } };
  const eatsNav = ownerNavigation("staff");
  for (const selection of ["calai", "cal-eats", "both"]) {
    const mode = businessWorkspaceMode(business, { selection });
    assert.equal(mode, selection);
    const groups = businessNavigation(business, eatsNav, mode);
    const items = groups.flatMap(group => group.items.map(([, path]) => path));
    assert.equal(items.filter(path => path === "/owner/dashboard").length, 1);
    assert.equal(items.includes("/owner/calai/agents"), mode !== "cal-eats");
    assert.equal(items.includes("/owner/orders"), mode !== "calai");
    assert.equal(groups.some(group => group.title === "Calai"), mode === "both");
    assert.equal(groups.some(group => group.title === "Cal-Eats"), mode === "both");
  }
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
  assert.deepEqual(groups.map(row=>row.title),["","Calai","Cal-Eats","Account"]);
  assert.equal(groups[2].items.filter(([,path])=>path==="/owner/dashboard").length,0);
  business.products.calai.adminAllowed=false;
  assert.deepEqual(businessNavigation(business,[["Orders","/owner/orders"]]).map(row=>row.title),["","Account"]);
});
test("business tablet navigation retains ordinary tools without a monitoring workspace for any principal",()=>{
  const nativeLinks=[["Dashboard","/owner/dashboard"],["Orders","/owner/orders"],["Printers","/owner/printers"],["Surface & printer","/owner/devices"]];
  for(const principalKind of ["human","terminal"]){
    for(const withCalai of [false,true]){
      const business={principalKind,products:{...(withCalai?{calai:product("calai-account")}:{}),"cal-eats":product("eats-account",{capabilities:{viewDevices:true}})}};
      const groups=businessNavigation(business,nativeLinks),paths=groups.flatMap(group=>group.items.map(([,path])=>path));
      assert.equal(paths.filter(path=>path==="/owner/dashboard").length,1);
      assert.ok(paths.includes("/owner/orders"));
      assert.equal(paths.includes("/owner/printers"),!withCalai,"Cal-Eats provides printer settings when used alone");
      assert.equal(paths.includes("/owner/calai/printer"),withCalai,"Both uses the shared Calai printer settings");
      assert.ok(paths.includes("/owner/connections"));assert.ok(paths.includes("/owner/statements"));
      assert.ok(!paths.includes("/owner/devices"),"Device-health monitoring belongs to the manager phone app");
      assert.ok(groups.every(group=>group.title!=="Workspace"));
      if(withCalai)assert.ok(groups.findIndex(group=>group.title==="Calai")<groups.findIndex(group=>group.title==="Cal-Eats"));
    }
  }
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
