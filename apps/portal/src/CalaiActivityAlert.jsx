import React, { useEffect, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import { api } from "./api.js";
import { createBusinessMessageMelody } from "./business-message-melody.js";
import { readBusinessSoundPreference } from "./business-sound-preference.js";
import { observeCalaiActivity } from "./calai-activity-alert-model.js";
import { useOrderAlerts } from "./NewOrderAlerts.jsx";
import { terminalApi } from "./terminal-client.js";
import { useBusinessResource } from "./UnifiedBusiness.jsx";
import { canUseCalaiWorkspaceTools, operationalTabletFor } from "./unified-business-model.js";

const path = "/api/business/calai/orders?scope=activity";
const humanRequest = (url, options) => api(url, { ...options, humanSession: true });

export function CalaiActivityAlert({ business, workspaceMode, terminal, userId }) {
  const signed = operationalTabletFor(business?.id, business?.eatsRestaurantId, terminal);
  const active = workspaceMode === "both" && canUseCalaiWorkspaceTools(business, workspaceMode) &&
    business.canViewEats && business.products["cal-eats"]?.active === true && (signed || business.principalKind === "human");
  const scope = active ? JSON.stringify([business.id, business.products.calai.sourceAccountId, userId, signed ? terminal.context.terminalId : null]) : null;
  const feed = useBusinessResource(active ? path : null, { scope, poll: 5_000, request: signed ? terminalApi : humanRequest });
  const otherAlerts = useOrderAlerts();
  const busyAudio = Boolean(otherAlerts?.total || otherAlerts?.testing);
  const audio = useRef(null), history = useRef(null);
  const [view, setView] = useState(null);
  const [soundBlocked, setSoundBlocked] = useState(null);

  useEffect(() => {
    history.current = { scope, state: null };
    setView(null);
    setSoundBlocked(null);
    if (!scope) return;
    const player = createBusinessMessageMelody();
    audio.current = player;
    function prepare(event) {
      if (event.isTrusted && readBusinessSoundPreference(userId)) void player.prepare().catch(() => {});
    }
    document.addEventListener("pointerdown", prepare, true);
    document.addEventListener("keydown", prepare, true);
    return () => {
      document.removeEventListener("pointerdown", prepare, true);
      document.removeEventListener("keydown", prepare, true);
      audio.current = null;
      player.dispose();
    };
  }, [scope, userId]);

  function chime() {
    const player = audio.current;
    if (!player || busyAudio || !readBusinessSoundPreference(userId)) return;
    void player.play().then(() => {
      if (audio.current === player) setSoundBlocked(null);
    }, error => {
      if (audio.current === player && error?.name === "NotAllowedError") setSoundBlocked(scope);
    });
  }

  useEffect(() => {
    if (!scope || scope !== history.current?.scope) return;
    const result = observeCalaiActivity(history.current.state, feed.error ? null : feed.value, business.id);
    history.current.state = result.state;
    setView(previous => ({
      scope,
      calls: result.currentCalls,
      orders: feed.error && !feed.value ? 0 : (previous?.scope === scope ? previous.orders : 0) + result.newOrders,
    }));
    if (result.newCalls || result.newOrders) chime();
  }, [scope, business?.id, feed.value, feed.error]); // process only a newly checked snapshot

  if (!scope || view?.scope !== scope || !(view.calls || view.orders)) return null;
  const label = view.orders ? `${view.orders} ${view.orders === 1 ? "new Calai phone order" : "new Calai phone orders"}`
    : `${view.calls} ${view.calls === 1 ? "active Calai call" : "active Calai calls"}`;
  return <section className="order-alert-bar has-pending" aria-label="Calai activity alerts">
    <div role="status"><strong>{label}</strong>
      {view.orders > 0 && view.calls > 0 && <small>{view.calls} {view.calls === 1 ? "active call" : "active calls"}</small>}
    </div>
    <div className="order-alert-bar-actions">
      {soundBlocked === scope && <button type="button" className="quiet" onClick={chime}>Enable Calai alert sound</button>}
      {view.orders > 0 && <>
        <NavLink className="button-link" to="/owner/calai/orders">View phone orders</NavLink>
        <button type="button" className="quiet" onClick={() => setView(previous => ({ ...previous, orders: 0 }))}>Dismiss</button>
      </>}
    </div>
  </section>;
}
