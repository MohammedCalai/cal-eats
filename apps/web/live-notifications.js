// One connection per mounted consumer; polling runs only during disconnection.
export function connectLiveNotifications({ onNotification, onRefresh = () => {}, onError = () => {}, fallbackMs = 30000 } = {}) {
  let source, stopped = false, connected = false, refreshing = false, queued = false;
  async function refresh() {
    if (stopped || document.hidden) return;
    if (refreshing) { queued = true; return; }
    refreshing = true;
    try { await onRefresh(); } catch (error) { onError(error); }
    finally { refreshing = false; if (queued) { queued = false; void refresh(); } }
  }
  function begin() {
    if (stopped || typeof EventSource === "undefined") return;
    source = new EventSource("/api/notifications/stream");
    source.onopen = () => { connected = true; void refresh(); };
    source.onerror = () => { connected = false; };
    source.addEventListener("notification", event => {
      if (stopped) return;
      try { onNotification?.(JSON.parse(event.data)); } catch (error) { onError(error); }
      void refresh();
    });
  }
  void refresh().finally(begin);
  const timer = setInterval(() => { if (!connected) void refresh(); }, fallbackMs);
  const visible = () => { if (!document.hidden) void refresh(); };
  document.addEventListener("visibilitychange", visible);
  return () => { stopped = true; source?.close(); clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
}
