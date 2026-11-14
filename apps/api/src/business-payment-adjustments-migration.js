export const businessPaymentAdjustmentMigration61 = {
  version: 61,
  name: "reviewed_weekly_business_payment_adjustments",
  sql: `
CREATE TABLE business_payment_adjustments (
 id TEXT PRIMARY KEY,reference TEXT NOT NULL UNIQUE,restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
 direction TEXT NOT NULL CHECK(direction IN ('credit','deduction')),amount_minor INTEGER NOT NULL CHECK(amount_minor BETWEEN 1 AND 1000000),
 currency TEXT NOT NULL CHECK(currency='GBP'),reason TEXT NOT NULL,effective_week_start TEXT NOT NULL,
 provider_mode TEXT NOT NULL CHECK(provider_mode IN ('stripe_test','stripe_live')),platform_account_id TEXT NOT NULL,destination_account_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('draft','reviewed','confirmed','rejected')),created_by_user_id TEXT NOT NULL REFERENCES users(id),
 creation_key TEXT NOT NULL,payload_hash TEXT NOT NULL,reviewed_by_user_id TEXT REFERENCES users(id),review_note TEXT,reviewed_at TEXT,
 confirmed_by_user_id TEXT REFERENCES users(id),confirmation_key TEXT,confirmed_at TEXT,applied_minor INTEGER NOT NULL DEFAULT 0 CHECK(applied_minor>=0 AND applied_minor<=amount_minor),applied_at TEXT,
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(created_by_user_id,creation_key)
);
CREATE INDEX business_adjustments_scope_idx ON business_payment_adjustments(restaurant_id,provider_mode,status,effective_week_start,created_at);
CREATE TRIGGER business_adjustment_immutable BEFORE UPDATE OF id,reference,restaurant_id,direction,amount_minor,currency,reason,effective_week_start,provider_mode,platform_account_id,destination_account_id,created_by_user_id,creation_key,payload_hash,created_at ON business_payment_adjustments BEGIN SELECT RAISE(ABORT,'Payment adjustment terms are immutable'); END;
CREATE TRIGGER business_adjustment_no_delete BEFORE DELETE ON business_payment_adjustments BEGIN SELECT RAISE(ABORT,'Payment adjustment records cannot be deleted'); END;
CREATE TABLE business_payment_settlements (
 order_id TEXT NOT NULL REFERENCES orders(id),restaurant_id TEXT NOT NULL REFERENCES restaurants(id),provider_mode TEXT NOT NULL,
 platform_account_id TEXT NOT NULL,destination_account_id TEXT NOT NULL,operation_key TEXT NOT NULL PRIMARY KEY,
 original_net_minor INTEGER NOT NULL CHECK(original_net_minor>0),deduction_minor INTEGER NOT NULL CHECK(deduction_minor>=0),
 transfer_minor INTEGER NOT NULL CHECK(transfer_minor>=0),refund_ids TEXT NOT NULL,snapshot_hash TEXT NOT NULL,created_at TEXT NOT NULL,
 CHECK(original_net_minor=deduction_minor+transfer_minor)
);
CREATE TRIGGER business_settlement_no_update BEFORE UPDATE ON business_payment_settlements BEGIN SELECT RAISE(ABORT,'Settlement snapshots are immutable'); END;
CREATE TRIGGER business_settlement_no_delete BEFORE DELETE ON business_payment_settlements BEGIN SELECT RAISE(ABORT,'Settlement snapshots cannot be deleted'); END;
CREATE INDEX business_settlements_order_idx ON business_payment_settlements(order_id,created_at);
CREATE TABLE business_payment_settlement_dispatches(operation_key TEXT PRIMARY KEY REFERENCES business_payment_settlements(operation_key),snapshot_hash TEXT NOT NULL,dispatched_at TEXT NOT NULL);
CREATE TRIGGER business_dispatch_no_update BEFORE UPDATE ON business_payment_settlement_dispatches BEGIN SELECT RAISE(ABORT,'Settlement dispatch evidence is immutable'); END;
CREATE TRIGGER business_dispatch_no_delete BEFORE DELETE ON business_payment_settlement_dispatches BEGIN SELECT RAISE(ABORT,'Settlement dispatch evidence cannot be deleted'); END;
CREATE TABLE business_payment_settlement_cancellations(operation_key TEXT PRIMARY KEY REFERENCES business_payment_settlements(operation_key),reason TEXT NOT NULL,snapshot_hash TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TRIGGER business_cancellation_no_update BEFORE UPDATE ON business_payment_settlement_cancellations BEGIN SELECT RAISE(ABORT,'Settlement cancellation evidence is immutable'); END;
CREATE TRIGGER business_cancellation_no_delete BEFORE DELETE ON business_payment_settlement_cancellations BEGIN SELECT RAISE(ABORT,'Settlement cancellation evidence cannot be deleted'); END;
CREATE TABLE business_payment_adjustment_allocations (
 id TEXT PRIMARY KEY,adjustment_id TEXT NOT NULL REFERENCES business_payment_adjustments(id),order_id TEXT NOT NULL REFERENCES orders(id),
 settlement_operation_key TEXT NOT NULL REFERENCES business_payment_settlements(operation_key) DEFERRABLE INITIALLY DEFERRED,
 amount_minor INTEGER NOT NULL CHECK(amount_minor>0),applied_minor INTEGER NOT NULL DEFAULT 0 CHECK(applied_minor>=0 AND applied_minor<=amount_minor),
 restored_minor INTEGER NOT NULL DEFAULT 0 CHECK(restored_minor>=0 AND restored_minor<=applied_minor),released_minor INTEGER NOT NULL DEFAULT 0 CHECK(released_minor>=0 AND released_minor<=amount_minor-applied_minor),applied_at TEXT,restored_at TEXT,
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(adjustment_id,settlement_operation_key)
);
CREATE INDEX business_adjustment_allocations_order_idx ON business_payment_adjustment_allocations(order_id);
CREATE TRIGGER business_allocation_immutable BEFORE UPDATE OF id,adjustment_id,order_id,settlement_operation_key,amount_minor,created_at ON business_payment_adjustment_allocations BEGIN SELECT RAISE(ABORT,'Adjustment allocation terms are immutable'); END;
CREATE TRIGGER business_allocation_no_delete BEFORE DELETE ON business_payment_adjustment_allocations BEGIN SELECT RAISE(ABORT,'Adjustment allocations cannot be deleted'); END;
CREATE TABLE business_payment_adjustment_events (
 id TEXT PRIMARY KEY,adjustment_id TEXT NOT NULL REFERENCES business_payment_adjustments(id),kind TEXT NOT NULL,amount_minor INTEGER NOT NULL DEFAULT 0,
 order_id TEXT REFERENCES orders(id),actor_user_id TEXT REFERENCES users(id),details TEXT NOT NULL,created_at TEXT NOT NULL
);
CREATE INDEX business_adjustment_events_idx ON business_payment_adjustment_events(adjustment_id,created_at);
CREATE TRIGGER business_adjustment_event_no_update BEFORE UPDATE ON business_payment_adjustment_events BEGIN SELECT RAISE(ABORT,'Adjustment audit is append only'); END;
CREATE TRIGGER business_adjustment_event_no_delete BEFORE DELETE ON business_payment_adjustment_events BEGIN SELECT RAISE(ABORT,'Adjustment audit cannot be deleted'); END;
CREATE TABLE business_payment_credit_jobs (
 adjustment_id TEXT PRIMARY KEY REFERENCES business_payment_adjustments(id),operation_key TEXT NOT NULL UNIQUE,payload TEXT NOT NULL,payload_hash TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','claimed','unknown','confirmed','held')),attempts INTEGER NOT NULL DEFAULT 0,
 lease_owner TEXT,lease_expires_at TEXT,provider_reference TEXT,dispatch_started_at TEXT,available_at TEXT NOT NULL,last_error TEXT,
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL
);
CREATE INDEX business_credit_worker_idx ON business_payment_credit_jobs(status,available_at,lease_expires_at);
CREATE TRIGGER business_credit_payload_immutable BEFORE UPDATE OF adjustment_id,operation_key,payload,payload_hash,created_at ON business_payment_credit_jobs BEGIN SELECT RAISE(ABORT,'Credit transfer payload is immutable'); END;
`
};
