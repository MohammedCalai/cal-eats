import React, { useEffect, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import { api, json, newKey } from "./api.js";
import { useFinanceResource } from "./finance-resource.js";
import "./MerchantAgreement.css";

export default function MerchantAgreement({ restaurantId }) {
  return <MerchantAgreementReview key={restaurantId} restaurantId={restaurantId}/>;
}

function ContractPeriod({value}) {
  if(!value?.enabled)return null;
  const term=value.activeAgreement,date=stamp=>new Date(stamp).toLocaleDateString("en-GB",{timeZone:"Europe/London"});
  return <section className="panel"><h2>Your contract period</h2>{term?<p>Your normal commission is fixed for the 24-month period from {date(term.startsAt)} to {date(term.endsAt)}. Accepting updated wording does not automatically extend this period. Scheduled commission-free periods still apply.</p>:<p>Your 24-month contract period starts when your owner acceptance is recorded. Your normal commission is fixed during that period; scheduled commission-free periods still apply.</p>}{value.acceptanceNeedsReview&&<p role="alert">Cal-Eats must provide a reviewed renewal agreement before a new contract period can start.</p>}</section>;
}

function MerchantAgreementReview({ restaurantId }) {
  const root = `/api/restaurant/restaurants/${restaurantId}/merchant-agreement`;
  const result = useFinanceResource(root), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const active = useRef(true), pending = useRef(false), value = result.value, document = value?.document;
  useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  useEffect(()=>{setConfirmed(false);setError("");},[document?.version,document?.sha256]);
  async function accept(event) {
    event.preventDefault();
    if (pending.current || !confirmed || !value?.enabled || !value.canAccept || !document || result.loading || result.error) return;
    pending.current=true;setBusy(true);setError("");
    try {
      await api(`${root}/accept`, json("POST", { version: document.version, sha256: document.sha256, accepted: true }, newKey("merchant-agreement")));
      if (active.current) { setConfirmed(false); await result.reload(); }
    } catch (cause) {
      if (active.current) { setError(cause.message || "Your acceptance could not be saved. Please try again."); if (cause.code === "MERCHANT_AGREEMENT_CHANGED") await result.reload(); }
    } finally { pending.current=false;if(active.current)setBusy(false); }
  }
  return <section className="merchant-agreement" aria-labelledby="merchant-agreement-title">
    <NavLink className="button-link merchant-agreement-back" to="/owner/earnings?view=payouts">← Bank & payouts</NavLink>
    <header><p className="eyebrow">Your restaurant agreement</p><h1 id="merchant-agreement-title">Review merchant agreement</h1><p>Read the exact commercial agreement for your restaurant before confirming acceptance.</p></header>
    {(result.error||error)&&<p className="alert" role="alert">{result.error||error}</p>}
    <ContractPeriod value={value}/>
    {!value ? <section className="panel"><p role="status">{result.loading?"Loading the approved agreement…":"The agreement is unavailable. Please refresh and try again."}</p><button type="button" className="quiet" disabled={result.loading} onClick={()=>void result.reload()}>Refresh agreement</button></section> : !value.enabled ? <section className="panel"><h2>No agreement available for acceptance</h2><p>Cal-Eats has not activated a reviewed merchant agreement. No draft or development agreement can be accepted here.</p></section> : <>
      <section className="panel merchant-agreement-document"><div className="merchant-agreement-document-heading"><div><h2>{value.restaurantName}</h2><p>Version {document.version} · Effective {new Date(document.effectiveAt).toLocaleDateString("en-GB",{timeZone:"Europe/London"})}</p></div><span className="pill">{value.acceptedAt?"Accepted":"Review required"}</span></div><pre tabIndex={0} aria-label="Approved merchant agreement text">{document.text}</pre><p className="fine merchant-agreement-fingerprint">Document SHA-256: {document.sha256}</p></section>
      {value.acceptedAt&&<section className="panel merchant-agreement-confirmation" role="status"><h2>Agreement accepted for this restaurant</h2><p>Accepted {new Date(value.acceptedAt).toLocaleString("en-GB",{timeZone:"Europe/London"})}. This exact version is retained with its acceptance record.</p><p>Agreement acceptance does not activate card payments or change an existing order.</p></section>}
      {!value.acceptedByCurrentOwner&&<form className="panel merchant-agreement-accept" onSubmit={accept} aria-busy={busy}><label><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)} disabled={busy||result.loading||!value.canAccept}/><span>I have read and accept this merchant agreement for {value.restaurantName}.</span></label>{!value.canAccept&&<p className="fine">You can accept this agreement from its effective date.</p>}<p className="fine">This confirms the version shown above. Bank verification and launch checks remain separate.</p><button className="primary" type="submit" disabled={!confirmed||busy||result.loading||!value.canAccept||Boolean(result.error)}>{busy?"Saving acceptance…":"Accept merchant agreement"}</button></form>}
    </>}
  </section>;
}
