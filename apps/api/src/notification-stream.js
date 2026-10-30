const hubs = new WeakMap();

function encodeEvent(row) {
  const data = { id: row.id, type: row.type, title: row.title, message: row.message, ...(row.order_id ? { orderId: row.order_id } : {}), ...(row.offer_id ? { offerId: row.offer_id } : {}), ...(row.restaurant_id ? { restaurantId: row.restaurant_id } : {}), ...(row.conversation_id ? { conversationId: row.conversation_id } : {}), ...(row.customer_id ? { customerId: row.customer_id } : {}), ...(row.support_case_id ? { supportCaseId: row.support_case_id } : {}), createdAt: row.created_at, readAt: row.read_at };
  return `id: ${row.id}\nevent: notification\ndata: ${JSON.stringify(data)}\n\n`;
}

function validClient(db, client, timestamp) {
  const user = db.prepare("SELECT role FROM users WHERE id=? AND account_enabled=1").get(client.userId);
  if (!user) return false;
  if (!client.sessionId) return false;
  if (client.native && (client.nativeAudience === "business" ? user.role !== "restaurant" || !db.prepare("SELECT 1 FROM restaurant_memberships WHERE user_id=?").get(client.userId) : user.role !== "customer")) return false;
  const table = client.native ? client.nativeAudience === "business" ? "native_business_sessions" : "native_sessions" : "sessions";
  return Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE id=? AND user_id=? AND revoked_at IS NULL AND expires_at>?`).get(client.sessionId, client.userId, timestamp));
}

export function notificationRecipientAllowed(db, row) {
  const user = db.prepare("SELECT role,account_enabled FROM users WHERE id=?").get(row.user_id);
  if (!user?.account_enabled) return false;
  if (user.role === "restaurant" && row.restaurant_id && !db.prepare("SELECT 1 FROM restaurant_memberships WHERE restaurant_id=? AND user_id=?").get(row.restaurant_id, row.user_id)) return false;
  if (row.support_case_id) {
    const ticket = db.prepare("SELECT user_id,restaurant_id FROM support_cases WHERE id=?").get(row.support_case_id);
    if (!ticket || (ticket.user_id !== row.user_id && user.role !== "admin" && !(user.role === "restaurant" && ticket.restaurant_id && db.prepare("SELECT 1 FROM restaurant_memberships WHERE restaurant_id=? AND user_id=?").get(ticket.restaurant_id,row.user_id)))) return false;
  }
  if (row.type === "customer_message") {
    const thread = row.conversation_id && db.prepare("SELECT restaurant_id,customer_id FROM restaurant_customer_threads WHERE id=?").get(row.conversation_id);
    if (!thread) return false;
    if (thread.customer_id !== row.user_id && !db.prepare("SELECT 1 FROM restaurant_memberships WHERE restaurant_id=? AND user_id=? AND permission='owner'").get(thread.restaurant_id, row.user_id)) return false;
  }
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
  const close = (client) => { if (client.closed) return; client.closed = true; clients.delete(client); if(client.done){client.req.off?.("close", client.done);client.res.off?.("close", client.done);}if(client.drain)client.res.off?.("drain",client.drain);client.drain=null;try { client.res.end(); } catch {} if (!clients.size) stop(); };
  const write = (client, chunk) => {
    if (client.closed) return;
    if (!validClient(db, client, now().toISOString())) return close(client);
    const accepted = client.res.write(chunk);
    if (!accepted) {
      client.buffered += Buffer.byteLength(chunk);
      if (client.buffered > maxBufferedBytes) return close(client);
      if(!client.drain){client.drain=()=>{client.buffered=0;client.drain=null;};client.res.once?.("drain",client.drain);}
    }
  };
  // Replay one bounded page per client. Live fan-out must not advance a client
  // past its backlog; the next page follows the hub watermark as it advances.
  const catchUp = (client, through) => {
    if (!validClient(db, client, now().toISOString())) return close(client);
    const rows = db.prepare("SELECT rowid AS stream_rowid,* FROM user_notifications WHERE user_id=? AND rowid>? AND rowid<=? ORDER BY rowid LIMIT 100").all(client.userId, client.deliveredThrough, through);
    for (const row of rows) {
      if (client.closed) break;
      if (notificationRecipientAllowed(db, row)) write(client, encodeEvent(row));
      client.deliveredThrough = row.stream_rowid;
    }
    if (rows.length < 100 || client.deliveredThrough >= through) {
      client.deliveredThrough = Math.max(client.deliveredThrough, through);
      client.catchingUp = false;
    }
  };
  const poll = () => {
    try {
      for (const client of clients) if (client.catchingUp) catchUp(client, globalRowId);
      const rows = db.prepare("SELECT rowid AS stream_rowid,* FROM user_notifications WHERE rowid>? ORDER BY rowid LIMIT 500").all(globalRowId);
      for (const row of rows) { globalRowId = row.stream_rowid; for (const client of clients) if (!client.catchingUp && client.userId === row.user_id && row.stream_rowid > client.deliveredThrough) { if (notificationRecipientAllowed(db, row)) write(client, encodeEvent(row)); client.deliveredThrough = row.stream_rowid; } }
    } catch { for (const client of [...clients]) close(client); stop(); }
  };
  const start = () => {
    timer ??= setInterval(poll, pollMs); timer.unref?.();
    heartbeat ??= setInterval(() => { try { for (const client of clients) write(client, `: heartbeat ${Date.now()}\n\n`); } catch { for (const client of [...clients]) close(client); stop(); } }, heartbeatMs); heartbeat.unref?.();
  };
  const stop = () => { if (timer) clearInterval(timer); if (heartbeat) clearInterval(heartbeat); timer = null; heartbeat = null; };
  const hub = {
    subscribe({ req, res, userId, sessionId, native = false, nativeAudience, lastEventId }) {
      if ([...clients].filter((client) => client.userId === userId).length >= 3) { res.writeHead(429, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify({ error: { code: "STREAM_LIMIT", message: "Too many notification streams" } })); return true; }
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.flushHeaders?.(); res.write("retry: 3000\n\n");
      let cursor = null;
      if (lastEventId) cursor = db.prepare("SELECT rowid AS stream_rowid FROM user_notifications WHERE id=? AND user_id=?").get(lastEventId, userId);
      const client = { req, res, userId, sessionId, native, nativeAudience, buffered: 0, closed: false, deliveredThrough: cursor?.stream_rowid ?? 0, catchingUp: Boolean(lastEventId) };
      // If a supplied cursor was deleted or belongs to someone else, replay only
      // this recipient's retained events. Event IDs let clients deduplicate.
      if (client.catchingUp) catchUp(client, globalRowId);
      else {
        const recent = db.prepare("SELECT rowid AS stream_rowid,* FROM user_notifications WHERE user_id=? ORDER BY rowid DESC LIMIT 100").all(userId).reverse();
        for (const row of recent) { if (client.closed) break; if (notificationRecipientAllowed(db, row)) write(client, encodeEvent(row)); client.deliveredThrough = row.stream_rowid; }
      }
      if (client.closed) return true;
      clients.add(client); client.done = () => close(client); req.once?.("close", client.done); res.once?.("close", client.done); start();
      return true;
    },
    close() { for (const client of [...clients]) close(client); stop(); },
    poll
  };
  hubs.set(db, hub); return hub;
}
