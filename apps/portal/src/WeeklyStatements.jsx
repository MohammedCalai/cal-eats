import React, { useCallback, useEffect, useRef, useState } from "react";
import { api, json } from "./api.js";
import { shortDate } from "./model.js";

const statusLabel = value => ({ queued: "Queued", generated: "Ready", local_saved: "Preview saved", sent: "Email provider accepted", failed: "Needs attention", unknown: "Delivery uncertain", sending: "Sending" })[value] || String(value || "Pending").replaceAll("_", " ");
async function statementApi(path, options = {}) {
  const controller = new AbortController(), timeout = window.setTimeout(() => controller.abort(), 15000);
  try { return await api(path, { ...options, signal: controller.signal }); }
  catch (error) { if (error.name === "AbortError") throw new Error("The statement service took too long to respond. Please try again."); throw error; }
  finally { window.clearTimeout(timeout); }
}

export default function WeeklyStatements({ restaurantId }) {
  const root = `/api/restaurant/restaurants/${restaurantId}/weekly-statements`;
  const [settings, setSettings] = useState(null), [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const sequence = useRef(0), saving = useRef(false);
  const load = useCallback(async () => {
    if (saving.current) return;
    const request = ++sequence.current;
    setLoading(true); setError("");
    const [configuration, statements] = await Promise.allSettled([statementApi(`${root}/settings`), statementApi(`${root}?page=1&pageSize=5`)]);
    if (request !== sequence.current) return;
    if (configuration.status === "fulfilled") setSettings(configuration.value);
    if (statements.status === "fulfilled") setHistory(statements.value.items || []);
    const failure = configuration.status === "rejected" ? configuration.reason : statements.status === "rejected" ? statements.reason : null;
    if (failure) setError(failure.message);
    setLoading(false);
  }, [root]);
  useEffect(() => {
    void load();
    const refresh = () => { if (!document.hidden) void load(); };
    window.addEventListener("focus", refresh);
    return () => { sequence.current++; window.removeEventListener("focus", refresh); };
  }, [load]);
  async function toggle() {
    if (busy || !settings) return;
    saving.current = true; setBusy(true); setError(""); setNotice("");
    sequence.current++;
    try {
      const value = await statementApi(`${root}/settings`, json("PATCH", { enabled: !settings.enabled }));
      setSettings(value);
      setNotice(value.enabled ? "Weekly statements enabled." : "Weekly statements paused.");
    } catch (caught) { setError(caught.message); }
    finally { saving.current = false; setBusy(false); setLoading(false); }
  }
  return <section className="panel dashboard-weekly-statements" aria-labelledby="dashboard-weekly-title">
    <div className="dashboard-section-heading"><div><p className="eyebrow">Weekly summary</p><h2 id="dashboard-weekly-title">Your weekly statement</h2></div><button className="quiet" disabled={loading || busy} onClick={() => void load()}>{loading && settings ? "Refreshing…" : "Refresh statements"}</button></div>
    {error && <p className="alert" role="alert">Statements could not be updated: {error}</p>}
    {notice && <p className="alert success" role="status">{notice}</p>}
    {!settings ? <p role="status">{loading ? "Loading weekly statement settings…" : "Statement settings are unavailable. Refresh to try again."}</p> : <>
      <div className="dashboard-statement-settings"><div><strong>{settings.enabled ? "Weekly statements on" : "Weekly statements paused"}</strong><p>{settings.schedule?.description || "Monday at 09:00 UK time, covering the previous Monday–Sunday"}</p><p className="fine">Recipient: <strong>{settings.recipient}</strong></p>{settings.enabled && settings.nextScheduledAt && <p className="fine">Next scheduled statement: {shortDate(settings.nextScheduledAt)}.</p>}</div><button className={settings.enabled ? "quiet" : "primary"} disabled={busy || loading} onClick={() => void toggle()}>{busy ? "Saving…" : settings.enabled ? "Pause weekly statements" : "Enable weekly statements"}</button></div>
      <div className={`dashboard-statement-delivery${settings.email?.realDeliveryEnabled && settings.email?.configured ? " enabled" : ""}`}><strong>{settings.email?.realDeliveryEnabled && settings.email?.configured ? "Email delivery enabled" : "Email delivery not active"}</strong><p>{settings.email?.note || "Statements can be generated for download. External weekly emails require the delivery connection to be activated."}</p></div>
    </>}
    <h3>Recent statements</h3>
    {history.length ? <ul className="dashboard-statement-history">{history.map(statement => <li key={statement.id}><div><strong>{statement.weekFrom} – {statement.weekTo}</strong><small>{statusLabel(statement.status)}{statement.sentAt ? ` · ${shortDate(statement.sentAt)}` : ""}</small>{statement.errorCode && <small>Delivery needs review: {statement.errorCode.replaceAll("_", " ")}</small>}</div><a className="button-link" href={`${root}/${encodeURIComponent(statement.id)}.csv`}>Download CSV</a></li>)}</ul> : <p className="fine">No weekly statements yet. Enabling this schedule starts with the next weekly run; it does not email past weeks.</p>}
  </section>;
}
