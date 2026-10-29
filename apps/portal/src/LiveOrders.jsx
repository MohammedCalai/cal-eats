import React from "react";
import { NavLink } from "react-router-dom";
import "./LiveOrders.css";

export default function LiveOrders({ operations, unavailable, generatedAt }) {
  const known = operations && !unavailable && Number.isInteger(operations.liveOrders);
  const count = known ? operations.liveOrders : null, live = count > 0;
  return <section className={`live-orders-panel${live ? " is-live" : ""}`} aria-label="Live restaurant orders">
    <div className="order-energy" aria-hidden="true"><i/><i/><i/></div>
    <div className="live-order-orbit"><span aria-hidden="true">◉</span><strong role="status" aria-live="polite" aria-atomic="true" aria-label={known ? `${count} live orders` : "Live order count unavailable"}>{count ?? "—"}</strong><small>LIVE ORDERS</small></div>
    <div className="live-order-content"><p className="live-order-label"><span/> LIVE ACTIVITY</p><h2>{!known ? unavailable ? "Live status unavailable" : "Checking live orders…" : live ? `${count} live order${count === 1 ? "" : "s"}` : "No live orders"}</h2><p>{known ? live ? "Your kitchen is in motion. Keep each order up to date." : "Keep this page open. New orders appear automatically." : "The count will return when the dashboard reconnects."}</p>
      {known && <div className="live-order-stages"><span><b>{operations.pendingConfirmation}</b> to confirm</span><span><b>{operations.confirmedInKitchen}</b> preparing</span><span><b>{operations.readyForHandover}</b> ready</span></div>}
      <NavLink to="/owner/orders" className="button-link">View orders <span aria-hidden="true">↗</span></NavLink>
      <small className="live-order-footnote">All dates · leaves live when out for delivery or collected<br/>Updates every 5 seconds{generatedAt && known ? ` · ${new Date(generatedAt).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : ""}</small>
    </div>
  </section>;
}
