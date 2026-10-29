import React from "react";
import { NavLink } from "react-router-dom";
import "./LiveOrders.css";

function ActivityIcon({kind="radio"}) {
  const paths={radio:"M16.24 7.76a6 6 0 0 1 0 8.48M7.76 16.24a6 6 0 0 1 0-8.48M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14M12 10v4",clock:"M12 8v4l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",kitchen:"M8 3v4M12 3v4M16 3v4M4 11h16v8H4zM8 15h8",ready:"M9 12l2 2 4-4M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0"};
  return <svg aria-hidden="true" viewBox="0 0 24 24"><path d={paths[kind]}/></svg>;
}
export default function LiveOrders({ operations, unavailable, generatedAt }) {
  const known = operations && !unavailable && Number.isInteger(operations.liveOrders);
  const count = known ? operations.liveOrders : null, live = count > 0;
  return <section className={`live-orders-panel${live ? " is-live" : ""}`} aria-label="Live restaurant orders">
    <div className="order-energy" aria-hidden="true"><i/><i/><i/></div>
    <div className="live-order-banner">
      <div className="live-order-orbit"><ActivityIcon/><strong role="status" aria-live="polite" aria-atomic="true" aria-label={known ? `${count} live orders` : "Live order count unavailable"}>{count ?? "—"}</strong><small>LIVE ORDERS</small></div>
      <div className="live-order-content"><p className="live-order-label"><span/> LIVE ACTIVITY</p><h2>{!known ? unavailable ? "Live status unavailable" : "Checking live orders…" : live ? count === 1 ? "Live order" : `${count} live orders` : "No live orders"}</h2><p>{known ? live ? "Your kitchen is preparing customer orders now." : "Keep this page open. New orders appear automatically." : "The count will return when the dashboard reconnects."}</p>
        {known && <div className="live-order-stages"><span><ActivityIcon kind="clock"/>{operations.pendingConfirmation} to confirm</span><span><ActivityIcon kind="kitchen"/>{operations.confirmedInKitchen} preparing</span><span><ActivityIcon kind="ready"/>{operations.readyForHandover} ready</span></div>}
      </div>
      <NavLink to="/owner/orders" className="button-link">View orders <span aria-hidden="true">↗</span></NavLink>
    </div>
    <footer className="live-order-footnote"><span>Updates every 5 seconds · your restaurant only</span><span>{known && generatedAt ? `Last update ${new Date(generatedAt).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : "Reconnecting…"}</span></footer>
  </section>;
}
