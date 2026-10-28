import { randomUUID } from "node:crypto";
import { withTransaction } from "./db/index.js";
import { requireRole } from "./auth/authorization.js";
import { HttpError, sendJson } from "./http.js";
import { createOrderAlertEmailAdapter, orderAlertEmailReadiness } from "./order-alert-email.js";

export const ORDER_CONFIRMATION_MS = 180000;
export const PAYABLE_ORDER_SQL = `(o.payment_method='cash' AND o.payment_status='cash_due' OR o.payment_method='mock_card' AND o.payment_status IN ('mock_authorized','mock_captured') OR o.payment_method='card' AND o.payment_status IN ('stripe_authorized','stripe_captured'))`;
const dueSql = `o.status='placed' AND o.confirmed_at IS NULL AND o.merchant_visible_at IS NOT NULL AND o.confirmation_due_at<=$now AND ${PAYABLE_ORDER_SQL}`;
const safe = (value, max = 180) => String(value ?? "").replace(/[\r\n\0]+/g," ").trim().slice(0,max);
const workers = new WeakMap();
const iso = config => config.now().toISOString();
const payable = order => order.payment_method === "cash" ? order.payment_status === "cash_due" : order.payment_method === "mock_card" ? ["mock_authorized","mock_captured"].includes(order.payment_status) : ["stripe_authorized","stripe_captured"].includes(order.payment_status);

export function markMerchantOrderVisible(db, orderId, stamp) {
  const due = new Date(Date.parse(stamp) + ORDER_CONFIRMATION_MS).toISOString();
  db.prepare(`UPDATE orders AS o SET merchant_visible_at=COALESCE(merchant_visible_at,?),confirmation_due_at=COALESCE(confirmation_due_at,?) WHERE o.id=? AND o.status='placed' AND ${PAYABLE_ORDER_SQL}`).run(stamp,due,orderId);
  return db.prepare(`SELECT 1 FROM orders o WHERE o.id=? AND o.merchant_visible_at IS NOT NULL AND o.status='placed' AND ${PAYABLE_ORDER_SQL}`).get(orderId) !== undefined;
}

export function defaultCustomerEtaMinutes(order, restaurant) {
  const estimate = order.fulfillment === "delivery" ? restaurant?.estimated_delivery_minutes ?? 35 : restaurant?.estimated_collection_minutes ?? 20;
  return Math.max(1, Math.min(480, Number(estimate) + Number(restaurant?.busy_minutes ?? 0)));
}

export function resolveConfirmationEta(db, order, provided, config) {
  const now = config.now(), restaurant = db.prepare("SELECT estimated_delivery_minutes,estimated_collection_minutes,busy_minutes FROM restaurants WHERE id=?").get(order.restaurant_id);
  if (provided === undefined) return new Date(+now + defaultCustomerEtaMinutes(order, restaurant) * 60000).toISOString();
  const date = new Date(provided);
  if (typeof provided !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(provided) || !Number.isFinite(+date) || date <= now || +date > +now + 24 * 3600000) throw new HttpError(400,"VALIDATION_ERROR","Customer ETA must be in the future and within 24 hours");
  return date.toISOString();
}

export function orderConfirmationDto(order, restaurant, now = new Date()) {
  return {
    merchantVisibleAt: order.merchant_visible_at ?? null, confirmationDueAt: order.confirmation_due_at ?? null, confirmedAt: order.confirmed_at ?? null,
    confirmationOverdue: Boolean(order.status === "placed" && !order.confirmed_at && order.confirmation_due_at && Date.parse(order.confirmation_due_at) <= +now && payable(order)),
    customerEtaAt: order.confirmed_at ? order.estimated_ready_at ?? null : null, customerEtaType: order.fulfillment === "delivery" ? "delivery_arrival" : "collection_ready",
    defaultCustomerEtaMinutes: defaultCustomerEtaMinutes(order, restaurant),
    confirmationState: order.confirmed_at ? "confirmed" : order.status !== "placed" ? "closed" : payable(order) ? "awaiting_confirmation" : "awaiting_payment"
  };
}

export function cancelUnsentOrderConfirmationAlert(db, orderId, stamp) {
  return db.prepare("UPDATE order_confirmation_email_outbox SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL,last_error='ORDER_NO_LONGER_AWAITING_CONFIRMATION',updated_at=? WHERE order_id=? AND status IN ('pending','claimed','failed') AND dispatch_started_at IS NULL").run(stamp,orderId).changes;
}

function stillEligible(db, orderId, stamp) {
  return Boolean(db.prepare(`SELECT 1 FROM orders o WHERE o.id=$id AND ${dueSql}`).get({id:orderId,now:stamp}));
}

function queueOverdue(db, config, limit) {
  const stamp = iso(config), settings = config.orderAlertEmail;
  return withTransaction(db, () => {
    db.prepare(`UPDATE order_confirmation_email_outbox SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL,last_error='ORDER_NO_LONGER_AWAITING_CONFIRMATION',updated_at=$now WHERE status IN ('pending','failed') AND NOT EXISTS(SELECT 1 FROM orders o WHERE o.id=order_confirmation_email_outbox.order_id AND ${dueSql})`).run({now:stamp});
    const rows = db.prepare(`SELECT o.id,o.restaurant_id,o.merchant_visible_at,r.name restaurant_name,r.phone restaurant_phone FROM orders o JOIN restaurants r ON r.id=o.restaurant_id WHERE ${dueSql} AND NOT EXISTS(SELECT 1 FROM order_confirmation_email_outbox e WHERE e.order_id=o.id) ORDER BY o.confirmation_due_at,o.id LIMIT $limit`).all({now:stamp,limit});
    for (const order of rows) {
      const id = randomUUID(), reference = order.id.slice(0,8).toUpperCase(), link = new URL("/business/admin/orders",config.origin); link.searchParams.set("orderId",order.id);
      const subject = `Cal-Eats order ${reference} is unconfirmed after 3 minutes`, body = `An order has not been confirmed by the restaurant within three minutes.\n\nOrder: ${reference}\nRestaurant: ${safe(order.restaurant_name)}\nBusiness phone: ${safe(order.restaurant_phone,60) || "Not supplied"}\nVisible to restaurant since: ${order.merchant_visible_at}\n\nReview: ${link.href}\n\nNo customer contact, address, card or payment details are included. Confirm the current order status before contacting the business.`, messageId = `<cal-eats-order-alert-${id}@calai.info>`;
      db.prepare("INSERT OR IGNORE INTO order_confirmation_email_outbox(id,order_id,restaurant_id,recipient,subject,body,message_id,mode,status,queued_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'pending',?,?)").run(id,order.id,order.restaurant_id,settings.recipient || "platform-owner@example.invalid",subject,body,messageId,settings.mode,stamp,stamp);
      for (const admin of db.prepare("SELECT id FROM users WHERE role='admin' AND account_enabled=1").all()) db.prepare("INSERT OR IGNORE INTO user_notifications(id,user_id,type,title,message,order_id,restaurant_id,event_key,created_at) VALUES(?,?,'order_unconfirmed','Order needs restaurant confirmation',?,?,? ,?,?)").run(randomUUID(),admin.id,`${safe(order.restaurant_name)} has not confirmed order ${reference} after 3 minutes.`,order.id,order.restaurant_id,`order:${order.id}:confirmation-overdue`,stamp);
    }
    return rows.length;
  });
}

async function run(db, config, { workerId = randomUUID(), limit = 25, adapter, beforeDispatch } = {}) {
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new TypeError("Order confirmation alert worker limit must be between 1 and 100");
  const result = { queued: queueOverdue(db,config,limit), sent:0, localSaved:0, failed:0, unknown:0, cancelled:0 }, stamp = iso(config);
  withTransaction(db, () => {
    const expired = db.prepare("SELECT * FROM order_confirmation_email_outbox WHERE status='claimed' AND lease_expires_at<=?").all(stamp);
    for (const row of expired) db.prepare("UPDATE order_confirmation_email_outbox SET status=?,lease_owner=NULL,lease_expires_at=NULL,last_error=?,updated_at=? WHERE id=? AND status='claimed' AND lease_expires_at<=?").run(row.dispatch_started_at ? "unknown" : stillEligible(db,row.order_id,stamp) ? "pending" : "cancelled",row.dispatch_started_at ? "EMAIL_LEASE_EXPIRED_AFTER_DISPATCH" : "EMAIL_LEASE_RECOVERED_BEFORE_DISPATCH",stamp,row.id,stamp);
  });
  const sender = adapter ?? createOrderAlertEmailAdapter(config.orderAlertEmail);
  for (let index = 0; index < limit; index++) {
    const row = withTransaction(db, () => {
      const now = iso(config), candidate = db.prepare("SELECT * FROM order_confirmation_email_outbox WHERE status='pending' ORDER BY queued_at,id LIMIT 1").get();
      if (!candidate) return null;
      if (!stillEligible(db,candidate.order_id,now)) { cancelUnsentOrderConfirmationAlert(db,candidate.order_id,now); result.cancelled++; return null; }
      const lease = new Date(Date.parse(now)+120000).toISOString(), claim = db.prepare("UPDATE order_confirmation_email_outbox SET status='claimed',lease_owner=?,lease_expires_at=?,attempts=attempts+1,updated_at=? WHERE id=? AND status='pending'").run(workerId,lease,now,candidate.id);
      return claim.changes === 1 ? { ...candidate, lease_owner:workerId,lease_expires_at:lease } : null;
    });
    if (!row) break;
    const current = () => {
      const now = iso(config), owned = db.prepare("SELECT * FROM order_confirmation_email_outbox WHERE id=? AND status='claimed' AND lease_owner=? AND lease_expires_at>?").get(row.id,workerId,now);
      return Boolean(owned && stillEligible(db,row.order_id,now));
    };
    const beforeSend = () => withTransaction(db, () => {
      const now = iso(config);
      if (!current()) { if (!stillEligible(db,row.order_id,now)) cancelUnsentOrderConfirmationAlert(db,row.order_id,now); return false; }
      return db.prepare("UPDATE order_confirmation_email_outbox SET dispatch_started_at=COALESCE(dispatch_started_at,?),updated_at=? WHERE id=? AND status='claimed' AND lease_owner=? AND lease_expires_at>?").run(now,now,row.id,workerId,now).changes === 1;
    });
    let outcome;
    try {
      await beforeDispatch?.(row);
      if (!current()) { if (!stillEligible(db,row.order_id,iso(config))) cancelUnsentOrderConfirmationAlert(db,row.order_id,iso(config)); result.cancelled++; continue; }
      if (row.mode !== config.orderAlertEmail.mode) { outcome={status:"failed",errorCode:"EMAIL_MODE_CHANGED"}; }
      else
      outcome = await sender({ id:row.id,to:row.recipient,from:config.orderAlertEmail.from,subject:row.subject,text:row.body,messageId:row.message_id },{beforeSend});
    } catch {
      const dispatched = db.prepare("SELECT dispatch_started_at FROM order_confirmation_email_outbox WHERE id=?").get(row.id)?.dispatch_started_at;
      outcome = { status:dispatched ? "unknown" : "failed",errorCode:dispatched ? "EMAIL_OUTCOME_UNKNOWN" : "EMAIL_ADAPTER_FAILED_BEFORE_DISPATCH" };
    }
    const status = ["sent","local_saved","failed","unknown","cancelled"].includes(outcome?.status) ? outcome.status : "unknown", now = iso(config), code = typeof outcome?.errorCode === "string" && /^[A-Z0-9_]{1,80}$/.test(outcome.errorCode) ? outcome.errorCode : status === "unknown" ? "EMAIL_OUTCOME_UNKNOWN" : null;
    const saved = withTransaction(db, () => db.prepare("UPDATE order_confirmation_email_outbox SET status=?,last_error=?,sent_at=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND status='claimed' AND lease_owner=? AND lease_expires_at>?").run(status,code,["sent","local_saved"].includes(status) ? now : null,now,row.id,workerId,now));
    if (saved.changes) result[status === "local_saved" ? "localSaved" : status]++;
  }
  return result;
}

export function runOrderConfirmationAlerts(db, config, options) {
  if (workers.has(db)) return workers.get(db);
  const work = run(db,config,options).finally(() => workers.delete(db)); workers.set(db,work); return work;
}

export async function routeOrderConfirmationAlerts({req,res,url,db,config,session}) {
  if (req.method !== "GET" || url.pathname !== "/api/admin/order-confirmation-alerts") return false;
  requireRole(session,"admin"); const rawPage = url.searchParams.get("page") ?? "1", rawLimit = url.searchParams.get("pageSize") ?? "25", page=Number(rawPage),pageSize=Number(rawLimit);
  if (!/^[1-9][0-9]*$/.test(rawPage) || !/^[1-9][0-9]*$/.test(rawLimit) || !Number.isSafeInteger(page) || page>100000 || pageSize>100) throw new HttpError(400,"VALIDATION_ERROR","Alert pagination is invalid");
  const total = db.prepare("SELECT COUNT(*) n FROM order_confirmation_email_outbox").get().n, rows=db.prepare("SELECT e.*,o.status order_status,r.name restaurant_name FROM order_confirmation_email_outbox e JOIN orders o ON o.id=e.order_id JOIN restaurants r ON r.id=e.restaurant_id ORDER BY e.queued_at DESC,e.id DESC LIMIT ? OFFSET ?").all(pageSize,(page-1)*pageSize);
  const summary=Object.fromEntries(db.prepare("SELECT status,COUNT(*) n FROM order_confirmation_email_outbox GROUP BY status").all().map(row=>[row.status,row.n]));
  return sendJson(res,200,{data:{items:rows.map(row=>({id:row.id,orderId:row.order_id,restaurantId:row.restaurant_id,restaurantName:row.restaurant_name,recipient:row.recipient,status:row.status,orderStatus:row.order_status,mode:row.mode,attempts:row.attempts,errorCode:row.last_error,queuedAt:row.queued_at,sentAt:row.sent_at,updatedAt:row.updated_at,dispatchStartedAt:row.dispatch_started_at})),pagination:{page,pageSize,total,totalPages:Math.ceil(total/pageSize),hasNext:page*pageSize<total,hasPrevious:page>1},summary,email:orderAlertEmailReadiness(config.orderAlertEmail)}});
}
