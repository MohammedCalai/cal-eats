import { HttpError } from "./http.js";
import { financialEnvironmentScope, orderEnvironmentPredicate } from "./financial-environment.js";

export function resolveFinanceScope(config, url = null) {
  const current = financialEnvironmentScope(config), requested = url?.searchParams?.get("scope");
  if (!requested) return current;
  if (requested === "testing") return "testing";
  if (requested === "live" && current === "live") return "live";
  throw new HttpError(400, "VALIDATION_ERROR", "Financial history scope is invalid");
}
const aliasFor = alias => {
  if (typeof alias !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new TypeError("A valid financial SQL alias is required");
  return alias;
};
const scoped = (live, scope) => {
  if (!["live", "testing"].includes(scope)) throw new TypeError("A valid financial scope is required");
  return scope === "live" ? live : `NOT (${live})`;
};
export function operationFinancePredicate(alias, scope) {
  const a = aliasFor(alias);
  return scoped(`${a}.provider_mode='stripe_live' AND EXISTS(SELECT 1 FROM orders finance_order WHERE finance_order.id=${a}.order_id AND ${orderEnvironmentPredicate("finance_order", "live")})`, scope);
}
export function journalFinancePredicate(alias, scope) {
  return operationFinancePredicate(alias, scope);
}
export function payoutFinancePredicate(alias, scope) {
  const a = aliasFor(alias), liveOperation = operationFinancePredicate("finance_op", "live");
  return scoped(`${a}.provider_mode='stripe_live' AND EXISTS(SELECT 1 FROM payout_items finance_item WHERE finance_item.payout_id=${a}.id) AND NOT EXISTS(SELECT 1 FROM payout_items finance_item JOIN marketplace_operations finance_op ON finance_op.id=finance_item.operation_id WHERE finance_item.payout_id=${a}.id AND NOT (${liveOperation}))`, scope);
}
export function cashCollectionFinancePredicate(alias, scope) {
  const a = aliasFor(alias);
  return scoped(`${a}.provider_mode='stripe_live' AND EXISTS(SELECT 1 FROM marketplace_operations finance_op WHERE finance_op.operation_key=${a}.operation_key AND ${operationFinancePredicate("finance_op", "live")})`, scope);
}
function bankEvidence(alias, mode) {
  const a = aliasFor(alias);
  const event = `EXISTS(SELECT 1 FROM provider_events finance_event WHERE finance_event.provider='${mode}' AND finance_event.object_type='payout' AND finance_event.event_type LIKE 'payout.%' AND finance_event.object_id=${a}.id AND finance_event.provider_account_reference=${a}.provider_account_id AND finance_event.restaurant_id=${a}.restaurant_id AND finance_event.status='completed' AND finance_event.error IS NULL)`;
  const api = `EXISTS(SELECT 1 FROM stripe_payout_api_provenance finance_read WHERE finance_read.payout_id=${a}.id AND finance_read.restaurant_id=${a}.restaurant_id AND finance_read.provider_account_id=${a}.provider_account_id AND finance_read.provider_mode='${mode}' AND finance_read.amount_minor=${a}.amount_minor AND finance_read.currency='GBP' AND finance_read.source='stripe_payouts_api_read')`;
  return `(${event} OR ${api})`;
}
export function bankPayoutFinancePredicate(alias, scope) { return scoped(bankEvidence(alias, "stripe_live"), scope); }
export function bankPayoutProviderModeSql(alias) {
  return `CASE WHEN ${bankEvidence(alias,"stripe_live")} THEN 'stripe_live' WHEN ${bankEvidence(alias,"stripe_test")} THEN 'stripe_test' ELSE 'unknown' END`;
}

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

export function buildFinanceSummary(db, restaurantId, url = null, config = null) {
  const range = parseLondonDateRange(url), scope = resolveFinanceScope(config, url);
  const all = sql => db.prepare(sql).all(restaurantId);
  const allOrders = all(`SELECT o.* FROM orders o WHERE o.restaurant_id=? AND ${orderEnvironmentPredicate("o",scope)}`).filter(row => ORDER_STATES.has(row.status) && (row.payment_method !== "card" || ["stripe_captured","stripe_partially_refunded","stripe_refunded"].includes(row.payment_status)));
  const rangedOrders = allOrders.filter(row => inDateRange(row,range));
  const rangedRefunds = all(`SELECT r.* FROM refunds r JOIN orders o ON o.id=r.order_id WHERE o.restaurant_id=? AND ${orderEnvironmentPredicate("o",scope)}`).filter(row=>inDateRange(row,range));
  const operations = all(`SELECT m.* FROM marketplace_operations m WHERE m.restaurant_id=? AND ${operationFinancePredicate("m",scope)}`), rangedOperations = operations.filter(row=>inDateRange(row,range));
  const recordedOrderIds = new Set(operations.filter(row=>["payment_capture","cash_order_accepted"].includes(row.kind)&&row.order_id).map(row=>row.order_id));
  const historicalOrderIds = new Set(allOrders.filter(row=>!recordedOrderIds.has(row.id)).map(row=>row.id)), historicalOrders = rangedOrders.filter(row=>historicalOrderIds.has(row.id));
  const sum = rows => rows.reduce((total,row)=>total+row.amount_minor,0);
  const historicalGrossSalesMinor = historicalOrders.reduce((n,row)=>n+row.total_minor,0);
  const historicalRefundsMinor = rangedRefunds.filter(row=>historicalOrderIds.has(row.order_id)).reduce((n,row)=>n+row.food_amount_minor+row.delivery_amount_minor,0);
  const historicalCommissionMinor = historicalOrders.reduce((n,row)=>n+row.commission_minor,0)-rangedRefunds.filter(row=>historicalOrderIds.has(row.order_id)).reduce((n,row)=>n+row.commission_reversal_minor,0);
  const recordedCommissionReversalsMinor = rangedRefunds.filter(row=>!historicalOrderIds.has(row.order_id)).reduce((n,row)=>n+row.commission_reversal_minor,0);
  const grossSalesMinor = historicalGrossSalesMinor+sum(rangedOperations.filter(row=>["payment_capture","cash_order_accepted","platform_voucher_credit"].includes(row.kind)&&row.status==="confirmed"));
  const refundsMinor = rangedRefunds.reduce((n,row)=>n+row.food_amount_minor+row.delivery_amount_minor,0);
  const commissionMinor = historicalCommissionMinor+sum(rangedOperations.filter(row=>["commission","cash_commission_receivable"].includes(row.kind)&&row.status==="confirmed"))-recordedCommissionReversalsMinor;
  const providerCostMinor = sum(rangedOperations.filter(row=>row.kind==="provider_cost"&&row.status==="confirmed"));
  const stripeTransfers = operations.filter(row=>["merchant_transfer","transfer_reversal"].includes(row.kind)&&["stripe_test","stripe_live"].includes(row.provider_mode));
  const confirmedStripeTransfers = sum(stripeTransfers.filter(row=>row.kind==="merchant_transfer"&&row.status==="confirmed")), confirmedStripeReversals = sum(stripeTransfers.filter(row=>row.kind==="transfer_reversal"&&row.status==="confirmed"));
  const payouts = all(`SELECT p.* FROM payout_batches p WHERE p.restaurant_id=? AND ${payoutFinancePredicate("p",scope)}`);
  const paidTransfersMinor = sum(payouts.filter(row=>row.status==="paid"))+Math.max(0,confirmedStripeTransfers-confirmedStripeReversals);
  const pendingTransfersMinor = sum(stripeTransfers.filter(row=>row.kind==="merchant_transfer"&&["pending","unknown","delayed"].includes(row.status)));
  const inTransitTransfersMinor = sum(payouts.filter(row=>row.status==="in_transit"));
  const successfulCollectionsMinor = sum(all(`SELECT c.* FROM cash_collections c WHERE c.restaurant_id=? AND c.status='succeeded' AND ${cashCollectionFinancePredicate("c",scope)}`));
  const completedCardNet = allOrders.filter(row=>row.payment_method!=="cash"&&row.status==="completed").reduce((n,row)=>n+orderNet(db,row).net,0);
  const pendingMinor = allOrders.filter(row=>row.payment_method!=="cash"&&row.status!=="completed").reduce((n,row)=>n+orderNet(db,row).net,0);
  const cashCommission = allOrders.filter(row=>row.payment_method==="cash").reduce((n,row)=>n+orderNet(db,row).commission,0);
  const heldOrders = allOrders.filter(row=>{
    const operation=db.prepare("SELECT status FROM marketplace_operations WHERE operation_key=?").get(`order:${row.id}:settlement-eligible`);
    if(operation?.status==="held")return true;
    if(row.payment_method!=="card")return false;
    const payment=db.prepare("SELECT provider_mode FROM stripe_order_payments WHERE order_id=?").get(row.id);
    const ready=payment&&db.prepare("SELECT 1 FROM stripe_account_readiness r JOIN provider_accounts a ON a.restaurant_id=r.restaurant_id AND a.provider_mode=r.provider_mode AND a.provider_reference=r.provider_account_id WHERE r.restaurant_id=? AND r.provider_mode=? AND r.charges_enabled=1 AND r.payouts_enabled=1 AND a.status='enabled'").get(restaurantId,payment.provider_mode);
    return !ready||Boolean(db.prepare("SELECT 1 FROM refund_cases WHERE order_id=? AND resolved_at IS NULL AND status NOT IN ('refunded','rejected')").get(row.id))||Boolean(db.prepare("SELECT 1 FROM marketplace_operations WHERE order_id=? AND kind='merchant_transfer' AND status='held'").get(row.id));
  });
  const heldMinor=heldOrders.reduce((n,row)=>n+orderNet(db,row).net,0),heldCardMinor=heldOrders.filter(row=>row.payment_method!=="cash").reduce((n,row)=>n+orderNet(db,row).net,0);
  const next=payouts.filter(row=>["scheduled","pending"].includes(row.status)).sort((a,b)=>a.scheduled_for.localeCompare(b.scheduled_for))[0];
  const providerModes=[...new Set(operations.filter(row=>row.amount_minor>0).map(row=>row.provider_mode))];
  const hasBankPayouts=Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='stripe_connected_payouts'").get());
  const bank=hasBankPayouts?all(`SELECT p.* FROM stripe_connected_payouts p WHERE p.restaurant_id=? AND ${bankPayoutFinancePredicate("p",scope)}`):[];
  const bankPaidMinor=sum(bank.filter(row=>row.status==="paid")),bankPendingMinor=sum(bank.filter(row=>["pending","in_transit"].includes(row.status)));
  const bankPayoutUnverifiedCount=hasBankPayouts?db.prepare(`SELECT COUNT(*) n FROM stripe_connected_payouts p WHERE p.restaurant_id=? AND ${bankPayoutProviderModeSql("p")}='unknown'`).get(restaurantId).n:0;
  const providerCostsPendingCount=hasBankPayouts?db.prepare(`SELECT COUNT(*) n FROM stripe_order_payments p JOIN orders o ON o.id=p.order_id WHERE o.restaurant_id=? AND ${orderEnvironmentPredicate("o",scope)} AND p.status='captured' AND p.provider_cost_minor IS NULL AND o.status IN ('accepted','preparing','ready','out_for_delivery','completed')`).get(restaurantId).n:0;
  return {
    restaurantId,currency:"GBP",scope,historyLabel:scope==="live"?"Live financial activity":"Testing and unclassified history",simulation:scope!=="live",
    providerMode:providerModes.length>1?"mixed":providerModes[0]??(scope==="live"?"stripe_live":"local_simulator"),providerModes,
    grossSalesMinor,commissionMinor,historicalGrossSalesMinor,historicalCommissionMinor,historicalNetEarningsMinor:historicalGrossSalesMinor-historicalRefundsMinor-historicalCommissionMinor,
    refundsMinor,adjustmentsMinor:0,netEarningsMinor:grossSalesMinor-refundsMinor-commissionMinor,
    cashCollectedMinor:sum(rangedOperations.filter(row=>row.kind==="cash_sale_recorded"&&row.status==="held")),cashCommissionOutstandingMinor:Math.max(0,cashCommission-successfulCollectionsMinor),
    pendingMinor,availableMinor:Math.max(0,completedCardNet-heldCardMinor-paidTransfersMinor-inTransitTransfersMinor-pendingTransfersMinor),heldMinor,
    platformVoucherCreditMinor:sum(rangedOperations.filter(row=>row.kind==="platform_voucher_credit"&&row.status==="confirmed")),providerCostMinor,providerCostsPendingCount,
    paidTransfersMinor,inTransitTransfersMinor,pendingTransfersMinor,bankPaidMinor,bankPendingMinor,bankPayoutUnverifiedCount,
    bankPayoutBasis:"Completed provider payout events or immutable verified API-read evidence must prove the recorded environment; unverified history is excluded.",
    nextPayout:next?{scheduledFor:next.scheduled_for,estimatedAmountMinor:next.amount_minor,status:next.status}:null
  };
}

const csvCell = (value) => {
  let content = String(value ?? "");
  if (/^[=+\-@]/.test(content)) content = `'${content}`;
  return `"${content.replaceAll('"', '""')}"`;
};
export function statementCsv(rows,scope="testing") {
  if(!["live","testing"].includes(scope))throw new TypeError("A valid statement scope is required");
  return ["operationKey,kind,status,amountMinor,currency,providerMode,createdAt,financialScope", ...rows.map((row) => [row.operation_key, row.kind, row.status, row.amount_minor, row.currency, row.provider_mode, row.created_at,scope].map(csvCell).join(","))].join("\r\n") + "\r\n";
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
