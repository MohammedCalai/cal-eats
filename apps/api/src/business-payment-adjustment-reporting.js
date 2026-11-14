// Read-only views over immutable adjustment terms and their recorded movements.
// Position totals are deliberately separate from dated cashflow and bank payouts.
import { HttpError } from "./http.js";
const amount = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const sum = (rows, field) => rows.reduce((total, row) => total + amount(row[field]), 0);
const available = db => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='business_payment_adjustments'").get());
const londonDay = value => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
function weekOf(value) { const date = londonDay(value), day = new Date(`${date}T12:00:00Z`), offset = (day.getUTCDay() + 6) % 7; return new Date(day.getTime() - offset * 86400000).toISOString().slice(0, 10); }

export function paymentAdjustmentDto(db, row, { asOf = new Date().toISOString() } = {}) {
  const allocated = row.direction === "deduction" ? db.prepare("SELECT amount_minor,applied_minor,restored_minor,released_minor FROM business_payment_adjustment_allocations WHERE adjustment_id=?").all(row.id) : [];
  const appliedMinor = row.direction === "credit" ? amount(row.applied_minor) : Math.max(0, sum(allocated, "applied_minor") - sum(allocated, "restored_minor"));
  const releasedMinor = sum(allocated, "released_minor");
  const reservedMinor = row.direction === "deduction" ? Math.max(0, sum(allocated, "amount_minor") - sum(allocated, "applied_minor") - releasedMinor) : 0;
  const pendingMinor = row.status === "confirmed" ? Math.max(0, row.amount_minor - appliedMinor - reservedMinor) : 0;
  const job = row.direction === "credit" ? db.prepare("SELECT status,last_error FROM business_payment_credit_jobs WHERE adjustment_id=?").get(row.id) : null;
  const restaurantName = row.restaurant_name ?? db.prepare("SELECT name FROM restaurants WHERE id=?").get(row.restaurant_id)?.name ?? "Restaurant unavailable";
  return { id: row.id, reference: row.reference, restaurantId: row.restaurant_id, restaurantName, direction: row.direction, amountMinor: row.amount_minor, currency: "GBP", reason: row.reason, effectiveWeekStart: row.effective_week_start, status: row.status,
    appliedMinor, reservedMinor, releasedMinor, pendingMinor, carriedForwardMinor: row.status === "confirmed" && row.effective_week_start < weekOf(asOf) ? pendingMinor : 0,
    createdAt: row.created_at, reviewedAt: row.reviewed_at, confirmedAt: row.confirmed_at, appliedAt: row.applied_at, providerMode: row.provider_mode, workerStatus: job?.status ?? null, error: job?.last_error ?? null };
}

export function buildPaymentAdjustmentStatement(db, { restaurantId, scope, from, toExclusive, asOf = new Date().toISOString() }) {
  const empty = { items: [], events: [], generatedAt: asOf, creditsAppliedMinor: 0, deductionsAppliedMinor: 0, deductionsRestoredMinor: 0, pendingCreditMinor: 0, pendingDeductionMinor: 0, reservedDeductionMinor: 0, carriedForwardDeductionMinor: 0 };
  if (!available(db)) return empty;
  const mode = scope === "live" ? "stripe_live" : "stripe_test", endWeek = weekOf(new Date(Date.parse(toExclusive) - 1).toISOString());
  const count = db.prepare("SELECT COUNT(*) n FROM business_payment_adjustments WHERE restaurant_id=? AND provider_mode=? AND status='confirmed' AND effective_week_start<=?").get(restaurantId, mode, endWeek).n;
  const eventCount = db.prepare("SELECT COUNT(*) n FROM business_payment_adjustment_events e JOIN business_payment_adjustments a ON a.id=e.adjustment_id WHERE a.restaurant_id=? AND a.provider_mode=? AND e.created_at>=? AND e.created_at<? AND e.kind IN ('credit_applied','deduction_applied','deduction_restored')").get(restaurantId, mode, from, toExclusive).n;
  if (count + eventCount > 50000) throw new Error("WEEKLY_STATEMENT_TOO_LARGE");
  const rows = db.prepare("SELECT a.*,r.name restaurant_name FROM business_payment_adjustments a JOIN restaurants r ON r.id=a.restaurant_id WHERE a.restaurant_id=? AND a.provider_mode=? AND a.status='confirmed' AND a.effective_week_start<=? ORDER BY a.effective_week_start,a.created_at,a.id").all(restaurantId, mode, endWeek);
  const items = rows.map(row => paymentAdjustmentDto(db, row, { asOf }));
  const events = db.prepare("SELECT e.*,a.reference,a.direction,a.reason,a.effective_week_start,a.provider_mode FROM business_payment_adjustment_events e JOIN business_payment_adjustments a ON a.id=e.adjustment_id WHERE a.restaurant_id=? AND a.provider_mode=? AND e.created_at>=? AND e.created_at<? AND e.kind IN ('credit_applied','deduction_applied','deduction_restored') ORDER BY e.created_at,e.id").all(restaurantId, mode, from, toExclusive).map(row => ({ id: row.id, adjustmentId: row.adjustment_id, reference: row.reference, direction: row.direction, reason: row.reason, effectiveWeekStart: row.effective_week_start, kind: row.kind, amountMinor: row.amount_minor, orderId: row.order_id, providerMode: row.provider_mode, createdAt: row.created_at }));
  return { ...empty, items, events, creditsAppliedMinor: sum(events.filter(row => row.kind === "credit_applied"), "amountMinor"), deductionsAppliedMinor: sum(events.filter(row => row.kind === "deduction_applied"), "amountMinor"), deductionsRestoredMinor: sum(events.filter(row => row.kind === "deduction_restored"), "amountMinor"),
    pendingCreditMinor: sum(items.filter(row => row.direction === "credit"), "pendingMinor"), pendingDeductionMinor: sum(items.filter(row => row.direction === "deduction"), "pendingMinor"), reservedDeductionMinor: sum(items.filter(row => row.direction === "deduction"), "reservedMinor"), carriedForwardDeductionMinor: sum(items.filter(row => row.direction === "deduction"), "carriedForwardMinor") };
}

export function buildOrderPaymentAdjustmentBreakdown(db, order) {
  if (!available(db)) return { items: [], reservedMinor: 0, appliedMinor: 0, restoredMinor: 0, releasedMinor: 0, transferMinor: null, fullyWithheld: false };
  const allocations = db.prepare("SELECT x.*,a.reference,a.reason,a.effective_week_start,a.provider_mode FROM business_payment_adjustment_allocations x JOIN business_payment_adjustments a ON a.id=x.adjustment_id JOIN order_financial_environments fe ON fe.order_id=x.order_id AND fe.environment=a.provider_mode WHERE x.order_id=? AND a.restaurant_id=? ORDER BY a.effective_week_start,a.created_at,a.id").all(order.id, order.restaurant_id);
  const snapshot = db.prepare("SELECT s.transfer_minor,s.deduction_minor FROM business_payment_settlements s WHERE s.order_id=? AND s.restaurant_id=? AND s.provider_mode=(SELECT environment FROM order_financial_environments WHERE order_id=?) AND NOT EXISTS(SELECT 1 FROM business_payment_settlement_cancellations c WHERE c.operation_key=s.operation_key) ORDER BY s.created_at DESC,s.rowid DESC LIMIT 1").get(order.id, order.restaurant_id, order.id);
  return { items: allocations.map(row => ({ id: row.id, adjustmentId: row.adjustment_id, settlementOperationKey: row.settlement_operation_key, reference: row.reference, reason: row.reason, effectiveWeekStart: row.effective_week_start, amountMinor: row.amount_minor, appliedMinor: row.applied_minor - row.restored_minor, reservedMinor: row.amount_minor - row.applied_minor - row.released_minor, restoredMinor: row.restored_minor, releasedMinor: row.released_minor })),
    reservedMinor: sum(allocations, "amount_minor") - sum(allocations, "applied_minor") - sum(allocations, "released_minor"), appliedMinor: sum(allocations, "applied_minor") - sum(allocations, "restored_minor"), restoredMinor: sum(allocations, "restored_minor"), releasedMinor: sum(allocations, "released_minor"), transferMinor: snapshot?.transfer_minor ?? null, fullyWithheld: Boolean(snapshot && snapshot.transfer_minor === 0 && snapshot.deduction_minor > 0) };
}

function cell(value) { let text = String(value ?? ""); if (/^\s*[=+\-@]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; }
export function paymentAdjustmentCsv(items, { asOf = new Date().toISOString() } = {}) {
  const columns = ["reference", "restaurantId", "restaurantName", "direction", "amountMinor", "currency", "reason", "effectiveWeekStart", "status", "appliedMinor", "reservedMinor", "releasedMinor", "pendingMinor", "carriedForwardMinor", "providerMode", "createdAt", "reviewedAt", "confirmedAt", "workerStatus", "error"];
  return [[...columns, "positionGeneratedAt", "bankDepositConfirmed"], ...items.map(row => [...columns.map(key => row[key]), asOf, "false"])].map(row => row.map(cell).join(",")).join("\r\n") + "\r\n";
}

export function listBusinessPaymentAdjustments(db, { restaurantId, providerMode, platformAccountId, weekStart, page = 1, pageSize = 25, now = new Date(), includeDrafts = true, exportMode = false } = {}) {
  const fail = message => { throw new HttpError(400, "VALIDATION_ERROR", message); };
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > (exportMode ? 10000 : 100)) fail("Adjustment pagination is invalid");
  if (weekStart && (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart) || !Number.isFinite(Date.parse(`${weekStart}T12:00:00Z`)) || new Date(`${weekStart}T12:00:00Z`).toISOString().slice(0, 10) !== weekStart || new Date(`${weekStart}T12:00:00Z`).getUTCDay() !== 1)) fail("Choose a Monday for the effective week");
  const asOf = new Date(now).toISOString(), pagination = { page, pageSize, total: 0, totalPages: 0, hasNext: false, hasPrevious: false };
  if (!available(db) || !["stripe_live", "stripe_test"].includes(providerMode)) return { items: [], pagination, positionGeneratedAt: asOf };
  const clauses = ["a.provider_mode=?"], args = [providerMode];
  if (restaurantId) { clauses.push("a.restaurant_id=?"); args.push(restaurantId); }
  if (platformAccountId) { clauses.push("a.platform_account_id=?"); args.push(platformAccountId); }
  if (weekStart) { clauses.push("a.effective_week_start=?"); args.push(weekStart); }
  if (!includeDrafts) clauses.push("a.status='confirmed'");
  const where = clauses.join(" AND "), total = db.prepare(`SELECT COUNT(*) n FROM business_payment_adjustments a WHERE ${where}`).get(...args).n;
  if (exportMode && total > 10000) throw new HttpError(413, "ADJUSTMENT_EXPORT_TOO_LARGE", "Choose a business or effective week to export up to 10,000 adjustments");
  const rows = db.prepare(`SELECT a.*,r.name restaurant_name FROM business_payment_adjustments a JOIN restaurants r ON r.id=a.restaurant_id WHERE ${where} ORDER BY a.effective_week_start DESC,a.created_at DESC,a.id DESC LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize);
  return { items: rows.map(row => paymentAdjustmentDto(db, row, { asOf })), pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize), hasNext: page * pageSize < total, hasPrevious: page > 1 }, positionGeneratedAt: asOf };
}

export const exportBusinessPaymentAdjustmentsCsv = paymentAdjustmentCsv;

export function paymentAdjustmentBalanceTotals(db, { restaurantId, scope, from = null, toExclusive = null, excludedOrderIds = [] } = {}) {
  const empty = { appliedCreditMinor: 0, pendingCreditMinor: 0, appliedDeductionMinor: 0, reservedDeductionMinor: 0, releasedDeductionMinor: 0, pendingDeductionMinor: 0, unheldWithholdingMinor: 0, adjustmentsMinor: 0 };
  if (!available(db)) return empty;
  const mode = scope === "live" ? "stripe_live" : "stripe_test";
  const rows = db.prepare("SELECT a.id,a.direction,a.amount_minor,a.applied_minor FROM business_payment_adjustments a WHERE a.restaurant_id=? AND a.provider_mode=? AND a.status='confirmed'").all(restaurantId, mode);
  const allocations = db.prepare("SELECT x.order_id,x.amount_minor,x.applied_minor,x.restored_minor,x.released_minor FROM business_payment_adjustment_allocations x JOIN business_payment_adjustments a ON a.id=x.adjustment_id JOIN order_financial_environments fe ON fe.order_id=x.order_id AND fe.environment=a.provider_mode WHERE a.restaurant_id=? AND a.provider_mode=? AND a.status='confirmed' AND a.direction='deduction'").all(restaurantId, mode);
  const credits = rows.filter(row => row.direction === "credit"), deductions = rows.filter(row => row.direction === "deduction"), excluded = new Set(excludedOrderIds);
  const appliedCreditMinor = sum(credits, "applied_minor"), appliedDeductionMinor = sum(allocations, "applied_minor") - sum(allocations, "restored_minor"), releasedDeductionMinor = sum(allocations, "released_minor"), reservedDeductionMinor = sum(allocations, "amount_minor") - sum(allocations, "applied_minor") - releasedDeductionMinor;
  const time = [], args = [restaurantId, mode];
  if (from) { time.push("e.created_at>=?"); args.push(from); } if (toExclusive) { time.push("e.created_at<?"); args.push(toExclusive); }
  const movement = db.prepare(`SELECT COALESCE(SUM(CASE WHEN e.kind IN ('credit_applied','deduction_restored') THEN e.amount_minor WHEN e.kind='deduction_applied' THEN -e.amount_minor ELSE 0 END),0) n FROM business_payment_adjustment_events e JOIN business_payment_adjustments a ON a.id=e.adjustment_id WHERE a.restaurant_id=? AND a.provider_mode=?${time.length ? ` AND ${time.join(" AND ")}` : ""}`).get(...args).n;
  return { appliedCreditMinor, pendingCreditMinor: sum(credits, "amount_minor") - appliedCreditMinor, appliedDeductionMinor, reservedDeductionMinor, releasedDeductionMinor, pendingDeductionMinor: Math.max(0, sum(deductions, "amount_minor") - appliedDeductionMinor - reservedDeductionMinor),
    unheldWithholdingMinor: allocations.filter(row => !excluded.has(row.order_id)).reduce((total, row) => total + row.amount_minor - row.restored_minor - row.released_minor, 0), adjustmentsMinor: movement };
}
