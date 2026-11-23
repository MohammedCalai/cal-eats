const prefix = "cal-eats:receipt-intent:";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const jobStatuses = new Set(["queued", "claimed", "dispatched", "submitted", "printed", "failed", "uncertain"]);
export const receiptUnconfirmed = "The print request could not be confirmed. Check the printer before retrying.";
export const receiptRefused = error => [400, 401, 403, 404, 409].includes(error?.status);

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
      throw Object.assign(new Error("This tab couldn't keep track of the receipt request. Check the printer before trying again."), { status: 400 });
    }
  }

  function clear(key) {
    try { storage().removeItem(key); }
    catch { /* Retaining the same request ID is safe if storage becomes unavailable. */ }
  }

  function submit(scope, printerId, send) {
    const key = requestKey(scope);
    if (pending.has(key)) return pending.get(key);
    const prior = read(scope);
    if (prior && prior.printerId !== printerId) return Promise.reject(new Error(receiptUnconfirmed));
    const intent = prior || { printerId, requestId: newId() };
    const result = (async () => {
      save(key, intent);
      try {
        const receipt = await send(intent.requestId);
        if (typeof receipt?.id !== "string" || !uuid.test(receipt.id) ||
            receipt.manualReprint !== true || !jobStatuses.has(receipt.status)) throw new Error(receiptUnconfirmed);
        clear(key);
        return receipt;
      } catch (error) {
        // A rejection on a later retry cannot tell us whether an earlier request queued.
        if (!prior && receiptRefused(error)) clear(key);
        throw error;
      }
    })().finally(() => pending.delete(key));
    pending.set(key, result);
    return result;
  }

  return { read, submit };
}

export const receiptPrintRequests = createReceiptPrintRequests();
