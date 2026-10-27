export const DISPUTE_RESOLUTION_MIGRATION_VERSION = 21;
export const DISPUTE_RESOLUTION_MIGRATION_SQL = `
ALTER TABLE refund_cases ADD COLUMN escalated_at TEXT;
ALTER TABLE refund_cases ADD COLUMN escalation_reason TEXT;
ALTER TABLE refund_cases ADD COLUMN resolved_at TEXT;
CREATE TABLE dispute_remedy_proposals (id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES refund_cases(id) ON DELETE CASCADE,restaurant_id TEXT NOT NULL REFERENCES restaurants(id),created_by_user_id TEXT NOT NULL REFERENCES users(id),idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL,type TEXT NOT NULL CHECK(type IN ('missing_item','replacement','free_item','voucher','partial_refund','full_refund')),status TEXT NOT NULL CHECK(status IN ('pending','accepted','declined','superseded','fulfilled')),amount_minor INTEGER,voucher_value_minor INTEGER,item_ids TEXT NOT NULL DEFAULT '[]',description TEXT NOT NULL,expires_at TEXT,redemption_conditions TEXT,financial_party TEXT NOT NULL CHECK(financial_party='restaurant'),responded_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(created_by_user_id,idempotency_key));
CREATE INDEX dispute_proposals_case_idx ON dispute_remedy_proposals(case_id,created_at);
CREATE UNIQUE INDEX dispute_one_pending_proposal ON dispute_remedy_proposals(case_id) WHERE status='pending';
CREATE TABLE dispute_remedy_fulfilments (id TEXT PRIMARY KEY,proposal_id TEXT NOT NULL REFERENCES dispute_remedy_proposals(id) ON DELETE CASCADE,actor_user_id TEXT NOT NULL REFERENCES users(id),idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL,action TEXT NOT NULL CHECK(action IN ('restaurant_evidence','customer_confirmed','admin_override')),evidence TEXT NOT NULL,reason TEXT,created_at TEXT NOT NULL,UNIQUE(actor_user_id,idempotency_key),UNIQUE(proposal_id,action));
CREATE INDEX dispute_fulfilments_proposal_idx ON dispute_remedy_fulfilments(proposal_id,created_at);
CREATE TABLE dispute_customer_responses (id TEXT PRIMARY KEY,proposal_id TEXT NOT NULL REFERENCES dispute_remedy_proposals(id) ON DELETE CASCADE,customer_id TEXT NOT NULL REFERENCES users(id),idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL,decision TEXT NOT NULL CHECK(decision IN ('accept','decline')),created_at TEXT NOT NULL,UNIQUE(customer_id,idempotency_key),UNIQUE(proposal_id));`;
export const disputeResolutionMigration21 = { version: DISPUTE_RESOLUTION_MIGRATION_VERSION, name: "restaurant_first_dispute_resolution", sql: DISPUTE_RESOLUTION_MIGRATION_SQL };
export const DISPUTE_RESOLUTION_MIGRATION = disputeResolutionMigration21;

export function applyDisputeResolutionMigration(db) {
  const caseColumns = db.prepare("PRAGMA table_info(refund_cases)").all().map((row) => row.name);
  if (!caseColumns.includes("escalated_at")) db.exec("ALTER TABLE refund_cases ADD COLUMN escalated_at TEXT");
  if (!caseColumns.includes("escalation_reason")) db.exec("ALTER TABLE refund_cases ADD COLUMN escalation_reason TEXT");
  if (!caseColumns.includes("resolved_at")) db.exec("ALTER TABLE refund_cases ADD COLUMN resolved_at TEXT");
  db.exec(`
    CREATE TABLE IF NOT EXISTS dispute_remedy_proposals (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES refund_cases(id) ON DELETE CASCADE,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
      created_by_user_id TEXT NOT NULL REFERENCES users(id),
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('missing_item','replacement','free_item','voucher','partial_refund','full_refund')),
      status TEXT NOT NULL CHECK(status IN ('pending','accepted','declined','superseded','fulfilled')),
      amount_minor INTEGER,
      voucher_value_minor INTEGER,
      item_ids TEXT NOT NULL DEFAULT '[]',
      description TEXT NOT NULL,
      expires_at TEXT,
      redemption_conditions TEXT,
      financial_party TEXT NOT NULL CHECK(financial_party='restaurant'),
      responded_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(created_by_user_id,idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS dispute_proposals_case_idx ON dispute_remedy_proposals(case_id,created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS dispute_one_pending_proposal ON dispute_remedy_proposals(case_id) WHERE status='pending';
    CREATE TABLE IF NOT EXISTS dispute_remedy_fulfilments (
      id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL REFERENCES dispute_remedy_proposals(id) ON DELETE CASCADE,
      actor_user_id TEXT NOT NULL REFERENCES users(id),
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('restaurant_evidence','customer_confirmed','admin_override')),
      evidence TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(actor_user_id,idempotency_key),
      UNIQUE(proposal_id,action)
    );
    CREATE INDEX IF NOT EXISTS dispute_fulfilments_proposal_idx ON dispute_remedy_fulfilments(proposal_id,created_at);
    CREATE TABLE IF NOT EXISTS dispute_customer_responses (
      id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL REFERENCES dispute_remedy_proposals(id) ON DELETE CASCADE,
      customer_id TEXT NOT NULL REFERENCES users(id),
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('accept','decline')),
      created_at TEXT NOT NULL,
      UNIQUE(customer_id,idempotency_key),
      UNIQUE(proposal_id)
    );
  `);
}
