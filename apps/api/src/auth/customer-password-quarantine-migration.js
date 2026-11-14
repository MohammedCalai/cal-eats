// Keep schema definitions independent of the authentication domain and database
// bootstrap so either entry point can be imported directly by maintenance tools.
export const customerPasswordQuarantineMigration62 = {
  version: 62,
  name: "scoped_customer_password_reset_quarantine",
  sql: `ALTER TABLE users ADD COLUMN password_reset_required INTEGER NOT NULL DEFAULT 0
    CHECK(password_reset_required IN (0,1) AND (password_reset_required=0 OR role='customer'));`
};
