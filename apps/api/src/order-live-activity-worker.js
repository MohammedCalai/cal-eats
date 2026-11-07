import { randomUUID } from "node:crypto";
import { withTransaction } from "./db/index.js";
import { createAPNsLiveActivityAdapter } from "./apns-live-activity-adapter.js";
import { decryptLiveActivityToken, endLiveActivityBinding, retireLiveActivityBinding, liveOrderActive, liveOrderContent, LIVE_ACTIVITY_NAME, LIVE_ACTIVITY_PROJECT } from "./order-live-activities.js";

const workers = new WeakMap(), adapters = new WeakMap(), leaseMs = 30000;
const safeCode = value => typeof value === "string" && /^LIVE_ACTIVITY_[A-Z_]{1,60}$/.test(value) ? value : "LIVE_ACTIVITY_SEND_FAILED";

function validSession(db, row, stamp) {
  return Boolean(db.prepare("SELECT 1 FROM native_sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.user_id=? AND s.revoked_at IS NULL AND s.expires_at>? AND u.account_enabled=1 AND u.role='customer'").get(row.session_id, row.user_id, stamp));
}
function source(db, config, job, stamp) {
  const row = db.prepare("SELECT * FROM customer_order_live_activities WHERE id=? AND generation=? AND state IN ('active','ending')").get(job.activity_id, job.generation);
  if (!row || row.project_id !== LIVE_ACTIVITY_PROJECT || !row.ciphertext) return null;
  const order = db.prepare("SELECT o.*,r.revision FROM orders o JOIN order_live_activity_revisions r ON r.order_id=o.id WHERE o.id=? AND o.customer_id=?").get(row.order_id, row.user_id);
  const privacyEnd = row.state === "ending" || !validSession(db, row, stamp) || row.expires_at <= stamp || !order;
  const fallback = order ?? { id: row.order_id, fulfillment: "delivery", status: "rejected", updated_at: stamp };
  const event = privacyEnd || !liveOrderActive(order) ? "end" : "update", now = new Date(stamp), revision = order?.revision ?? job.revision;
  return { row, order, revision, privacyEnd, event, content: liveOrderContent(fallback, now, privacyEnd) };
}
function sweep(db, config, stamp) {
  withTransaction(db, () => {
    for (const row of db.prepare("SELECT a.id,a.expires_at FROM customer_order_live_activities a WHERE a.state='active' AND (a.expires_at<=? OR NOT EXISTS(SELECT 1 FROM native_sessions s JOIN users u ON u.id=s.user_id WHERE s.id=a.session_id AND s.user_id=a.user_id AND s.revoked_at IS NULL AND s.expires_at>? AND u.account_enabled=1 AND u.role='customer')) ORDER BY a.expires_at LIMIT 250").all(stamp,stamp)) endLiveActivityBinding(db, row.id, row.expires_at <= stamp ? "activity_expired" : "session_ended", stamp);
    for (const row of db.prepare("SELECT id FROM customer_order_live_activities WHERE state='ending' AND cleanup_until<=? ORDER BY cleanup_until LIMIT 250").all(stamp)) retireLiveActivityBinding(db, row.id, stamp);
    db.prepare("UPDATE order_live_activity_outbox SET status=CASE WHEN attempts<5 THEN 'pending' ELSE 'failed' END,available_at=CASE WHEN attempts<5 THEN ? ELSE NULL END,lease_owner=NULL,lease_expires_at=NULL,last_error='LIVE_ACTIVITY_LEASE_RECOVERED',updated_at=? WHERE status='claimed' AND lease_expires_at<=?").run(stamp, stamp, stamp);
  });
}

async function run(db, config, { workerId = randomUUID(), limit = 25, adapter, beforeDispatch } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("Live Activity worker limit must be 1–100");
  const result = { accepted: 0, ended: 0, failed: 0, cancelled: 0, deferred: 0 };
  sweep(db, config, config.now().toISOString());
  if (!config.orderLiveActivities?.enabled || config.runMode !== "hosted-preview" && !adapter) return { ...result, disabled: true };
  if (!adapter && !adapters.has(config)) adapters.set(config, createAPNsLiveActivityAdapter(config.orderLiveActivities, { now: () => +config.now() }));
  const transport = adapter ?? adapters.get(config);
  for (let index = 0; index < limit; index++) {
    const job = withTransaction(db, () => {
      const stamp = config.now().toISOString(), pending = db.prepare("SELECT q.* FROM order_live_activity_outbox q JOIN customer_order_live_activities a ON a.id=q.activity_id WHERE q.status IN ('pending','failed') AND q.available_at<=? AND q.attempts<5 AND a.state IN ('active','ending') ORDER BY CASE a.state WHEN 'ending' THEN 0 ELSE 1 END,q.available_at,q.activity_id LIMIT 1").get(stamp);
      if (!pending) return null;
      db.prepare("UPDATE order_live_activity_outbox SET status='claimed',attempts=attempts+1,lease_owner=?,lease_expires_at=?,dispatch_started_at=NULL,updated_at=? WHERE activity_id=? AND generation=?").run(workerId, new Date(Date.parse(stamp) + leaseMs).toISOString(), stamp, pending.activity_id, pending.generation);
      return { ...pending, attempts: pending.attempts + 1 };
    });
    if (!job) break;
    const owned = () => Boolean(db.prepare("SELECT 1 FROM order_live_activity_outbox WHERE activity_id=? AND generation=? AND status='claimed' AND lease_owner=? AND lease_expires_at>?").get(job.activity_id, job.generation, workerId, config.now().toISOString()));
    await beforeDispatch?.(job);
    if (!owned()) continue;
    const stamp = config.now().toISOString(), current = source(db, config, job, stamp);
    if (!current) { db.prepare("UPDATE order_live_activity_outbox SET status='cancelled',available_at=NULL,last_error='LIVE_ACTIVITY_BINDING_RETIRED',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE activity_id=? AND generation=? AND lease_owner=?").run(stamp, job.activity_id, job.generation, workerId); result.cancelled++; continue; }
    const timestamp = Math.floor(Date.parse(stamp) / 1000);
    if (current.row.last_timestamp >= timestamp) {
      db.prepare("UPDATE order_live_activity_outbox SET status='pending',attempts=MAX(0,attempts-1),available_at=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE activity_id=? AND generation=? AND lease_owner=?").run(new Date((current.row.last_timestamp + 1) * 1000).toISOString(), stamp, job.activity_id, job.generation, workerId); result.deferred++; continue;
    }
    const stale = Math.floor(Math.min(Date.parse(current.row.expires_at), Math.max(Date.parse(stamp) + 15 * 60000, (current.content.etaUnix ?? 0) * 1000 + 15 * 60000)) / 1000);
    const payload = { aps: { timestamp, event: current.event, "content-state": { name: LIVE_ACTIVITY_NAME, props: JSON.stringify(current.content) }, ...(current.event === "end" ? { "dismissal-date": timestamp - 1 } : { "stale-date": stale }) } };
    const beforeSend = () => withTransaction(db, () => {
      if (!owned()) return false;
      const fresh = source(db, config, job, config.now().toISOString());
      if (!fresh || fresh.revision !== current.revision || fresh.event !== current.event || fresh.privacyEnd !== current.privacyEnd) return false;
      const changed = db.prepare("UPDATE order_live_activity_outbox SET dispatch_started_at=?,updated_at=? WHERE activity_id=? AND generation=? AND status='claimed' AND lease_owner=? AND dispatch_started_at IS NULL").run(config.now().toISOString(), config.now().toISOString(), job.activity_id, job.generation, workerId);
      if (changed.changes) db.prepare("UPDATE customer_order_live_activities SET last_timestamp=? WHERE id=? AND generation=?").run(timestamp, job.activity_id, job.generation);
      return changed.changes === 1;
    });
    let outcome;
    try { outcome = await transport.send(decryptLiveActivityToken(config, current.row), payload, { beforeSend, priority: 10 }); }
    catch { outcome = { status: "retry", errorCode: "LIVE_ACTIVITY_SEND_FAILED" }; }
    const now = config.now().toISOString(), accepted = outcome?.status === "accepted" && db.prepare("SELECT dispatch_started_at FROM order_live_activity_outbox WHERE activity_id=? AND generation=? AND lease_owner=?").get(job.activity_id, job.generation, workerId)?.dispatch_started_at;
    const status = accepted ? "accepted" : outcome?.status === "cancelled" ? "pending" : "failed", deadline = current.row.state === "ending" ? current.row.cleanup_until : current.row.expires_at;
    const retryAt = new Date(Date.parse(now) + Math.min(60000, 5000 * 2 ** (job.attempts - 1))).toISOString(), retry = outcome?.status === "retry" && job.attempts < 5 && retryAt < deadline;
    const saved = db.prepare("UPDATE order_live_activity_outbox SET status=?,available_at=?,last_error=?,apns_id=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE activity_id=? AND generation=? AND status='claimed' AND lease_owner=?").run(status, status === "pending" ? now : retry ? retryAt : null, accepted ? null : safeCode(outcome?.errorCode), accepted ? outcome.apnsId ?? null : null, now, job.activity_id, job.generation, workerId);
    if (!saved.changes) continue;
    if (accepted) {
      db.prepare("UPDATE customer_order_live_activities SET sent_revision=?,updated_at=? WHERE id=? AND generation=?").run(current.revision, now, job.activity_id, job.generation);
      result.accepted++;
      if (current.event === "end") { retireLiveActivityBinding(db, job.activity_id, now); result.ended++; }
    } else if (outcome?.status === "invalid_activity") { retireLiveActivityBinding(db, job.activity_id, now, true); result.failed++; }
    else result[status === "pending" ? "cancelled" : "failed"]++;
  }
  return result;
}

export function runOrderLiveActivityWorker(db, config, options) {
  if (workers.has(db)) return workers.get(db);
  const work = run(db, config, options).finally(() => workers.delete(db)); workers.set(db, work); return work;
}
