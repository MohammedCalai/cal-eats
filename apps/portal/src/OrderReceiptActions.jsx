import React, { useRef, useState } from "react";
import { api, json } from "./api.js";
import { listItems } from "./model.js";
import { canPrintOrderReceipt, orderCustomerName } from "./order-presentation.js";
import { receiptPrintRequests, receiptRefused, receiptUnconfirmed } from "./order-receipt-print.js";
import { terminalApi } from "./terminal-client.js";

const ownerApi = (path, options) => api(path, { ...options, humanSession: true });

export default function OrderReceiptActions({ order, businessId, restaurantId, principal, openLabel, onOpen }) {
  const scope = { businessId, restaurantId, orderId: order.id };
  const request = principal === "owner" ? ownerApi : terminalApi;
  const printable = canPrintOrderReceipt(order, restaurantId);
  const prior = receiptPrintRequests.read(scope);
  const customer = orderCustomerName(order);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [printers, setPrinters] = useState([]);
  const pending = useRef(false);

  async function print(printerId) {
    if (!principal || !printable || pending.current) return;
    pending.current = true;
    setBusy(true);
    setFeedback(null);
    setPrinters([]);
    const root = `/api/restaurant/restaurants/${encodeURIComponent(restaurantId)}/printers`;
    try {
      const result = await receiptPrintRequests.submit(scope,
        async () => listItems(await request(`${root}?scope=reprint`)),
        (printer, requestId) => request(`${root}/${encodeURIComponent(printer)}/reprints`, json("POST", {
          orderId: order.id, requestId, intent: "labelled_copy",
        })),
        printerId);
      if (result.printerChoices) setPrinters(result.printerChoices);
      else setFeedback({ text: result.status === "queued" ? `Receipt queued for ${result.printerName}.`
        : "This copy was already requested. Check the printer." });
    } catch (error) {
      const text = error.code === "PRINT_ALREADY_QUEUED" ? "A receipt is already waiting at this printer."
        : receiptRefused(error) || ["PRINT_TRACKING_UNAVAILABLE", "PRINT_PICKER_UNAVAILABLE"].includes(error.code)
          ? error.message : receiptUnconfirmed;
      setFeedback({ text, error: true });
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return <div className="business-order-action-cell">
    <div className="business-order-row-actions">
      <button type="button" className="primary" aria-label={`${openLabel} for ${customer}`} onClick={() => onOpen(order)}>{openLabel}</button>
      <button type="button" className="quiet" aria-label={`Print receipt for ${customer}`} disabled={!principal || !printable || busy}
        title={!principal ? "Ask a restaurant owner or use the registered tablet" : !printable ? "Available for confirmed orders" : undefined}
        onClick={() => void print()}>{busy ? "Queueing…" : prior ? "Retry print" : "Print"}</button>
    </div>
    {printers.length > 0 && principal && printable && <label>Choose a printer
      <select value="" aria-label={`Choose a printer for ${customer}`} onChange={event => { if (event.target.value) void print(event.target.value); }}>
        <option value="">Select printer</option>
        {printers.map(printer => <option key={printer.id} value={printer.id}>{printer.name}</option>)}
      </select>
    </label>}
    {feedback && <small role={feedback.error ? "alert" : "status"} className={feedback.error ? "business-print-error" : "business-print-status"}>{feedback.text}</small>}
    {!feedback && !busy && prior && <small className="business-print-error">Check the printer before retrying.</small>}
  </div>;
}
