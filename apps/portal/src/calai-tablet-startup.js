const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CALAI_SIGN_IN = "https://calai.info/auth/login?workspace=calai";
const BOTH_DASHBOARD = "https://calai.info/owner/dashboard?workspace=both";
const readyProduct = product => product?.linked === true && product.active === true &&
  product.allowedOnTablet === true && product.readiness?.ready === true;

export function calaiTabletAssignment(terminal, signedContext, businessId) {
  const identity = terminal?.context;
  const selection = signedContext?.tabletConfiguration;
  if (terminal?.status !== "ready" || terminal.paired !== true || !ID.test(identity?.terminalId ?? "") ||
      identity.principalKind !== "terminal" || identity.businessId !== businessId || !ID.test(businessId ?? "") ||
      signedContext?.id !== businessId || signedContext.principalKind !== "terminal" ||
      !(selection?.selection === "calai" || (selection?.selection === "both" && signedContext.nativeBothLaunch === true)) ||
      !ID.test(selection.tabletId ?? "") || !Number.isSafeInteger(selection.revision) || selection.revision < 1) return null;

  return {
    key: [businessId, identity.terminalId, selection.tabletId, selection.revision, selection.selection].join(":"),
    businessId, terminalId: identity.terminalId, tabletId: selection.tabletId, revision: selection.revision,
    selection: selection.selection,
    authorised: signedContext.canViewCalai === true && readyProduct(signedContext.products?.calai) &&
      (selection.selection === "calai" || signedContext.canViewEats === true && readyProduct(signedContext.products?.["cal-eats"])),
  };
}

export function acceptsRenderedBoth(event, parent, origin, assignment) {
  const message = event.data;
  return Boolean(parent && event.source === parent && event.origin === origin && assignment?.authorised &&
    assignment.selection === "both" && message?.type === "cal-eats-workspace:both-rendered" && message.version === 1 &&
    message.businessId === assignment.businessId && message.tabletId === assignment.tabletId && message.revision === assignment.revision);
}

export async function openAssignedCalai({ assignment, request, isCurrent, signal, replace }) {
  if (!assignment?.authorised || signal.aborted || !isCurrent(assignment)) return false;
  const result = await request(`/api/business/accounts/${assignment.businessId}/surface/heartbeat`, {
    method: "POST", signal,
    body: JSON.stringify({ state: assignment.selection === "both" ? "open_both" : "confirm_calai_launch", configurationTabletId: assignment.tabletId, configurationRevision: assignment.revision }),
  });
  if (signal.aborted || !isCurrent(assignment)) return false;
  const confirmed = result?.tabletConfiguration;
  if (confirmed?.selection !== assignment.selection || confirmed.tabletId !== assignment.tabletId || confirmed.revision !== assignment.revision) {
    throw Error("The tablet’s Calai setting could not be confirmed.");
  }
  // The original site must authenticate its own browser. The tablet grant is
  // never sent to the native domain and cannot verify an existing native cookie.
  const destination = assignment.selection === "both" ? BOTH_DASHBOARD : CALAI_SIGN_IN;
  replace(`${destination}&tabletWorkspace=1#tablet=${assignment.businessId}.${assignment.tabletId}`);
  return true;
}
