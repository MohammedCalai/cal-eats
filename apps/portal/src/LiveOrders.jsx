import React, { useId } from "react";
import { NavLink } from "react-router-dom";
import "./LiveOrders.css";

function ActivityIcon({kind="radio"}) {
  const paths={radio:"M16.24 7.76a6 6 0 0 1 0 8.48M7.76 16.24a6 6 0 0 1 0-8.48M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14M12 10v4",clock:"M12 8v4l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",kitchen:"M8 3v4M12 3v4M16 3v4M4 11h16v8H4zM8 15h8",ready:"M9 12l2 2 4-4M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0"};
  return <svg aria-hidden="true" viewBox="0 0 24 24"><path d={paths[kind]}/></svg>;
}
function LiveOrderOrbitArt({ live }) {
  const id = `live-order-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const blue = live ? "#3184ff" : "#40516b", cyan = live ? "#b8ebff" : "#9eacc0";
  return <svg className="live-order-orbit-art" aria-hidden="true" viewBox="0 0 256 256" fill="none">
    <defs>
      <linearGradient id={`${id}-shell`} x1="53" y1="21" x2="205" y2="238" gradientUnits="userSpaceOnUse"><stop stopColor="#617ba7"/><stop offset=".18" stopColor="#243b60"/><stop offset=".57" stopColor="#0a1425"/><stop offset=".84" stopColor="#32466e"/><stop offset="1" stopColor="#0c1729"/></linearGradient>
      <linearGradient id={`${id}-rim`} x1="39" y1="27" x2="221" y2="227" gradientUnits="userSpaceOnUse"><stop stopColor={cyan}/><stop offset=".25" stopColor={blue}/><stop offset=".56" stopColor={live ? "#2853bd" : "#27344e"}/><stop offset=".82" stopColor={live ? "#5494ff" : "#62718d"}/><stop offset="1" stopColor="#182846"/></linearGradient>
      <radialGradient id={`${id}-face`} cx=".27" cy=".15" r=".92"><stop stopColor={live ? "#293f62" : "#293240"}/><stop offset=".45" stopColor={live ? "#15283f" : "#1b2532"}/><stop offset="1" stopColor="#0c1626"/></radialGradient>
      <linearGradient id={`${id}-edge`} x1="73" y1="23" x2="173" y2="232" gradientUnits="userSpaceOnUse"><stop stopColor="#c4e8ff" stopOpacity=".72"/><stop offset=".38" stopColor="#6d9acd" stopOpacity=".12"/><stop offset="1" stopColor="#0a1221" stopOpacity=".78"/></linearGradient>
      <linearGradient id={`${id}-glass`} x1="98" y1="28" x2="143" y2="143" gradientUnits="userSpaceOnUse"><stop stopColor="#d5eeff" stopOpacity=".115"/><stop offset="1" stopColor="#d5eeff" stopOpacity="0"/></linearGradient>
      <clipPath id={`${id}-clip`}><circle cx="128" cy="128" r="109"/></clipPath>
    </defs>
    <circle cx="128" cy="128" r="124" fill="#030a14" opacity=".3"/>
    <circle cx="128" cy="128" r="121.3" fill={`url(#${id}-shell)`} stroke="#7f9bc0" strokeOpacity=".22" strokeWidth=".8"/>
    <circle cx="128" cy="128" r="117" stroke={`url(#${id}-rim)`} strokeWidth="6.3"/>
    <circle cx="128" cy="128" r="112.8" fill={`url(#${id}-face)`} stroke={`url(#${id}-edge)`} strokeWidth="1.8"/>
    <g clipPath={`url(#${id}-clip)`}><path d="M4 46C64-1 173 0 248 48L248 116C182 97 86 142 8 113Z" fill={`url(#${id}-glass)`}/></g>
    <circle cx="128" cy="128" r="106" stroke="#b6dbff" strokeOpacity=".045" strokeWidth=".8"/>
    <path d="M36 64A116 116 0 0 1 135 12" stroke="#e2f7ff" strokeOpacity={live ? ".7" : ".3"} strokeWidth="1.25" strokeLinecap="round"/>
    <path d="M233 167A113 113 0 0 1 163 235" stroke={live ? "#5a9fff" : "#5c7293"} strokeOpacity=".5" strokeWidth="1.1" strokeLinecap="round"/>
  </svg>;
}
export default function LiveOrders({ operations, unavailable, generatedAt }) {
  const known = operations && !unavailable && Number.isInteger(operations.liveOrders);
  const count = known ? operations.liveOrders : null, live = count > 0;
  return <section className={`live-orders-panel${live ? " is-live" : ""}`} aria-label="Live restaurant orders">
    <div className="order-energy" aria-hidden="true"><i/><i/><i/></div>
    <div className="live-order-banner">
      <div className="live-order-orbit"><LiveOrderOrbitArt live={live}/><strong role="status" aria-live="polite" aria-atomic="true" aria-label={known ? `${count} live orders` : "Live order count unavailable"}>{count ?? "—"}</strong><small>LIVE ORDERS</small></div>
      <div className="live-order-content"><p className="live-order-label"><span/> LIVE ACTIVITY</p><h2>{!known ? unavailable ? "Live status unavailable" : "Checking live orders…" : live ? count === 1 ? "Live order" : `${count} live orders` : "No live orders"}</h2><p>{known ? live ? "Follow confirmation, preparation and handover in one place." : "Keep this page open. New orders appear automatically." : "The count will return when the dashboard reconnects."}</p>
        {known && <div className="live-order-stages"><span><ActivityIcon kind="clock"/>{operations.pendingConfirmation} to confirm</span><span><ActivityIcon kind="kitchen"/>{operations.confirmedInKitchen} preparing</span><span><ActivityIcon kind="ready"/>{operations.readyForHandover} ready</span></div>}
      </div>
      <NavLink to="/owner/orders" className="button-link">Order summary <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M7 17 17 7M7 7h10v10"/></svg></NavLink>
    </div>
    <footer className="live-order-footnote"><span>{known && generatedAt ? `Last update ${new Date(generatedAt).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : "Reconnecting…"}</span></footer>
  </section>;
}
