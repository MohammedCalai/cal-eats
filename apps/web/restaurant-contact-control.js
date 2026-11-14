export function restaurantContactCopy(blocked) {
  return blocked ? {
    action: "Resume messages", title: "Resume restaurant messages?", confirm: "Resume messages",
    explanation: "Direct messages and eligible personalised offers from this restaurant can reach you again. Your offer preferences still apply.",
    status: "Restaurant messages are stopped. Ordering, order updates and Cal-Eats support remain available."
  } : {
    action: "Stop restaurant messages", title: "Stop restaurant messages?", confirm: "Stop messages",
    explanation: "Stop direct messages and personalised offers from this restaurant. You can still browse, place orders and receive order status, ETA and payment updates. Cal-Eats support stays available.",
    status: "You control direct messages from this restaurant."
  };
}

// One controller belongs to one signed-in customer and one restaurant. Callers
// supply the live identity check so an old confirmation cannot write as a new user.
export function createRestaurantContactControl({ api, restaurantId, isCurrent = () => true, onState = () => {}, onChanged = () => {} }) {
  if (typeof restaurantId !== "string" || !restaurantId.trim()) throw new Error("Restaurant is required");
  const path = `/api/customer-safety/restaurants/${encodeURIComponent(restaurantId)}`;
  let active = true, revision = 0, pending = null;
  let state = Object.freeze({ loaded: false, blocked: false, busy: false, error: "" });
  const current = () => active && isCurrent();
  const update = patch => { if (current()) { state = Object.freeze({ ...state, ...patch }); onState(state); } };
  function checked(value) {
    if (!value || value.restaurantId !== restaurantId || typeof value.blocked !== "boolean") throw new Error("Message preferences could not be verified. Please check again.");
    return value.blocked;
  }
  function run(blocked) {
    if (!current() || pending || state.busy || (blocked !== undefined && !state.loaded)) return Promise.resolve(false);
    const version = ++revision;
    update({ busy: true, error: "" });
    const operation = Promise.resolve().then(async () => {
      try {
        if (!current() || version !== revision) return false;
        const value = await api(path, blocked === undefined ? undefined : { method: "PUT", body: JSON.stringify({ blocked }) });
        if (!current() || version !== revision) return false;
        const confirmed = checked(value);
        if (blocked !== undefined && confirmed !== blocked) throw new Error("Message preferences could not be confirmed. Please check again.");
        update({ loaded: true, blocked: confirmed, busy: false, error: "" });
        onChanged(confirmed);
        return true;
      } catch (error) {
        if (current() && version === revision) update({ loaded: false, busy: false, error: error?.message || "Message preferences could not be checked. Please try again." });
        return false;
      } finally { if (pending === operation) pending = null; }
    });
    pending = operation;
    return operation;
  }
  return { snapshot: () => state, refresh: () => pending || run(), change: blocked => typeof blocked === "boolean" ? run(blocked) : Promise.resolve(false), close() { active = false; revision++; } };
}

export function mountRestaurantContactControls({ api, container, restaurantId, isCurrent = () => true, onChanged = () => {}, confirm = message => window.confirm(message) }) {
  let closed = false;
  const current = () => !closed && container.isConnected && isCurrent();
  container.innerHTML = '<div class="restaurant-contact-controls"><button type="button" class="quiet" data-contact-toggle disabled>Checking message preferences…</button><button type="button" class="quiet" data-contact-retry hidden>Check message preferences</button><p class="meta" data-contact-preference-status role="status"></p><p class="error" data-contact-preference-error role="alert" hidden></p></div>';
  const button = container.querySelector("[data-contact-toggle]"), retry = container.querySelector("[data-contact-retry]"), status = container.querySelector("[data-contact-preference-status]"), error = container.querySelector("[data-contact-preference-error]");
  const control = createRestaurantContactControl({ api, restaurantId, isCurrent: current, onChanged, onState(value) {
    button.disabled = value.busy || !value.loaded;
    button.textContent = value.loaded ? restaurantContactCopy(value.blocked).action : value.busy ? "Checking message preferences…" : "Message preferences unavailable";
    button.setAttribute("aria-busy", String(value.busy));
    retry.hidden = value.loaded || value.busy;
    status.textContent = value.loaded ? restaurantContactCopy(value.blocked).status : "";
    error.hidden = !value.error; error.textContent = value.error;
  } });
  button.onclick = async () => {
    const value = control.snapshot();
    if (!current() || value.busy || !value.loaded) return;
    const copy = restaurantContactCopy(value.blocked);
    if (!await confirm(`${copy.title}\n\n${copy.explanation}`) || !current()) return;
    // Another confirmation or refresh may have changed the choice meanwhile.
    if (control.snapshot().blocked !== value.blocked) return;
    await control.change(!value.blocked);
  };
  retry.onclick = () => control.refresh();
  void control.refresh();
  return { ...control, close() { if (closed) return; closed = true; control.close(); } };
}
