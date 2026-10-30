import { createHash, randomUUID } from "node:crypto";
import { requireRestaurantOwner, requireRole, requireUser } from "./auth/authorization.js";
import { withTransaction } from "./db/index.js";
import { HttpError, exactObject, readJson, sendJson } from "./http.js";
import { routeCustomerRelationships } from "./customer-relationships.js";
import { notificationRecipientAllowed } from "./notification-stream.js";
import { markMerchantOrderVisible, routeOrderConfirmationAlerts } from "./order-confirmation.js";
import { queueCustomerEmailForNotification, routeCustomerTransactionalEmails } from "./customer-emails.js";

const clean = (value, min, max, label) => {
  const result = typeof value === "string" ? value.trim() : "";
  if (result.length < min || result.length > max) throw new HttpError(400, "VALIDATION_ERROR", `${label} is invalid`);
  return result;
};
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const fingerprint = (value) => createHash("sha256").update(canonical(value)).digest("hex");

export function addNotification(db, { userId, type, title, message, orderId = null, offerId = null, restaurantId = null, conversationId = null, customerId = null, eventKey, now }) {
  const inserted=db.prepare("INSERT OR IGNORE INTO user_notifications(id,user_id,type,title,message,order_id,offer_id,restaurant_id,conversation_id,customer_id,event_key,created_at,read_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL)").run(randomUUID(), userId, type, title, message, orderId, offerId, restaurantId, conversationId, customerId, eventKey, now);
  if(inserted.changes)queueCustomerEmailForNotification(db,userId,eventKey);
}

export function notifyNewOrder(db, order, now) {
  if (!markMerchantOrderVisible(db,order.id,now)) return;
  for (const member of db.prepare("SELECT user_id FROM restaurant_memberships WHERE restaurant_id=?").all(order.restaurant_id)) addNotification(db, { userId: member.user_id, type: "new_order", title: "New order", message: `New ${order.fulfillment} order from ${order.customer_name}`, orderId: order.id, restaurantId: order.restaurant_id, eventKey: `order:${order.id}:new`, now });
}

export function notifyOrderStatus(db, order, status, now, type = "order_status", eventSuffix = "") {
  const labels = { accepted: "confirmed", preparing: "being prepared", ready: "ready", out_for_delivery: "out for delivery", completed: "completed", rejected: "rejected", refunded: "refunded" };
  const eta = order.estimated_ready_at ? new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/London",weekday:"short",hour:"2-digit",minute:"2-digit"}).format(new Date(order.estimated_ready_at)) : null;
  const etaText = eta ? ` Estimated ${order.fulfillment === "delivery" ? "delivery" : "collection"}: ${eta}.` : "";
  const title = status === "accepted" ? "Order confirmed" : status === "out_for_delivery" ? "Out for delivery" : status === "refunded" ? "Order refund recorded" : "Order update";
  addNotification(db, { userId: order.customer_id, type, title, message: status === "refunded" ? "A refund was recorded for your order" : `Your order is ${labels[status] ?? status}.${["accepted","out_for_delivery"].includes(status)?etaText:""}`, orderId: order.id, restaurantId: order.restaurant_id, eventKey: `order:${order.id}:${status}${eventSuffix}`, now });
}

export function releaseOfferForOrder(db, order, now) {
  if (!order.offer_grant_id) return;
  const grant = db.prepare("SELECT g.*,c.expires_at FROM offer_grants g JOIN offer_campaigns c ON c.id=g.campaign_id WHERE g.id=?").get(order.offer_grant_id);
  if (!grant || grant.status !== "reserved" || grant.reserved_order_id !== order.id) return;
  const status = grant.expires_at <= now ? "expired" : "available";
  db.prepare("UPDATE offer_grants SET status=?,reserved_order_id=NULL,reserved_discount_minor=0,updated_at=? WHERE id=? AND status='reserved' AND reserved_order_id=?").run(status, now, grant.id, order.id);
}

export function redeemOfferForOrder(db, order, now) {
  if (!order.offer_grant_id) return;
  db.prepare("UPDATE offer_grants SET status='redeemed',redeemed_order_id=?,updated_at=? WHERE id=? AND status='reserved' AND reserved_order_id=?").run(order.id, now, order.offer_grant_id, order.id);
}

function notificationDto(row) {
  return { id: row.id, type: row.type, title: row.title, message: row.message, ...(row.order_id ? { orderId: row.order_id } : {}), ...(row.offer_id ? { offerId: row.offer_id } : {}), ...(row.restaurant_id ? { restaurantId: row.restaurant_id } : {}), ...(row.conversation_id ? { conversationId: row.conversation_id } : {}), ...(row.customer_id ? { customerId: row.customer_id } : {}), ...(row.support_case_id ? { supportCaseId: row.support_case_id } : {}), createdAt: row.created_at, readAt: row.read_at };
}
function campaignDto(db, row) {
  const counts = db.prepare("SELECT COUNT(*) recipientCount,SUM(viewed_at IS NOT NULL) openedCount,SUM(status='reserved') reservedCount,SUM(status='redeemed') redeemedCount FROM offer_grants WHERE campaign_id=?").get(row.id);
  return { id: row.id, title: row.title, message: row.message, menuItemId: row.menu_item_id, itemName: row.item_name, itemValueMinor: row.item_value_minor, minSubtotalMinor: row.min_subtotal_minor, expiresAt: row.expires_at, createdAt: row.created_at, recipientCount: counts.recipientCount, openedCount: counts.openedCount, reservedCount: counts.reservedCount, redeemedCount: counts.redeemedCount };
}
function grantDto(row, now) {
  const campaignRules=JSON.parse(row.campaign_rules ?? "{}");
  const effectiveStatus = row.status === "available" && row.expires_at <= now ? "expired" : row.status;
  return { id: row.id, campaignId: row.campaign_id, recipientSegment: campaignRules.audienceSegment ?? row.recipient_segment ?? null, campaignType: row.campaign_type ?? null, campaignRules, restaurantId: row.restaurant_id, restaurantName: row.restaurant_name, title: row.title, message: row.message, offerType: row.offer_type ?? "free_item", value: row.offer_value ?? 0, menuItemId: row.menu_item_id, itemName: row.item_name, itemValueMinor: row.item_value_minor, minSubtotalMinor: row.min_subtotal_minor, startsAt: row.starts_at ?? row.created_at, expiresAt: row.expires_at, eligibleItemIds: JSON.parse(row.eligible_item_ids ?? "[]"), eligibleCategories: JSON.parse(row.eligible_categories ?? "[]"), stackingPolicy: row.stacking_policy ?? "exclusive", fundingParty: row.funding_party ?? "restaurant", status: effectiveStatus, viewedAt: row.viewed_at };
}

const grantSelect=`SELECT g.*,c.title,c.message,c.menu_item_id,c.item_name,c.item_value_minor,c.min_subtotal_minor,c.expires_at,c.offer_type,c.offer_value,c.starts_at,c.eligible_item_ids,c.eligible_categories,c.stacking_policy,c.funding_party,c.recipient_segment,c.campaign_type,c.campaign_rules,c.weekly_budget_minor,r.name restaurant_name FROM offer_grants g JOIN offer_campaigns c ON c.id=g.campaign_id JOIN restaurants r ON r.id=g.restaurant_id`;
const personalPriority=`CASE WHEN COALESCE(json_extract(c.campaign_rules,'$.audienceSegment'),c.recipient_segment)='selected' THEN 1 ELSE 0 END`;
function customerOffers({res,url,db,config,user}){
  const paged=url.searchParams.has("limit"),limit=paged?Number(url.searchParams.get("limit")):100,scope=url.searchParams.get("scope")||(paged?"active":"all"),after=url.searchParams.get("after"),restaurantId=url.searchParams.get("restaurantId");
  if(!Number.isInteger(limit)||limit<1||limit>100||!["active","all"].includes(scope)||(after&&(!paged||after.length>100)))throw new HttpError(400,"VALIDATION_ERROR","Offer pagination is invalid");
  const empty=paged?{items:[],hasMore:false,nextCursor:null}:[];
  const permitted=Boolean(db.prepare("SELECT COALESCE(mp.in_app_promotions,u.merchant_offers,0) allowed FROM users u LEFT JOIN marketing_preferences mp ON mp.user_id=u.id WHERE u.id=?").get(user.id)?.allowed);
  if(!permitted)return sendJson(res,200,{data:empty});
  const params={user:user.id,now:config.now().toISOString(),limit:limit+1},filters=["g.customer_id=$user","g.dismissed_at IS NULL"];
  if(restaurantId){filters.push("g.restaurant_id=$restaurant");params.restaurant=restaurantId;}
  if(scope==="active")filters.push("(g.status='reserved' OR (g.status='available' AND c.expires_at>$now))");
  if(after){const prior=db.prepare(`SELECT g.*,${personalPriority} personal_priority FROM offer_grants g JOIN offer_campaigns c ON c.id=g.campaign_id WHERE g.id=? AND g.customer_id=?`).get(after,user.id);if(!prior||(restaurantId&&prior.restaurant_id!==restaurantId))throw new HttpError(404,"NOT_FOUND","Offer cursor is unavailable");filters.push(`(${personalPriority}<$priority OR (${personalPriority}=$priority AND (g.created_at<$created OR (g.created_at=$created AND g.id<$id))))`);Object.assign(params,{priority:prior.personal_priority,created:prior.created_at,id:prior.id});}
  const order=paged?`${personalPriority} DESC,g.created_at DESC,g.id DESC`:"g.created_at DESC,g.id DESC";
  const queryParams={...params};if(scope!=="active")delete queryParams.now;
  const found=db.prepare(`${grantSelect} WHERE ${filters.join(" AND ")} ORDER BY ${order} LIMIT $limit`).all(queryParams),items=found.slice(0,limit).map(row=>grantDto(row,params.now));
  return sendJson(res,200,{data:paged?{items,hasMore:found.length>limit,nextCursor:found.length>limit?items.at(-1).id:null}:items});
}

export async function routeOffers({ req, res, url, db, config, session }) {
  if (await routeCustomerTransactionalEmails({req,res,url,db,config,session})) return true;
  if (await routeOrderConfirmationAlerts({req,res,url,db,config,session})) return true;
  if (await routeCustomerRelationships({ req, res, url, db, config, session })) return true;
  if (req.method === "GET" && url.pathname === "/api/notifications") {
    const user = requireUser(session), permitsOffers = Boolean(db.prepare("SELECT COALESCE(mp.in_app_promotions,u.merchant_offers,0) allowed FROM users u LEFT JOIN marketing_preferences mp ON mp.user_id=u.id WHERE u.id=?").get(user.id)?.allowed);
    const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 100, before = url.searchParams.get("before"), beforeId = url.searchParams.get("beforeId");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (before && Number.isNaN(Date.parse(before))) || (beforeId && (!before || beforeId.length > 100))) throw new HttpError(400,"VALIDATION_ERROR","Notification pagination is invalid");
    const params = { uid: user.id, role: user.role, permitsOffers: Number(permitsOffers) };
    const allowed = `user_id=$uid AND (type<>'offer' OR $permitsOffers=1)
      AND ($role<>'restaurant' OR restaurant_id IS NULL OR EXISTS(SELECT 1 FROM restaurant_memberships mm WHERE mm.restaurant_id=user_notifications.restaurant_id AND mm.user_id=$uid))
      AND (type<>'customer_message' OR EXISTS(SELECT 1 FROM restaurant_customer_threads t WHERE t.id=user_notifications.conversation_id AND (t.customer_id=$uid OR EXISTS(SELECT 1 FROM restaurant_memberships cm WHERE cm.restaurant_id=t.restaurant_id AND cm.user_id=$uid AND cm.permission='owner'))))
      AND (type<>'order_message' OR EXISTS(SELECT 1 FROM orders o WHERE o.id=user_notifications.order_id AND (o.customer_id=$uid OR EXISTS(SELECT 1 FROM restaurant_memberships om WHERE om.restaurant_id=o.restaurant_id AND om.user_id=$uid))))
      AND (support_case_id IS NULL OR EXISTS(SELECT 1 FROM support_cases sc WHERE sc.id=user_notifications.support_case_id AND (sc.user_id=$uid OR $role='admin' OR ($role='restaurant' AND EXISTS(SELECT 1 FROM restaurant_memberships sm WHERE sm.restaurant_id=sc.restaurant_id AND sm.user_id=$uid)))))`;
    const cursor = before ? " AND (created_at<$before OR (created_at=$before AND id<$beforeId))" : "";
    const rows = db.prepare(`SELECT * FROM user_notifications WHERE ${allowed}${cursor} ORDER BY created_at DESC,id DESC LIMIT $limit`).all({ ...params, ...(before ? { before, beforeId: beforeId ?? "~" } : {}), limit: limit + 1 });
    const hasMore = rows.length > limit, selected = rows.slice(0, limit), oldest = selected.at(-1);
    const unreadCount = db.prepare(`SELECT COUNT(*) n FROM user_notifications WHERE ${allowed} AND read_at IS NULL`).get(params).n;
    const unreadMessageCount = db.prepare(`SELECT COUNT(*) n FROM user_notifications WHERE ${allowed} AND read_at IS NULL AND type IN ('order_message','customer_message')`).get(params).n;
    const unreadSupportCount = db.prepare(`SELECT COUNT(*) n FROM user_notifications WHERE ${allowed} AND read_at IS NULL AND support_case_id IS NOT NULL`).get(params).n;
    return sendJson(res, 200, { data: { items: selected.map(notificationDto), unreadCount, unreadMessageCount, unreadSupportCount, nextCursor: hasMore ? { before: oldest.created_at, beforeId: oldest.id } : null } });
  }
  let match = url.pathname.match(/^\/api\/notifications\/([^/]+)$/);
  if (match && req.method === "PATCH") {
    const user = requireUser(session); const body = await readJson(req, config.bodyLimit); exactObject(body, ["read"]);
    if (body.read !== true) throw new HttpError(400, "VALIDATION_ERROR", "read must be true");
    const row = db.prepare("SELECT * FROM user_notifications WHERE id=? AND user_id=?").get(match[1], user.id); if (!row) throw new HttpError(404, "NOT_FOUND", "Resource not found");
    if (!notificationRecipientAllowed(db, row)) throw new HttpError(404, "NOT_FOUND", "Resource not found");
    db.prepare("UPDATE user_notifications SET read_at=COALESCE(read_at,?) WHERE id=?").run(config.now().toISOString(), row.id);
    return sendJson(res, 200, { data: notificationDto(db.prepare("SELECT * FROM user_notifications WHERE id=?").get(row.id)) });
  }
  match = url.pathname.match(/^\/api\/restaurant\/restaurants\/([^/]+)\/offers$/);
  if (match && req.method === "GET") { requireRestaurantOwner(db, session, match[1]); return sendJson(res, 200, { data: db.prepare("SELECT * FROM offer_campaigns WHERE restaurant_id=? ORDER BY created_at DESC").all(match[1]).map((row) => campaignDto(db, row)) }); }
  if (match && req.method === "POST") return createCampaign({ req, res, db, config, session, restaurantId: match[1] });
  if (req.method === "GET" && url.pathname === "/api/offers") {
    return customerOffers({res,url,db,config,user:requireRole(session,"customer")});
  }
  match = url.pathname.match(/^\/api\/offers\/([^/]+)$/);
  if(match&&req.method==="GET"){
    const user=requireRole(session,"customer"),row=db.prepare(`${grantSelect} WHERE g.id=? AND g.customer_id=? AND g.dismissed_at IS NULL`).get(match[1],user.id);
    if(!row)throw new HttpError(404,"NOT_FOUND","Offer is unavailable");
    const allowed=db.prepare("SELECT COALESCE(mp.in_app_promotions,u.merchant_offers,0) allowed FROM users u LEFT JOIN marketing_preferences mp ON mp.user_id=u.id WHERE u.id=?").get(user.id)?.allowed;if(!allowed)throw new HttpError(409,"MARKETING_CONSENT_WITHDRAWN","Promotion is unavailable because marketing consent is off");
    return sendJson(res,200,{data:grantDto(row,config.now().toISOString())});
  }
  if (match && req.method === "PATCH") {
    const user = requireRole(session, "customer"); const body = await readJson(req, config.bodyLimit); exactObject(body, ["viewed","dismissed"]);
    if((body.viewed===true?1:0)+(body.dismissed===true?1:0)!==1||Object.keys(body).length!==1)throw new HttpError(400,"VALIDATION_ERROR","Set either viewed or dismissed to true");
    if(body.dismissed===true){
      const result=withTransaction(db,()=>{const row=db.prepare("SELECT * FROM offer_grants WHERE id=? AND customer_id=?").get(match[1],user.id);if(!row)throw new HttpError(404,"NOT_FOUND","Resource not found");if(row.status==="reserved")throw new HttpError(409,"OFFER_IN_ORDER","This offer is attached to an order. It can be removed after that order is resolved.");const now=config.now().toISOString();db.prepare("UPDATE offer_grants SET dismissed_at=COALESCE(dismissed_at,?),updated_at=? WHERE id=? AND customer_id=?").run(now,now,row.id,user.id);db.prepare("UPDATE user_notifications SET read_at=COALESCE(read_at,?) WHERE user_id=? AND offer_id=?").run(now,user.id,row.id);return{id:row.id,dismissed:true};});
      return sendJson(res,200,{data:result});
    }
    const permitted = Boolean(db.prepare("SELECT COALESCE(mp.in_app_promotions,u.merchant_offers,0) allowed FROM users u LEFT JOIN marketing_preferences mp ON mp.user_id=u.id WHERE u.id=?").get(user.id)?.allowed); if (!permitted) throw new HttpError(409, "MARKETING_CONSENT_WITHDRAWN", "Promotion is unavailable because marketing consent is off");
    const row = db.prepare("SELECT * FROM offer_grants WHERE id=? AND customer_id=? AND dismissed_at IS NULL").get(match[1], user.id); if (!row) throw new HttpError(404, "NOT_FOUND", "Resource not found");
    db.prepare("UPDATE offer_grants SET viewed_at=COALESCE(viewed_at,?),updated_at=? WHERE id=?").run(config.now().toISOString(), config.now().toISOString(), row.id);
    const joined = db.prepare("SELECT g.*,c.title,c.message,c.menu_item_id,c.item_name,c.item_value_minor,c.min_subtotal_minor,c.expires_at,c.offer_type,c.offer_value,c.starts_at,c.eligible_item_ids,c.eligible_categories,c.stacking_policy,c.funding_party,c.recipient_segment,c.campaign_type,c.campaign_rules,c.weekly_budget_minor,r.name restaurant_name FROM offer_grants g JOIN offer_campaigns c ON c.id=g.campaign_id JOIN restaurants r ON r.id=g.restaurant_id WHERE g.id=?").get(row.id);
    return sendJson(res, 200, { data: grantDto(joined, config.now().toISOString()) });
  }
  return false;
}

async function createCampaign({ req, res, db, config, session, restaurantId }) {
  const user = requireRestaurantOwner(db, session, restaurantId); const key = clean(req.headers["idempotency-key"], 1, 100, "Idempotency-Key");
  const body = await readJson(req, config.bodyLimit); exactObject(body, ["customerIds", "title", "message", "menuItemId", "minSubtotalMinor", "expiresInDays"]);
  if (!Array.isArray(body.customerIds) || body.customerIds.length < 1 || body.customerIds.length > 100 || new Set(body.customerIds).size !== body.customerIds.length || body.customerIds.some((id) => typeof id !== "string" || !id)) throw new HttpError(400, "VALIDATION_ERROR", "Recipients are invalid");
  if (!Number.isSafeInteger(body.minSubtotalMinor) || body.minSubtotalMinor < 0 || body.minSubtotalMinor > 100000 || !Number.isInteger(body.expiresInDays) || body.expiresInDays < 1 || body.expiresInDays > 90) throw new HttpError(400, "VALIDATION_ERROR", "Offer terms are invalid");
  const normalized = { customerIds: [...body.customerIds].sort(), title: clean(body.title, 1, 80, "Title"), message: clean(body.message, 1, 500, "Message"), menuItemId: clean(body.menuItemId, 1, 100, "Menu item"), minSubtotalMinor: body.minSubtotalMinor, expiresInDays: body.expiresInDays };
  const hash = fingerprint({ restaurantId, ...normalized }); const prior = db.prepare("SELECT * FROM offer_campaigns WHERE created_by_user_id=? AND idempotency_key=?").get(user.id, key);
  if (prior) { if (prior.request_hash !== hash) throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was already used for another request"); return sendJson(res, 200, { data: campaignDto(db, prior) }); }
  const created = withTransaction(db, () => {
    const existing = db.prepare("SELECT * FROM offer_campaigns WHERE created_by_user_id=? AND idempotency_key=?").get(user.id, key);
    if (existing) { if (existing.request_hash !== hash) throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was already used for another request"); return { row: existing, replay: true }; }
    const item = db.prepare("SELECT * FROM menu_items WHERE id=? AND restaurant_id=? AND available=1").get(normalized.menuItemId, restaurantId);
    if (!item) throw new HttpError(409, "MENU_UNAVAILABLE", "Offer item is unavailable");
    if (JSON.parse(item.modifier_groups ?? "[]").some((group) => group.minSelections > 0)) throw new HttpError(409, "OFFER_ITEM_REQUIRES_MODIFIERS", "Offer item cannot require modifiers");
    const eligible = new Set(db.prepare(`SELECT DISTINCT o.customer_id FROM orders o JOIN users u ON u.id=o.customer_id WHERE o.restaurant_id=? AND o.status='completed' AND u.merchant_offers=1 AND o.customer_id IN (${normalized.customerIds.map(() => "?").join(",")})`).all(restaurantId, ...normalized.customerIds).map((row) => row.customer_id));
    if (eligible.size !== normalized.customerIds.length) throw new HttpError(409, "RECIPIENT_NOT_ELIGIBLE", "Every recipient must allow offers and have a completed order at this restaurant");
    const nowDate = config.now(); const now = nowDate.toISOString(); const id = randomUUID(); const expiresAt = new Date(nowDate.getTime() + normalized.expiresInDays * 86400000).toISOString();
    db.prepare("INSERT INTO offer_campaigns(id,restaurant_id,created_by_user_id,idempotency_key,request_hash,title,message,menu_item_id,item_name,item_value_minor,min_subtotal_minor,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, restaurantId, user.id, key, hash, normalized.title, normalized.message, item.id, item.name, item.price_minor, normalized.minSubtotalMinor, expiresAt, now);
    for (const customerId of normalized.customerIds) { const grantId = randomUUID(); db.prepare("INSERT INTO offer_grants(id,campaign_id,restaurant_id,customer_id,status,viewed_at,reserved_order_id,redeemed_order_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(grantId, id, restaurantId, customerId, "available", null, null, null, now, now); addNotification(db, { userId: customerId, type: "offer", title: normalized.title, message: normalized.message, offerId: grantId, restaurantId, eventKey: `offer:${grantId}:issued`, now }); }
    db.prepare("INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)").run(randomUUID(), user.id, "offer_campaign", id, "offer_campaign_created", JSON.stringify({ recipientCount: normalized.customerIds.length }), now);
    return { row: db.prepare("SELECT * FROM offer_campaigns WHERE id=?").get(id), replay: false };
  });
  return sendJson(res, created.replay ? 200 : 201, { data: campaignDto(db, created.row) });
}
