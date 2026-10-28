import React, { useCallback, useEffect, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import { api } from "./api.js";
import { pounds, shortDate } from "./model.js";
import { connectLiveNotifications } from "../../web/live-notifications.js";
import WeeklyStatements from "./WeeklyStatements.jsx";
import "./OwnerDashboard.css";

const periods = [["today", "Today"], ["yesterday", "Yesterday"], ["this_week", "This week"], ["last_week", "Last week"]];
const readable = value => ({ placed: "Awaiting confirmation", accepted: "Confirmed", preparing: "Preparing", ready: "Ready", out_for_delivery: "Out for delivery", completed: "Completed", rejected: "Rejected", cancelled: "Cancelled", mock_card: "Test card", card: "Card", cash: "Cash" })[value] || String(value || "—").replaceAll("_", " ");

function Metric({ label, value, hint, accent = false }) {
  return <article className={`dashboard-metric${accent ? " dashboard-metric-accent" : ""}`}><span>{label}</span><strong>{value}</strong>{hint && <small>{hint}</small>}</article>;
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
        const query = new URLSearchParams({ period, page: String(page), pageSize: "20" });
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
  const [period, setPeriod] = useState("today"), [page, setPage] = useState(1);
  const result = useDashboard(restaurant.id, period, page), refresh = useRef(result.reload);
  refresh.current = result.reload;
  useEffect(() => {
    const reload = () => { if (!document.hidden) return refresh.current(); };
    const disconnect = connectLiveNotifications({ onRefresh: reload });
    window.addEventListener("focus", reload);
    window.addEventListener("cal-eats-orders-updated", reload);
    return () => { disconnect(); window.removeEventListener("focus", reload); window.removeEventListener("cal-eats-orders-updated", reload); };
  }, [restaurant.id]);
  const data = result.data, isOwner = permission === "owner", finance = isOwner ? data?.finance : null;
  const summary = data?.summary || {}, operations = data?.operations || {}, items = data?.orders?.items || [], pagination = data?.orders?.pagination;
  const mode = finance?.balance?.providerMode;
  const selectedLabel = periods.find(([value]) => value === period)?.[1];
  const status = restaurant.paused ? "Orders paused" : restaurant.approvalStatus || restaurant.status || "Pending approval";
  function selectPeriod(next) { if (next !== period) { setPeriod(next); setPage(1); } }
  return <div className="business-dashboard">
    <header className="page-heading dashboard-heading"><div><p className="eyebrow">Cal-Eats Business</p><h1>Your restaurant, at a glance</h1><p>{restaurant.name} · <span className="dashboard-restaurant-status">{readable(status)}</span></p></div><button className="quiet" disabled={result.loading} onClick={() => void result.reload()}>{result.loading && data ? "Refreshing…" : "Refresh"}</button></header>
    <div className="dashboard-period-toolbar"><div className="dashboard-periods" role="group" aria-label="Dashboard period">{periods.map(([value, label]) => <button key={value} aria-pressed={period === value} className={period === value ? "dashboard-period selected" : "dashboard-period"} onClick={() => selectPeriod(value)}>{label}</button>)}</div><p>{data?.range ? `${data.range.fromDate} – ${data.range.toDate}` : selectedLabel}<small>London time · weeks start Monday</small></p></div>
    {mode && mode !== "stripe_live" && <p className="dashboard-test-note">{mode === "stripe_test" ? "Stripe test mode" : mode === "mixed" ? "Mixed payment environments" : "Preview payments"} · Test transactions and simulated balances are not real charges or bank payouts.</p>}
    {result.error && <div className="alert" role="alert">Dashboard could not be refreshed: {result.error} <button className="quiet" onClick={() => void result.reload()}>Try again</button></div>}
    {!data ? <section className="panel" role="status">{result.loading ? "Loading your restaurant dashboard…" : "Your dashboard is unavailable. Use Refresh to try again."}</section> : <div aria-busy={result.loading}>
      <section aria-label={`${selectedLabel} overview`}>
        <div className="dashboard-metrics">
          <Metric label="Orders placed" value={summary.ordersPlaced || 0} hint={`${summary.confirmedOrders || 0} confirmed · ${summary.cancelledOrders || 0} cancelled`}/>
          <Metric label="Completed orders" value={summary.completedOrders || 0} hint="Orders placed in this period"/>
          {finance && <><Metric label="Sales" value={pounds(finance.period.grossSalesMinor)} hint="Confirmed orders, before refunds"/><Metric label="Restaurant earnings" value={pounds(finance.period.netEarningsMinor)} hint="After refunds and commission" accent/></>}
        </div>
        <p className="dashboard-caption">Figures follow orders placed in the selected period. Earnings use their current payment and refund state.{data.generatedAt ? ` Updated ${shortDate(data.generatedAt)}.` : ""}</p>
      </section>
      <section className="panel dashboard-operations" aria-labelledby="dashboard-operations-title"><div className="dashboard-section-heading"><div><p className="eyebrow">Live operations · all dates</p><h2 id="dashboard-operations-title">What needs attention</h2></div><NavLink to="/owner/orders" className="button-link">Open orders</NavLink></div><div className="dashboard-task-grid">
        <NavLink to="/owner/orders" className={`dashboard-task${operations.overdueConfirmation ? " urgent" : ""}`}><span>Awaiting confirmation</span><strong>{operations.pendingConfirmation || 0}</strong><small>{operations.overdueConfirmation ? `${operations.overdueConfirmation} over the three-minute deadline` : "Review and confirm new orders"}</small></NavLink>
        <NavLink to="/owner/orders" className="dashboard-task"><span>Active orders</span><strong>{operations.activeOrders || 0}</strong><small>Keep preparation and delivery up to date</small></NavLink>
        {isOwner && <><NavLink to="/owner/inbox" className="dashboard-task"><span>Unread messages</span><strong>{operations.unreadMessages || 0}</strong><small>Reply to your customers</small></NavLink><NavLink to="/owner/refunds" className="dashboard-task"><span>Open refund cases</span><strong>{operations.openRefundCases || 0}</strong><small>Review cases and proposed remedies</small></NavLink></>}
      </div></section>
      {finance && <section className="panel" aria-labelledby="dashboard-balance-title"><div className="dashboard-section-heading"><div><p className="eyebrow">Current balance · all time</p><h2 id="dashboard-balance-title">Earnings and payouts</h2></div><NavLink to="/owner/earnings" className="button-link">View earnings & payouts</NavLink></div><p className="fine">These balances cover all dates, separate from {selectedLabel.toLowerCase()}. Funds available or transferred to Stripe are not proof of a bank payout.</p><div className="dashboard-balance-grid"><Metric label="Available" value={pounds(finance.balance.availableMinor)}/><Metric label="Pending" value={pounds(finance.balance.pendingMinor)}/><Metric label="Held" value={pounds(finance.balance.heldMinor)}/><Metric label="Reported bank payouts" value={pounds(finance.balance.bankPaidMinor)} hint={mode === "stripe_live" ? "Provider-reported paid records" : "Test reports are not real money"}/></div><div className="dashboard-finance-details"><span>Reported bank payouts pending <strong>{pounds(finance.balance.bankPendingMinor)}</strong></span><span>Cash commission outstanding <strong>{pounds(finance.balance.cashCommissionOutstandingMinor)}</strong></span><span>Period commission <strong>{pounds(finance.period.commissionMinor)}</strong></span><span>Period refunds <strong>{pounds(finance.period.refundsMinor)}</strong></span><span>Period cash collected <strong>{pounds(finance.period.cashCollectedMinor)}</strong></span><span>Average confirmed order <strong>{pounds(finance.period.averageOrderMinor)}</strong></span></div>{finance.balance.nextPayout?.scheduledFor && <p className="fine">Next scheduled payout: {shortDate(finance.balance.nextPayout.scheduledFor)} · estimated {pounds(finance.balance.nextPayout.estimatedAmountMinor)} · {readable(finance.balance.nextPayout.status)}. A schedule is not confirmation of receipt.</p>}<p className="fine">Cash is collected directly by your restaurant. It is not a card payout or money due from Cal-Eats.</p></section>}
      <div className="dashboard-secondary-grid"><section className="panel" aria-labelledby="dashboard-top-items-title"><p className="eyebrow">{selectedLabel}</p><h2 id="dashboard-top-items-title">Popular items</h2>{data.topItems?.length ? <ol className="dashboard-top-items">{data.topItems.slice(0, 6).map((item, index) => <li key={`${item.name}:${index}`}><div><span>{item.name}</span><strong>{item.quantity} sold</strong></div><div className="dashboard-item-track" aria-hidden="true"><span style={{ width: `${Math.max(2, Math.min(100, (item.quantity / Math.max(1, ...data.topItems.map(row => row.quantity))) * 100))}%` }}/></div></li>)}</ol> : <p className="empty">No confirmed item sales in this period yet.</p>}</section><section className="panel" aria-labelledby="dashboard-tools-title"><p className="eyebrow">Day-to-day</p><h2 id="dashboard-tools-title">Restaurant tools</h2><div className="dashboard-tool-links"><NavLink to="/owner/menu">Edit menu & availability <span>→</span></NavLink>{isOwner && <><NavLink to="/owner/inbox">Customer messages <span>→</span></NavLink><NavLink to="/owner/customers">Your customers <span>→</span></NavLink><NavLink to="/owner/offers">Personalised offers <span>→</span></NavLink><NavLink to="/owner/printers">Receipt printers <span>→</span></NavLink><NavLink to="/owner/settings">Opening hours & delivery <span>→</span></NavLink></>}<NavLink to="/owner/orders">Manage orders <span>→</span></NavLink></div></section></div>
      <section className="panel" aria-labelledby="dashboard-order-earnings-title"><div className="dashboard-section-heading"><div><p className="eyebrow">{selectedLabel}</p><h2 id="dashboard-order-earnings-title">{finance ? "Earnings by order" : "Orders"}</h2></div><span className="fine">{pagination?.total || 0} order{pagination?.total === 1 ? "" : "s"}</span></div>{items.length ? <div className="table-wrap responsive-table dashboard-order-table"><table><thead><tr><th>Order</th><th>Status</th>{finance && <><th>Order total</th><th>Commission</th><th>Restaurant earnings</th><th>Payment & payout</th></>}</tr></thead><tbody>{items.map(order => <tr key={order.id}><td data-label="Order"><NavLink to={`/owner/orders?order=${encodeURIComponent(order.id)}`}>#{order.id.slice(0, 8).toUpperCase()}</NavLink><small>{order.customerName || "Customer"}</small><small>{shortDate(order.createdAt)}</small></td><td data-label="Status"><strong>{readable(order.status)}</strong><small>{readable(order.fulfillment)}</small></td>{finance && <><td data-label="Order total"><strong>{pounds(order.totalMinor)}</strong>{order.refundsMinor > 0 && <small>{pounds(order.refundsMinor)} refunded</small>}</td><td data-label="Commission">{pounds(order.commissionMinor)}</td><td data-label="Restaurant earnings"><strong className="dashboard-net">{pounds(order.netEarningsMinor)}</strong></td><td data-label="Payment & payout"><strong>{order.payoutLabel || "Awaiting payment status"}</strong><small>{readable(order.paymentMethod)} · {readable(order.paymentState)}</small>{order.providerMode && !["stripe_live", "live"].includes(order.providerMode) && <small>Test mode · no bank payout</small>}</td></>}</tr>)}</tbody></table></div> : <p className="empty">No orders were placed in this period.</p>}{pagination && pagination.totalPages > 1 && <nav className="dashboard-pagination" aria-label="Order earnings pages"><button className="quiet" disabled={result.loading || page <= 1} onClick={() => setPage(previous => Math.max(1, previous - 1))}>Previous</button><span>Page {pagination.page} of {pagination.totalPages}</span><button className="quiet" disabled={result.loading || page >= pagination.totalPages} onClick={() => setPage(previous => previous + 1)}>Next</button></nav>}</section>
      {isOwner && <WeeklyStatements restaurantId={restaurant.id}/>}
    </div>}
  </div>;
}
