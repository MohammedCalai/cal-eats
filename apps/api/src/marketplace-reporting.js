import { HttpError } from "./http.js";

const LONDON = "Europe/London";
const ORDER_STATES = new Set(["accepted", "preparing", "ready", "out_for_delivery", "completed"]);

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function nextDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + 1));
  return date.toISOString().slice(0, 10);
}

function londonMidnight(value) {
  const [year, month, day] = value.split("-").map(Number);
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: LONDON, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  });
  const target = Date.UTC(year, month - 1, day);
  let instant = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    const correction = target - represented;
    instant += correction;
    if (correction === 0) break;
  }
  return new Date(instant).toISOString();
}

export function parseLondonDateRange(url) {
  const from = url?.searchParams?.get("from") || null;
  const to = url?.searchParams?.get("to") || null;
  if ((from && !validDate(from)) || (to && !validDate(to)) || (from && to && from > to)) {
    throw new HttpError(400, "VALIDATION_ERROR", "Date range is invalid");
  }
  return {
    from: from ? londonMidnight(from) : null,
    toExclusive: to ? londonMidnight(nextDate(to)) : null
  };
}

export function inDateRange(row, range) {
  return (!range.from || row.created_at >= range.from) && (!range.toExclusive || row.created_at < range.toExclusive);
}

function refundTotals(db, orderId) {
  return db.prepare("SELECT COALESCE(SUM(food_amount_minor+delivery_amount_minor),0) amount, COALESCE(SUM(commission_reversal_minor),0) reversal FROM refunds WHERE order_id=?").get(orderId);
}

function orderNet(db, order) {
  const refunds = refundTotals(db, order.id);
  const commission = Math.max(0, order.commission_minor - refunds.reversal);
  return { refunds: refunds.amount, commission, net: Math.max(0, order.total_minor - refunds.amount - commission) };
}

export function buildFinanceSummary(db, restaurantId, url = null) {
  const range = parseLondonDateRange(url);
  const allOrders = db.prepare("SELECT * FROM orders WHERE restaurant_id=?").all(restaurantId).filter((row) => ORDER_STATES.has(row.status));
  const rangedOrders = allOrders.filter((row) => inDateRange(row, range));
  const rangedRefunds = db.prepare("SELECT r.* FROM refunds r JOIN orders o ON o.id=r.order_id WHERE o.restaurant_id=?").all(restaurantId).filter((row) => inDateRange(row, range));
  const rangedOperations = db.prepare("SELECT * FROM marketplace_operations WHERE restaurant_id=?").all(restaurantId).filter((row) => inDateRange(row, range));
  const recordedOrderIds = new Set(db.prepare("SELECT order_id FROM marketplace_operations WHERE restaurant_id=? AND kind IN ('payment_capture','cash_order_accepted') AND order_id IS NOT NULL").all(restaurantId).map((row) => row.order_id));
  const historicalOrderIds = new Set(allOrders.filter((row) => !recordedOrderIds.has(row.id)).map((row) => row.id));
  const historicalOrders = rangedOrders.filter((row) => historicalOrderIds.has(row.id));
  const historicalGrossSalesMinor = historicalOrders.reduce((sum, row) => sum + row.total_minor, 0);
  const historicalRefundsMinor = rangedRefunds.filter((row) => historicalOrderIds.has(row.order_id)).reduce((sum, row) => sum + row.food_amount_minor + row.delivery_amount_minor, 0);
  const historicalCommissionMinor = historicalOrders.reduce((sum, row) => sum + row.commission_minor, 0)
    - rangedRefunds.filter((row) => historicalOrderIds.has(row.order_id)).reduce((sum, row) => sum + row.commission_reversal_minor, 0);
  const recordedCommissionReversalsMinor = rangedRefunds.filter((row) => !historicalOrderIds.has(row.order_id)).reduce((sum, row) => sum + row.commission_reversal_minor, 0);

  const grossSalesMinor = historicalGrossSalesMinor + rangedOperations.filter((row) => ["payment_capture", "cash_order_accepted"].includes(row.kind) && row.status === "confirmed").reduce((sum, row) => sum + row.amount_minor, 0);
  const refundsMinor = rangedRefunds.reduce((sum, row) => sum + row.food_amount_minor + row.delivery_amount_minor, 0);
  const commissionMinor = historicalCommissionMinor + rangedOperations.filter((row) => ["commission", "cash_commission_receivable"].includes(row.kind) && row.status === "confirmed").reduce((sum, row) => sum + row.amount_minor, 0)
    - recordedCommissionReversalsMinor;
  const providerCostMinor = rangedOperations.filter((row) => row.kind === "provider_cost" && row.status === "confirmed").reduce((sum, row) => sum + row.amount_minor, 0);
  const paidTransfersMinor = db.prepare("SELECT COALESCE(SUM(amount_minor),0) n FROM payout_batches WHERE restaurant_id=? AND status='paid'").get(restaurantId).n;
  const inTransitTransfersMinor = db.prepare("SELECT COALESCE(SUM(amount_minor),0) n FROM payout_batches WHERE restaurant_id=? AND status='in_transit'").get(restaurantId).n;
  const successfulCollectionsMinor = db.prepare("SELECT COALESCE(SUM(amount_minor),0) n FROM cash_collections WHERE restaurant_id=? AND status='succeeded'").get(restaurantId).n;
  const completedCardNet = allOrders.filter((row) => row.payment_method !== "cash" && row.status === "completed").reduce((sum, row) => sum + orderNet(db, row).net, 0);
  const pendingMinor = allOrders.filter((row) => row.payment_method !== "cash" && row.status !== "completed").reduce((sum, row) => sum + orderNet(db, row).net, 0);
  const cashCommission = allOrders.filter((row) => row.payment_method === "cash").reduce((sum, row) => sum + orderNet(db, row).commission, 0);
  const heldOrders = allOrders.filter((row) => {
    const operation = db.prepare("SELECT status FROM marketplace_operations WHERE operation_key=?").get(`order:${row.id}:settlement-eligible`);
    return operation?.status === "held";
  });
  const heldMinor = heldOrders.reduce((sum, row) => sum + orderNet(db, row).net, 0);
  const heldCardMinor = heldOrders.filter((row) => row.payment_method !== "cash").reduce((sum, row) => sum + orderNet(db, row).net, 0);
  const next = db.prepare("SELECT * FROM payout_batches WHERE restaurant_id=? AND status IN ('scheduled','pending') ORDER BY scheduled_for LIMIT 1").get(restaurantId);

  return {
    restaurantId, currency: "GBP", providerMode: "local_simulator",
    grossSalesMinor,
    commissionMinor,
    historicalGrossSalesMinor,
    historicalCommissionMinor,
    historicalNetEarningsMinor: historicalGrossSalesMinor - historicalRefundsMinor - historicalCommissionMinor,
    refundsMinor,
    adjustmentsMinor: 0,
    netEarningsMinor: grossSalesMinor - refundsMinor - commissionMinor,
    cashCollectedMinor: rangedOperations.filter((row) => row.kind === "cash_sale_recorded" && row.status === "held").reduce((sum, row) => sum + row.amount_minor, 0),
    cashCommissionOutstandingMinor: Math.max(0, cashCommission - successfulCollectionsMinor),
    pendingMinor,
    availableMinor: Math.max(0, completedCardNet - heldCardMinor - paidTransfersMinor - inTransitTransfersMinor),
    heldMinor,
    providerCostMinor,
    paidTransfersMinor,
    inTransitTransfersMinor,
    nextPayout: next ? { scheduledFor: next.scheduled_for, estimatedAmountMinor: next.amount_minor, status: next.status } : null
  };
}

const csvCell = (value) => {
  let content = String(value ?? "");
  if (/^[=+\-@]/.test(content)) content = `'${content}`;
  return `"${content.replaceAll('"', '""')}"`;
};
export function statementCsv(rows) {
  return ["operationKey,kind,status,amountMinor,currency,providerMode,createdAt", ...rows.map((row) => [row.operation_key, row.kind, row.status, row.amount_minor, row.currency, row.provider_mode, row.created_at].map(csvCell).join(","))].join("\r\n") + "\r\n";
}

function eventAudience(event) {
  let details = event.details;
  if (typeof details === "string") { try { details = JSON.parse(details); } catch { details = {}; } }
  if (details?.audience) return details.audience;
  if (event.kind === "internal_note" || event.kind === "customer_replied") return "admin";
  if (event.kind === "ask_restaurant") return "restaurant";
  if (event.kind === "request_information" || event.kind === "restaurant_replied") return "customer";
  return "public";
}

export function filterCaseCommunications({ messages = [], events = [], viewerRole }) {
  if (!new Set(["customer", "restaurant", "admin"]).has(viewerRole)) throw new TypeError("Unknown viewer role");
  const visible = (audience) => viewerRole === "admin" || audience === "public" || audience === "all" || audience === viewerRole;
  return {
    messages: messages.filter((message) => visible(message.audience ?? "public")),
    events: events.filter((event) => visible(eventAudience(event)))
  };
}
