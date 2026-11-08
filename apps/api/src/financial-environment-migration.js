export const financialEnvironmentMigration = {
  version: 53,
  name: "immutable_order_financial_environment",
  sql: `
CREATE TABLE order_financial_environments (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  environment TEXT NOT NULL CHECK(environment IN ('local_simulator','stripe_test','stripe_live','unknown')),
  provenance TEXT NOT NULL, source_reference TEXT, recorded_at TEXT NOT NULL
);
CREATE INDEX order_financial_environment_scope ON order_financial_environments(environment,order_id);
INSERT INTO order_financial_environments(order_id,environment,provenance,source_reference,recorded_at)
SELECT o.id,
  CASE WHEN o.payment_method='card' AND p.provider_mode IN ('stripe_test','stripe_live') THEN p.provider_mode
       WHEN o.payment_method='mock_card' THEN 'local_simulator'
       WHEN o.payment_method='cash' AND o.contract_demo_only=1 THEN 'local_simulator'
       ELSE 'unknown' END,
  CASE WHEN o.payment_method='card' AND p.provider_mode IN ('stripe_test','stripe_live') THEN 'legacy_stripe_payment'
       WHEN o.payment_method='mock_card' THEN 'legacy_mock_payment'
       WHEN o.payment_method='cash' AND o.contract_demo_only=1 THEN 'legacy_development_cash'
       ELSE 'legacy_unproven' END,
  CASE WHEN o.payment_method='card' AND p.provider_mode IN ('stripe_test','stripe_live') THEN p.payment_intent_id ELSE NULL END,
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM orders o LEFT JOIN stripe_order_payments p ON p.order_id=o.id;
CREATE TRIGGER order_financial_environment_immutable_update BEFORE UPDATE ON order_financial_environments BEGIN SELECT RAISE(ABORT,'Order financial environment is immutable'); END;
CREATE TRIGGER order_financial_environment_immutable_delete BEFORE DELETE ON order_financial_environments BEGIN SELECT RAISE(ABORT,'Order financial environment is immutable'); END;
`
};
