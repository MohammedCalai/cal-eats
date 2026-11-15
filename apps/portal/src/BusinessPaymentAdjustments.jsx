import React, { useEffect, useRef, useState } from "react";
import { api, json, newKey } from "./api.js";
import { pounds, shortDate } from "./model.js";
import { AdminPager, useAdminResource } from "./AdminWorkspaceShared.jsx";
import { WorkspaceDialog } from "./CustomerWorkspace.jsx";
import { DashboardCsvDownload } from "./OwnerDashboard.jsx";
import BusinessReportEmail from "./BusinessReportEmail.jsx";
import "./BusinessPaymentAdjustments.css";

const label = value => ({ draft: "Awaiting review", reviewed: "Reviewed · awaiting confirmation", confirmed: "Confirmed", rejected: "Rejected", held: "Needs review", failed: "Needs review", pending: "Pending", applied: "Applied" })[value] || String(value || "Pending").replaceAll("_", " ");
const signed = row => `${row.direction === "deduction" ? "−" : "+"}${pounds(row.amountMinor)}`;

function AdjustmentRow({ row, admin, enabled, onAction }) {
  return <article className={`payment-adjustment-row ${row.direction}`}>
    <div className="payment-adjustment-identity"><span className="payment-adjustment-direction">{row.direction === "credit" ? "Cal-Eats credit" : "Future earnings deduction"}</span><h3>{row.restaurantName || row.reference}</h3><p>{row.reason}</p><small>{row.reference} · Week beginning {row.effectiveWeekStart}</small></div>
    <div className="payment-adjustment-amount"><strong>{signed(row)}</strong><span className="pill">{label(row.status)}</span></div>
    <dl className="payment-adjustment-position"><div><dt>Applied</dt><dd>{pounds(row.appliedMinor || 0)}</dd></div><div><dt>Reserved</dt><dd>{pounds(row.reservedMinor || 0)}</dd></div><div><dt>Pending</dt><dd>{pounds(row.pendingMinor || 0)}</dd></div><div><dt>Carried forward</dt><dd>{pounds(row.carriedForwardMinor || 0)}</dd></div></dl>
    <p className="fine payment-adjustment-note">{row.direction === "deduction" ? "Taken only from future earnings awaiting allocation. Any remaining amount carries forward; your bank account is not debited." : "Funded by Cal-Eats. Applied credits join the available payout balance; they do not confirm a bank deposit."}{row.confirmedAt ? ` Confirmed ${shortDate(row.confirmedAt)}.` : ""}</p>
    {row.releasedMinor>0&&<p className="fine payment-adjustment-note">Previous reservations totalling {pounds(row.releasedMinor)} were released before allocation. Released reservations have not reduced your earnings.</p>}
    {["held","unknown"].includes(row.workerStatus)&&<p className="alert payment-adjustment-note" role="status">{row.workerStatus==="held"?"Cal-Eats is reviewing this credit before it can be applied.":"The payment connection has not confirmed this credit yet. Its amount remains pending."}{admin&&row.error?` Reference: ${row.error}.`:""}</p>}
    {admin && enabled && ["draft", "reviewed"].includes(row.status) && <div className="button-row payment-adjustment-actions"><button className="primary" onClick={() => onAction(row, row.status === "draft" ? "review" : "confirm")}>{row.status === "draft" ? "Review adjustment" : "Confirm adjustment"}</button>{row.status === "draft" && <button className="quiet" onClick={() => onAction(row, "reject")}>Reject draft</button>}</div>}
  </article>;
}

function CreateAdjustment({ restaurantId, restaurantName, onClose, onSaved }) {
  const [direction, setDirection] = useState("credit"), [amount, setAmount] = useState(""), [reason, setReason] = useState(""), [week, setWeek] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const request = useRef(null), pending = useRef(false);
  async function create(event) {
    event.preventDefault(); if (pending.current) return;
    const decimal = amount.trim();
    if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(decimal)) { setError("Enter an amount in pounds with no more than two decimal places."); return; }
    const [whole, fraction = ""] = decimal.split("."), amountMinor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor > 1000000) { setError("Enter an amount greater than £0 and no more than £10,000."); return; }
    if (new Date(`${week}T12:00:00Z`).getUTCDay() !== 1) { setError("Choose a Monday for the effective week."); return; }
    const body = { restaurantId, direction, amountMinor, reason: reason.trim(), effectiveWeekStart: week }, identity = JSON.stringify(body);
    if (request.current?.identity !== identity) request.current = { identity, key: newKey("business-adjustment") };
    pending.current = true; setBusy(true); setError("");
    try { await api("/api/admin/business-payment-adjustments", json("POST", body, request.current.key)); await onSaved(); onClose(); }
    catch (caught) { setError(caught.message); }
    finally { pending.current = false; setBusy(false); }
  }
  return <WorkspaceDialog title="Create payment adjustment" onClose={() => { if (!busy) onClose(); }}><form className="payment-adjustment-form" onSubmit={create}><p><strong>{restaurantName}</strong></p><label>Adjustment type<select value={direction} onChange={event => setDirection(event.target.value)} disabled={busy}><option value="credit">Cal-Eats credit · increase earnings</option><option value="deduction">Future earnings deduction · decrease earnings</option></select></label><label>Amount in GBP<input type="text" inputMode="decimal" placeholder="0.00" value={amount} onChange={event => setAmount(event.target.value)} required disabled={busy}/></label><label>Week beginning Monday<input type="date" value={week} onChange={event => setWeek(event.target.value)} required disabled={busy}/></label><label>Reason visible to the business<textarea rows={3} maxLength={500} minLength={10} value={reason} onChange={event => setReason(event.target.value)} required disabled={busy}/></label><p className="fine">This creates a draft for review. Confirmed adjustments keep their original reason and amount. Corrections require a separate adjustment. Order commission and past payouts are unchanged.</p>{error && <p className="alert" role="alert">{error}</p>}<div className="button-row"><button className="quiet" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{busy ? "Saving draft…" : "Save for review"}</button></div></form></WorkspaceDialog>;
}

function ReviewAdjustment({ row, action, onClose, onSaved }) {
  const [note, setNote] = useState(""), [accepted, setAccepted] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const requestKey = useRef(newKey("confirm-adjustment")), pending = useRef(false), confirming = action === "confirm";
  async function save(event) {
    event.preventDefault(); if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await api(`/api/admin/business-payment-adjustments/${encodeURIComponent(row.id)}/${confirming ? "confirm" : "review"}`, json("POST", confirming ? {} : { decision: action === "reject" ? "reject" : "approve", note: note.trim() }, confirming ? requestKey.current : undefined)); await onSaved(); onClose(); }
    catch (caught) { setError(caught.message); }
    finally { pending.current = false; setBusy(false); }
  }
  return <WorkspaceDialog title={confirming ? "Confirm payment adjustment" : action === "reject" ? "Reject draft adjustment" : "Review payment adjustment"} onClose={() => { if (!busy) onClose(); }}><form className="payment-adjustment-form" onSubmit={save}><p><strong>{row.restaurantName}</strong></p><div className="payment-adjustment-confirm-amount">{signed(row)}</div><p>{row.reason}</p><p className="fine">{row.reference} · Week beginning {row.effectiveWeekStart}</p>{confirming ? <><p>{row.direction === "credit" ? "This authorises a platform-funded credit to this restaurant’s connected payout account when the effective week starts and funds are available." : "This authorises a deduction from future earnings awaiting allocation. Any shortfall carries forward. No bank debit or change to previously allocated earnings is authorised."}</p><label className="payment-adjustment-ack"><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} disabled={busy} required/><span>I have checked the business, amount, reason and effective week.</span></label></> : <label>Review note<textarea rows={3} minLength={3} maxLength={500} required value={note} onChange={event => setNote(event.target.value)} disabled={busy}/></label>}{error && <p className="alert" role="alert">{error}</p>}<div className="button-row"><button type="button" className="quiet" disabled={busy} onClick={onClose}>Cancel</button><button className={action === "reject" ? "danger" : "primary"} disabled={busy || (confirming && !accepted)}>{busy ? "Saving…" : confirming ? "Confirm adjustment" : action === "reject" ? "Reject draft" : "Approve review"}</button></div></form></WorkspaceDialog>;
}

function RestaurantPicker({ selection, onChange }) {
  const [search, setSearch] = useState(""), [q, setQ] = useState("");
  useEffect(() => { const timer = setTimeout(() => setQ(search.trim()), 250); return () => clearTimeout(timer); }, [search]);
  const directory = useAdminResource(`/api/admin/restaurant-directory?${new URLSearchParams({ q, page: "1", status: "approved" })}`);
  return <div className="payment-adjustment-restaurant"><label>Find a business<input type="search" value={search} onChange={event => setSearch(event.target.value)} maxLength={100} placeholder="Search business name"/></label>{selection ? <div className="button-row"><strong>{selection.name}</strong><button className="quiet" onClick={() => { onChange(null); setSearch(""); }}>All businesses</button></div> : q && <ul className="payment-adjustment-business-results">{directory.value?.items?.map(row => <li key={row.id}><button className="quiet" onClick={() => { onChange(row); setSearch(row.name); }}>{row.name}</button></li>)}{!directory.loading && !directory.value?.items?.length && <li>No matching businesses.</li>}{directory.error && <li role="alert">{directory.error}</li>}</ul>}</div>;
}

export default function BusinessPaymentAdjustments({ admin = false, restaurantId = "" }) {
  const [selection, setSelection] = useState(null), [week, setWeek] = useState(""), [page, setPage] = useState(1), [dialog, setDialog] = useState(null);
  const selectedId = admin ? selection?.id || "" : restaurantId;
  const query = new URLSearchParams({ page: String(page), pageSize: "20", ...(selectedId ? { restaurantId: selectedId } : {}), ...(week ? { weekStart: week } : {}) });
  const root = `/api/${admin ? "admin" : "owner"}/business-payment-adjustments`, resource = useAdminResource(`${root}?${query}`);
  const enabled = resource.value?.enabled === true, rows = resource.value?.items || [];
  const exportQuery = new URLSearchParams({ ...(selectedId ? { restaurantId: selectedId } : {}), ...(week ? { weekStart: week } : {}) });
  useEffect(() => { setPage(1); }, [selectedId, week]);
  return <section className="panel payment-adjustments" aria-label="Business payment adjustments"><div className="finance-section-heading"><div><p className="eyebrow">Separate from order commission</p><h2>{admin ? "Business payment adjustments" : "Your payment adjustments"}</h2></div><button className="quiet" disabled={resource.loading || resource.refreshing} onClick={() => void resource.reload()}>Refresh adjustments</button></div><p className="fine">Credits are funded by Cal-Eats. Deductions apply to future earnings only and carry forward until covered. Available funds follow the automatic weekly Monday bank payout schedule once cleared. An applied adjustment is not a confirmed bank deposit.</p>
    {resource.value && !enabled && <p className="finance-preview-note" role="status">Payment adjustments are not yet enabled. Existing records remain available for review.</p>}
    <div className="payment-adjustment-toolbar">{admin && <RestaurantPicker selection={selection} onChange={setSelection}/>}<label>Effective week (Monday)<input type="date" value={week} onChange={event => setWeek(event.target.value)}/></label><div className="button-row">{week && <button className="quiet" onClick={() => setWeek("")}>All weeks</button>}{admin ? <DashboardCsvDownload href={`${root}/export.csv${exportQuery.size ? `?${exportQuery}` : ""}`}>Adjustments CSV</DashboardCsvDownload> : <BusinessReportEmail href={`${root}/export.csv${exportQuery.size ? `?${exportQuery}` : ""}`}>Email adjustments CSV</BusinessReportEmail>}{admin && <button className="primary" disabled={!enabled || !selection} onClick={() => setDialog({ action: "create" })}>Create adjustment</button>}</div></div>
    {admin && enabled && !selection && <p className="fine">Find and select a business to create an adjustment.</p>}
    {resource.error && <p className="alert" role="alert">{resource.error}</p>}{resource.loading && !resource.value ? <p role="status">Loading payment adjustments…</p> : !rows.length ? <p className="fine">No payment adjustments in this view.</p> : <div className="payment-adjustment-list">{rows.map(row => <AdjustmentRow key={row.id} row={row} admin={admin} enabled={enabled} onAction={(value, action) => setDialog({ row: value, action })}/>)}</div>}
    <AdminPager pagination={resource.value?.pagination} page={page} onChange={setPage} busy={resource.loading || resource.refreshing}/>
    {dialog?.action === "create" && selection && <CreateAdjustment restaurantId={selection.id} restaurantName={selection.name} onClose={() => setDialog(null)} onSaved={resource.reload}/>}{dialog?.row && <ReviewAdjustment key={`${dialog.row.id}:${dialog.action}`} row={dialog.row} action={dialog.action} onClose={() => setDialog(null)} onSaved={resource.reload}/>}
  </section>;
}
