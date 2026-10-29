import "./BusinessMenu.css";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import { api } from "./api.js";
import { shortDate } from "./model.js";
import { connectLiveNotifications } from "../../web/live-notifications.js";

import "./OwnerDashboard.css";
import LiveOrders from "./LiveOrders.jsx";
import { useOrderAlerts } from "./NewOrderAlerts.jsx";

const periods = [["yesterday", "Yesterday"], ["today", "Today"], ["this_week", "This week"], ["last_week", "Last week"]];
const readable = value => ({ placed: "Awaiting confirmation", accepted: "Confirmed", preparing: "Preparing", ready: "Ready", out_for_delivery: "Out for delivery", completed: "Completed", rejected: "Rejected", cancelled: "Cancelled", mock_card: "Test card", card: "Card", cash: "Cash" })[value] || String(value || "—").replaceAll("_", " ");

function Metric({ label, value, hint, accent = false }) {
  const id = React.useId();
  return <article className={`dashboard-metric${accent ? " dashboard-metric-accent" : ""}`}><span>{label}</span><strong>{value}</strong>{hint && <small>{hint}</small>}<svg className="calai-stat-wave" aria-hidden="true" viewBox="0 0 200 50" preserveAspectRatio="none"><defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#2563eb" stopOpacity=".15"/><stop offset="100%" stopColor="#2563eb" stopOpacity="0"/></linearGradient></defs><path d="M0,45 C30,45 40,15 65,15 C90,15 100,40 130,40 C155,40 170,20 185,20 C195,20 198,30 200,30 L200,50 L0,50 Z" fill={`url(#${id})`}/><path d="M0,45 C30,45 40,15 65,15 C90,15 100,40 130,40 C155,40 170,20 185,20 C195,20 198,30 200,30" fill="none" stroke="#0f42ff" strokeWidth="1.5" strokeOpacity=".5"/></svg></article>;
}

function useDashboard(restaurantId, period, page) {
  const key = `${restaurantId}:${period}:${page}`;
  const [state, setState] = useState({ key: "", data: null, error: "", loading: true });
  const sequence = useRef(0), pending = useRef(null);
  const load = useCallback(() => {
    if (pending.current?.key === key) return pending.current.promise;
    const request = ++sequence.current, controller = new AbortController();
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
    setState(previous => ({ key, data: previous.key === key ? previous.data : null, error: "", loading: true }));
    const promise = (async () => {
      try {
        const query = new URLSearchParams({ period, view: "operations", page: String(page), pageSize: "20" });
        const data = await api(`/api/restaurant/restaurants/${restaurantId}/dashboard?${query}`, { signal: controller.signal });
        if (request === sequence.current) setState({ key, data, error: "", loading: false });
      } catch (error) {
        if (request === sequence.current && (error.name !== "AbortError" || timedOut)) setState(previous => ({ key, data: previous.key === key ? previous.data : null, error: timedOut ? "The dashboard took too long to respond. Please refresh and try again." : error.message, loading: false }));
      } finally { window.clearTimeout(timeout); if (pending.current?.request === request) pending.current = null; }
    })();
    pending.current = { key, request, promise, controller };
    return promise;
  }, [restaurantId, period, page, key]);
  useEffect(() => {
    void load();
    return () => { sequence.current++; pending.current?.controller.abort(); pending.current = null; };
  }, [load]);
  return { ...(state.key === key ? state : { data: null, error: "", loading: true }), reload: load };
}

export default function OwnerDashboard({ restaurant, permission }) {
  const alerts = useOrderAlerts();
  const [period, setPeriod] = useState("today"), [page, setPage] = useState(1);
  const result = useDashboard(restaurant.id, period, page), refresh = useRef(result.reload);
  refresh.current = result.reload;
  useEffect(() => {
    const reload = () => { if (!document.hidden) return refresh.current(); };
    const disconnect = connectLiveNotifications({ onRefresh: reload }), timer = window.setInterval(reload, 5000);
    window.addEventListener("focus", reload);
    window.addEventListener("cal-eats-orders-updated", reload);
    return () => { disconnect(); window.clearInterval(timer); window.removeEventListener("focus", reload); window.removeEventListener("cal-eats-orders-updated", reload); };
  }, [restaurant.id]);
  const data = result.data, isOwner = permission === "owner";
  const summary = data?.summary || {}, operations = data?.operations || {}, items = data?.orders?.items || [], pagination = data?.orders?.pagination;
  const selectedLabel = periods.find(([value]) => value === period)?.[1];
  function selectPeriod(next) { if (next !== period) { setPeriod(next); setPage(1); } }
  return <div className="business-dashboard">
    <header className="page-heading dashboard-heading"><div><h1>Dashboard</h1><p>Your orders, conversations and live activity in one place.</p></div><div className="dashboard-heading-actions">{alerts?.available && <button className="quiet" type="button" onClick={()=>void alerts.enableAndTest()}>{alerts.armed&&alerts.soundWanted?"Test sound":"Enable sound"}</button>}<button className="quiet" disabled={result.loading} onClick={() => void result.reload()}>{result.loading && data ? "Refreshing…" : "Refresh"}</button></div></header>
    <LiveOrders operations={data?.operations} unavailable={Boolean(result.error)} generatedAt={data?.generatedAt}/>
    {isOwner && <NavLink className={`dashboard-message-shortcut${operations.unreadMessages ? " has-unread" : ""}`} to="/owner/inbox"><span className="message-shortcut-icon" aria-hidden="true">✉</span><span><strong>Customer messages</strong><small>{operations.unreadMessages ? `${operations.unreadMessages} unread message${operations.unreadMessages === 1 ? "" : "s"} · needs your reply` : "Read and reply to your customers"}</small></span><b aria-label={`${operations.unreadMessages || 0} unread messages`}>{operations.unreadMessages || 0}</b><span aria-hidden="true">↗</span></NavLink>}
    <div className="dashboard-period-toolbar"><div className="dashboard-periods" role="group" aria-label="Dashboard period">{periods.map(([value, label]) => <button key={value} aria-pressed={period === value} className={period === value ? "dashboard-period selected" : "dashboard-period"} onClick={() => selectPeriod(value)}>{label}</button>)}</div><p>{data?.range ? `${data.range.fromDate} – ${data.range.toDate}` : selectedLabel}<small>London time · weeks start Monday</small></p></div>
    {result.error && <div className="alert" role="alert">Dashboard could not be refreshed: {result.error} <button className="quiet" onClick={() => void result.reload()}>Try again</button></div>}
    {!data ? <section className="panel" role="status">{result.loading ? "Loading your restaurant dashboard…" : "Your dashboard is unavailable. Use Refresh to try again."}</section> : <div aria-busy={result.loading}>
      <section aria-label={`${selectedLabel} orders`}><div className="dashboard-metrics"><Metric label="Total orders" value={summary.ordersPlaced || 0} hint={selectedLabel}/><Metric label="Confirmed orders" value={summary.confirmedOrders || 0} hint={selectedLabel}/><Metric label="Completed orders" value={summary.completedOrders || 0} hint={selectedLabel}/><Metric label="Awaiting confirmation" value={operations.pendingConfirmation || 0} hint="Right now · all dates"/><Metric label="Preparing orders" value={operations.confirmedInKitchen || 0} hint="Right now · all dates"/><Metric label="Ready for handover" value={operations.readyForHandover || 0} hint="Right now · all dates"/></div><p className="dashboard-caption">Delivery orders leave live when marked out for delivery; collection orders leave when collected.</p></section>
      <section className="panel dashboard-operations" aria-labelledby="dashboard-operations-title"><div className="dashboard-section-heading"><div><p className="eyebrow">Live operations · all dates</p><h2 id="dashboard-operations-title">What needs attention</h2></div><NavLink to="/owner/orders" className="button-link">Open orders</NavLink></div><div className="dashboard-task-grid">
        <NavLink to="/owner/orders" className={`dashboard-task${operations.overdueConfirmation ? " urgent" : ""}`}><span>Awaiting confirmation</span><strong>{operations.pendingConfirmation || 0}</strong><small>{operations.overdueConfirmation ? `${operations.overdueConfirmation} over the three-minute deadline` : "Review and confirm new orders"}</small></NavLink>
        <NavLink to="/owner/orders" className="dashboard-task"><span>Active orders</span><strong>{operations.activeOrders || 0}</strong><small>Includes orders out for delivery</small></NavLink>
        {isOwner && <><NavLink to="/owner/inbox" className="dashboard-task"><span>Unread messages</span><strong>{operations.unreadMessages || 0}</strong><small>Reply to your customers</small></NavLink><NavLink to="/owner/refunds" className="dashboard-task"><span>Open refund cases</span><strong>{operations.openRefundCases || 0}</strong><small>Review cases and proposed remedies</small></NavLink></>}
      </div></section>
      <div className="dashboard-secondary-grid"><section className="panel" aria-labelledby="dashboard-top-items-title"><p className="eyebrow">{selectedLabel}</p><h2 id="dashboard-top-items-title">Popular items</h2>{data.topItems?.length ? <ol className="dashboard-top-items">{data.topItems.slice(0, 5).map((item, index) => <li key={`${item.name}:${index}`}><div><span>{item.name}</span><strong>{item.quantity} ordered</strong></div><div className="dashboard-item-track" aria-hidden="true"><span style={{ width: `${Math.max(2, Math.min(100, (item.quantity / Math.max(1, ...data.topItems.map(row => row.quantity))) * 100))}%` }}/></div></li>)}</ol> : <p className="empty">No confirmed items in this period yet.</p>}</section><section className="panel" aria-labelledby="dashboard-tools-title"><p className="eyebrow">Day-to-day</p><h2 id="dashboard-tools-title">Restaurant tools</h2><div className="dashboard-tool-links"><NavLink to="/owner/menu">Edit menu & availability <span>→</span></NavLink>{isOwner && <><NavLink to="/owner/inbox">Customer messages <span>→</span></NavLink><NavLink to="/owner/customers">Your customers <span>→</span></NavLink><NavLink to="/owner/offers">Personalised offers <span>→</span></NavLink><NavLink to="/owner/printers">Receipt printers <span>→</span></NavLink><NavLink to="/owner/settings">Opening hours & delivery <span>→</span></NavLink></>}<NavLink to="/owner/orders">Manage orders <span>→</span></NavLink></div></section></div>
      <section className="panel" aria-labelledby="dashboard-orders-title"><div className="dashboard-section-heading"><div><p className="eyebrow">{selectedLabel}</p><h2 id="dashboard-orders-title">Orders</h2></div><span className="fine">{pagination?.total || 0} order{pagination?.total === 1 ? "" : "s"}</span></div>{items.length ? <div className="table-wrap responsive-table dashboard-order-table"><table><thead><tr><th>Order</th><th>Status</th></tr></thead><tbody>{items.map(order => <tr key={order.id}><td data-label="Order"><NavLink to={`/owner/orders?order=${encodeURIComponent(order.id)}`}>#{order.id.slice(0, 8).toUpperCase()}</NavLink><small>{order.customerName || "Customer"}</small><small>{shortDate(order.createdAt)}</small></td><td data-label="Status"><strong>{readable(order.status)}</strong><small>{readable(order.fulfillment)}</small></td></tr>)}</tbody></table></div> : <p className="empty">No orders were placed in this period.</p>}{pagination && pagination.totalPages > 1 && <nav className="dashboard-pagination" aria-label="Order pages"><button className="quiet" disabled={result.loading || page <= 1} onClick={() => setPage(previous => Math.max(1, previous - 1))}>Previous</button><span>Page {pagination.page} of {pagination.totalPages}</span><button className="quiet" disabled={result.loading || page >= pagination.totalPages} onClick={() => setPage(previous => previous + 1)}>Next</button></nav>}</section>
    </div>}
  </div>;
}
