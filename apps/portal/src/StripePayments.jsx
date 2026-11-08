import React, { useEffect, useRef, useState } from "react";
import { api, json, newKey } from "./api.js";
import { BankPayoutPanel } from "./EarningsPage.jsx";
import { useFinanceResource } from "./finance-resource.js";
import PaymentLaunchReadiness from "./PaymentLaunchReadiness.jsx";
import BankingPasswordChange from "./BankingPasswordChange.jsx";
import { bankSetupState } from "./bank-setup-state.js";

export function StripeAdminReadiness(){return <><PaymentLaunchReadiness/><StripeConnectionReadiness/></>;}

const money = (minor) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format((minor || 0) / 100);
const merchantCopy=value=>String(value||"").replace(/\bStripe(?:’s|'s)?\b/gi,"the payment provider");
function hosted(url, hosts) { const parsed = new URL(url); if (parsed.protocol !== "https:" || !hosts.includes(parsed.hostname) || parsed.username || parsed.password) throw new Error("The payment service returned an unexpected destination."); return parsed.toString(); }

export function RestaurantBankSetupSummary({ restaurantId, onOpen }) {
  const result = useFinanceResource(`/api/restaurant/restaurants/${restaurantId}/finance/stripe`);
  useEffect(()=>{const refresh=()=>{if(!document.hidden)void result.reload();};window.addEventListener("focus",refresh);return()=>window.removeEventListener("focus",refresh);},[result.reload]);
  const setup = bankSetupState(result);
  return <section className="panel finance-bank-entry" aria-label="Your bank account"><span className="finance-bank-entry-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M3 8l9-5 9 5H3ZM5 11v7m5-7v7m5-7v7m5-7v7M3 21h18"/></svg></span><div><p className="eyebrow">Bank account</p><h2>{setup.status}</h2><p>{setup.passwordRequired?"Use Bank & payouts to update your password and continue securely.":setup.description}</p>{result.value?.onboardingOnly&&<small>Bank setup does not activate customer payments. Launch checks still apply.</small>}</div><button className="primary" type="button" onClick={onOpen}>{setup.label}<span aria-hidden="true"> →</span></button></section>;
}

export function StripeRestaurantFinance({ restaurantId }) {
  return <StripeRestaurantWorkspace key={restaurantId} restaurantId={restaurantId}/>;
}
function StripeRestaurantWorkspace({ restaurantId }) {
  const root = `/api/restaurant/restaurants/${restaurantId}/finance/stripe`;
  const result = useFinanceResource(root), [error, setError] = useState(""), [busy, setBusy] = useState(""), [bankVersion, setBankVersion] = useState(0),[securityNotice,setSecurityNotice]=useState("");
  const pending = useRef(false), active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(()=>{const refresh=()=>{if(!document.hidden&&!pending.current)void result.reload();};window.addEventListener("focus",refresh);return()=>window.removeEventListener("focus",refresh);},[result.reload]);
  async function action(kind, hosts) {
    if (pending.current || !bankSetupState(result).available) return;
    pending.current = true; setBusy(kind); setError("");
    try {
      const value = await api(`${root}/${kind}`, json("POST", {}, newKey(`stripe-${kind}`)));
      if (!active.current) return;
      if (value.url) window.location.assign(hosted(value.url, hosts));
      else { await result.reload(); if (active.current) setBankVersion(version => version + 1); }
    } catch (caught) { if (active.current) setError(caught.message); }
    finally { pending.current = false; if (active.current) setBusy(""); }
  }
  const stripe = result.value, account = stripe?.account || {}, onboardingOnly=stripe?.onboardingOnly===true, setup=bankSetupState(result), passwordRequired=setup.passwordRequired;
  async function passwordChanged(){if(!active.current)return;setSecurityNotice("Your password has been updated. Continue with secure bank setup when you are ready.");await result.reload();}
  return <section className="finance-payment-setup">
    <div className="panel finance-bank-setup"><div className="finance-section-heading"><div><p className="eyebrow">Secure payout connection</p><h2>Your bank account</h2></div><span className="finance-subtle-label">{setup.status}</span></div>
    {(result.error || error) && <p className="alert" role="alert">{merchantCopy(result.error || error)}</p>}
    {securityNotice&&<p className="alert success" role="status">{securityNotice}</p>}
    <p id="bank-setup-description">{setup.description}</p>
    <div className="button-row finance-bank-setup-actions"><button className="primary" type="button" aria-describedby="bank-setup-description" disabled={Boolean(busy)||!setup.available} onClick={() => void action(setup.action, setup.action==="dashboard"?["dashboard.stripe.com", "connect.stripe.com"]:["connect.stripe.com"])}>{busy===setup.action?"Opening secure account…":setup.label}</button><button className="quiet" type="button" disabled={Boolean(busy)||result.loading} onClick={()=>void result.reload()}>{result.loading?"Checking connection…":"Refresh bank connection"}</button></div>
    {passwordRequired&&<BankingPasswordChange onChanged={passwordChanged}/>}
    {!stripe ? <p role="status">{result.loading ? "Loading payment setup…" : "Payment setup status is unavailable. Refresh to try again."}</p> : !stripe.configured ? <div className="finance-empty"><h3>{onboardingOnly?"Real bank setup awaiting connection":"Card payments awaiting connection"}</h3><p>{onboardingOnly?"Cal-Eats is preparing your real bank-payout connection. Customer ordering stays paused until Cal-Eats completes launch checks.":"Card payments and bank payouts are unavailable for this restaurant until its payment setup is completed."}</p><ol><li>Cal-Eats connects the payment account.</li><li>You enter your business and bank details securely with the payment provider.</li><li>{onboardingOnly?"After verification and launch, completed orders become eligible for restaurant transfers.":"Once verified, completed orders become eligible for restaurant transfers."}</li><li>The payment provider pays available funds to your connected bank account.</li></ol><p>Your order statements show the saved commission and confirmed refunds. Cash stays a separate payment to your restaurant.</p></div> : <>
      <p><strong>{onboardingOnly?"Real bank-payout setup":stripe.providerMode === "stripe_live" ? "Live card payments" : "Card payment test mode"}</strong>. {onboardingOnly?"Enter your real business and bank details securely. Customer ordering stays paused until Cal-Eats completes launch checks.":"Bank details and identity verification are entered on the payment provider’s secure pages."}</p>
      <div className="finance-account-state"><span>Account: <strong>{String(account.status || "Not started").replaceAll("_", " ")}</strong></span><span>{onboardingOnly?"Provider card capability":"Card payments"}: <strong>{account.chargesEnabled ? "Enabled" : "Not enabled"}</strong></span><span>Bank payouts: <strong>{account.payoutsEnabled ? "Enabled" : "Not enabled"}</strong></span>{onboardingOnly&&<span>Customer ordering: <strong>{stripe.customerPaymentsLive?"Live":"Paused before launch"}</strong></span>}</div>
      {account.requirements?.length > 0 && <p className="finance-preview-note">Your payment account needs more information to complete verification. Continue setup to review the remaining tasks.</p>}
      {account.status&&account.status!=="not_started"&&<div className="button-row"><button className="quiet" disabled={Boolean(busy)||!setup.available} onClick={() => void action("refresh", [])}>{busy === "refresh" ? "Refreshing…" : "Refresh verification status"}</button>{setup.action!=="onboarding"&&<button className="quiet" disabled={Boolean(busy)||!setup.available} onClick={() => void action("onboarding", ["connect.stripe.com"])}>Review business verification</button>}</div>}
    </>}
    </div>{stripe&&!passwordRequired&&<BankPayoutPanel key={bankVersion} restaurantId={restaurantId} showSetupLink={false}/>}
  </section>;
}

function StripeConnectionReadiness() { const [value, setValue] = useState(null), [error, setError] = useState(""); useEffect(() => { api("/api/admin/finance/stripe/readiness").then(setValue).catch((e) => setError(e.message)); }, []); if (error) return <p role="alert">{error}</p>; if (!value) return <p>Loading Stripe readiness…</p>; const accounts=value.accounts||{}, total=Object.values(accounts).reduce((sum,count)=>sum+(Number(count)||0),0), orders=value.orders||{}; return <section><h2>Connection checks</h2><div className="checklist"><span className={value.configured?"done":""}>{value.configured?"✓ Stripe account connected":"○ Stripe account awaiting connection"}</span>{value.webhookConfigured!==undefined?<span className={value.webhookConfigured?"done":""}>{value.webhookConfigured?"✓ Payment updates connected":"○ Payment updates awaiting setup"}</span>:null}</div><p><strong>Payment mode:</strong> {String(value.providerMode||"local simulator").replaceAll("_"," ")}</p><div className="stats"><div className="stat"><strong>{total}</strong><span>Restaurant accounts</span></div><div className="stat"><strong>{accounts.enabled??0}</strong><span>{value.providerMode==="stripe_live"?"Ready for payments":value.providerMode==="stripe_test"?"Test bank setup ready":"Preview setup ready"}</span></div><div className="stat"><strong>{accounts.restricted??0}</strong><span>Need attention</span></div><div className="stat"><strong>{orders.pending??0}</strong><span>Pending card orders</span></div><div className="stat"><strong>{orders.failed??0}</strong><span>Failed card orders</span></div></div><p>Planned bank payouts: {value.payoutSchedule?.interval||"weekly"} on {value.payoutSchedule?.weeklyAnchor||"Monday"}, once setup and verification are complete.</p><StripeBankPayouts/><p className="fine">This view contains readiness status only. It does not expose Stripe secrets, bank details or identity documents.</p></section>; }

function StripeBankPayouts(){const [items,setItems]=useState([]),[error,setError]=useState("");useEffect(()=>{api("/api/admin/finance/stripe/payouts").then(value=>setItems(value.items)).catch(error=>setError(error.message));},[]);return <section><h3>Bank payouts</h3>{error?<p role="alert">{error}</p>:items.length?<div className="table-wrap"><table><thead><tr><th>Restaurant</th><th>Amount</th><th>Status</th><th>Expected arrival</th></tr></thead><tbody>{items.map(item=><tr key={item.id}><td>{item.restaurantName}</td><td>{money(item.amountMinor)}</td><td>{item.failure||item.status}</td><td>{item.arrivalAt?new Date(item.arrivalAt).toLocaleDateString("en-GB"):"Awaiting Stripe"}</td></tr>)}</tbody></table></div>:<p>No bank payouts have been confirmed by Stripe yet.</p>}</section>;}
