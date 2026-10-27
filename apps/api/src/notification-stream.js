const hubs = new WeakMap();

function encodeEvent(row) {
  const data = { id: row.id, type: row.type, title: row.title, message: row.message, ...(row.order_id ? { orderId: row.order_id } : {}), ...(row.restaurant_id ? { restaurantId: row.restaurant_id } : {}), createdAt: row.created_at, readAt: row.read_at };
  return `id: ${row.id}\nevent: notification\ndata: ${JSON.stringify(data)}\n\n`;
}

function validClient(db, client, timestamp) {
  if (!db.prepare("SELECT 1 FROM users WHERE id=? AND account_enabled=1").get(client.userId)) return false;
  if (!client.sessionId) return false;
  const table = client.native ? "native_sessions" : "sessions";
  return Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE id=? AND user_id=? AND revoked_at IS NULL AND expires_at>?`).get(client.sessionId, client.userId, timestamp));
}

function allowed(db, row) {
  if (row.type === "order_message") {
    const order = row.order_id && db.prepare("SELECT customer_id,restaurant_id FROM orders WHERE id=?").get(row.order_id);
    if (!order) return false;
    if (order.customer_id !== row.user_id && !db.prepare("SELECT 1 FROM restaurant_memberships WHERE restaurant_id=? AND user_id=?").get(order.restaurant_id, row.user_id)) return false;
  }
  if (row.type !== "offer") return true;
  try { return Boolean(db.prepare("SELECT 1 FROM marketing_preferences WHERE user_id=? AND in_app_promotions=1").get(row.user_id)); }
  catch { return false; }
}

export function notificationStreamHub(db, { pollMs = 1000, heartbeatMs = 20_000, maxBufferedBytes = 64 * 1024, now = () => new Date() } = {}) {
  if (hubs.has(db)) return hubs.get(db);
  const clients = new Set(); let timer = null; let heartbeat = null; let globalRowId = db.prepare("SELECT COALESCE(MAX(rowid),0) value FROM user_notifications").get().value;
  const close = (client) => { if (client.closed) return; client.closed = true; clients.delete(client); client.req.off?.("close", client.done); client.res.off?.("close", client.done); try { client.res.end(); } catch {} if (!clients.size) stop(); };
  const write = (client, chunk) => {
    if (client.closed) return;
    if (!validClient(db, client, now().toISOString())) return close(client);
    const accepted = client.res.write(chunk);
    if (!accepted) {
      client.buffered += Buffer.byteLength(chunk);
      if (client.buffered > maxBufferedBytes) return close(client);
      client.res.once?.("drain", () => { client.buffered = 0; });
    }
  };
  const poll = () => {
    try {
      const rows = db.prepare("SELECT rowid AS stream_rowid,* FROM user_notifications WHERE rowid>? ORDER BY rowid LIMIT 500").all(globalRowId);
      for (const row of rows) { globalRowId = row.stream_rowid; for (const client of clients) if (client.userId === row.user_id && row.stream_rowid > client.deliveredThrough) { if (allowed(db, row)) write(client, encodeEvent(row)); client.deliveredThrough = row.stream_rowid; } }
    } catch { for (const client of [...clients]) close(client); stop(); }
  };
  const start = () => {
    timer ??= setInterval(poll, pollMs); timer.unref?.();
    heartbeat ??= setInterval(() => { try { for (const client of clients) write(client, `: heartbeat ${Date.now()}\n\n`); } catch { for (const client of [...clients]) close(client); stop(); } }, heartbeatMs); heartbeat.unref?.();
  };
  const stop = () => { if (timer) clearInterval(timer); if (heartbeat) clearInterval(heartbeat); timer = null; heartbeat = null; };
  const hub = {
    subscribe({ req, res, userId, sessionId, native = false, lastEventId }) {
      if ([...clients].filter((client) => client.userId === userId).length >= 3) { res.writeHead(429, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify({ error: { code: "STREAM_LIMIT", message: "Too many notification streams" } })); return true; }
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.flushHeaders?.(); res.write("retry: 3000\n\n");
      let cursor = null;
      if (lastEventId) cursor = db.prepare("SELECT rowid AS stream_rowid FROM user_notifications WHERE id=? AND user_id=?").get(lastEventId, userId);
      const client = { req, res, userId, sessionId, native, buffered: 0, closed: false, deliveredThrough: cursor?.stream_rowid ?? 0 };
      const catchup = cursor ? db.prepare("SELECT rowid AS stream_rowid,* FROM user_notifications WHERE user_id=? AND rowid>? ORDER BY rowid LIMIT 100").all(userId, cursor.stream_rowid) : db.prepare("SELECT rowid AS stream_rowid,* FROM user_notifications WHERE user_id=? ORDER BY rowid DESC LIMIT 100").all(userId).reverse();
      for (const row of catchup) { if (allowed(db, row)) write(client, encodeEvent(row)); client.deliveredThrough = row.stream_rowid; }
      if (client.closed) return true;
      clients.add(client); client.done = () => close(client); req.once?.("close", client.done); res.once?.("close", client.done); start();
      return true;
    },
    close() { for (const client of [...clients]) close(client); stop(); },
    poll
  };
  hubs.set(db, hub); return hub;
}
