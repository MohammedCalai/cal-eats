import React from "react";
import { NavLink } from "react-router-dom";
import { shortDate } from "./model.js";
import { dashboardOrderActivity, productName } from "./unified-business-model.js";
import { useBusinessResource } from "./UnifiedBusiness.jsx";

const statusLabels = {
  received: "Received", unconfirmed: "Unconfirmed", confirmed: "Confirmed",
  placed: "Awaiting confirmation", accepted: "Confirmed", preparing: "Preparing",
  ready: "Ready", out_for_delivery: "Out for delivery", completed: "Completed",
  rejected: "Rejected", cancelled: "Cancelled", expired: "Expired",
};
const orderType = { delivery: "Delivery", collection: "Collection", takeaway: "Takeaway" };

export function useDashboardOrderActivity(business, products) {
  const enabled = products.length > 0;
  return useBusinessResource(enabled ? "/api/business/dashboard" : null, {
    poll: enabled ? 30000 : 0,
    scope: enabled ? [business.id, ...products].join(":") : null,
  });
}

export function DashboardOrderActivity({ businessId, products, resource }) {
  const { counters, total, rows } = dashboardOrderActivity(
    resource.error ? null : resource.value, businessId, products,
  );
  const checking = resource.loading && !resource.value && !resource.error;
  const countLabel = count => count === null ? (checking ? "Loading…" : "Unavailable") : count.toLocaleString("en-GB");
  return <section className="panel" aria-labelledby="dashboard-orders-title">
    <div className="dashboard-section-heading">
      <div><p className="eyebrow">Today · London time</p><h2 id="dashboard-orders-title">Orders</h2></div>
      <div className="button-row">
        {products.includes("calai") && <NavLink className="button-link" to="/owner/calai/orders">Calai orders</NavLink>}
        {products.includes("cal-eats") && <NavLink className="button-link" to="/owner/orders">Cal-Eats orders</NavLink>}
      </div>
    </div>
    <dl className="dashboard-source-counts" aria-label="Orders received today">
      {counters.map(({ product, count }) => <div key={product}><dt>{productName(product)}</dt><dd>{countLabel(count)}</dd></div>)}
      {products.length > 1 && <div><dt>Total received</dt><dd>{countLabel(total)}</dd></div>}
    </dl>
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

export function OrderActivityDashboard({ business, products, onRetryRestaurant }) {
  const resource = useDashboardOrderActivity(business, products);
  return <div className="business-dashboard">
    <header className="page-heading dashboard-heading">
      <div><h1>Dashboard</h1><p>{business.name}</p></div>
      <button className="quiet" disabled={resource.loading} onClick={() => void resource.reload()}>Refresh</button>
    </header>
    {onRetryRestaurant && <p className="alert" role="status">Cal-Eats restaurant tools are temporarily unavailable. <button className="quiet" type="button" onClick={() => void onRetryRestaurant()}>Try again</button></p>}
    <DashboardOrderActivity businessId={business.id} products={products} resource={resource}/>
  </div>;
}
