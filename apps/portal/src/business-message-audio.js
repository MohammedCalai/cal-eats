export const BUSINESS_MESSAGE_REPEAT_MS = 10_000;
const numericRevision = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const validScope = value => typeof value === "string" ? value.trim() : "";

/** Sound prompts attention until a conversation is successfully read. Acknowledging
 * attention never changes any conversation's unread badge or server read cursor. */
export function createBusinessMessageAudio(player, {
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancel = handle => clearTimeout(handle)
} = {}) {
  if (typeof player?.play !== "function" || typeof player?.pause !== "function") throw new TypeError("A message melody player is required");
  const listeners = new Set();
  const acknowledged = new Map();
  let current = { scope: "", enabled: false, pending: false, revision: 0, orderAlarmActive: false };
  let timer = null, active = null, generation = 0, repeatDue = false;
  let state = Object.freeze({ ...current, acknowledgedRevision: -1, playing: false, testing: false, blocked: false, error: "" });
  function publish(patch = {}) {
    const next = { ...state, ...current, acknowledgedRevision: acknowledged.get(current.scope) ?? -1, ...patch };
    if (Object.keys(next).every(key => next[key] === state[key])) return;
    state = Object.freeze(next);
    for (const listener of listeners) listener(state);
  }
  function eligible() {
    return Boolean(current.scope && current.enabled && current.pending && current.revision > (acknowledged.get(current.scope) ?? -1) && !current.orderAlarmActive);
  }
  function clearRepeat() {
    if (timer !== null) cancel(timer);
    timer = null;
    repeatDue = false;
  }
  function silence({ alwaysPause = false } = {}) {
    clearRepeat();
    generation++;
    const hadActive = Boolean(active);
    active = null;
    if (hadActive || alwaysPause) {
      try { player.pause(); } catch { /* Playback must remain disabled even if the underlying player fails to stop. */ }
    }
    publish({ playing: false, testing: false, blocked: false, error: "" });
  }
  function start({ sample = false } = {}) {
    if ((sample ? !current.scope || !current.enabled || current.orderAlarmActive : !eligible()) || active || state.blocked) return;
    clearRepeat();
    const attempt = ++generation;
    active = { attempt, scope: current.scope, sample };
    publish({ playing: true, testing: sample, blocked: false, error: "" });
    // The cadence is measured from each start. A longer melody must finish before another can start.
    if (!sample) timer = schedule(() => {
      timer = null;
      if (!eligible()) return;
      if (active) repeatDue = true;
      else start();
    }, BUSINESS_MESSAGE_REPEAT_MS);
    const complete = error => {
      if (active?.attempt !== attempt || generation !== attempt) return;
      active = null;
      if (error) {
        clearRepeat();
        publish({ playing: false, testing: false, blocked: true, error: error?.name === "NotAllowedError"
          ? "Tap anywhere in the business platform to allow message sounds."
          : "Message sound could not play. Check device volume and audio permissions." });
        return;
      }
      publish({ playing: false, testing: false, blocked: false, error: "" });
      if ((repeatDue || sample) && eligible()) start();
    };
    try { Promise.resolve(player.play()).then(() => complete(), complete); }
    catch (error) { complete(error); }
  }

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    update(next) {
      const scope = validScope(next?.scope), revision = numericRevision(next?.revision);
      const scopeChanged = scope !== current.scope;
      const previouslyPending = current.pending;
      if (scopeChanged) silence();
      current = {
        scope, enabled: Boolean(next?.enabled), pending: typeof next?.pending === "number" ? next.pending > 0 : Boolean(next?.pending),
        revision, orderAlarmActive: Boolean(next?.orderAlarmActive)
      };
      publish(scopeChanged ? { blocked: false, error: "" } : {});
      if (!eligible()) {
        if (active?.sample && !scopeChanged && current.enabled && !current.orderAlarmActive) return;
        if (!scopeChanged && current.enabled && !current.pending && !previouslyPending && !current.orderAlarmActive && state.blocked) return;
        silence(); return;
      }
      // Repeated polls, route renders and count changes do not restart an active melody/cadence.
      if (!active && timer === null && !state.blocked) start();
    },
    acknowledge({ scope, revision, unreadCount } = {}) {
      // This is called only with the successful server read response for the
      // conversation the user opened. A racing newer arrival must keep ringing.
      if (validScope(scope) !== current.scope || !current.scope || unreadCount !== 0 || !Number.isSafeInteger(revision) || revision < current.revision || revision < 0) return false;
      acknowledged.set(current.scope, Math.max(acknowledged.get(current.scope) ?? -1, revision));
      silence();
      return true;
    },
    // Call synchronously from the shell's trusted click/key handler.
    interact() {
      if (!eligible()) return;
      if (state.blocked) publish({ blocked: false, error: "" });
      if (!active && timer === null) start();
    },
    // A deliberate sample never marks messages read or suppresses a new arrival.
    test() {
      if (!current.scope || !current.enabled || current.orderAlarmActive) return false;
      silence({ alwaysPause: true });
      start({ sample: !eligible() });
      return true;
    },
    stopTest() { if (active?.sample) silence({ alwaysPause: true }); },
    stop() {
      current = { scope: "", enabled: false, pending: false, revision: 0, orderAlarmActive: false };
      silence({ alwaysPause: true });
    }
  };
}
