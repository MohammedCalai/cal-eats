export const customerSafetyMigration51 = {
  version: 51,
  name: "customer_restaurant_safety_reports_and_contact_blocks",
  sql: `
CREATE TABLE customer_restaurant_safety (
  customer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  blocked INTEGER NOT NULL CHECK(blocked IN (0,1)),
  created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
  PRIMARY KEY(customer_id,restaurant_id)
);
CREATE TABLE customer_safety_reports (
  case_id TEXT PRIMARY KEY REFERENCES support_cases(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  order_id TEXT REFERENCES orders(id),
  conversation_id TEXT REFERENCES restaurant_customer_threads(id) ON DELETE SET NULL,
  message_id TEXT,reason TEXT NOT NULL,created_at TEXT NOT NULL
);
CREATE INDEX customer_safety_report_customer_idx ON customer_safety_reports(customer_id,created_at);
`
};
