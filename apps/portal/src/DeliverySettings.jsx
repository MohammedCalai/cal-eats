import React, { useEffect, useState } from "react";
import { api, json } from "./api.js";
import { listItems, pounds, poundsInputMinor } from "./model.js";

export default function DeliverySettings({ restaurant, permission }) {
  const [delivery, setDelivery] = useState(restaurant.delivery);
  const [enabled, setEnabled] = useState(Boolean(delivery.enabled));
  const [outcodes, setOutcodes] = useState(delivery.outcodes.join(", "));
  const [fee, setFee] = useState((delivery.deliveryFeeMinor / 100).toFixed(2));
  const [minimum, setMinimum] = useState((delivery.minDeliverySubtotalMinor / 100).toFixed(2));
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [saved, setSaved] = useState("");
  const [loading, setLoading] = useState(true);
  function adopt(value) {
    setDelivery(value); setEnabled(Boolean(value.enabled)); setOutcodes(value.outcodes.join(", "));
    setFee((value.deliveryFeeMinor / 100).toFixed(2)); setMinimum((value.minDeliverySubtotalMinor / 100).toFixed(2));
  }
  async function load() {
    setLoading(true); setError("");
    try {
      const owned = listItems(await api("/api/restaurant/restaurants")).find(item => item.id === restaurant.id);
      if (!owned) throw new Error("Your restaurant could not be loaded. Refresh and try again.");
      adopt(owned.delivery);
    } catch (caught) { setError(caught.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (permission === "owner") void load(); }, [restaurant.id, permission]);
  if (permission !== "owner") return null;
  async function save(event) {
    event.preventDefault(); if (busy) return;
    setError(""); setSaved("");
    try {
      const body = { enabled, outcodes: [...new Set(outcodes.toUpperCase().split(/[\s,;]+/).filter(Boolean))], deliveryFeeMinor: poundsInputMinor(fee, "Delivery fee"), minDeliverySubtotalMinor: poundsInputMinor(minimum, "Minimum food order") };
      if (enabled && !body.outcodes.length) throw new Error("Enter at least one delivery postcode area, such as LU1.");
      setBusy(true);
      const result = await api(`/api/restaurant/restaurants/${restaurant.id}/delivery`, json("PATCH", body));
      adopt(result.delivery);
      setSaved(`Delivery settings saved. New delivery orders use your ${pounds(result.delivery.deliveryFeeMinor)} fee. Existing orders keep their original fee.`);
    } catch (caught) { setError(caught.message); }
    finally { setBusy(false); }
  }
  return <section className="panel delivery-settings" aria-labelledby="delivery-settings-title">
    <h2 id="delivery-settings-title">Delivery area & fees</h2>
    <p>You set your restaurant’s delivery charge. Customers see this fee before ordering.</p>
    {loading ? <p role="status">Loading delivery settings…</p> : <form className="form-grid" onSubmit={save}>
      <label className="check-field full"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} disabled={busy}/> Offer delivery</label>
      <label className="full">Delivery postcode areas<input value={outcodes} onChange={event => setOutcodes(event.target.value)} autoCapitalize="characters" placeholder="LU1, LU2" maxLength={400} disabled={busy}/><small>Use outward codes, separated by commas. LU1 does not include LU10.</small></label>
      <label>Delivery fee (£)<input inputMode="decimal" value={fee} onChange={event => setFee(event.target.value)} required disabled={busy}/></label>
      <label>Minimum food order (£)<input inputMode="decimal" value={minimum} onChange={event => setMinimum(event.target.value)} required disabled={busy}/></label>
      {error && <p className="alert full" role="alert">{error}</p>}
      {saved && <p className="alert success full" role="status">{saved}</p>}
      <button className="primary full" disabled={busy}>{busy ? "Saving…" : "Save delivery settings"}</button>
    </form>}
  </section>;
}
