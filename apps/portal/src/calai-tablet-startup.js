const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CALAI_SIGN_IN = "https://calai.info/auth/login";

export function calaiTabletAssignment(terminal, signedContext, businessId) {
  const identity = terminal?.context;
  const selection = signedContext?.tabletConfiguration;
  if (terminal?.status !== "ready" || terminal.paired !== true || !ID.test(identity?.terminalId ?? "") ||
      identity.principalKind !== "terminal" || identity.businessId !== businessId || !ID.test(businessId ?? "") ||
      signedContext?.id !== businessId || signedContext.principalKind !== "terminal" || selection?.selection !== "calai" ||
      !ID.test(selection.tabletId ?? "") || !Number.isSafeInteger(selection.revision) || selection.revision < 1) return null;

  const calai = signedContext.products?.calai;
  return {
    key: [businessId, identity.terminalId, selection.tabletId, selection.revision].join(":"),
    businessId, terminalId: identity.terminalId, tabletId: selection.tabletId, revision: selection.revision,
    authorised: signedContext.canViewCalai === true && calai?.linked === true && calai.active === true &&
      calai.allowedOnTablet === true && calai.readiness?.ready === true,
  };
}

export async function openAssignedCalai({ assignment, request, isCurrent, signal, replace }) {
  if (!assignment?.authorised || signal.aborted || !isCurrent(assignment)) return false;
  const result = await request(`/api/business/accounts/${assignment.businessId}/surface/heartbeat`, {
    method: "POST", signal,
    body: JSON.stringify({ state: "open_calai", configurationTabletId: assignment.tabletId, configurationRevision: assignment.revision }),
  });
  if (signal.aborted || !isCurrent(assignment)) return false;
  const confirmed = result?.tabletConfiguration;
  if (confirmed?.selection !== "calai" || confirmed.tabletId !== assignment.tabletId || confirmed.revision !== assignment.revision) {
    throw Error("The tablet’s Calai setting could not be confirmed.");
  }
  // The original site must authenticate its own browser. The tablet grant is
  // never sent to the native domain and cannot verify an existing native cookie.
  replace(CALAI_SIGN_IN);
  return true;
}
