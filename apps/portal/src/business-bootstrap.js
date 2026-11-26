const BACKOFF = [5000, 10000, 30000, 60000];
const denied = new Set(["TERMINAL_REVOKED", "TABLET_REVOKED", "TABLET_NOT_ENROLLED", "TERMINAL_NOT_PAIRED", "TERMINAL_LOCAL_INVALID", "TABLET_SESSION_RESPONSE_INVALID"]);
const sameIdentity = (expected, result) => expected?.principalKind === "terminal" && result?.principalKind === "terminal" && result.terminalId === expected.terminalId && result.businessId === expected.businessId && result.restaurantId === expected.restaurantId && result.user?.role === "restaurant" && result.user.id === expected.user?.id;
const sameTerminal = (snapshot, result) => snapshot?.status === "ready" && snapshot.paired === true && sameIdentity(snapshot.context, result);
const isCalaiOnly = context => context?.restaurantId === null && context.products?.calai?.active === true && context.products?.["cal-eats"]?.active === false;
const recoverableCalai = (snapshot, terminal) => terminal && snapshot?.terminalId === terminal.terminalId && snapshot.paired === true && snapshot.reconnectEligible === true;

// This coordinates reads only. Its retry/latch state never grants authority;
// every terminal identity still comes from the signed native companion.
export function createBusinessBootstrap({ readHuman, connectTerminal, readTerminal, terminalStatus, canDiscover = () => false, preferTerminalForUser = () => false, setPrincipal = () => {}, onSession = () => {}, onLoading = () => {}, onTerminal = () => {}, onSignOut = () => {}, schedule = setTimeout, cancel = clearTimeout }) {
  let generation = 0, pending = null, timer = null, retry = 0, signedOut = false, lastUser = null, verifiedCalai = null;
  const current = expected => expected === generation;
  function publishHuman(human) {
    setPrincipal("human");
    onSession({ user: human?.user ?? null, principalKind: "human" });
  }
  function clearTimer() { if (timer !== null) cancel(timer); timer = null; }
  function stop() { generation++; clearTimer(); pending?.controller.abort(); retry = 0; verifiedCalai = null; }
  function signOut() { signedOut = true; try { onSignOut(); } finally { stop(); } }
  function retryLater(expected, error, recovery = null) {
    const snapshot = terminalStatus();
    const startupRetry = snapshot?.startupRetryEligible === true;
    const managedRetry = snapshot?.status === "managed_setup" && snapshot.permission === "granted";
    if (!current(expected) || signedOut || denied.has(error?.code)) return;
    if (recovery) {
      if (verifiedCalai !== recovery || !recoverableCalai(snapshot, recovery) || retry >= BACKOFF.length) return;
    } else if ((snapshot?.paired !== true && !managedRetry && (!startupRetry || retry >= BACKOFF.length)) || ["revoked", "unpaired", "not_installed", "permission_required", "permission_denied"].includes(snapshot?.status) || [401, 403].includes(error?.status)) return;
    const delay = BACKOFF[Math.min(retry++, BACKOFF.length - 1)];
    clearTimer(); timer = schedule(() => {
      timer = null;
      if (current(expected) && !pending && (!startupRetry || terminalStatus()?.startupRetryEligible === true) &&
          (!managedRetry || terminalStatus()?.status === "managed_setup" && terminalStatus()?.permission === "granted") &&
          (!recovery || recoverableCalai(terminalStatus(), recovery))) void run(expected, { recovery });
    }, delay);
  }
  function observeTerminal(snapshot) {
    if (signedOut || pending || timer !== null || !recoverableCalai(snapshot, verifiedCalai)) return;
    retryLater(generation, null, verifiedCalai);
  }
  // An authenticated workspace may still be open when Intune completes the
  // first install. Its existing account poll can look for the companion, only
  // with previously granted browser permission and the same selected business.
  async function observeManagedSetup(businessId) {
    if (!businessId || signedOut || pending || timer !== null || !lastUser || !canDiscover(lastUser) || terminalStatus()?.status === "ready") return;
    const expected = generation, controller = new AbortController(), attempt = { controller, promise: null };
    pending = attempt;
    attempt.promise = (async () => {
      try {
        await connectTerminal({ signal: controller.signal, managedBusinessId: businessId });
        if (!current(expected) || controller.signal.aborted || signedOut) return;
        const verified = await readTerminal({ signal: controller.signal });
        if (!current(expected) || controller.signal.aborted || signedOut || verified.businessId !== businessId || !sameTerminal(terminalStatus(), verified)) return;
        retry = 0;
        verifiedCalai = isCalaiOnly(verified) ? verified : null;
        onTerminal({ afterSignIn: false, terminalContext: verified });
      } catch { /* The existing workspace poll may try again. */ }
      finally { if (pending === attempt) pending = null; }
    })();
    return attempt.promise;
  }
  async function run(expected, { afterSignIn = false, alreadyConnected = false, recovery = null } = {}) {
    if (!current(expected)) return;
    const controller = new AbortController(), attempt = { controller, promise: null };
    pending = attempt;
    attempt.promise = (async () => {
      let human = null, prefersTablet = false;
      try {
        try {
          if (recovery) {
            await connectTerminal({ signal: controller.signal, expectedTerminal: recovery });
            if (!current(expected) || controller.signal.aborted || signedOut) return;
            const verified = await readTerminal({ signal: controller.signal });
            if (!current(expected) || controller.signal.aborted || signedOut) return;
            if (!sameIdentity(recovery, verified) || !sameTerminal(terminalStatus(), verified) || !isCalaiOnly(verified)) return;
            retry = 0;
            onTerminal({ afterSignIn: false, terminalContext: verified, restored: true });
            return;
          }
          const result = await readHuman({ signal: controller.signal });
          if (!current(expected) || controller.signal.aborted) return;
          if (!result?.user?.id) throw Error("No authenticated business session.");
          human = result; lastUser = result.user;
          // Only an explicit business sign-in releases a same-page logout.
          if (afterSignIn && human.user.role !== "customer") signedOut = false;
          // A shopper cookie belongs to a separate flow. A portal may wait for
          // the local and signed tablet identities before deciding which to use.
          prefersTablet = human.user.role === "customer" && preferTerminalForUser(human.user);
          if (!prefersTablet) publishHuman(human);
        } catch (error) {
          if (!current(expected) || controller.signal.aborted) return;
          if (recovery) { retryLater(expected, error, recovery); return; }
          lastUser = null;
        }
        if (signedOut || !canDiscover(human?.user || null)) {
          if (!human || prefersTablet) publishHuman(human);
          return;
        }
        try {
          if (!alreadyConnected) await connectTerminal({ signal: controller.signal });
          if (!current(expected) || controller.signal.aborted || signedOut) return;
          const verified = await readTerminal({ signal: controller.signal });
          if (!current(expected) || controller.signal.aborted || signedOut) return;
          if (!sameTerminal(terminalStatus(), verified)) throw Object.assign(Error("Tablet identity changed."), { code: "TERMINAL_LOCAL_INVALID" });
          retry = 0;
          verifiedCalai = isCalaiOnly(verified) ? verified : null;
          if (human && !prefersTablet) onTerminal({afterSignIn,terminalContext:verified});
          else { setPrincipal("terminal"); onSession({ user: verified.user, principalKind: "terminal" }); }
        } catch (error) {
          if (!current(expected) || controller.signal.aborted || signedOut) return;
          if (!human || prefersTablet) publishHuman(human);
          retryLater(expected, error);
        }
      } finally { if (pending === attempt) pending = null; }
    })();
    return attempt.promise;
  }
  async function refresh(options = {}) {
    const previous = pending?.promise;
    stop(); const expected = generation;
    onLoading();
    // Abort then settle the preceding read before another bootstrap begins.
    if (previous) await previous.catch(() => {});
    if (current(expected)) return run(expected, options);
  }
  function connectFromInteraction() {
    if (signedOut) return Promise.reject(Object.assign(Error("Sign in to your business account before reconnecting this tablet."), { code: "TERMINAL_SIGN_IN_REQUIRED", status: 403 }));
    if (!canDiscover(lastUser)) return Promise.reject(Object.assign(Error("Use the restaurant's Windows ordering tablet."), { code: "TERMINAL_DEVICE_REQUIRED", status: 403 }));
    const previous = pending?.promise;
    stop(); const expected = generation, controller = new AbortController(), attempt = { controller, promise: null };
    pending = attempt;
    // Start the local fetch in the trusted click's call stack. In particular,
    // do not await an old request, a cloud read or a permission query first.
    let opening;
    try { opening = connectTerminal({ signal: controller.signal, userInitiated: true }); }
    catch (error) { opening = Promise.reject(error); }
    attempt.promise = (async () => {
      try {
        await opening;
        if (previous) await previous.catch(() => {});
        if (current(expected) && !controller.signal.aborted && !signedOut) return run(expected, { alreadyConnected: true });
      } catch (error) {
        if (current(expected) && !controller.signal.aborted && !signedOut) { retryLater(expected, error); throw error; }
      } finally { if (pending === attempt) pending = null; }
    })();
    return attempt.promise;
  }
  return { refresh, connectFromInteraction, observeTerminal, observeManagedSetup, signOut, stop, isSuspended: () => signedOut };
}
