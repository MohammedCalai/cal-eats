const transient = error => error instanceof TypeError || error?.name === "TimeoutError" || [408, 429].includes(error?.status) || error?.status >= 500;
export { transient as isTemporaryPrinterFailure };

function pause(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); reject(new DOMException("Cancelled", "AbortError")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, milliseconds);
    if (signal?.aborted) stop();
    else signal?.addEventListener("abort", stop, { once: true });
  });
}

// Retry only reads. A timed-out print, edit or setup request must never be
// replayed here because it may already have reached the server.
export async function refreshPrinterSnapshot(read, { signal, sleep = pause, timeoutMs = 8000 } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    let timedOut = false;
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try { return await read(controller.signal); }
    catch (error) {
      if (signal?.aborted || (!timedOut && !transient(error)) || attempt === 2) throw error;
    } finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort); }
    await sleep(500 * 2 ** attempt, signal);
  }
}

export function printerRefreshState(error) {
  return error?.status === 401 ? "sign_in" : error?.status === 403 ? "access" : "reconnecting";
}
