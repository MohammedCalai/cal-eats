const prefix = "cal-eats:receipt-intent:";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const jobStatuses = new Set(["queued", "claimed", "dispatched", "submitted", "printed", "failed", "uncertain"]);
const queueRefusals = new Map([
  ["REPRINT_CHECK_REQUIRED", 400],
  ["ORDER_NOT_CONFIRMED", 409],
  ["PRINT_ALREADY_QUEUED", 409],
  ["PRINTER_DISABLED", 409],
  ["PRINTER_DEVICE_REQUIRED", 409],
]);
export const receiptUnconfirmed = "The print request could not be confirmed. Check the printer before retrying.";
export const receiptRefused = error => queueRefusals.has(error?.code) && queueRefusals.get(error.code) === error.status;

function requestKey({ businessId, restaurantId, orderId }) {
  return prefix + [businessId, restaurantId, orderId].join(":");
}

export function createReceiptPrintRequests({
  storage = () => globalThis.sessionStorage,
  newId = () => globalThis.crypto.randomUUID(),
} = {}) {
  const pending = new Map();

  function read(scope) {
    try {
      const value = JSON.parse(storage().getItem(requestKey(scope)));
      return value && uuid.test(value.printerId || "") && uuid.test(value.requestId || "")
        ? { printerId: value.printerId, requestId: value.requestId } : null;
    } catch { return null; }
  }

  function save(key, value) {
    try { storage().setItem(key, JSON.stringify(value)); }
    catch {
      throw Object.assign(new Error("This tab couldn't keep track of the receipt request. Check the printer before trying again."), { code: "PRINT_TRACKING_UNAVAILABLE" });
    }
  }

  function clear(key) {
    try { storage().removeItem(key); }
    catch { /* Retaining the same request ID is safe if storage becomes unavailable. */ }
  }

  function submit(scope, loadPrinters, send, selectedPrinterId) {
    const key = requestKey(scope);
    if (pending.has(key)) return pending.get(key);
    const prior = read(scope);
    const result = Promise.resolve().then(async () => {
      let printers;
      try {
        printers = (await loadPrinters()).filter(printer => uuid.test(printer?.id || "") && typeof printer.name === "string");
      } catch {
        if (prior) throw new Error(receiptUnconfirmed);
        throw Object.assign(new Error("Could not load your receipt printer. Try again."), { code: "PRINT_PICKER_UNAVAILABLE" });
      }
      const targetId = prior?.printerId || selectedPrinterId;
      if (!targetId && printers.length > 1) return { printerChoices: printers };
      const printer = targetId ? printers.find(({ id }) => id === targetId) : printers[0];
      if (!printer) {
        if (prior) throw new Error(receiptUnconfirmed);
        throw Object.assign(new Error("No paired receipt printer is available."), { code: "PRINT_PICKER_UNAVAILABLE" });
      }
      const intent = prior || { printerId: printer.id, requestId: newId() };
      save(key, intent);
      try {
        const receipt = await send(printer.id, intent.requestId);
        if (typeof receipt?.id !== "string" || !uuid.test(receipt.id) ||
            receipt.manualReprint !== true || !jobStatuses.has(receipt.status)) throw new Error(receiptUnconfirmed);
        clear(key);
        return { ...receipt, printerName: printer.name };
      } catch (error) {
        // A rejection on a later retry cannot tell us whether an earlier request queued.
        if (!prior && receiptRefused(error)) clear(key);
        throw error;
      }
    }).finally(() => pending.delete(key));
    pending.set(key, result);
    return result;
  }

  return { read, submit };
}

export const receiptPrintRequests = createReceiptPrintRequests();
