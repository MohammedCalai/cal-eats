import React from "react";
import { NavLink } from "react-router-dom";
import { shortDate } from "./model.js";
import { dashboardOrderActivity, productName } from "./unified-business-model.js";
import { useBusinessResource } from "./UnifiedBusiness.jsx";
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

export function DashboardOrderActivity({ businessId, products, resource, workspaceMode }) {
  const visibleProducts = workspaceMode === "both" ? ["calai", "cal-eats"]
    : workspaceMode === "calai" ? ["calai"] : workspaceMode === "cal-eats" ? ["cal-eats"] : products;
  const activity = dashboardOrderActivity(
    resource.error ? null : resource.value, businessId, products,
  );
  const counters = visibleProducts.map(product => ({ product,
    count: activity.counters.find(counter => counter.product === product)?.count ?? null,
  }));
  const rows = activity.rows.filter(order => visibleProducts.includes(order.source));
  const checking = resource.loading && !resource.value && !resource.error;
  const unavailable = counters.filter(({ product, count }) => count === null && (!checking || !products.includes(product)));
  const countLabel = (count, loading = checking) => count === null ? (loading ? "Loading…" : "Unavailable") : count.toLocaleString("en-GB");
  return <section className="panel dashboard-workspace-orders" aria-labelledby="dashboard-orders-title">
    <div className="dashboard-section-heading">
      <div><p className="eyebrow">Today · London time</p><h2 id="dashboard-orders-title">{workspaceMode === "both" ? "Combined orders" : "Orders"}</h2></div>
      <div className="button-row">
        {visibleProducts.includes("calai") && products.includes("calai") && <NavLink className="button-link" to="/owner/calai/orders">Calai orders</NavLink>}
        {visibleProducts.includes("cal-eats") && products.includes("cal-eats") && <NavLink className="button-link" to="/owner/orders">Cal-Eats orders</NavLink>}
      </div>
    </div>
    <dl className="dashboard-source-counts dashboard-workspace-counts" aria-label="Orders received today">
      {counters.map(({ product, count }) => <div className={`dashboard-workspace-counter source-${product}`} key={product}><dt>{productName(product)}</dt><dd><strong>{countLabel(count, checking && products.includes(product))}</strong><span>{product === "calai" ? "Telephone orders" : "Online orders"}</span></dd></div>)}
    </dl>
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
      <div className="dashboard-heading-actions">{workspaceMode === "calai" && <a className="button-link" href="https://calai.info/owner/dashboard" target="_blank" rel="noopener noreferrer">Open original Calai dashboard ↗</a>}<button className="quiet" disabled={resource.loading || !products.length} onClick={() => void resource.reload()}>Refresh</button></div>
    </header>
    {onRetryRestaurant && <p className="alert" role="status">Cal-Eats restaurant tools are temporarily unavailable. <button className="quiet" type="button" onClick={() => void onRetryRestaurant()}>Try again</button></p>}
    <DashboardOrderActivity businessId={business.id} products={products} resource={resource} workspaceMode={workspaceMode}/>
  </div>;
}
