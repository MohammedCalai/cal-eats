import React from "react";
import { NavLink } from "react-router-dom";
import { shortDate } from "./model.js";
import { dashboardOrderActivity, productName } from "./unified-business-model.js";
import { useBusinessResource } from "./UnifiedBusiness.jsx";
import { liveOrderCount, LiveOrderOrbit, LiveOrderStages } from "./LiveOrders.jsx";
import "./DashboardWorkspace.css";

const statusLabels = {
  received: "Received", unconfirmed: "Unconfirmed", confirmed: "Confirmed",
  placed: "Awaiting confirmation", accepted: "Confirmed", preparing: "Preparing",
  ready: "Ready", out_for_delivery: "Out for delivery", completed: "Completed",
  rejected: "Rejected", cancelled: "Cancelled", expired: "Expired",
};
const orderType = { delivery: "Delivery", collection: "Collection", takeaway: "Takeaway" };

export function useDashboardOrderActivity(business, products) {
  const enabled = Boolean(business?.id && products.length > 0);
  return useBusinessResource(enabled ? "/api/business/dashboard" : null, {
    poll: enabled ? 30000 : 0,
    scope: enabled ? [business.id, ...products].join(":") : null,
  });
}

function CombinedOrderCards({ counters, products, checking, operations, operationsUnavailable, calaiLiveCalls }) {
  const [{ count: phoneOrders }, { count: onlineOrders }] = counters;
  const calls = calaiLiveCalls?.activeCalls ?? null;
  const live = liveOrderCount(operations, operationsUnavailable);
  const callsLoading = checking && products.includes("calai");
  const hasCallActivity = calaiLiveCalls && [calls, calaiLiveCalls.ringing, calaiLiveCalls.queued, calaiLiveCalls.forwarding]
    .some(count => count > 0);
  const callLabel = calls === null
    ? callsLoading ? "Checking live calls" : "Live calls unavailable"
    : calls === 1 ? "1 live call" : calls + " live calls";
  const liveLabel = live === null
    ? operationsUnavailable ? "Live order count unavailable" : "Checking live orders"
    : live + " live orders";

  return <div className="dashboard-service-grid">
    <article className="dashboard-service-card source-calai" aria-labelledby="combined-calai-title">
      <header className="dashboard-service-heading">
        <h3 id="combined-calai-title">Calai</h3><p>Live calls</p>
      </header>
      <LiveOrderOrbit value={calls?.toLocaleString("en-GB")} label="LIVE CALLS"
        active={hasCallActivity} announcement={callLabel}/>
      <div className="dashboard-service-status">
        {calaiLiveCalls ? <div className="live-order-stages">
          <span>{calaiLiveCalls.agentsInUse} {calaiLiveCalls.agentsInUse === 1 ? "agent" : "agents"} in use</span>
          <span>{calaiLiveCalls.ringing} ringing</span>
          <span>{calaiLiveCalls.queued} queued</span>
          <span>{calaiLiveCalls.forwarding} forwarded</span>
        </div> : <p>{callLabel}</p>}
        {phoneOrders !== null && <p className="dashboard-service-today">{phoneOrders.toLocaleString("en-GB")} {phoneOrders === 1 ? "phone order" : "phone orders"} today</p>}
      </div>
      {products.includes("calai") && <NavLink className="button-link dashboard-service-action" to="/owner/calai/orders">View phone orders</NavLink>}
    </article>
    <article className="dashboard-service-card source-cal-eats" aria-labelledby="combined-eats-title">
      <header className="dashboard-service-heading">
        <h3 id="combined-eats-title">Cal-Eats</h3><p>Online orders</p>
      </header>
      <LiveOrderOrbit value={live?.toLocaleString("en-GB")} label="LIVE ORDERS" active={live > 0} announcement={liveLabel}/>
      <div className="dashboard-service-status">
        {live === null ? <p>{liveLabel}</p> : <LiveOrderStages operations={operations}/>}
        {onlineOrders !== null && <p className="dashboard-service-today">{onlineOrders.toLocaleString("en-GB")} received today</p>}
      </div>
      {products.includes("cal-eats") && <NavLink className="button-link dashboard-service-action" to="/owner/orders">Manage online orders</NavLink>}
    </article>
  </div>;
}

export function DashboardOrderActivity({ businessId, products, resource, workspaceMode, operations, operationsUnavailable }) {
  const combined = workspaceMode === "both";
  const visibleProducts = combined ? ["calai", "cal-eats"]
    : workspaceMode === "calai" ? ["calai"] : workspaceMode === "cal-eats" ? ["cal-eats"] : products;
  const snapshot = !resource.error && resource.value?.business?.id === businessId ? resource.value : null;
  const activity = dashboardOrderActivity(snapshot, businessId, products);
  const callSnapshot = combined && products.includes("calai") ? snapshot?.calaiLiveCalls : null;
  const validCallSnapshot = callSnapshot && ["activeCalls", "agentsInUse", "ringing", "queued", "forwarding"]
    .every(key => Number.isSafeInteger(callSnapshot[key]) && callSnapshot[key] >= 0);
  const counters = visibleProducts.map(product => ({ product,
    count: activity.counters.find(counter => counter.product === product)?.count ?? null,
  }));
  const rows = activity.rows.filter(order => visibleProducts.includes(order.source));
  const checking = resource.loading && !resource.value && !resource.error;
  const unavailable = counters.filter(({ product, count }) => count === null && (!checking || !products.includes(product)));
  const countLabel = (count, loading = checking) => count === null ? (loading ? "Loading…" : "Unavailable") : count.toLocaleString("en-GB");
  return <section className={"panel dashboard-workspace-orders" + (combined ? " dashboard-workspace-orders--combined" : "")} aria-labelledby="dashboard-orders-title">
    <div className="dashboard-section-heading">
      <div>{!combined && <p className="eyebrow">Today · London time</p>}<h2 id="dashboard-orders-title">{combined ? "Live activity" : "Orders"}</h2></div>
      {!combined && <div className="button-row">
        {visibleProducts.includes("calai") && products.includes("calai") && <NavLink className="button-link" to="/owner/calai/orders">Calai orders</NavLink>}
        {visibleProducts.includes("cal-eats") && products.includes("cal-eats") && <NavLink className="button-link" to="/owner/orders">Cal-Eats orders</NavLink>}
      </div>}
    </div>
    {combined
      ? <CombinedOrderCards counters={counters} products={products} checking={checking} operations={operations}
          operationsUnavailable={operationsUnavailable} calaiLiveCalls={validCallSnapshot ? callSnapshot : null}/>
      : <dl className="dashboard-source-counts dashboard-workspace-counts" aria-label="Orders received today">
      {counters.map(({ product, count }) => <div className={`dashboard-workspace-counter source-${product}`} key={product}><dt>{productName(product)}</dt><dd><strong>{countLabel(count, checking && products.includes(product))}</strong><span>{product === "calai" ? "Telephone orders" : "Online orders"}</span></dd></div>)}
    </dl>}
    {unavailable.length > 0 && <p className="dashboard-workspace-availability" role="status">Current order information is unavailable for {unavailable.map(({ product }) => productName(product)).join(" and ")}.{resource.error && products.length > 0 && <button type="button" className="quiet" onClick={() => void resource.reload()}>Refresh orders</button>}</p>}
    {rows.length ? <div className="table-wrap responsive-table dashboard-order-table">
      <table>
        <caption className="dashboard-source-caption">Latest orders received today</caption>
        <thead><tr><th scope="col">Order</th><th scope="col">Source</th><th scope="col">Status</th></tr></thead>
        <tbody>{rows.map(order => {
          const reference = "#" + order.sourceOrderId.slice(0, 8).toUpperCase();
          return <tr key={order.id}>
            <td data-label="Order">
              {order.source === "cal-eats"
                ? <NavLink to={`/owner/orders?order=${encodeURIComponent(order.sourceOrderId)}`}>{reference}</NavLink>
                : <strong>{reference}</strong>}
              <small>{order.customerName || "Customer"}</small><small>{shortDate(order.createdAt)}</small>
            </td>
            <td data-label="Source"><span className={`dashboard-order-source source-${order.source}`}>
              {order.source === "calai" ? "Calai · Phone" : "Cal-Eats · Online"}
            </span></td>
            <td data-label="Status">
              <strong>{statusLabels[order.status] || "Status unavailable"}</strong>
              {orderType[order.fulfilment] && <small>{orderType[order.fulfilment]}</small>}
            </td>
          </tr>;
        })}</tbody>
      </table>
    </div> : <p className="empty" role="status">{checking ? "Loading today’s orders…" :
      counters.every(({ count }) => count === 0) ? "No orders received today." :
      "No recent orders are available to display."}</p>}
  </section>;
}

export function OrderActivityDashboard({ business, products, onRetryRestaurant, workspaceMode }) {
  const resource = useDashboardOrderActivity(business, products);
  return <div className="business-dashboard">
    <header className="page-heading dashboard-heading">
      <div>{workspaceMode === "calai" && <p className="eyebrow">Calai</p>}<h1>Dashboard</h1><p>{business.name}</p></div>
      <div className="dashboard-heading-actions"><button className="quiet" disabled={resource.loading || !products.length} onClick={() => void resource.reload()}>Refresh</button></div>
    </header>
    {onRetryRestaurant && <p className="alert" role="status">Cal-Eats restaurant tools are temporarily unavailable. <button className="quiet" type="button" onClick={() => void onRetryRestaurant()}>Try again</button></p>}
    <DashboardOrderActivity businessId={business.id} products={products} resource={resource} workspaceMode={workspaceMode} operationsUnavailable/>
  </div>;
}
