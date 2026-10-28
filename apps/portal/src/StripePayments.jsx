import React, { useEffect, useRef, useState } from "react";
import { api, json, newKey } from "./api.js";
import { BankPayoutPanel } from "./EarningsPage.jsx";
import { useFinanceResource } from "./finance-resource.js";

const money = (minor) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format((minor || 0) / 100);
function hosted(url, hosts) { const parsed = new URL(url); if (parsed.protocol !== "https:" || !hosts.includes(parsed.hostname) || parsed.username || parsed.password) throw new Error("Stripe returned an unexpected destination."); return parsed.toString(); }

export function StripeRestaurantFinance({ restaurantId }) {
  return <StripeRestaurantWorkspace key={restaurantId} restaurantId={restaurantId}/>;
}
function StripeRestaurantWorkspace({ restaurantId }) {
  const root = `/api/restaurant/restaurants/${restaurantId}/finance/stripe`;
  const result = useFinanceResource(root), [error, setError] = useState(""), [busy, setBusy] = useState(""), [bankVersion, setBankVersion] = useState(0);
  const pending = useRef(false), active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function action(kind, hosts) {
    if (pending.current) return;
    pending.current = true; setBusy(kind); setError("");
    try {
      const value = await api(`${root}/${kind}`, json("POST", {}, newKey(`stripe-${kind}`)));
      if (!active.current) return;
      if (value.url) window.location.assign(hosted(value.url, hosts));
      else { await result.reload(); if (active.current) setBankVersion(version => version + 1); }
    } catch (caught) { if (active.current) setError(caught.message); }
    finally { pending.current = false; if (active.current) setBusy(""); }
  }
  const stripe = result.value, account = stripe?.account || {};
  return <section>
    <h2>Your payment connection</h2>
    {(result.error || error) && <p className="alert" role="alert">{result.error || error}</p>}
    {!stripe ? <p role="status">{result.loading ? "Loading Stripe status…" : "Stripe status is unavailable. Refresh to try again."}</p> : !stripe.configured ? <div className="finance-empty"><h3>Card payments awaiting connection</h3><p>Cal-Eats is preparing its Stripe account. No real card charge or bank payout occurs in this preview.</p><ol><li>Cal-Eats connects the payment account.</li><li>You enter your business and bank details securely with Stripe.</li><li>Once verified, completed orders become eligible for restaurant transfers.</li><li>Stripe pays available funds to your connected bank account.</li></ol><p>Your order statements show the saved commission and confirmed refunds. Cash stays a separate payment to your restaurant.</p></div> : <>
      <p><strong>{stripe.providerMode === "stripe_live" ? "Stripe live mode" : "Stripe test mode"}</strong>. Bank details and identity verification are entered on Stripe.</p>
      <div className="finance-account-state"><span>Account: <strong>{String(account.status || "Not started").replaceAll("_", " ")}</strong></span><span>Card payments: <strong>{account.chargesEnabled ? "Enabled" : "Not enabled"}</strong></span><span>Bank payouts: <strong>{account.payoutsEnabled ? "Enabled" : "Not enabled"}</strong></span></div>
      {account.requirements?.length > 0 && <p className="finance-preview-note">Stripe needs more information to complete your verification. Open Stripe to review its remaining tasks.</p>}
      <div className="button-row"><button className="primary" disabled={Boolean(busy)} onClick={() => void action("onboarding", ["connect.stripe.com"])}>{busy === "onboarding" ? "Opening Stripe…" : "Continue Stripe verification"}</button><button className="quiet" disabled={Boolean(busy)} onClick={() => void action("refresh", [])}>{busy === "refresh" ? "Refreshing…" : "Refresh status"}</button><button className="quiet" disabled={Boolean(busy)} onClick={() => void action("dashboard", ["dashboard.stripe.com", "connect.stripe.com"])}>{busy === "dashboard" ? "Opening Stripe…" : "Open Stripe dashboard"}</button></div>
    </>}
    <BankPayoutPanel key={bankVersion} restaurantId={restaurantId} showSetupLink={false}/>
  </section>;
}

export function StripeAdminReadiness() { const [value, setValue] = useState(null), [error, setError] = useState(""); useEffect(() => { api("/api/admin/finance/stripe/readiness").then(setValue).catch((e) => setError(e.message)); }, []); if (error) return <p role="alert">{error}</p>; if (!value) return <p>Loading Stripe readiness…</p>; const accounts=value.accounts||{}, total=Object.values(accounts).reduce((sum,count)=>sum+(Number(count)||0),0), orders=value.orders||{}; return <section><h2>Connection checks</h2><div className="checklist"><span className={value.configured?"done":""}>{value.configured?"✓ Stripe account connected":"○ Stripe account awaiting connection"}</span>{value.webhookConfigured!==undefined?<span className={value.webhookConfigured?"done":""}>{value.webhookConfigured?"✓ Payment updates connected":"○ Payment updates awaiting setup"}</span>:null}</div><p><strong>Payment mode:</strong> {String(value.providerMode||"local simulator").replaceAll("_"," ")}</p><div className="stats"><div className="stat"><strong>{total}</strong><span>Restaurant accounts</span></div><div className="stat"><strong>{accounts.enabled??0}</strong><span>Ready for payments</span></div><div className="stat"><strong>{accounts.restricted??0}</strong><span>Need attention</span></div><div className="stat"><strong>{orders.pending??0}</strong><span>Pending card orders</span></div><div className="stat"><strong>{orders.failed??0}</strong><span>Failed card orders</span></div></div><p>Planned bank payouts: {value.payoutSchedule?.interval||"weekly"} on {value.payoutSchedule?.weeklyAnchor||"Monday"}, once setup and verification are complete.</p><StripeBankPayouts/><p className="fine">This view contains readiness status only. It does not expose Stripe secrets, bank details or identity documents.</p></section>; }

function StripeBankPayouts(){const [items,setItems]=useState([]),[error,setError]=useState("");useEffect(()=>{api("/api/admin/finance/stripe/payouts").then(value=>setItems(value.items)).catch(error=>setError(error.message));},[]);return <section><h3>Bank payouts</h3>{error?<p role="alert">{error}</p>:items.length?<div className="table-wrap"><table><thead><tr><th>Restaurant</th><th>Amount</th><th>Status</th><th>Expected arrival</th></tr></thead><tbody>{items.map(item=><tr key={item.id}><td>{item.restaurantName}</td><td>{money(item.amountMinor)}</td><td>{item.failure||item.status}</td><td>{item.arrivalAt?new Date(item.arrivalAt).toLocaleDateString("en-GB"):"Awaiting Stripe"}</td></tr>)}</tbody></table></div>:<p>No bank payouts have been confirmed by Stripe yet.</p>}</section>;}
