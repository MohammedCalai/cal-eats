import { terminalApi, terminalStatus, connectAutomaticTerminal, isLocalTerminalProofError } from "./terminal-client.js";

const sequences = new Map();
const offline = snapshot => ["offline", "connection_unavailable"].includes(snapshot?.status);
const canReconnect = snapshot => offline(snapshot) && snapshot.reconnectEligible === true;
const connectionBlocked = snapshot => ["revoked", "unpaired", "permission_required", "permission_denied"].includes(snapshot?.status) ||
  (offline(snapshot) && !canReconnect(snapshot));
const accessDenied = error => [401, 403, 409].includes(error?.status) && !isLocalTerminalProofError(error);
export function createSurfacePresenceClient({ status = terminalStatus, request = terminalApi, reconnect = options => connectAutomaticTerminal(options), schedule = setTimeout, cancel = clearTimeout, heartbeatMs = 30000, nextSequence = id => { const value = (sequences.get(id) || 0) + 1; sequences.set(id, value); return value; }, onState = () => {} } = {}) {
  let scope = null, running = false, generation = 0, timer = null, pending = null, interval = heartbeatMs, closing = null, retry = 0, explicitlySignedOut = false;
  const verified = new Map(), retryDelays = [5000, 10000, 30000, 60000], scopeKey = selected => `${selected?.businessId}:${selected?.restaurantId}`;
  const sameScope = (context, selected) => context?.principalKind === "terminal" && context.businessId === selected?.businessId && context.restaurantId === selected?.restaurantId && Boolean(context.terminalId);
  function clearTimer() { if (timer !== null) cancel(timer); timer = null; }
  function stop() { running = false; generation++; clearTimer(); pending?.controller.abort(); }
  function plan(expected, delay = interval) { if (running && expected === generation) { clearTimer(); timer = schedule(() => { timer = null; void tick(); }, delay); } }
  async function recover(expected, selected, snapshot) {
    const known = verified.get(scopeKey(selected));
    if (explicitlySignedOut || snapshot?.paired !== true || !canReconnect(snapshot) || known?.terminalId !== snapshot.terminalId) {
      plan(expected);
      return;
    }
    const controller = new AbortController(), attempt = { controller, promise: null };
    pending = attempt;
    attempt.promise = (async () => {
      let restored = false;
      try {
        await reconnect({ signal: controller.signal });
        const fresh = status();
        if (!running || expected !== generation || controller.signal.aborted) return;
        if (fresh.status !== "ready" || !sameScope(fresh.context, selected) || fresh.context.terminalId !== known.terminalId) {
          stop();
          onState({ state: "not_reporting", code: "TERMINAL_SCOPE_MISMATCH" });
          return;
        }
        retry = 0;
        restored = true;
        onState({ state: "terminal_restored" });
      } catch (error) {
        if (expected !== generation || controller.signal.aborted) return;
        onState({ state: "not_reporting", code: error.code || "TERMINAL_RECONNECT_UNAVAILABLE" });
        if (accessDenied(error) || connectionBlocked(status())) stop();
      } finally {
        if (pending === attempt) pending = null;
        if (running && expected === generation) {
          if (restored) void tick();
          else plan(expected, retryDelays[Math.min(retry++, retryDelays.length - 1)]);
        }
      }
    })();
    return attempt.promise;
  }
  async function tick() {
    if (!running || pending) return;
    const expected = generation, selected = scope, snapshot = status();
    if (snapshot?.status !== "ready" || !sameScope(snapshot.context, selected)) { onState({ state: "not_reporting" }); if(connectionBlocked(snapshot)){stop();return;}return recover(expected,selected,snapshot); }
    const context = snapshot.context, controller = new AbortController(), attempt = { controller, promise: null }; pending = attempt;
    verified.set(scopeKey(selected),{terminalId:context.terminalId});let retryDelay=null;
    attempt.promise = (async () => {
      try {
        await request(`/api/restaurant/orders/pending-confirmation?restaurantId=${encodeURIComponent(context.restaurantId)}`, { signal: controller.signal });
        const fresh = status();
        if (!running || expected !== generation || controller.signal.aborted || fresh.status !== "ready" || !sameScope(fresh.context, selected) || fresh.context.terminalId !== context.terminalId) return;
        const result = await request(`/api/business/accounts/${encodeURIComponent(context.businessId)}/surface/heartbeat`, { method: "POST", signal: controller.signal, body: JSON.stringify({ sequence: nextSequence(context.terminalId), state: "active" }) });
        if (!running || expected !== generation || controller.signal.aborted) return;
        if (Number.isSafeInteger(result?.heartbeatSeconds) && result.heartbeatSeconds >= 10 && result.heartbeatSeconds <= 600) interval = result.heartbeatSeconds * 1000;
        retry=0;
        onState({ state: "reporting", receivedAt: result?.receivedAt || null });
      } catch (error) {
        if (expected !== generation || controller.signal.aborted) return;
        onState({ state: "not_reporting", code: error.code || "PRESENCE_UNAVAILABLE" });
        if (accessDenied(error) || connectionBlocked(status())) stop();
        else if(isLocalTerminalProofError(error)||error.status===0||error.status>=500)retryDelay=retryDelays[Math.min(retry++,retryDelays.length-1)];
      } finally { if (pending === attempt) pending = null; plan(expected,retryDelay??interval); }
    })();
    return attempt.promise;
  }
  function start(selected) {
    stop(); scope = selected?.businessId && selected?.restaurantId ? { businessId: selected.businessId, restaurantId: selected.restaurantId } : null;
    if (!scope || explicitlySignedOut) return;
    running = true; interval = heartbeatMs; closing = null;const expected=generation;
    if(pending?.promise)void pending.promise.finally(()=>{if(running&&expected===generation)void tick();}).catch(()=>{});else void tick();
  }
  function signedOut(){if(closing)return closing;closing=sendSignOut();return closing;}
  async function sendSignOut() {
    const selected = scope, before = status(); explicitlySignedOut=true;stop(); const oldPending = pending?.promise;
    if (oldPending) await oldPending.catch(() => {});
    const fresh = status();
    if (before?.status !== "ready" || fresh?.status !== "ready" || !sameScope(fresh.context, selected) || fresh.context.terminalId !== before.context?.terminalId) return { sent: false };
    try {
      const result = await request(`/api/business/accounts/${encodeURIComponent(fresh.context.businessId)}/surface/heartbeat`, { method: "POST", body: JSON.stringify({ sequence: nextSequence(fresh.context.terminalId), state: "signed_out" }) });
      onState({ state: "signed_out", receivedAt: result?.receivedAt || null }); return { sent: true };
    } catch (error) { onState({ state: "not_reporting", code: error.code || "SIGN_OUT_UNCONFIRMED" }); return { sent: false }; }
  }
  function resetAfterVerifiedSignIn(){const snapshot=status();if(snapshot?.status!=="ready"||snapshot.context?.principalKind!=="terminal"||!snapshot.context.businessId||!snapshot.context.restaurantId||!snapshot.context.terminalId)return false;stop();explicitlySignedOut=false;closing=null;return true;}
  return { start, stop, signedOut, tick, resetAfterVerifiedSignIn };
}
const operationalPresence = createSurfacePresenceClient({onState:value=>{if(value.state==='terminal_restored'&&typeof window!=='undefined')window.dispatchEvent(new Event('cal-eats-terminal-session-restored'));}});
export const startOperationalPresence = scope => operationalPresence.start(scope);
export const stopOperationalPresence = () => operationalPresence.stop();
export const endOperationalPresence = () => operationalPresence.signedOut();
// Call only after an explicit human sign-in AND a newly verified native grant.
// This does not start receiving/reporting; the mounted location client must do
// its signed own-order receive check before any active heartbeat.
export const resumeOperationalPresenceAfterSignIn = () => operationalPresence.resetAfterVerifiedSignIn();
