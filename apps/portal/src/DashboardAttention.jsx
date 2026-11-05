import React, { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { api } from "./api.js";
import { shortDate } from "./model.js";
import { printerConnectionSummary } from "./dashboard-attention-model.js";

export function DashboardPrinterWarning({ restaurantId, canManage = false }) {
  const [state, setState] = useState({ restaurantId: "", items: null, error: "" });
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    async function refresh() {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const value = await api(`/api/restaurant/restaurants/${encodeURIComponent(restaurantId)}/printer-status`, { signal: controller.signal });
        if (!controller.signal.aborted) setState({ restaurantId, items: Array.isArray(value) ? value : value.items || [], error: "" });
      } catch (error) {
        if (!controller.signal.aborted) setState(previous => ({ restaurantId, items: previous.restaurantId === restaurantId ? previous.items : null, error: "Printer connection could not be checked." }));
      } finally { busy = false; }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10000);
    window.addEventListener("focus", refresh);
    return () => { controller.abort(); window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [restaurantId]);
  if (state.restaurantId !== restaurantId) return null;
  const { configured, disconnected } = printerConnectionSummary(state.items || []);
  if (!state.error && (state.items === null || configured.length && !disconnected.length)) return null;
  return <section className="dashboard-printer-warning" aria-label="Receipt printer connection"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M6 8V3h12v5M6 17H3V8h18v9h-3M6 13h12v8H6zM17 10h1"/></svg><div><strong>{state.error ? "Printer status unavailable" : "Printer not connected"}</strong><span className="dashboard-printer-badge">{state.error ? "Check connection" : !configured.length ? "Not configured" : "Offline"}</span><p>{state.error || (!configured.length ? "No printer configured · A connected thermal receipt printer automatically prints confirmed orders." : `${disconnected.map(printer => printer.name).join(", ")} · Last seen: ${disconnected[0]?.lastSeenAt ? shortDate(disconnected[0].lastSeenAt) : "Never"}`)}</p></div>{canManage ? <NavLink to="/owner/printers">{!state.error && !configured.length ? "Connect printer" : "Check printer"} ↗</NavLink> : <small className="fine">Ask your owner to connect or check the printer.</small>}</section>;
}
