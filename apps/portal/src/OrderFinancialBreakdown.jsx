import React from "react";
import { pounds, shortDate } from "./model.js";
import { useFinanceResource } from "./finance-resource.js";
import "./EarningsFinance.css";

const readable = value => String(value || "").replaceAll("_", " ");
function Amount({ label, value, negative, strong }) { return <div className={`finance-amount${strong ? " strong" : ""}`}><span>{label}</span><strong>{negative && value ? "−" : ""}{pounds(value)}</strong></div>; }

export default function OrderFinancialBreakdown({ restaurantId, orderId }) {
  const result = useFinanceResource(`/api/restaurant/restaurants/${restaurantId}/finance/orders/${orderId}/breakdown`);
  const value = result.value;
  return <section className="order-financial-breakdown" aria-label="Order financial breakdown">
    <div className="finance-section-heading"><div><p className="eyebrow">Order statement</p><h3>Financial breakdown</h3></div><button type="button" className="quiet" disabled={result.loading} onClick={() => void result.reload()}>{result.loading && value ? "Refreshing…" : "Refresh breakdown"}</button></div>
    {result.error && <p className="alert" role="alert">The breakdown could not be loaded: {result.error}</p>}
    {!value ? <p role="status">{result.loading ? "Loading the order statement…" : "The financial statement is unavailable. Use Refresh to try again."}</p> : <>
      <p className="fine">Order #{value.orderId.slice(0, 8).toUpperCase()} · {shortDate(value.createdAt)}. Prices, commission and offers follow the order’s saved details.</p>
      {value.providerMode !== "stripe_live" && <p className="finance-preview-note">{value.providerMode === "stripe_test" ? "Stripe test payment" : "Preview payment"} · These figures do not establish a real charge or bank payout.</p>}
      {!value.earnings.confirmed && <p className="finance-preview-note">Earnings are not confirmed for this order. Quoted order prices are shown below; no commission or restaurant earnings are recognised yet.</p>}
      <div className="finance-breakdown-grid">
        <section className="finance-breakdown-card"><h4>Order pricing and refunds</h4>
          <Amount label="Food before money-off offers" value={value.totals.grossFoodMinor}/>
          <Amount label="Restaurant-funded money-off" value={value.totals.restaurantDiscountMinor} negative/>
          <Amount label="Food after money-off" value={value.totals.foodChargedMinor}/>
          <Amount label="Delivery fee" value={value.totals.deliveryFeeMinor}/>
          <Amount label="Order total" value={value.totals.customerChargedMinor} strong/>
          <Amount label="Food refunded" value={value.totals.refundedFoodMinor} negative/>
          <Amount label="Delivery refunded" value={value.totals.refundedDeliveryMinor} negative/>
          <Amount label="Order value after refunds" value={value.totals.retainedCustomerPaymentMinor} strong/>
          <p className="fine">Payment status: {readable(value.paymentStatus)}. {value.paymentMethod === "cash" ? "Cash is received directly by your restaurant." : ""}</p>
        </section>
        <section className="finance-breakdown-card"><h4>Commission and your earnings</h4>
          <Amount label={`Commission basis · ${value.commission.base === "food_plus_delivery" ? "food and delivery" : "food only"}`} value={value.commission.commissionableMinor}/>
          <div className="finance-amount"><span>Saved commission rate</span><strong>{(value.commission.rateBasisPoints / 100).toLocaleString("en-GB", { maximumFractionDigits: 2 })}%</strong></div>
          <Amount label="Original commission" value={value.commission.originalMinor}/>
          <Amount label="Commission reversed after refunds" value={value.commission.reversedMinor} negative/>
          <Amount label="Commission retained" value={value.commission.retainedMinor}/>
          <Amount label="Payment processing charged to you" value={value.earnings.providerFeeChargedToRestaurantMinor}/>
          <Amount label="Original restaurant earnings" value={value.earnings.originalMinor}/>
          <Amount label="Refund impact on your earnings" value={value.earnings.refundImpactMinor} negative/>
          <Amount label="Current restaurant earnings" value={value.earnings.currentMinor} strong/>
          <p className="fine">Payment processing fees are borne by Cal-Eats under this order’s model. {value.commission.developmentAssumption ? "This order uses the displayed development commission agreement." : ""}</p>
        </section>
      </div>
      <section className="finance-breakdown-card"><h4>Items on this order</h4><div className="finance-item-list">{value.items.map((item, index) => <article key={item.id || index}><div><strong>{item.quantity} × {item.name}</strong><span>{item.isOfferItem ? "Free offer item" : pounds(item.lineTotalMinor)}</span></div>{item.modifiers?.length > 0 && <small>{item.modifiers.map(modifier => `${modifier.name}${modifier.priceMinor ? ` (${pounds(modifier.priceMinor)})` : ""}`).join(" · ")}</small>}</article>)}</div></section>
      <section className="finance-breakdown-card"><h4>Promotional offers</h4>{!value.promotion ? <p className="fine">No promotional offer was applied to this order.</p> : <>
        <div className="finance-promotion-heading"><strong>{value.promotion.title || "Restaurant offer"}</strong><span className="pill">{readable(value.promotion.offerType)}</span></div>
        <p className="fine">Funded by your restaurant. The amounts below are the values saved when this order was placed.</p>
        <Amount label="Money-off discount" value={value.promotion.discountMinor}/>
        {value.promotion.freeItems.length > 0 && <><div className="finance-item-list">{value.promotion.freeItems.map((item, index) => <article key={`${item.name}:${index}`}><div><strong>{item.quantity} × {item.name}</strong><span>{pounds(item.retailValueMinor)} retail value</span></div></article>)}</div><Amount label="Free-item retail value" value={value.promotion.freeItemRetailValueMinor}/><p className="fine">Free items were charged at £0. Their retail value is shown for reference; it is not your food cost and is not deducted from earnings again.</p></>}
        {value.promotion.allocations.length > 0 && <details><summary>Discount by item</summary><div className="finance-item-list">{value.promotion.allocations.map((item, index) => <article key={`${item.menuItemId}:${index}`}><strong>{item.name}</strong><small>Before discount {pounds(item.grossMinor)} · discount {pounds(item.discountMinor)} · charged {pounds(item.netMinor)}</small></article>)}</div></details>}
      </>}</section>
      <section className="finance-breakdown-card"><h4>Payout and transfer status</h4><p><strong>{value.settlement.label}</strong></p><Amount label="Transferred to connected Stripe balance" value={value.settlement.transferredMinor}/><Amount label="Transfers reversed" value={value.settlement.reversedTransferMinor}/><p className="fine">{value.settlement.note || "Order earnings and transfers are separate from Stripe’s aggregated bank payouts."}</p></section>
      {value.refunds.length > 0 && <section className="finance-breakdown-card"><h4>Refund activity</h4><div className="finance-item-list">{value.refunds.map(refund => <article key={refund.id}><strong>{shortDate(refund.createdAt)}</strong><small>Food {pounds(refund.foodMinor)} · delivery {pounds(refund.deliveryMinor)} · commission reversed {pounds(refund.commissionReversalMinor)}</small></article>)}</div></section>}
    </>}
  </section>;
}
