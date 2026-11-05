const REPEAT_MS = 20_000;
const numericRevision = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const validScope = value => typeof value === "string" ? value.trim() : "";

/** One short message melody; explicit acknowledgement silences the current scoped backlog. */
export function createBusinessMessageAudio(player, {
  readAcknowledged = () => 0,
  writeAcknowledged = () => {},
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancel = handle => clearTimeout(handle)
} = {}) {
  if (typeof player?.play !== "function" || typeof player?.pause !== "function") throw new TypeError("A message melody player is required");
  const acknowledgements = new Map(), observed = new Map(), listeners = new Set();
  let current = { scope: "", enabled: false, pending: false, revision: 0, orderAlarmActive: false };
  let timer = null, active = null, generation = 0, repeatDue = false;
  let state = Object.freeze({ ...current, acknowledgedRevision: 0, playing: false, blocked: false, error: "" });

  function acknowledged(scope) {
    if (!scope) return 0;
    let persisted = 0;
    try { persisted = numericRevision(readAcknowledged(scope)); } catch { /* Storage can be unavailable; this tab still remembers acknowledgement. */ }
    const value = Math.max(acknowledgements.get(scope) || 0, persisted);
    acknowledgements.set(scope, value);
    return value;
  }
  function publish(patch = {}) {
    const next = { ...state, ...current, acknowledgedRevision: acknowledged(current.scope), ...patch };
    if (Object.keys(next).every(key => next[key] === state[key])) return;
    state = Object.freeze(next);
    for (const listener of listeners) listener(state);
  }
  function eligible() {
    return Boolean(current.scope && current.enabled && current.pending && !current.orderAlarmActive && current.revision > acknowledged(current.scope));
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
    publish({ playing: false, blocked: false, error: "" });
  }
  function start() {
    if (!eligible() || active || state.blocked) return;
    clearRepeat();
    const attempt = ++generation;
    active = { attempt, scope: current.scope };
    publish({ playing: true, blocked: false, error: "" });
    // The cadence is measured from each start. A longer melody must finish before another can start.
    timer = schedule(() => {
      timer = null;
      if (!eligible()) return;
      if (active) repeatDue = true;
      else start();
    }, REPEAT_MS);
    const complete = error => {
      if (active?.attempt !== attempt || generation !== attempt) return;
      active = null;
      if (error) {
        clearRepeat();
        publish({ playing: false, blocked: true, error: error?.name === "NotAllowedError"
          ? "Tap anywhere in the business platform to allow message sounds."
          : "Message sound could not play. Check device volume and audio permissions." });
        return;
      }
      publish({ playing: false, blocked: false, error: "" });
      if (repeatDue && eligible()) start();
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
      if (scopeChanged) silence();
      current = {
        scope, enabled: Boolean(next?.enabled), pending: typeof next?.pending === "number" ? next.pending > 0 : Boolean(next?.pending),
        revision, orderAlarmActive: Boolean(next?.orderAlarmActive)
      };
      if (scope) observed.set(scope, Math.max(observed.get(scope) || 0, revision));
      publish(scopeChanged ? { blocked: false, error: "" } : {});
      if (!eligible()) { silence(); return; }
      // Repeated polls, route renders and count changes do not restart an active melody/cadence.
      if (!active && timer === null && !state.blocked) start();
    },
    acknowledge(scope = current.scope, optionalRevision) {
      scope = validScope(scope);
      if (!scope) return 0;
      // A successful read's server barrier can be newer than our last poll, or older than an arrival since that read.
      if (optionalRevision !== undefined && (!Number.isSafeInteger(optionalRevision) || optionalRevision < 0)) throw new TypeError("The message read revision must be a non-negative safe integer");
      const revision = Math.max(acknowledged(scope), optionalRevision === undefined ? observed.get(scope) || 0 : optionalRevision);
      if (revision > acknowledged(scope)) {
        acknowledgements.set(scope, revision);
        try { writeAcknowledged(scope, revision); } catch { /* In-memory acknowledgement still silences this session. */ }
      }
      if (scope === current.scope) {
        publish();
        if (!eligible()) silence();
        else if (!active && timer === null && !state.blocked) start();
      }
      return revision;
    },
    // Call synchronously from the shell's trusted click/key handler.
    interact() {
      if (!eligible()) return;
      if (state.blocked) publish({ blocked: false, error: "" });
      if (!active && timer === null) start();
    },
    stop() {
      current = { scope: "", enabled: false, pending: false, revision: 0, orderAlarmActive: false };
      silence({ alwaysPause: true });
    }
  };
}
