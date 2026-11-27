import { calaiTabletAssignment } from "./calai-tablet-startup.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const nativeOrigin = "https://calai.info";
export const configurationChanged = "cal-eats-tablet-configuration-changed";
export function nativeWatch(event, parent) {
  const data = event.data;
  return event.source === parent && event.origin === nativeOrigin && data?.type === "cal-eats-workspace:watch-mode" &&
    data.version === 1 && uuid.test(data.nonce) && uuid.test(data.businessId) && uuid.test(data.tabletId) &&
    ["both","calai"].includes(data.hostMode) ? data : null;
}
export function sameConfiguration(current, observed) {
  return Boolean(current && observed && uuid.test(current.tabletId) && current.tabletId === observed.tabletId &&
    Number.isSafeInteger(current.revision) && current.revision > 0 && current.revision === observed.revision &&
    ["cal-eats","both","calai"].includes(current.selection) && current.selection === observed.selection);
}
async function waitForSave(ticket, signal) {
  const result = await fetch("/api/business/tablet-mode-watch", {method:"POST", signal, credentials:"omit", cache:"no-store",
    redirect:"error", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ticket})});
  if (!result.ok) throw Error("The tablet settings connection closed.");
}
// Keep a single same-origin wait outside the Windows signing process. The
// response carries no settings and only wakes the next authenticated read.
export function startTabletModeWatch({ read, observed, wait = waitForSave, schedule = setTimeout, cancel = clearTimeout }) {
  const controller = new AbortController(), {signal} = controller;
  let retry, failures = 0;
  async function check() {
    try {
      const {ticket,tabletConfiguration} = await read(signal);
      if (signal.aborted) return;
      if (!sameConfiguration(tabletConfiguration,tabletConfiguration) || !/^[A-Za-z0-9_-]{43}$/.test(ticket))
        throw Error("Invalid tablet settings.");
      await observed(tabletConfiguration,signal);
      if (signal.aborted) return;
      const timeout = AbortSignal.timeout(55000);
      await wait(ticket,AbortSignal.any([signal,timeout]));
      failures = 0;
    } catch { failures++; }
    if (!signal.aborted) retry = schedule(check, failures ? Math.min(30000, 1000 * 2 ** Math.min(5,failures-1)) : 0);
  }
  void check();
  return () => { controller.abort(); cancel(retry); };
}
export function readMode(request,businessId,signal) {
  return request(`/api/business/accounts/${businessId}/surface/heartbeat`,{method:"POST",signal,body:JSON.stringify({state:"watch_configuration"})});
}

export async function publishNativeMode({challenge, observed, signal, status, request, publish}) {
  const {businessId,tabletId,hostMode,nonce} = challenge;
  if (signal.aborted || tabletId !== observed.tabletId) return;
  const terminal = status(), context = await request("/api/business/context",{signal});
  if (signal.aborted || terminal.status !== "ready" || terminal.paired !== true || terminal.context?.businessId !== businessId ||
      terminal.context.principalKind !== "terminal" || context.id !== businessId || context.principalKind !== "terminal" ||
      !sameConfiguration(context.tabletConfiguration,observed)) return;
  const {selection,revision} = observed;
  if (selection === "cal-eats") {
    const eats = context.products?.["cal-eats"];
    if (!context.canViewEats || !eats?.allowedOnTablet || !eats.linked || !eats.active || !eats.readiness?.ready) return;
  } else {
    const assignment = calaiTabletAssignment(terminal,context,businessId);
    if (!assignment?.authorised) return;
    const renderedCalai = hostMode === "calai" && selection === "calai" && !observed.receivedAt &&
      typeof challenge.renderedTenantId === "string" && challenge.renderedTenantId === context.products.calai.sourceAccountId;
    if (hostMode !== selection || renderedCalai) {
      const state = renderedCalai ? "calai_rendered" : selection === "both" ? "open_both" : "confirm_calai_launch";
      const result = await request(`/api/business/accounts/${businessId}/surface/heartbeat`,{method:"POST",signal,
        body:JSON.stringify({state,configurationTabletId:tabletId,configurationRevision:revision,
          ...(renderedCalai ? {nativeAccountId:challenge.renderedTenantId} : {})})});
      if (!sameConfiguration(result?.tabletConfiguration,observed)) return;
    }
  }
  const current = status();
  if (signal.aborted || current.status !== "ready" || current.context?.terminalId !== terminal.context.terminalId ||
      current.context.businessId !== businessId) return;
  publish({type:"cal-eats-workspace:mode",version:1,nonce,selection,businessId,tabletId,revision});
}
