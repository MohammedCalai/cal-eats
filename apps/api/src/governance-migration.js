export function applyGovernanceMigration(db) {
  const userColumns = db.prepare("PRAGMA table_info(users)").all().map((row) => row.name);
  if (!userColumns.includes("account_enabled")) db.exec("ALTER TABLE users ADD COLUMN account_enabled INTEGER NOT NULL DEFAULT 1 CHECK(account_enabled IN (0,1))");
  db.exec(`
    CREATE TABLE IF NOT EXISTS governance_audit (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT REFERENCES users(id),
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      details TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS governance_audit_created_idx ON governance_audit(created_at);
    CREATE TABLE IF NOT EXISTS refund_response_policy (
      id INTEGER PRIMARY KEY CHECK(id=1),
      customer_response_hours INTEGER NOT NULL CHECK(customer_response_hours BETWEEN 1 AND 720),
      restaurant_response_hours INTEGER NOT NULL CHECK(restaurant_response_hours BETWEEN 1 AND 720),
      reminder_lead_hours INTEGER NOT NULL CHECK(reminder_lead_hours BETWEEN 1 AND 168),
      updated_by_user_id TEXT REFERENCES users(id),
      updated_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO refund_response_policy VALUES(1,48,48,12,NULL,'1970-01-01T00:00:00.000Z');
    CREATE TABLE IF NOT EXISTS refund_response_deadlines (
      case_id TEXT PRIMARY KEY REFERENCES refund_cases(id) ON DELETE CASCADE,
      awaiting_status TEXT NOT NULL CHECK(awaiting_status IN ('awaiting_customer','awaiting_restaurant')),
      due_at TEXT NOT NULL,
      reminder_sent_at TEXT,
      escalated_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  applyGovernanceEpisodeMigration(db);
}

export const GOVERNANCE_EPISODE_MIGRATION_VERSION = 18;
export const GOVERNANCE_EPISODE_MIGRATION_SQL = "ALTER TABLE refund_response_deadlines ADD COLUMN episode_key TEXT NOT NULL DEFAULT '';";
export const GOVERNANCE_EPISODE_MIGRATION = {version:GOVERNANCE_EPISODE_MIGRATION_VERSION,name:"refund_response_waiting_episodes",sql:GOVERNANCE_EPISODE_MIGRATION_SQL};
export function applyGovernanceEpisodeMigration(db) {
  const columns=db.prepare("PRAGMA table_info(refund_response_deadlines)").all().map(row=>row.name);
  if(!columns.includes("episode_key"))db.exec(GOVERNANCE_EPISODE_MIGRATION_SQL);
}
