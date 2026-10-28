export const orderConfirmationMigration26 = {
  version: 26,
  name: "order_confirmation_clock_and_owner_email_outbox",
  sql: `
ALTER TABLE orders ADD COLUMN merchant_visible_at TEXT;
ALTER TABLE orders ADD COLUMN confirmation_due_at TEXT;
ALTER TABLE orders ADD COLUMN confirmed_at TEXT;
UPDATE orders SET merchant_visible_at=COALESCE(
  (SELECT MIN(n.created_at) FROM user_notifications n WHERE n.order_id=orders.id AND n.type='new_order'),
  CASE WHEN payment_method<>'card' THEN created_at ELSE
    COALESCE((SELECT updated_at FROM stripe_order_payments p WHERE p.order_id=orders.id),updated_at) END
) WHERE payment_method<>'card' OR payment_status IN ('stripe_authorized','stripe_captured','stripe_partially_refunded','stripe_refunded');
UPDATE orders SET confirmation_due_at=strftime('%Y-%m-%dT%H:%M:%fZ',merchant_visible_at,'+180 seconds') WHERE merchant_visible_at IS NOT NULL;
UPDATE orders SET confirmed_at=COALESCE(
  (SELECT MIN(e.created_at) FROM order_events e WHERE e.order_id=orders.id AND e.to_status='accepted'),updated_at
) WHERE status IN ('accepted','preparing','ready','out_for_delivery','completed');
CREATE INDEX order_confirmation_due_idx ON orders(status,confirmation_due_at,restaurant_id);
CREATE TABLE order_confirmation_email_outbox (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK(mode IN ('local','smtp','off')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','claimed','local_saved','sent','failed','unknown','cancelled')),
  lease_owner TEXT,
  lease_expires_at TEXT,
  dispatch_started_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  queued_at TEXT NOT NULL,
  sent_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX order_confirmation_email_dispatch_idx ON order_confirmation_email_outbox(status,queued_at,lease_expires_at);
`
};
