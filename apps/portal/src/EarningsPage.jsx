import React, { useEffect, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import { api, json, newKey } from "./api.js";
import { pounds, shortDate } from "./model.js";
import { useFinanceResource } from "./finance-resource.js";
import { WorkspaceDialog } from "./CustomerWorkspace.jsx";
import OrderFinancialBreakdown from "./OrderFinancialBreakdown.jsx";
import "./EarningsFinance.css";

const periods = [["today", "Today"], ["yesterday", "Yesterday"], ["this_week", "This week"], ["last_week", "Last week"]];
const readable = value => String(value || "Awaiting update").replaceAll("_", " ");
const payoutLabel = value => ({ paid: "Stripe reports paid", pending: "Pending", in_transit: "In transit", failed: "Failed", canceled: "Cancelled", cancelled: "Cancelled" })[value] || readable(value);
const currencyMoney = (amount, currency) => new Intl.NumberFormat("en-GB", { style: "currency", currency: /^[A-Za-z]{3}$/.test(currency || "") ? currency.toUpperCase() : "GBP" }).format((amount || 0) / 100);
function Metric({ label, value, hint }) { return <article className="finance-metric"><span>{label}</span><strong>{value}</strong>{hint && <small>{hint}</small>}</article>; }
function BankStatus({ bank }) { return <article className="finance-bank-card"><div><span className="finance-bank-symbol" aria-hidden="true">▥</span><div><strong>{bank.bankName || "Connected bank account"}</strong><p className="finance-bank-last4">{bank.last4 ? `•••• ${bank.last4}` : "Account ending unavailable"}</p></div></div><p className="fine">{bank.currency?.toUpperCase() || "Currency unavailable"} · {bank.country || "Country unavailable"}{bank.defaultForCurrency ? " · Default payout account" : ""}</p><span className="pill">{readable(bank.status)}</span></article>; }

export function BankPayoutPanel({ restaurantId, showSetupLink = true }) {
  return <BankPayoutWorkspace key={restaurantId} restaurantId={restaurantId} showSetupLink={showSetupLink}/>;
}
function BankPayoutWorkspace({ restaurantId, showSetupLink }) {
  const root = `/api/restaurant/restaurants/${restaurantId}/finance/stripe`;
  const banking = useFinanceResource(`${root}/banking`);
  const [cursors, setCursors] = useState([null]), [cursorIndex, setCursorIndex] = useState(0), [busy, setBusy] = useState(false), [actionError, setActionError] = useState("");
  const managing = useRef(false), active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const cursor = cursors[cursorIndex];
  const query = new URLSearchParams({ pageSize: "20", ...(cursor ? { startingAfter: cursor } : {}) });
  const payouts = useFinanceResource(`${root}/payouts?${query}`);
  const bank = banking.value, rows = payouts.value?.items || [];
  useEffect(() => {
    const refresh = () => { if (!document.hidden && !managing.current) { void banking.reload(); void payouts.reload(); } };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [banking.reload, payouts.reload]);
  async function manageBank() {
    if (managing.current || !bank?.canManageBankDetails) return;
    managing.current = true; setBusy(true); setActionError("");
    try {
      const value = await api(`${root}/dashboard`, json("POST", {}, newKey("bank-details")));
      if (!active.current) return;
      const destination = new URL(value.url);
      if (destination.protocol !== "https:" || !["connect.stripe.com", "dashboard.stripe.com"].includes(destination.hostname) || destination.username || destination.password) throw new Error("Stripe returned an unexpected destination. Refresh and try again.");
      window.location.assign(destination.href);
    } catch (error) { if (active.current) { setActionError(error.message); managing.current = false; setBusy(false); } }
  }
  function next() { if (!payouts.value?.hasMore || !payouts.value.nextCursor) return; setCursors(previous => [...previous.slice(0, cursorIndex + 1), payouts.value.nextCursor]); setCursorIndex(index => index + 1); }
  function refresh() { void banking.reload(); if (cursorIndex) { setCursors([null]); setCursorIndex(0); } else void payouts.reload(); }
  return <section className="panel finance-banking" aria-labelledby="finance-banking-title">
    <div className="finance-section-heading"><div><p className="eyebrow">Stripe connection</p><h2 id="finance-banking-title">Bank account and payouts</h2></div><button className="quiet" disabled={banking.loading || payouts.loading || busy} onClick={refresh}>Refresh bank & payouts</button></div>
    {(banking.error || actionError) && <p className="alert" role="alert">{banking.error || actionError}</p>}
    {!bank ? <p role="status">{banking.loading ? "Loading your bank connection…" : "Bank connection unavailable. Refresh to try again."}</p> : <>
      {bank.providerMode !== "stripe_live" && <p className="finance-preview-note">{bank.providerMode === "stripe_test" ? "Stripe sandbox" : "Preview mode"} · Any test bank or payout details are separate from real payments.</p>}
      {!bank.connected ? <div className="finance-empty"><h3>Bank account awaiting Stripe connection</h3><p>{bank.note || "Your business and bank details are entered securely with Stripe. No bank account is connected to this restaurant yet."}</p>{showSetupLink && <NavLink className="button-link" to="/owner/stripe">Open Stripe setup</NavLink>}</div> : <>
        <div className="finance-bank-list">{bank.bankAccounts?.length ? bank.bankAccounts.map(account => <BankStatus key={account.id} bank={account}/>) : <div className="finance-empty"><strong>{bank.bankDetailsAvailable ? "No payout bank details reported" : "Bank details available through Stripe"}</strong><p>{bank.note || "Open Stripe to view or update your payout destination."}</p></div>}</div>
        <div className="finance-account-state"><span>Account: <strong>{readable(bank.account?.status)}</strong></span><span>Card payments: <strong>{bank.account?.chargesEnabled ? "Enabled" : "Not enabled"}</strong></span><span>Bank payouts: <strong>{bank.account?.payoutsEnabled ? "Enabled" : "Not enabled"}</strong></span></div>
        {bank.account?.requirements?.length > 0 && <p className="finance-preview-note">Stripe needs more information. Open Stripe setup to review the remaining verification tasks.</p>}
        {bank.canManageBankDetails && <button className="primary" disabled={busy} onClick={() => void manageBank()}>{busy ? "Opening Stripe…" : "View or update bank details in Stripe"}</button>}
        <p className="fine">Cal-Eats shows only masked bank information. Changes are made on Stripe’s secure pages. {bank.refreshedAt ? `Last refreshed ${shortDate(bank.refreshedAt)}.` : ""}</p>
      </>}
      <p className="fine">Payout schedule: {bank.payoutSchedule?.interval === "weekly" ? `weekly on ${readable(bank.payoutSchedule.weeklyAnchor || "monday")}` : readable(bank.payoutSchedule?.interval)}. Available funds, verification and bank processing affect arrival.</p>
    </>}
    <h3>Bank payout history · all dates</h3>
    <p className="fine">These are Stripe’s bank payout records. Transfers from individual orders to your connected Stripe balance are shown separately in each order breakdown.</p>
    {payouts.error && <p className="alert" role="alert">Payout history could not be loaded: {payouts.error}</p>}
    {payouts.loading && !payouts.value ? <p role="status">Loading bank payout history…</p> : !rows.length ? <p className="finance-empty">No Stripe bank payouts have been reported for this restaurant.</p> : <div className="table-wrap"><table className="finance-history-table"><thead><tr><th>Payout</th><th>Amount</th><th>Status</th><th>Expected arrival</th><th>Paid confirmation</th></tr></thead><tbody>{rows.map(payout => <tr key={payout.id}>
      <td data-label="Payout"><strong>{payout.id}</strong><small>Created {shortDate(payout.createdAt)}</small>{payout.destinationLast4 && <small>Bank ending {payout.destinationLast4}</small>}</td>
      <td data-label="Amount">{currencyMoney(payout.amountMinor, payout.currency)}</td><td data-label="Status"><strong>{payoutLabel(payout.status)}</strong>{payout.failure && <small className="finance-failure">{payout.failure}</small>}</td>
      <td data-label="Expected arrival">{shortDate(payout.expectedArrivalAt || payout.arrivalAt)}</td><td data-label="Paid confirmation">{payout.paidAt ? shortDate(payout.paidAt) : payout.status === "paid" ? "Paid status reported; confirmation time unavailable" : "Not reported paid"}</td>
    </tr>)}</tbody></table></div>}
    {(cursorIndex > 0 || payouts.value?.hasMore) && <div className="finance-pagination"><button className="quiet" disabled={!cursorIndex || payouts.loading} onClick={() => setCursorIndex(index => index - 1)}>Previous payouts</button><span>Page {cursorIndex + 1}</span><button className="quiet" disabled={!payouts.value?.hasMore || payouts.loading} onClick={next}>Next payouts</button></div>}
    <p className="fine">An expected arrival is an estimate. “Stripe reports paid” reflects Stripe’s status and does not independently verify receipt in your bank account.</p>
  </section>;
}

const views = [["overview", "Overview"], ["payouts", "Bank & payouts"], ["orders", "Order statements"]];
function FinanceViews({ value, onChange }) {
  return <nav className="finance-views" aria-label="Earnings views">{views.map(([id,label])=><button type="button" key={id} aria-current={value===id?"page":undefined} className={value===id?"selected":""} onClick={()=>onChange(id)}>{label}</button>)}</nav>;
}
function BalanceOverview({ balance }) {
  return <section className="panel finance-balance-panel"><div className="finance-section-heading"><div><p className="eyebrow">Across all dates</p><h2>Your Cal-Eats balance</h2></div><span className="finance-subtle-label">Separate from bank payouts</span></div><div className="finance-metrics"><Metric label="Available earnings" value={pounds(balance.availableMinor)} hint="Available in your Cal-Eats balance"/><Metric label="Pending earnings" value={pounds(balance.pendingMinor)} hint="Awaiting release or settlement"/><Metric label="Held earnings" value={pounds(balance.heldMinor)} hint="Held for review or adjustments"/></div><details className="finance-cash-details"><summary>Cash orders and outstanding commission</summary><div className="finance-amount"><span>Cash commission outstanding</span><strong>{pounds(balance.cashCommissionOutstandingMinor)}</strong></div><p className="fine">Cash is received directly by your restaurant. This is separate from earnings transferred through Stripe.</p></details></section>;
}
export default function EarningsPage({ restaurantId }) {
  const [view,setView]=useState("overview"),[period,setPeriod]=useState("this_week"),[page,setPage]=useState(1),[selectedOrder,setSelectedOrder]=useState(null);
  const root=`/api/restaurant/restaurants/${restaurantId}/finance`;
  const dashboard=useFinanceResource(`/api/restaurant/restaurants/${restaurantId}/dashboard?period=${period}&page=${page}&pageSize=20`);
  const data=dashboard.value,finance=data?.finance,rows=data?.orders?.items||[],pagination=data?.orders?.pagination;
  const periodName=periods.find(([id])=>id===period)?.[1]||"Selected period";
  function choose(next){if(next!==period){setPeriod(next);setPage(1);}}
  useEffect(()=>{const refresh=()=>{if(!document.hidden)void dashboard.reload();};window.addEventListener("focus",refresh);window.addEventListener("cal-eats-orders-updated",refresh);return()=>{window.removeEventListener("focus",refresh);window.removeEventListener("cal-eats-orders-updated",refresh);};},[dashboard.reload]);
  const statementQuery=data?.range?`?from=${data.range.fromDate}&to=${data.range.toDate}`:"";
  if(data&&data.permission!=="owner")return <section className="panel"><h1>Owner access required</h1><p>Your restaurant membership does not include financial statements or bank details.</p><NavLink className="button-link" to="/owner/dashboard">Return to dashboard</NavLink></section>;
  return <div className="earnings-workspace">
    <header className="page-heading finance-section-heading"><div><p className="eyebrow">Your business finances</p><h1>Earnings & payouts</h1><p>Follow your earnings from each order to your bank.</p></div><span className="finance-currency-tag">GBP · UK time</span></header>
    <FinanceViews value={view} onChange={setView}/>
    {view!=="payouts"&&<section className="finance-filter-bar"><div className="finance-periods" role="group" aria-label="Earnings period">{periods.map(([value,label])=><button type="button" key={value} className={period===value?"selected":""} aria-pressed={period===value} onClick={()=>choose(value)}>{label}</button>)}</div><button className="quiet" disabled={dashboard.loading} onClick={()=>void dashboard.reload()}>{dashboard.loading?"Refreshing…":"Refresh earnings"}</button>{data?.range&&<p className="fine">{data.range.fromDate} – {data.range.toDate} · Orders placed in this period{data.generatedAt?` · Updated ${shortDate(data.generatedAt)}`:""}</p>}</section>}
    {view!=="payouts"&&dashboard.error&&<p className="alert" role="alert">Earnings could not be loaded: {dashboard.error}</p>}
    {view!=="payouts"&&finance&&finance.balance.providerMode!=="stripe_live"&&<p className="finance-preview-note">{finance.balance.providerMode==="stripe_test"?"Stripe test mode":"Preview mode"} · Test earnings and balances are separate from real payments and bank payouts.</p>}
    {view!=="payouts"&&!data&&dashboard.loading&&<p role="status">Loading earnings…</p>}
    {view==="overview"&&finance&&<>
      <section className="finance-overview-hero"><div className="finance-net-hero"><span>{periodName} · Restaurant earnings</span><strong>{pounds(finance.period.netEarningsMinor)}</strong><p>After refunds and commission. Bank payouts are shown separately.</p><button className="finance-hero-button" onClick={()=>setView("orders")}>View order statements <span aria-hidden="true">↗</span></button></div><div className="finance-period-totals"><Metric label="Confirmed sales" value={pounds(finance.period.grossSalesMinor)} hint="Confirmed order totals"/><Metric label="Refunds" value={pounds(finance.period.refundsMinor)} hint="Adjustments to these orders"/><Metric label="Commission" value={pounds(finance.period.commissionMinor)} hint="After refund reversals"/></div></section>
      <BalanceOverview balance={finance.balance}/>
      <section className="panel finance-payout-guide"><div className="finance-section-heading"><div><p className="eyebrow">How your money moves</p><h2>From orders to your bank</h2></div><button className="quiet" onClick={()=>setView("payouts")}>View bank & payouts</button></div><ol><li><span>1</span><div><strong>Order earnings</strong><p>Saved order prices, offers, refunds and commission determine your earnings.</p></div></li><li><span>2</span><div><strong>Stripe balance</strong><p>Eligible card earnings are transferred to your connected Stripe account.</p></div></li><li><span>3</span><div><strong>Bank payout</strong><p>Stripe sends funds to your bank according to its payout schedule.</p></div></li></ol></section>
    </>}
    {view==="payouts"&&<BankPayoutPanel restaurantId={restaurantId}/>}
    {view==="orders"&&<section className="panel finance-order-statements"><div className="finance-section-heading"><div><p className="eyebrow">Every order explained</p><h2>Order statements</h2></div>{data?.range&&<a className="button-link" href={`${root}/statement.csv${statementQuery}`}>Download activity CSV</a>}</div><p className="fine">Open any order for item prices, offers, commission, refunds and retained earnings. The CSV lists financial activity within the selected dates. <NavLink to="/owner/orders">Find older orders</NavLink>.</p>
      {data&&!rows.length&&<div className="finance-empty"><h3>No orders in {periodName.toLowerCase()}</h3><p>Choose another period to view its order statements.</p></div>}
      {rows.length>0&&<div className="table-wrap"><table className="finance-history-table finance-orders-table"><thead><tr><th>Order</th><th>Customer total</th><th>Your earnings</th><th>Settlement</th><th>Details</th></tr></thead><tbody>{rows.map(order=><tr key={order.id}><td data-label="Order"><strong>#{order.id.slice(0,8).toUpperCase()}</strong><small>{shortDate(order.createdAt)} · {readable(order.status)}</small></td><td data-label="Customer total">{pounds(order.totalMinor)}<small>Refunds {pounds(order.refundsMinor)}</small></td><td data-label="Your earnings"><strong>{pounds(order.netEarningsMinor)}</strong><small>Commission {pounds(order.commissionMinor)}</small></td><td data-label="Settlement"><span className="finance-settlement-label">{order.payoutLabel}</span><small>{order.paymentMethod==="cash"?"Cash payment handled by your restaurant":readable(order.paymentMethod)}</small></td><td data-label="Details"><button className="quiet" onClick={()=>setSelectedOrder(order.id)}>View breakdown</button></td></tr>)}</tbody></table></div>}
      {pagination?.totalPages>1&&<div className="finance-pagination"><button className="quiet" disabled={page<=1||dashboard.loading} onClick={()=>setPage(value=>value-1)}>Previous orders</button><span>Page {page} of {pagination.totalPages}</span><button className="quiet" disabled={page>=pagination.totalPages||dashboard.loading} onClick={()=>setPage(value=>value+1)}>Next orders</button></div>}
    </section>}
    {selectedOrder&&<WorkspaceDialog title={`Order #${selectedOrder.slice(0,8).toUpperCase()}`} onClose={()=>setSelectedOrder(null)}><OrderFinancialBreakdown key={selectedOrder} restaurantId={restaurantId} orderId={selectedOrder}/><NavLink className="button-link" to={`/owner/orders?order=${encodeURIComponent(selectedOrder)}`}>Open order and customer messages</NavLink></WorkspaceDialog>}
  </div>;
}
