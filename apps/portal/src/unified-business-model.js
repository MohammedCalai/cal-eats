export const BUSINESS_PRODUCTS = ["calai", "cal-eats"];
export const productName = product => product === "calai" ? "Calai" : "Cal-Eats";
export const productControlLabel = product => product === "calai" ? "Allow Calai connection in the combined workspace" : "Enable Cal-Eats";
export function businessToolPermissions({permission,capabilities={},principalKind="human"}={}){
  const human=principalKind!=="terminal",owner=human&&permission==="owner";
  return{viewFinance:human&&(owner||capabilities.viewFinance===true),viewDevices:human&&(owner||capabilities.viewDevices===true),manageMenu:human&&(owner||capabilities.manageMenu===true),manageMarketing:human&&(owner||capabilities.manageMarketing===true),manageBank:owner,manageSettings:owner,manageStaff:owner,acceptOrders:false};
}
export function terminalSetupDocument(value,{businessId,apiOrigin,now=Date.now()}={}){
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if(value?.schemaVersion!==1||value.product!=="calai-business-terminal"||value.businessId!==businessId||!uuid.test(value.terminalId||"")||value.apiBaseUrl!==apiOrigin||!/^[A-Za-z0-9_-]{32}$/.test(value.code||"")||!/^[A-Za-z0-9_-]{43}$/.test(value.challenge||"")||!Number.isFinite(Date.parse(value.expiresAt))||Date.parse(value.expiresAt)<=now||Date.parse(value.expiresAt)>now+11*60_000)throw Error("The tablet setup could not be verified. Request a new setup file.");
  return JSON.stringify({schemaVersion:1,product:value.product,apiBaseUrl:value.apiBaseUrl,businessId:value.businessId,terminalId:value.terminalId,code:value.code,challenge:value.challenge,expiresAt:value.expiresAt},null,2)+"\n";
}
export function operationalTabletFor(businessId, restaurantId, snapshot) {
  return Boolean(businessId && restaurantId && snapshot?.status === "ready" && snapshot.context?.principalKind === "terminal" && snapshot.context.businessId === businessId && snapshot.context.restaurantId === restaurantId);
}
export function applyTabletProductAccess(business, tabletContext) {
  if (!business || tabletContext?.principalKind !== "terminal" || tabletContext.id !== business.id) return business;
  const products = { ...business.products };
  for (const product of BUSINESS_PRODUCTS) {
    const allowedOnTablet = tabletContext.products?.[product]?.allowedOnTablet;
    if (products[product] && typeof allowedOnTablet === "boolean") {
      products[product] = { ...products[product], allowedOnTablet };
    }
  }
  return { ...business, products };
}
export function productPresentation(business, product) {
  const value = business?.products?.[product] || {};
  const nativeAccountId = value.nativeAccountId || value.sourceAccountId || null;
  const linked = value.linked === true && Boolean(nativeAccountId);
  const allowed = value.adminAllowed === true;
  const ready = value.readiness?.ready === true;
  const status = value.effectiveStatus || (allowed ? "setup_required" : "admin_off");
  const labels = { admin_off: "Disabled by administrator", setup_required: "Setup required", ready: "Ready", unavailable: "Connection unavailable" };
  return { ...value, product, name: productName(product), nativeAccountId, linked, allowed, ready, status, label: labels[status] || "Status unavailable", tasks: Array.isArray(value.readiness?.tasks) ? value.readiness.tasks : [], usable: allowed && linked && ready && status === "ready" && value.allowedOnTablet !== false, canConnect: allowed && value.canConnect !== false, financialAccess: value.financialAccess === true };
}
export function canConnectBusinessProduct(business, product) {
  if (!BUSINESS_PRODUCTS.includes(product) || business?.principalKind === "terminal" || business?.canConnectProducts !== true) return false;
  return productPresentation(business, product).canConnect === true;
}
export function calaiTabletAuthorizationPath(business) {
  const calai = productPresentation(business, "calai");
  if (!business?.id || business.principalKind !== "human" || business.canManageProducts === true || business.canViewCalai !== true ||
      !canConnectBusinessProduct(business, "calai") || !calai.linked || !calai.ready || calai.status !== "ready") return null;
  return `/api/business/accounts/${encodeURIComponent(business.id)}/terminals/calai-authorization`;
}
export function canLoadEatsRestaurantWorkspace(business) {
  return Boolean(business?.eatsRestaurantId && business.canViewEats === true &&
    business.products?.["cal-eats"]?.allowedOnTablet !== false);
}
export function businessNavigation(business, eatsNavigation = []) {
  const calai = productPresentation(business, "calai"), eats = productPresentation(business, "cal-eats");
  const dashboard = ["Dashboard", "/owner/dashboard"], showEats = eats.linked && eats.allowedOnTablet !== false;
  const eatsItems = showEats ? eatsNavigation.filter(([, path]) => path !== "/owner/dashboard" && path !== "/owner/devices") : [];
  return [
    ...(calai.usable ? [
      { title: "", items: [dashboard] },
      { title: "Calai", items: [["Calai orders", "/owner/calai/orders"], ["Calai calls", "/owner/calai/calls"], ["Calai settings", "/owner/calai/settings"]] },
      ...(showEats ? [{ title: "Cal-Eats", items: eatsItems }] : []),
    ] : [{ title: "", items: [dashboard, ...eatsItems] }]),
    { title: "Account", items: [["Accounts & connections", "/owner/connections"], ["Statements", "/owner/statements"]] },
  ];
}
export function counterPresentation(counter, product) {
  const available = counter?.available === true && Number.isSafeInteger(counter.today) && counter.today >= 0;
  return { product, label: productName(product), available, value: available ? counter.today.toLocaleString("en-GB") : "Unavailable", explanation: available ? "Orders placed today" : "A current count could not be confirmed" };
}
export function safeNativeLink(value, fallback = null) {
  if (typeof value !== "string") return fallback;
  try { const url = new URL(value); return url.origin === "https://calai.info" && !url.username && !url.password ? url.href : fallback; } catch { return fallback; }
}
export function accountDirectoryQuery({ q = "", product = "all", page = 1 } = {}) {
  const query = new URLSearchParams({ page: String(Math.max(1, Math.floor(Number(page) || 1))), pageSize: "25" });
  if (q.trim()) query.set("q", q.trim().slice(0, 100));
  if (["calai", "cal-eats", "both"].includes(product)) query.set("product", product);
  return query.toString();
}
export function connectionConfirmation(product, proof, confirmed) {
  if (!BUSINESS_PRODUCTS.includes(product) || !confirmed || typeof proof?.connectionToken !== "string" || !proof.connectionToken || typeof proof?.sourceAccount?.id !== "string" || !proof.sourceAccount.id) throw Error("Verify the account and confirm the correct restaurant and branch first.");
  const merge = proof.mergeRequired;
  if (merge && (typeof merge.businessId !== "string" || !merge.businessId || merge.businessId.length > 100)) throw Error("Verify the existing workspace association again.");
  return { connectionToken: proof.connectionToken, ...(product === "calai" ? { expectedBusinessId: proof.sourceAccount.id } : { restaurantId: proof.sourceAccount.id }), confirmLocation: true, ...(merge ? { confirmMergeBusinessId: merge.businessId } : {}) };
}
export function deviceStateLabel(state) {
  return ({ online: "Online", offline_sign_in_required: "Offline — sign-in required", offline_connection_lost: "Offline — connection lost", closed: "Closed", disabled_by_admin: "Disabled by admin", setup_required: "Setup required", monitoring_unavailable: "Monitoring unavailable" })[state] || "Monitoring unavailable";
}
