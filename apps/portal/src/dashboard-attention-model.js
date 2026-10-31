export function printerConnectionSummary(items = []) {
  const configured = items.filter(printer => !printer.revoked && printer.status !== "revoked");
  return { configured, disconnected: configured.filter(printer => printer.enabled === false || printer.status !== "online") };
}

export function startDashboardReminder(player, { schedule = setInterval, cancel = clearInterval, onBlocked = () => {} } = {}) {
  let disposed = false, playing = false, allowed = false;
  async function ring() {
    if (playing || disposed) return;
    playing = true;
    try {
      player.currentTime = 0;
      await player.play();
      if (!disposed) { allowed = true; onBlocked(false); }
    } catch { if (!disposed) { allowed = false; onBlocked(true); } }
    finally { playing = false; if (disposed) player.pause(); }
  }
  void ring();
  const timer = schedule(() => void ring(), 15000);
  return {
    interact(event) { if (event.isTrusted && !allowed) void ring(); },
    stop() { disposed = true; cancel(timer); player.pause(); player.currentTime = 0; }
  };
}
