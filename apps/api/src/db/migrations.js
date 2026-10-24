export const migrations = [
  {
    version: 1,
    name: "initial_schema",
    sql: `
CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('customer','restaurant','admin')), created_at TEXT NOT NULL);
CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, revoked_at TEXT, created_at TEXT NOT NULL);
CREATE INDEX sessions_token_hash_idx ON sessions(token_hash);
CREATE TABLE restaurants (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')), created_at TEXT NOT NULL);
CREATE TABLE restaurant_memberships (restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL, PRIMARY KEY (restaurant_id,user_id));
CREATE TABLE menu_items (id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', price_minor INTEGER NOT NULL CHECK(price_minor >= 0), available INTEGER NOT NULL DEFAULT 1 CHECK(available IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE orders (id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL REFERENCES restaurants(id), restaurant_name TEXT NOT NULL, customer_id TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL CHECK(status IN ('placed','accepted','preparing','ready','completed','rejected')), currency TEXT NOT NULL DEFAULT 'GBP', subtotal_minor INTEGER NOT NULL CHECK(subtotal_minor >= 0), commission_minor INTEGER NOT NULL CHECK(commission_minor >= 0), payment_method TEXT NOT NULL CHECK(payment_method IN ('mock_card','cash')), payment_status TEXT NOT NULL, fulfillment TEXT NOT NULL CHECK(fulfillment = 'collection'), idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(customer_id,idempotency_key));
CREATE TABLE order_items (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE, menu_item_id TEXT NOT NULL REFERENCES menu_items(id), name TEXT NOT NULL, unit_price_minor INTEGER NOT NULL CHECK(unit_price_minor >= 0), quantity INTEGER NOT NULL CHECK(quantity > 0));
CREATE TABLE order_events (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE, actor_user_id TEXT REFERENCES users(id), kind TEXT NOT NULL, from_status TEXT, to_status TEXT, created_at TEXT NOT NULL);
CREATE TABLE ledger_entries (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), restaurant_id TEXT NOT NULL REFERENCES restaurants(id), kind TEXT NOT NULL, amount_minor INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'GBP', created_at TEXT NOT NULL, UNIQUE(order_id,kind));
`
  }
];
