const BACKOFF = [5000, 10000, 30000, 60000];
const denied = new Set(["TERMINAL_REVOKED", "TABLET_REVOKED", "TABLET_NOT_ENROLLED", "TERMINAL_NOT_PAIRED", "TERMINAL_LOCAL_INVALID", "TABLET_SESSION_RESPONSE_INVALID"]);
const sameTerminal = (snapshot, result) => snapshot?.status === "ready" && snapshot.paired === true && snapshot.context?.principalKind === "terminal" && result?.principalKind === "terminal" && result.terminalId === snapshot.context.terminalId && result.businessId === snapshot.context.businessId && result.restaurantId === snapshot.context.restaurantId && result.user?.id === snapshot.context.user?.id;

// This coordinates reads only. Its retry/latch state never grants authority;
// every terminal identity still comes from the signed native companion.
export function createBusinessBootstrap({ readHuman, connectTerminal, readTerminal, terminalStatus, canDiscover = () => false, setPrincipal = () => {}, onSession = () => {}, onLoading = () => {}, onTerminal = () => {}, schedule = setTimeout, cancel = clearTimeout }) {
  let generation = 0, pending = null, timer = null, retry = 0, signedOut = false;
  const current = expected => expected === generation;
  function clearTimer() { if (timer !== null) cancel(timer); timer = null; }
  function stop() { generation++; clearTimer(); pending?.controller.abort(); retry = 0; }
  function signOut() { signedOut = true; stop(); }
  function retryLater(expected, error) {
    const snapshot = terminalStatus();
    if (!current(expected) || signedOut || snapshot?.paired !== true || ["revoked", "unpaired", "not_installed"].includes(snapshot.status) || denied.has(error?.code) || [401, 403].includes(error?.status)) return;
    const delay = BACKOFF[Math.min(retry++, BACKOFF.length - 1)];
    clearTimer(); timer = schedule(() => { timer = null; if (current(expected) && !pending) void run(expected); }, delay);
  }
  async function run(expected, { afterSignIn = false } = {}) {
    if (!current(expected)) return;
    const controller = new AbortController(), attempt = { controller, promise: null };
    pending = attempt;
    attempt.promise = (async () => {
      let human = null;
      try {
        try {
          const result = await readHuman({ signal: controller.signal });
          if (!current(expected) || controller.signal.aborted) return;
          if (!result?.user?.id) throw Error("No authenticated business session.");
          human = result;
          // An explicit successful human sign-in is the only same-page reset.
          if (afterSignIn) signedOut = false;
          setPrincipal("human"); onSession({ user: human.user, principalKind: "human" });
        } catch (error) {
          if (!current(expected) || controller.signal.aborted) return;
        }
        if (signedOut || !canDiscover(human?.user || null)) {
          if (!human) { setPrincipal("human"); onSession({ user: null, principalKind: "human" }); }
          return;
        }
        try {
          await connectTerminal({ signal: controller.signal });
          if (!current(expected) || controller.signal.aborted || signedOut) return;
          const verified = await readTerminal({ signal: controller.signal });
          if (!current(expected) || controller.signal.aborted || signedOut) return;
          if (!sameTerminal(terminalStatus(), verified)) throw Object.assign(Error("Tablet identity changed."), { code: "TERMINAL_LOCAL_INVALID" });
          retry = 0;
          if (human) onTerminal({afterSignIn,terminalContext:verified});
          else { setPrincipal("terminal"); onSession({ user: verified.user, principalKind: "terminal" }); }
        } catch (error) {
          if (!current(expected) || controller.signal.aborted || signedOut) return;
          if (!human) { setPrincipal("human"); onSession({ user: null, principalKind: "human" }); }
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
  return { refresh, signOut, stop };
}
