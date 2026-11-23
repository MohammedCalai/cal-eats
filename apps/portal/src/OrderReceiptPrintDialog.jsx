import React, { useRef, useState } from "react";
import { json } from "./api.js";
import { WorkspaceDialog } from "./CustomerWorkspace.jsx";
import { listItems } from "./model.js";
import { orderReprintLabel } from "./order-presentation.js";
import { receiptPrintRequests, receiptRefused, receiptUnconfirmed } from "./order-receipt-print.js";
import { terminalApi } from "./terminal-client.js";
import { useBusinessResource } from "./UnifiedBusiness.jsx";

export default function OrderReceiptPrintDialog({ order, businessId, restaurantId, allowed, onClose }) {
  const root = `/api/restaurant/restaurants/${encodeURIComponent(restaurantId)}/printers`;
  const scope = { businessId, restaurantId, orderId: order.id };
  const printers = useBusinessResource(allowed ? `${root}?scope=reprint` : null, {
    request: terminalApi, scope: restaurantId,
  });
  const prior = receiptPrintRequests.read(scope);
  const [selection, setSelection] = useState(prior?.printerId || "");
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(prior ? receiptUnconfirmed : "");
  const [notice, setNotice] = useState("");
  const pending = useRef(false);
  const choices = listItems(printers.value);
  const printerId = prior?.printerId || (choices.length === 1 ? choices[0].id : selection);
  const printer = choices.find(choice => choice.id === printerId);

  async function print(event) {
    event.preventDefault();
    if (!allowed || !printer || !checked || pending.current || notice || printers.loading || printers.error) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await receiptPrintRequests.submit(scope, printerId, requestId =>
        terminalApi(`${root}/${encodeURIComponent(printerId)}/reprints`, json("POST", {
          orderId: order.id, requestId, checkedOriginal: true,
        })));
      setNotice(result.status === "queued" ? "Receipt queued." :
        "This receipt was already requested. Check the printer before requesting another copy.");
    } catch (caught) {
      setError(caught.code === "PRINT_ALREADY_QUEUED" ? "A receipt for this order is already waiting at this printer."
        : receiptRefused(caught) ? caught.message : receiptUnconfirmed);
      setChecked(false);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  function close() {
    if (!pending.current) onClose();
  }

  return <WorkspaceDialog title="Print receipt" className="business-order-print-dialog" onClose={close}>
    <p className="fine">{orderReprintLabel(order)}</p>
    {notice ? <>
      <p className="alert success" role="status">{notice}</p>
      <button className="primary" onClick={close}>Done</button>
    </> : <form onSubmit={print} aria-busy={busy}>
      {!allowed ? <p role="status">Printing is available on the registered restaurant tablet.</p>
        : printers.loading ? <p role="status">Loading receipt printers…</p>
        : printers.error ? <p className="alert" role="alert">{printers.error} <button type="button" className="quiet" onClick={() => void printers.reload()}>Try again</button></p>
        : prior && !printer ? <p role="status">The selected printer is unavailable. Check the original receipt before requesting another copy.</p>
        : !choices.length ? <p role="status">No enabled receipt printer is paired for this restaurant.</p>
        : <>
          {choices.length > 1 && !prior ? <label>Printer<select value={printerId} onChange={e => setSelection(e.target.value)} disabled={busy} required>
            <option value="">Choose a printer</option>
            {choices.map(choice => <option key={choice.id} value={choice.id}>{choice.name}</option>)}
          </select></label> : <p>Printer <strong>{printer?.name}</strong></p>}
          <label className="check-field"><input type="checkbox" checked={checked} disabled={busy} required onChange={e => setChecked(e.target.checked)}/>
            I’ve checked the original receipt and want a labelled copy.
          </label>
        </>}
      {error && <p className="alert" role="alert">{error}</p>}
      <div className="button-row">
        <button type="button" className="quiet" disabled={busy} onClick={close}>Cancel</button>
        <button type="submit" className="primary" disabled={!allowed || !printer || !checked || busy || printers.loading || Boolean(printers.error)}>
          {busy ? "Queueing…" : prior ? "Retry print" : "Print"}
        </button>
      </div>
    </form>}
  </WorkspaceDialog>;
}
