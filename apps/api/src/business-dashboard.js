import { requireRestaurantMembership } from "./auth/authorization.js";
import { HttpError, sendJson } from "./http.js";
import { buildFinanceSummary, parseLondonDateRange } from "./marketplace-reporting.js";
import { PAYABLE_ORDER_SQL } from "./order-confirmation.js";

const CONFIRMED = "'accepted','preparing','ready','out_for_delivery','completed'";
const recognized = (alias = "o") => `${alias}.status IN (${CONFIRMED}) AND (${alias}.payment_method<>'card' OR ${alias}.payment_status IN ('stripe_captured','stripe_partially_refunded','stripe_refunded'))`;
const dateInLondon = now => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};
const shiftDate = (date, days) => { const stamp = new Date(`${date}T12:00:00.000Z`); stamp.setUTCDate(stamp.getUTCDate() + days); return stamp.toISOString().slice(0, 10); };

export function dashboardRange(period = "today", now = new Date()) {
  if (!["today", "yesterday", "this_week", "last_week"].includes(period)) throw new HttpError(400, "VALIDATION_ERROR", "Dashboard period is invalid");
  const today = dateInLondon(now), day = new Date(`${today}T12:00:00.000Z`).getUTCDay(), monday = shiftDate(today, -((day + 6) % 7));
  const fromDate = period === "today" ? today : period === "yesterday" ? shiftDate(today, -1) : period === "this_week" ? monday : shiftDate(monday, -7);
  const toDate = period === "yesterday" ? fromDate : period === "last_week" ? shiftDate(monday, -1) : today;
  const range = parseLondonDateRange(new URL(`http://dashboard.local/?from=${fromDate}&to=${toDate}`));
  return { period, label: { today: "Today", yesterday: "Yesterday", this_week: "This week", last_week: "Last week" }[period], fromDate, toDate, ...range, timeZone: "Europe/London", basis: "order_created_at", weekStartsOn: "monday" };
}

function pageValue(value, fallback, maximum) {
  if (value === null) return fallback;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) throw new HttpError(400, "VALIDATION_ERROR", "Dashboard pagination is invalid");
  return Number(value);
}

export function comparisonRange(range) {
  const fromDate = shiftDate(range.fromDate, -7), toDate = shiftDate(range.toDate, -7);
  return { fromDate, toDate, ...parseLondonDateRange(new URL(`http://dashboard.local/?from=${fromDate}&to=${toDate}`)) };
}
function growth(current, previous) { return previous ? Math.round((current - previous) / previous * 1000) / 10 : current ? null : 0; }
function dashboardInsights(db, restaurantId, range, now) {
  const previous = comparisonRange(range), previousFinance = periodFinance(db, restaurantId, previous), currentFinance = periodFinance(db, restaurantId, range);
  const previousOrders = db.prepare("SELECT COUNT(*) n FROM orders WHERE restaurant_id=? AND created_at>=? AND created_at<?").get(restaurantId, previous.from, previous.toExclusive).n;
  const currentOrders = db.prepare("SELECT COUNT(*) n FROM orders WHERE restaurant_id=? AND created_at>=? AND created_at<?").get(restaurantId, range.from, range.toExclusive).n;
  const marketing = db.prepare(`SELECT COUNT(*) AS offerOrders,COALESCE(SUM(o.total_minor),0) AS offerSalesMinor,COALESCE(SUM(o.restaurant_discount_minor),0) AS discountMinor FROM orders o WHERE o.restaurant_id=? AND o.created_at>=? AND o.created_at<? AND ${recognized()} AND (o.offer_grant_id IS NOT NULL OR o.promotion_snapshot IS NOT NULL)`).get(restaurantId, range.from, range.toExclusive);
  const activeOffers = db.prepare("SELECT COUNT(*) n FROM offer_campaigns WHERE restaurant_id=? AND expires_at>?").get(restaurantId, now).n;
  return { comparison: { fromDate: previous.fromDate, toDate: previous.toDate, salesChangePercent: growth(currentFinance.grossSalesMinor, previousFinance.grossSalesMinor), ordersChangePercent: growth(currentOrders, previousOrders), previousOrders, previousSalesMinor: previousFinance.grossSalesMinor }, marketing: { ...marketing, activeOffers, basis: "confirmed_orders_before_refunds" } };
}

function operationalCounts(db, restaurantId, userId, owner, now) {
  const pending = db.prepare(`SELECT COUNT(*) AS pending,SUM(CASE WHEN o.confirmation_due_at<=? THEN 1 ELSE 0 END) AS overdue FROM orders o WHERE o.restaurant_id=? AND o.status='placed' AND o.confirmed_at IS NULL AND o.merchant_visible_at IS NOT NULL AND ${PAYABLE_ORDER_SQL}`).get(now, restaurantId);
  const active = db.prepare(`SELECT COUNT(*) AS count FROM orders o WHERE o.restaurant_id=? AND (o.status IN ('accepted','preparing','ready','out_for_delivery') OR (o.status='placed' AND o.merchant_visible_at IS NOT NULL AND ${PAYABLE_ORDER_SQL}))`).get(restaurantId).count;
  const kitchen = db.prepare(`SELECT COUNT(*) AS liveOrders,COALESCE(SUM(CASE WHEN o.status IN ('accepted','preparing') THEN 1 ELSE 0 END),0) AS confirmedInKitchen,COALESCE(SUM(CASE WHEN o.status='ready' THEN 1 ELSE 0 END),0) AS readyForHandover FROM orders o WHERE o.restaurant_id=? AND (o.status IN ('accepted','preparing','ready') OR (o.status='placed' AND o.merchant_visible_at IS NOT NULL AND ${PAYABLE_ORDER_SQL}))`).get(restaurantId);
  const orderMessages = db.prepare(`SELECT COUNT(*) AS count FROM order_messages m JOIN orders o ON o.id=m.order_id LEFT JOIN order_message_reads r ON r.order_id=m.order_id AND r.user_id=? WHERE o.restaurant_id=? AND m.sender_role='customer' AND m.expires_at>? AND (r.order_id IS NULL OR m.created_at>r.last_read_created_at OR (m.created_at=r.last_read_created_at AND m.id>r.last_read_message_id))`).get(userId, restaurantId, now).count;
  const customerMessages = owner ? db.prepare(`SELECT COUNT(*) AS count FROM restaurant_customer_messages m JOIN restaurant_customer_threads t ON t.id=m.thread_id LEFT JOIN restaurant_customer_message_reads r ON r.thread_id=m.thread_id AND r.user_id=? WHERE t.restaurant_id=? AND m.sender_role='customer' AND m.expires_at>? AND m.ingest_sequence>COALESCE(r.last_read_sequence,0)`).get(userId, restaurantId, now).count : 0;
  return {
    pendingConfirmation: pending.pending, overdueConfirmation: pending.overdue ?? 0, activeOrders: active, ...kitchen,
    unreadMessages: orderMessages + customerMessages,
    openRefundCases: owner ? db.prepare("SELECT COUNT(*) AS count FROM refund_cases WHERE restaurant_id=? AND resolved_at IS NULL AND status NOT IN ('refunded','rejected')").get(restaurantId).count : null
  };
}

function periodFinance(db, restaurantId, range) {
  const row = db.prepare(`WITH scoped AS (
    SELECT o.*,
      COALESCE((SELECT SUM(food_amount_minor+delivery_amount_minor) FROM refunds WHERE order_id=o.id),0) AS refund_minor,
      COALESCE((SELECT SUM(commission_reversal_minor) FROM refunds WHERE order_id=o.id),0) AS reversal_minor
    FROM orders o WHERE o.restaurant_id=? AND o.created_at>=? AND o.created_at<? AND ${recognized()}
  ) SELECT COUNT(*) AS count,COALESCE(SUM(total_minor),0) AS gross,COALESCE(SUM(refund_minor),0) AS refunds,
    COALESCE(SUM(MAX(0,commission_minor-reversal_minor)),0) AS commission,
    COALESCE(SUM(MAX(0,total_minor-refund_minor-MAX(0,commission_minor-reversal_minor))),0) AS net,
    COALESCE(SUM(CASE WHEN payment_method='cash' THEN total_minor ELSE 0 END),0) AS cash,
    COALESCE(SUM(CASE WHEN payment_method='cash' AND status='completed' AND payment_status='cash_collected' THEN total_minor ELSE 0 END),0) AS collected,
    COALESCE(SUM(CASE WHEN payment_method<>'cash' THEN total_minor ELSE 0 END),0) AS card FROM scoped`).get(restaurantId, range.from, range.toExclusive);
  return { grossSalesMinor: row.gross, refundsMinor: row.refunds, commissionMinor: row.commission, netEarningsMinor: row.net, cashSalesMinor: row.cash, cashCollectedMinor: row.collected, cardSalesMinor: row.card, averageOrderMinor: row.count ? Math.round(row.gross / row.count) : 0 };
}

function payoutState(db, order, net, providerMode) {
  if (!["accepted", "preparing", "ready", "out_for_delivery", "completed"].includes(order.status) || (order.payment_method === "card" && !["stripe_captured", "stripe_partially_refunded", "stripe_refunded"].includes(order.payment_status))) return { payoutState: "not_confirmed", payoutLabel: "No earnings confirmed" };
  if (net === 0) return { payoutState: "no_net_earnings", payoutLabel: "No net earnings remaining" };
  if (order.payment_method === "cash") return order.payment_status === "cash_collected" ? { payoutState: "cash_direct", payoutLabel: "Cash received by restaurant" } : { payoutState: "cash_due", payoutLabel: "Cash due to restaurant" };
  if (order.payment_method === "mock_card") return { payoutState: "simulated", payoutLabel: "Test payment · no bank payout" };
  const prefix = providerMode === "stripe_live" ? "" : "Test · ";
  const transfers = db.prepare("SELECT kind,status,amount_minor FROM marketplace_operations WHERE restaurant_id=? AND order_id=? AND kind IN ('merchant_transfer','transfer_reversal')").all(order.restaurant_id, order.id);
  const transferred = transfers.filter(row => row.kind === "merchant_transfer" && row.status === "confirmed").reduce((sum, row) => sum + row.amount_minor, 0) - transfers.filter(row => row.kind === "transfer_reversal" && row.status === "confirmed").reduce((sum, row) => sum + row.amount_minor, 0);
  if (transfers.some(row => row.status === "unknown")) return { payoutState: "needs_review", payoutLabel: `${prefix}transfer needs review` };
  if (transferred > 0) return { payoutState: "transferred_to_balance", payoutLabel: `${prefix}transferred to Stripe balance` };
  if (transfers.some(row => row.status === "held") || db.prepare("SELECT 1 FROM refund_cases WHERE order_id=? AND resolved_at IS NULL AND status NOT IN ('refunded','rejected') LIMIT 1").get(order.id)) return { payoutState: "held", payoutLabel: `${prefix}transfer on hold` };
  if (transfers.some(row => ["pending", "delayed"].includes(row.status))) return { payoutState: "processing", payoutLabel: `${prefix}transfer processing` };
  return order.status === "completed" ? { payoutState: "pending_transfer", payoutLabel: `${prefix}awaiting transfer` } : { payoutState: "awaiting_completion", payoutLabel: `${prefix}awaiting order completion` };
}

function orderRows(db, restaurantId, range, owner, page, pageSize) {
  const total = db.prepare("SELECT COUNT(*) AS count FROM orders WHERE restaurant_id=? AND created_at>=? AND created_at<?").get(restaurantId, range.from, range.toExclusive).count;
  const rows = db.prepare(`SELECT o.*,
    COALESCE((SELECT SUM(food_amount_minor+delivery_amount_minor) FROM refunds WHERE order_id=o.id),0) AS refund_minor,
    COALESCE((SELECT SUM(commission_reversal_minor) FROM refunds WHERE order_id=o.id),0) AS reversal_minor,
    (SELECT provider_mode FROM stripe_order_payments WHERE order_id=o.id) AS provider_mode
    FROM orders o WHERE o.restaurant_id=? AND o.created_at>=? AND o.created_at<? ORDER BY o.created_at DESC,o.id DESC LIMIT ? OFFSET ?`).all(restaurantId, range.from, range.toExclusive, pageSize, (page - 1) * pageSize);
  const items = rows.map(order => {
    const base = { id: order.id, createdAt: order.created_at, customerName: order.customer_name, status: order.status, fulfillment: order.fulfillment };
    if (!owner) return base;
    const confirmed = ["accepted", "preparing", "ready", "out_for_delivery", "completed"].includes(order.status) && (order.payment_method !== "card" || ["stripe_captured", "stripe_partially_refunded", "stripe_refunded"].includes(order.payment_status));
    const commission = confirmed ? Math.max(0, order.commission_minor - order.reversal_minor) : 0, net = confirmed ? Math.max(0, order.total_minor - order.refund_minor - commission) : 0;
    const providerMode = order.provider_mode ?? "local_simulator";
    return { ...base, totalMinor: order.total_minor, refundsMinor: order.refund_minor, commissionMinor: commission, netEarningsMinor: net, paymentMethod: order.payment_method, paymentState: order.payment_status, providerMode, ...payoutState(db, order, net, providerMode) };
  });
  return { items, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
}

export async function routeBusinessDashboard({ req, res, url, db, config, session }) {
  const match = url.pathname.match(/^\/api\/restaurant\/restaurants\/([^/]+)\/dashboard$/);
  if (req.method !== "GET" || !match) return false;
  const restaurantId = match[1], user = requireRestaurantMembership(db, session, restaurantId);
  const permission = db.prepare("SELECT permission FROM restaurant_memberships WHERE restaurant_id=? AND user_id=?").get(restaurantId, user.id).permission, owner = permission === "owner";
  const view = url.searchParams.get("view") ?? "full";
  if (!["full", "operations"].includes(view)) throw new HttpError(400, "VALIDATION_ERROR", "Dashboard view is invalid");
  const includeFinance = owner && view === "full";
  const now = config.now(), range = dashboardRange(url.searchParams.get("period") ?? "today", now), page = pageValue(url.searchParams.get("page"), 1, 1000000), pageSize = pageValue(url.searchParams.get("pageSize"), 20, 100);
  const summary = db.prepare(`SELECT COUNT(*) AS ordersPlaced,COALESCE(SUM(CASE WHEN ${recognized()} THEN 1 ELSE 0 END),0) AS confirmedOrders,COALESCE(SUM(CASE WHEN o.status='completed' THEN 1 ELSE 0 END),0) AS completedOrders,COALESCE(SUM(CASE WHEN o.status IN ('rejected','cancelled','expired') THEN 1 ELSE 0 END),0) AS cancelledOrders FROM orders o WHERE o.restaurant_id=? AND o.created_at>=? AND o.created_at<?`).get(restaurantId, range.from, range.toExclusive);
  const topItems = db.prepare(`SELECT i.name,SUM(i.quantity) AS quantity FROM order_items i JOIN orders o ON o.id=i.order_id WHERE o.restaurant_id=? AND o.created_at>=? AND o.created_at<? AND ${recognized()} GROUP BY i.name ORDER BY quantity DESC,i.name LIMIT 5`).all(restaurantId, range.from, range.toExclusive);
  let finance = null;
  if (includeFinance) {
    const balance = buildFinanceSummary(db, restaurantId);
    finance = { period: periodFinance(db, restaurantId, range), balance: { basis: "all_time", availableMinor: balance.availableMinor, pendingMinor: balance.pendingMinor, heldMinor: balance.heldMinor, bankPaidMinor: balance.bankPaidMinor, bankPendingMinor: balance.bankPendingMinor, nextPayout: balance.nextPayout, providerMode: balance.providerMode, cashCommissionOutstandingMinor: balance.cashCommissionOutstandingMinor } };
  }
  return sendJson(res, 200, { data: { restaurantId, permission, currency: "GBP", generatedAt: now.toISOString(), range, summary, operations: operationalCounts(db, restaurantId, user.id, owner, now.toISOString()), finance, ...(includeFinance ? dashboardInsights(db,restaurantId,range,now.toISOString()) : {}), topItems, orders: orderRows(db, restaurantId, range, includeFinance, page, pageSize) } });
}
