import { randomUUID } from "node:crypto";
import { withTransaction } from "../db/index.js";

// Queueing records eligibility only. The Stripe worker independently rechecks it
// after claiming the job and before making any provider request.
export function queueEligibleStripeTransfers(db, config, { limit = 25 } = {}) {
  const mode = config.paymentProviderMode;
  if (!["stripe_test", "stripe_live"].includes(mode) || !config.stripePlatformAccountId) return { queued: 0 };
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("Transfer queue limit is invalid");
  const stamp = config.now().toISOString();
  return withTransaction(db, () => {
    const rows = db.prepare(`SELECT o.*, p.payment_intent_id, p.latest_charge_id,
        a.provider_reference AS destination_account_id, a.capabilities
      FROM orders o
      JOIN stripe_order_payments p ON p.order_id=o.id AND p.status='captured' AND p.provider_mode=?
      JOIN provider_accounts a ON a.restaurant_id=o.restaurant_id AND a.status='enabled' AND a.provider_mode=p.provider_mode
      JOIN stripe_account_readiness ready ON ready.restaurant_id=a.restaurant_id AND ready.provider_mode=a.provider_mode
        AND ready.provider_account_id=a.provider_reference AND ready.charges_enabled=1 AND ready.payouts_enabled=1
      JOIN marketplace_operations eligible ON eligible.order_id=o.id AND eligible.operation_key='order:'||o.id||':settlement-eligible'
        AND eligible.kind='settlement_eligibility' AND eligible.status='confirmed' AND eligible.provider_mode=p.provider_mode
      WHERE o.status='completed' AND o.payment_method='card' AND o.payment_status IN ('stripe_captured','stripe_partially_refunded')
        AND p.payment_intent_id IS NOT NULL AND p.latest_charge_id IS NOT NULL AND a.provider_reference IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM refund_cases c WHERE c.order_id=o.id AND c.resolved_at IS NULL AND c.status NOT IN ('rejected','refunded'))
        AND NOT EXISTS (SELECT 1 FROM marketplace_operations t WHERE t.order_id=o.id AND t.kind='merchant_transfer' AND t.provider_mode=p.provider_mode)
      ORDER BY o.updated_at,o.id LIMIT ?`).all(mode, limit);
    let queued = 0;
    for (const order of rows) {
      let capabilities;
      try { capabilities = JSON.parse(order.capabilities); } catch { continue; }
      if (!Array.isArray(capabilities) || !capabilities.includes("transfers") || !capabilities.includes("card_payments")) continue;
      const refunds = db.prepare(`SELECT COALESCE(SUM(food_amount_minor+delivery_amount_minor),0) AS total,
        COALESCE(SUM(commission_reversal_minor),0) AS reversal FROM refunds WHERE order_id=?`).get(order.id);
      const commissionMinor = Math.max(0, order.commission_minor - refunds.reversal);
      const amountMinor = order.total_minor - refunds.total - commissionMinor;
      if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor > order.total_minor || refunds.total > order.total_minor) continue;
      const operationKey = `stripe-transfer:${mode}:${order.id}`;
      const snapshot = { orderId: order.id, restaurantId: order.restaurant_id, amountMinor,
        totalMinor: order.total_minor, refundsMinor: refunds.total, commissionMinor,
        sourceCharge: order.latest_charge_id, paymentIntentId: order.payment_intent_id,
        accountId: order.destination_account_id, platformAccountId: config.stripePlatformAccountId,
        providerMode: mode, policyVersion: order.contract_policy_version, verifiedCompletedAt: stamp,
        refundIds: db.prepare("SELECT id FROM refunds WHERE order_id=? ORDER BY id").all(order.id).map(row=>row.id) };
      const inserted = db.prepare(`INSERT OR IGNORE INTO marketplace_operations
        (id,operation_key,restaurant_id,order_id,kind,status,amount_minor,currency,provider_mode,provider_reference,error,metadata,created_at,updated_at)
        VALUES(?,?,?,?,'merchant_transfer','pending',?,'GBP',?,NULL,NULL,?,?,?)`)
        .run(randomUUID(), operationKey, order.restaurant_id, order.id, amountMinor, mode, JSON.stringify(snapshot), stamp, stamp);
      if (!inserted.changes) continue;
      db.prepare(`INSERT INTO marketplace_worker_jobs
        (id,kind,entity_id,operation_key,status,lease_owner,lease_expires_at,attempts,payload,error,available_at,created_at,updated_at)
        VALUES(?,'stripe_transfer',?,?,'queued',NULL,NULL,0,?,NULL,?,?,?)`)
        .run(randomUUID(), order.id, operationKey, JSON.stringify(snapshot), stamp, stamp, stamp);
      queued += 1;
    }
    return { queued };
  });
}
