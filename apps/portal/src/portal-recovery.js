export function portalRecovery(error) {
  let name = "", message = "";
  try {
    if (typeof error?.name === "string") name = error.name;
    if (typeof error?.message === "string") message = error.message;
  } catch { /* An unexpected error object must not break the recovery screen. */ }
  const chunk = name === "ChunkLoadError" || /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|loading (?:css )?chunk .+ failed|unable to preload css/i.test(message);
  return chunk ? {
    kind: "module",
    title: "This page couldn’t finish loading",
    description: "Cal-Eats may have been updated, or your connection was interrupted. Check your connection, then reload the workspace."
  } : {
    kind: "page",
    title: "We couldn’t open this page",
    description: "Reload the workspace to try again. If the problem continues, contact Cal-Eats support."
  };
}

// Recovery always requires a deliberate click. Duplicate clicks cannot start a
// reload loop, and a blocked browser reload can be retried manually.
export function createManualPortalReload(reload) {
  let requested = false;
  return () => {
    if (requested) return "already_requested";
    requested = true;
    try { reload(); return "requested"; }
    catch { requested = false; return "failed"; }
  };
}
