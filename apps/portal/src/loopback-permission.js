const STATES = new Set(["granted", "prompt", "denied"]);
const DISCOVERY_HINT = "cal-eats-tablet-discovery-v1";

export const loopbackPermissionState = value => STATES.has(value?.state) ? value.state : "unknown";

export async function queryLoopbackPermission(permissions = globalThis.navigator?.permissions) {
  try {
    if (typeof permissions?.query !== "function") return { state: "unknown" };
    // Never query the legacy combined name: older Chromium versions can fail
    // outside a catchable JavaScript rejection for that permission name.
    return await permissions.query({ name: "loopback-network" });
  } catch { return { state: "unknown" }; }
}

export const tabletDiscoveryHint = {
  read() { try { return globalThis.localStorage?.getItem(DISCOVERY_HINT) === "1"; } catch { return false; } },
  write(enabled) {
    try {
      if (enabled) globalThis.localStorage?.setItem(DISCOVERY_HINT, "1");
      else globalThis.localStorage?.removeItem(DISCOVERY_HINT);
    } catch { /* A blocked store requires another deliberate connection next time. */ }
  }
};
