# Database schema reference

Generated 30 October 2026 from registered migrations at `b94092ee4657b01d93466a4ddf282155f76a0fa2`, using a fresh in-memory Node SQLite database. This is source-derived schema, not a dump of an existing database. No row data is included.

**31 migrations; 85 tables; 57 explicit indexes; 149 foreign-key edges.** Primary-key/UNIQUE autoindexes are listed separately within each table and are not part of the 57 explicit-index count. `schema_migrations` is included in 85.

Foreign keys are active in `openDatabase`; rows generally use application-supplied UUID text IDs, integer minor currency values and ISO timestamp text. JSON fields remain TEXT; runtime validation supplies much of their shape checking. Primary-key nullability is shown as SQLite declares it; SQLite TEXT PRIMARY KEY is not the same as a separately declared NOT NULL column.

See [backend audit](BACKEND_DATABASE.md) for ownership, tenant boundaries, migration and operational risks. The exact CREATE TABLE SQL below preserves CHECK/UNIQUE constraints and defaults.

## Migration order

| Version | Name | Rebuild with foreign keys temporarily off |
|---|---|---|
| 1 | initial_schema | No |
| 2 | delivery_journey | Yes |
| 3 | finance_operations | Yes |
| 4 | local_notification_sink | No |
| 5 | product_operations | No |
| 6 | offers_and_in_app_notifications | No |
| 7 | local_account_access | No |
| 8 | persistent_auth_throttling | No |
| 9 | final_local_polish | No |
| 10 | marketplace_finance_refunds_devices | No |
| 11 | native_customer_sessions_and_device_claim_owner | No |
| 12 | marketplace_report_artifacts | No |
| 13 | commission_base_snapshot | No |
| 14 | printer_claim_replay_tokens | No |
| 15 | recoverable_payout_states | Yes |
| 16 | admin_governance_and_refund_sla | No |
| 17 | provider_test_events_reconciliation | No |
| 18 | refund_response_waiting_episodes | No |
| 19 | encrypted_order_messaging | No |
| 20 | restaurant_loyalty_promotions_and_consent | No |
| 21 | restaurant_first_dispute_resolution | No |
| 22 | stripe_connect_payments | Yes |
| 23 | restaurant_customer_directory_and_conversations | No |
| 24 | business_native_sessions_and_routed_support | No |
| 25 | durable_customer_message_ingestion_sequence | No |
| 26 | order_confirmation_clock_and_owner_email_outbox | No |
| 27 | durable_transactional_customer_email_and_graph_alert_mode | No |
| 28 | weekly_owner_statements_and_durable_delivery | No |
| 29 | platform_business_support_and_service_email_recipients | No |
| 30 | menu_product_type_and_energy | No |
| 31 | customer_locations_and_service_areas | No |

## Table inventory

`account_access_tokens`, `audit_events`, `auth_rate_limits`, `business_statement_preferences`, `business_weekly_statement_outbox`, `cash_collections`, `cash_mandates`, `cash_settlements`, `commission_policies`, `contracts`, `customer_email_delivery_settings`, `customer_transactional_email_outbox`, `deletion_requests`, `device_print_jobs`, `dispute_customer_responses`, `dispute_remedy_fulfilments`, `dispute_remedy_proposals`, `governance_audit`, `integration_status`, `journal_postings`, `ledger_entries`, `local_mail_sink`, `local_notifications`, `loyalty_settings`, `marketing_preferences`, `marketplace_operations`, `marketplace_report_jobs`, `marketplace_worker_jobs`, `media_assets`, `menu_imports`, `menu_items`, `native_business_sessions`, `native_sessions`, `notification_outbox`, `offer_campaigns`, `offer_grants`, `operational_jobs`, `order_confirmation_email_outbox`, `order_events`, `order_items`, `order_message_incidents`, `order_message_rate_limits`, `order_message_reads`, `order_message_settings`, `order_messages`, `orders`, `payout_batches`, `payout_items`, `print_jobs`, `printer_devices`, `printer_job_claim_tokens`, `printer_pairing_codes`, `provider_accounts`, `provider_event_object_state`, `provider_events`, `refund_case_events`, `refund_case_evidence`, `refund_case_messages`, `refund_cases`, `refund_decisions`, `refund_response_deadlines`, `refund_response_policy`, `refunds`, `restaurant_customer_message_rate_limits`, `restaurant_customer_message_reads`, `restaurant_customer_messages`, `restaurant_customer_thread_sequences`, `restaurant_customer_threads`, `restaurant_customer_workflows`, `restaurant_memberships`, `restaurant_printers`, `restaurants`, `saved_addresses`, `schema_migrations`, `service_area_settings`, `sessions`, `stripe_account_readiness`, `stripe_connected_payouts`, `stripe_order_decisions`, `stripe_order_payments`, `support_case_messages`, `support_cases`, `support_message_rate_limits`, `user_notifications`, `users`.

## account_access_tokens

```sql
CREATE TABLE account_access_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, purpose TEXT NOT NULL CHECK(purpose IN ('password_reset','email_verification')), token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, consumed_at TEXT, created_at TEXT NOT NULL);
```

Foreign keys: `user_id` → `users.id` (delete CASCADE, update NO ACTION).

Indexes:

- `account_access_tokens_user_idx`: (user_id, purpose, created_at), explicit. SQL: `CREATE INDEX account_access_tokens_user_idx ON account_access_tokens(user_id,purpose,created_at)`
- `sqlite_autoindex_account_access_tokens_2`: UNIQUE (token_hash), constraint autoindex.
- `sqlite_autoindex_account_access_tokens_1`: UNIQUE (id), constraint autoindex.

## audit_events

```sql
CREATE TABLE audit_events (id TEXT PRIMARY KEY, actor_user_id TEXT NOT NULL REFERENCES users(id), entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL);
```

Foreign keys: `actor_user_id` → `users.id` (delete NO ACTION, update NO ACTION).

Indexes:

- `sqlite_autoindex_audit_events_1`: UNIQUE (id), constraint autoindex.

## auth_rate_limits

```sql
CREATE TABLE auth_rate_limits (bucket_key TEXT PRIMARY KEY, window_start_ms INTEGER NOT NULL, attempt_count INTEGER NOT NULL CHECK(attempt_count > 0));
```

Foreign keys: none.

Indexes:

- `sqlite_autoindex_auth_rate_limits_1`: UNIQUE (bucket_key), constraint autoindex.

## business_statement_preferences

```sql
CREATE TABLE business_statement_preferences (
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),user_id TEXT NOT NULL REFERENCES users(id),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),activated_at TEXT NOT NULL,next_due_at TEXT NOT NULL,updated_at TEXT NOT NULL,
  PRIMARY KEY(restaurant_id,user_id)
);
```

Foreign keys: `user_id` → `users.id` (delete NO ACTION, update NO ACTION); `restaurant_id` → `restaurants.id` (delete NO ACTION, update NO ACTION).

Indexes:

- `business_statement_due_idx`: (enabled, next_due_at), explicit. SQL: `CREATE INDEX business_statement_due_idx ON business_statement_preferences(enabled,next_due_at)`
- `sqlite_autoindex_business_statement_preferences_1`: UNIQUE (restaurant_id, user_id), constraint autoindex.

## business_weekly_statement_outbox

```sql
CREATE TABLE business_weekly_statement_outbox (
  id TEXT PRIMARY KEY,restaurant_id TEXT NOT NULL REFERENCES restaurants(id),user_id TEXT NOT NULL REFERENCES users(id),
  recipient TEXT NOT NULL,week_from TEXT NOT NULL,week_to TEXT NOT NULL,summary TEXT NOT NULL,csv TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,mode TEXT NOT NULL CHECK(mode IN ('local','smtp','graph','off')),
  status TEXT NOT NULL CHECK(status IN ('pending','claimed','local_saved','sent','failed','unknown','cancelled')),
  lease_owner TEXT,lease_expires_at TEXT,dispatch_started_at TEXT,attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT,
  queued_at TEXT NOT NULL,sent_at TEXT,updated_at TEXT NOT NULL,
  UNIQUE(restaurant_id,user_id,week_from)
);
```

Foreign keys: `user_id` → `users.id` (delete NO ACTION, update NO ACTION); `restaurant_id` → `restaurants.id` (delete NO ACTION, update NO ACTION).

Indexes:

- `business_statement_owner_idx`: (restaurant_id, user_id, week_from), explicit. SQL: `CREATE INDEX business_statement_owner_idx ON business_weekly_statement_outbox(restaurant_id,user_id,week_from DESC)`
- `business_statement_dispatch_idx`: (status, queued_at, lease_expires_at), explicit. SQL: `CREATE INDEX business_statement_dispatch_idx ON business_weekly_statement_outbox(status,queued_at,lease_expires_at)`
- `sqlite_autoindex_business_weekly_statement_outbox_3`: UNIQUE (restaurant_id, user_id, week_from), constraint autoindex.
- `sqlite_autoindex_business_weekly_statement_outbox_2`: UNIQUE (message_id), constraint autoindex.
- `sqlite_autoindex_business_weekly_statement_outbox_1`: UNIQUE (id), constraint autoindex.

## cash_collections

```sql
CREATE TABLE cash_collections (id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL REFERENCES restaurants(id), mandate_id TEXT NOT NULL REFERENCES cash_mandates(id), operation_key TEXT NOT NULL UNIQUE, amount_minor INTEGER NOT NULL CHECK(amount_minor > 0), status TEXT NOT NULL CHECK(status IN ('pending','succeeded','failed','delayed')), provider_mode TEXT NOT NULL, failure TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
```

Foreign keys: `mandate_id` → `cash_mandates.id` (delete NO ACTION, update NO ACTION); `restaurant_id` → `restaurants.id` (delete NO ACTION, update NO ACTION).

Indexes:

- `sqlite_autoindex_cash_collections_2`: UNIQUE (operation_key), constraint autoindex.
- `sqlite_autoindex_cash_collections_1`: UNIQUE (id), constraint autoindex.

## cash_mandates

```sql
CREATE TABLE cash_mandates (id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL UNIQUE REFERENCES restaurants(id), status TEXT NOT NULL CHECK(status IN ('created','authorised','revoked','failed')), provider_mode TEXT NOT NULL, operation_key TEXT NOT NULL UNIQUE, provider_reference TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
```

Foreign keys: `restaurant_id` → `restaurants.id` (delete NO ACTION, update NO ACTION).

Indexes:

- `sqlite_autoindex_cash_mandates_3`: UNIQUE (operation_key), constraint autoindex.
- `sqlite_autoindex_cash_mandates_2`: UNIQUE (restaurant_id), constraint autoindex.
- `sqlite_autoindex_cash_mandates_1`: UNIQUE (id), constraint autoindex.

## cash_settlements

```sql
CREATE TABLE cash_settlements (id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL REFERENCES restaurants(id), actor_user_id TEXT NOT NULL REFERENCES users(id), idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, amount_minor INTEGER NOT NULL CHECK(amount_minor > 0), reference TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(actor_user_id,idempotency_key));
```

Foreign keys: `actor_user_id` → `users.id` (delete NO ACTION, update NO ACTION); `restaurant_id` → `restaurants.id` (delete NO ACTION, update NO ACTION).

Indexes:

- `sqlite_autoindex_cash_settlements_2`: UNIQUE (actor_user_id, idempotency_key), constraint autoindex.
- `sqlite_autoindex_cash_settlements_1`: UNIQUE (id), constraint autoindex.

## commission_policies

```sql
CREATE TABLE commission_policies (id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL REFERENCES restaurants(id), rate_bps INTEGER NOT NULL CHECK(rate_bps BETWEEN 0 AND 10000), commission_base TEXT NOT NULL CHECK(commission_base IN ('food','food_plus_delivery')), starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, duration_months INTEGER NOT NULL, version TEXT NOT NULL, development_assumption INTEGER NOT NULL CHECK(development_assumption IN (0,1)), accepted_at TEXT, accepted_by_user_id TEXT REFERENCES users(id), created_at TEXT NOT NULL, UNIQUE(restaurant_id,version));
```

Foreign keys: `accepted_by_user_id` → `users.id` (delete NO ACTION, update NO ACTION); `restaurant_id` → `restaurants.id` (delete NO ACTION, update NO ACTION).

Indexes:

- `sqlite_autoindex_commission_policies_2`: UNIQUE (restaurant_id, version), constraint autoindex.
- `sqlite_autoindex_commission_policies_1`: UNIQUE (id), constraint autoindex.

## contracts

```sql
CREATE TABLE contracts (id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL UNIQUE REFERENCES restaurants(id) ON DELETE CASCADE, rate_bps INTEGER NOT NULL, duration_months INTEGER NOT NULL, policy_version TEXT NOT NULL, demo_only INTEGER NOT NULL CHECK(demo_only IN (0,1)), accepted_at TEXT, accepted_by_user_id TEXT REFERENCES users(id), created_at TEXT NOT NULL);
```

Foreign keys: `accepted_by_user_id` → `users.id` (delete NO ACTION, update NO ACTION); `restaurant_id` → `restaurants.id` (delete CASCADE, update NO ACTION).

Indexes:

- `sqlite_autoindex_contracts_2`: UNIQUE (restaurant_id), constraint autoindex.
- `sqlite_autoindex_contracts_1`: UNIQUE (id), constraint autoindex.

## customer_email_delivery_settings

```sql
CREATE TABLE customer_email_delivery_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  mode TEXT NOT NULL CHECK(mode IN ('local','smtp','graph','off')),
  payment_provider_mode TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Foreign keys: none.

Indexes:

None (an INTEGER PRIMARY KEY may use the rowid).

## customer_transactional_email_outbox

```sql
CREATE TABLE "customer_transactional_email_outbox" (
  id TEXT PRIMARY KEY,customer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_id TEXT REFERENCES user_notifications(id) ON DELETE SET NULL,
  source_key TEXT NOT NULL,event_kind TEXT NOT NULL CHECK(event_kind IN ('order_update','order_message','customer_message','support_reply','support_update','case_update')),
  source_message_id TEXT,order_id TEXT REFERENCES orders(id),restaurant_id TEXT REFERENCES restaurants(id),
  conversation_id TEXT REFERENCES restaurant_customer_threads(id) ON DELETE SET NULL,
  support_case_id TEXT REFERENCES support_cases(id) ON DELETE SET NULL,refund_case_id TEXT REFERENCES refund_cases(id) ON DELETE SET NULL,
  recipient TEXT NOT NULL,payload TEXT NOT NULL,message_id TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK(mode IN ('local','smtp','graph','off')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','claimed','local_saved','sent','failed','unknown','cancelled')),
  lease_owner TEXT,lease_expires_at TEXT,dispatch_started_at TEXT,attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT,
  queued_at TEXT NOT NULL,sent_at TEXT,updated_at TEXT NOT NULL,UNIQUE(customer_id,source_key)
);
```

Foreign keys: `refund_case_id` → `refund_cases.id` (delete SET NULL, update NO ACTION); `support_case_id` → `support_cases.id` (delete SET NULL, update NO ACTION); `conversation_id` → `restaurant_customer_threads.id` (delete SET NULL, update NO ACTION); `restaurant_id` → `restaurants.id` (delete NO ACTION, update NO ACTION); `order_id` → `orders.id` (delete NO ACTION, update NO ACTION); `notification_id` → `user_notifications.id` (delete SET NULL, update NO ACTION); `customer_id` → `users.id` (delete CASCADE, update NO ACTION).

Indexes:

- `customer_transactional_email_customer_idx`: (customer_id, queued_at, id), explicit. SQL: `CREATE INDEX customer_transactional_email_customer_idx ON customer_transactional_email_outbox(customer_id,queued_at DESC,id)`
- `customer_transactional_email_dispatch_idx`: (status, queued_at, lease_expires_at), explicit. SQL: `CREATE INDEX customer_transactional_email_dispatch_idx ON customer_transactional_email_outbox(status,queued_at,lease_expires_at)`
- `sqlite_autoindex_customer_transactional_email_outbox_3`: UNIQUE (customer_id, source_key), constraint autoindex.
- `sqlite_autoindex_customer_transactional_email_outbox_2`: UNIQUE (message_id), constraint autoindex.
- `sqlite_autoindex_customer_transactional_email_outbox_1`: UNIQUE (id), constraint autoindex.

## deletion_requests

```sql
CREATE TABLE deletion_requests (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), reason TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('requested','under_review','resolved')), note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
```

Foreign keys: `user_id` → `users.id` (delete NO ACTION, update NO ACTION).

Indexes:

- `sqlite_autoindex_deletion_requests_1`: UNIQUE (id), constraint autoindex.

## device_print_jobs

```sql
CREATE TABLE device_print_jobs (id TEXT PRIMARY KEY, printer_id TEXT NOT NULL REFERENCES restaurant_printers(id), order_id TEXT NOT NULL REFERENCES orders(id), operation_key TEXT NOT NULL UNIQUE, receipt TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','claimed','printed','failed','uncertain')), manual_reprint INTEGER NOT NULL DEFAULT 0 CHECK(manual_reprint IN (0,1)), attempt INTEGER NOT NULL DEFAULT 0, claim_token_hash TEXT, lease_expires_at TEXT, detail TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, claimed_by_device_id TEXT REFERENCES printer_devices(id));
```

Foreign keys: `claimed_by_device_id` → `printer_devices.id` (delete NO ACTION, update NO ACTION); `order_id` → `orders.id` (delete NO ACTION, update NO ACTION); `printer_id` → `restaurant_printers.id` (delete NO ACTION, update NO ACTION).

Indexes:

- `device_print_jobs_claim_idx`: (printer_id, status, created_at), explicit. SQL: `CREATE INDEX device_print_jobs_claim_idx ON device_print_jobs(printer_id,status,created_at)`
- `sqlite_autoindex_device_print_jobs_2`: UNIQUE (operation_key), constraint autoindex.
- `sqlite_autoindex_device_print_jobs_1`: UNIQUE (id), constraint autoindex.

## dispute_customer_responses

```sql
CREATE TABLE dispute_customer_responses (id TEXT PRIMARY KEY,proposal_id TEXT NOT NULL REFERENCES dispute_remedy_proposals(id) ON DELETE CASCADE,customer_id TEXT NOT NULL REFERENCES users(id),idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL,decision TEXT NOT NULL CHECK(decision IN ('accept','decline')),created_at TEXT NOT NULL,UNIQUE(customer_id,idempotency_key),UNIQUE(proposal_id));
```

Foreign keys: `customer_id` → `users.id` (delete NO ACTION, update NO ACTION); `proposal_id` → `dispute_remedy_proposals.id` (delete CASCADE, update NO ACTION).

Indexes:

- `sqlite_autoindex_dispute_customer_responses_3`: UNIQUE (proposal_id), constraint autoindex.
- `sqlite_autoindex_dispute_customer_responses_2`: UNIQUE (customer_id, idempotency_key), constraint autoindex.
- `sqlite_autoindex_dispute_customer_responses_1`: UNIQUE (id), constraint autoindex.

## dispute_remedy_fulfilments

```sql
CREATE TABLE dispute_remedy_fulfilments (id TEXT PRIMARY KEY,proposal_id TEXT NOT NULL REFERENCES dispute_remedy_proposals(id) ON DELETE CASCADE,actor_user_id TEXT NOT NULL REFERENCES users(id),idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL,action TEXT NOT NULL CHECK(action IN ('restaurant_evidence','customer_confirmed','admin_override')),evidence TEXT NOT NULL,reason TEXT,created_at TEXT NOT NULL,UNIQUE(actor_user_id,idempotency_key),UNIQUE(proposal_id,action));
```

Foreign keys: `actor_user_id` → `users.id` (delete NO ACTION, update NO ACTION); `proposal_id` → `dispute_remedy_proposals.id` (delete CASCADE, update NO ACTION).

Indexes:

- `dispute_fulfilments_proposal_idx`: (proposal_id, created_at), explicit. SQL: `CREATE INDEX dispute_fulfilments_proposal_idx ON dispute_remedy_fulfilments(proposal_id,created_at)`
- `sqlite_autoindex_dispute_remedy_fulfilments_3`: UNIQUE (proposal_id, action), constraint autoindex.
- `sqlite_autoindex_dispute_remedy_fulfilments_2`: UNIQUE (actor_user_id, idempotency_key), constraint autoindex.
- `sqlite_autoindex_dispute_remedy_fulfilments_1`: UNIQUE (id), constraint autoindex.

## dispute_remedy_proposals

```sql
CREATE TABLE dispute_remedy_proposals (id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES refund_cases(id) ON DELETE CASCADE,restaurant_id TEXT NOT NULL REFERENCES restaurants(id),created_by_user_id TEXT NOT NULL REFERENCES users(id),idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL,type TEXT NOT NULL CHECK(type IN ('missing_item','replacement','free_item','voucher','partial_refund','full_refund')),status TEXT NOT NULL CHECK(status IN ('pending','accepted','declined','superseded','fulfilled')),amount_minor INTEGER,voucher_value_minor INTEGER,item_ids TEXT NOT NULL DEFAULT '[]',description TEXT NOT NULL,expires_at TEXT,redemption_conditions TEXT,financial_party TEXT NOT NULL CHECK(financial_party='restaurant'),responded_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(created_by_user_id,idempotency_key));
```

Foreign keys: `created_by_user_id` → `users.id` (delete NO ACTION, update NO ACTION); `restaurant_id` → `restaurants.id` (delete NO ACTION, update NO ACTION); `case_id` → `refund_cases.id` (delete CASCADE, update NO ACTION).

Indexes:

- `dispute_one_pending_proposal`: UNIQUE (case_id), explicit, partial. SQL: `CREATE UNIQUE INDEX dispute_one_pending_proposal ON dispute_remedy_proposals(case_id) WHERE status='pending'`
- `dispute_proposals_case_idx`: (case_id, created_at), explicit. SQL: `CREATE INDEX dispute_proposals_case_idx ON dispute_remedy_proposals(case_id,created_at)`
- `sqlite_autoindex_dispute_remedy_proposals_2`: UNIQUE (created_by_user_id, idempotency_key), constraint autoindex.
- `sqlite_autoindex_dispute_remedy_proposals_1`: UNIQUE (id), constraint autoindex.

## governance_audit

```sql
CREATE TABLE governance_audit (id TEXT PRIMARY KEY, actor_user_id TEXT REFERENCES users(id), action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL);
```

Foreign keys: `actor_user_id` → `users.id` (delete NO ACTION, update NO ACTION).

Indexes:

- `governance_audit_created_idx`: (created_at), explicit. SQL: `CREATE INDEX governance_audit_created_idx ON governance_audit(created_at)`
- `sqlite_autoindex_governance_audit_1`: UNIQUE (id), constraint autoindex.

## integration_status

```sql
CREATE TABLE integration_status (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, mode TEXT NOT NULL CHECK(mode IN ('mock','off')), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), detail TEXT NOT NULL, updated_at TEXT NOT NULL);
```

Foreign keys: none.

Indexes:

- `sqlite_autoindex_integration_status_2`: UNIQUE (name), constraint autoindex.
- `sqlite_autoindex_integration_status_1`: UNIQUE (id), constraint autoindex.

## journal_postings

```sql
CREATE TABLE journal_postings (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, operation_key TEXT NOT NULL REFERENCES marketplace_operations(operation_key), restaurant_id TEXT NOT NULL REFERENCES restaurants(id), order_id TEXT REFERENCES orders(id), account TEXT NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('debit','credit')), amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0), currency TEXT NOT NULL DEFAULT 'GBP', source_type TEXT NOT NULL, source_id TEXT NOT NULL, provider_mode TEXT NOT NULL, created_at TEXT NOT NULL);
```

Foreign keys: `order_id` → `orders.id` (delete NO ACTION, update NO ACTION); `restaurant_id` → `restaurants.id` (delete NO ACTION, update NO ACTION); `operation_key` → `marketplace_operations.operation_key` (delete NO ACTION, update NO ACTION).

Indexes:

- `journal_postings_restaurant_idx`: (restaurant_id, created_at), explicit. SQL: `CREATE INDEX journal_postings_restaurant_idx ON journal_postings(restaurant_id,created_at)`
- `sqlite_autoindex_journal_postings_1`: UNIQUE (id), constraint autoindex.

## ledger_entries

```sql
CREATE TABLE "ledger_entries" (id TEXT PRIMARY KEY, order_id TEXT REFERENCES orders(id), restaurant_id TEXT NOT NULL REFERENCES restaurants(id), kind TEXT NOT NULL, amount_minor INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'GBP', reference_type TEXT NOT NULL DEFAULT 'order', reference_id TEXT, created_at TEXT NOT NULL);
```

Foreign keys: `restaurant_id` → `restaurants.id` (delete NO ACTION, update NO ACTION); `order_id` → `orders.id` (delete NO ACTION, update NO ACTION).

Indexes:

- `ledger_reference_unique`: UNIQUE (kind, reference_type, reference_id), explicit. SQL: `CREATE UNIQUE INDEX ledger_reference_unique ON ledger_entries(kind,reference_type,reference_id)`
- `sqlite_autoindex_ledger_entries_1`: UNIQUE (id), constraint autoindex.

## local_mail_sink

```sql
CREATE TABLE local_mail_sink (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('password_reset','email_verification')), recipient TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
```

Foreign keys: `user_id` → `users.id` (delete CASCADE, update NO ACTION).

Indexes:

- `local_mail_sink_created_idx`: (created_at), explicit. SQL: `CREATE INDEX local_mail_sink_created_idx ON local_mail_sink(created_at)`
- `sqlite_autoindex_local_mail_sink_1`: UNIQUE (id), constraint autoindex.

## local_notifications

```sql
CREATE TABLE local_notifications (id TEXT PRIMARY KEY, outbox_id TEXT NOT NULL UNIQUE REFERENCES notification_outbox(id), event_type TEXT NOT NULL, entity_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
```

Foreign keys: `outbox_id` → `notification_outbox.id` (delete NO ACTION, update NO ACTION).

Indexes:

- `sqlite_autoindex_local_notifications_2`: UNIQUE (outbox_id), constraint autoindex.
- `sqlite_autoindex_local_notifications_1`: UNIQUE (id), constraint autoindex.

## loyalty_settings

```sql
CREATE TABLE loyalty_settings (restaurant_id TEXT PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE, regular_order_count INTEGER NOT NULL DEFAULT 3 CHECK(regular_order_count BETWEEN 2 AND 100), regular_window_days INTEGER NOT NULL DEFAULT 60 CHECK(regular_window_days BETWEEN 7 AND 730), lapsed_after_days INTEGER NOT NULL DEFAULT 30 CHECK(lapsed_after_days BETWEEN 7 AND 730), updated_by_user_id TEXT REFERENCES users(id), updated_at TEXT NOT NULL);
```

Foreign keys: `updated_by_user_id` → `users.id` (delete NO ACTION, update NO ACTION); `restaurant_id` → `restaurants.id` (delete CASCADE, update NO ACTION).

Indexes:

- `sqlite_autoindex_loyalty_settings_1`: UNIQUE (restaurant_id), constraint autoindex.

## marketing_preferences

```sql
CREATE TABLE marketing_preferences (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, in_app_promotions INTEGER NOT NULL DEFAULT 0 CHECK(in_app_promotions IN (0,1)), push_promotions INTEGER NOT NULL DEFAULT 0 CHECK(push_promotions IN (0,1)), consent_version TEXT NOT NULL DEFAULT 'loyalty-v1', consent_source TEXT NOT NULL DEFAULT 'default', consented_at TEXT, updated_at TEXT NOT NULL);
```

Foreign keys: `user_id` → `users.id` (delete CASCADE, update NO ACTION).

Indexes:

- `sqlite_autoindex_marketing_preferences_1`: UNIQUE (user_id), constraint autoindex.

## marketplace_operations

```sql
CREATE TABLE "marketplace_operations" (id TEXT PRIMARY KEY,operation_key TEXT NOT NULL UNIQUE,restaurant_id TEXT NOT NULL REFERENCES restaurants(id),order_id TEXT REFERENCES orders(id),kind TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','confirmed','failed','delayed','held','cancelled','unknown')),amount_minor INTEGER NOT NULL CHECK(amount_minor>=0),currency TEXT NOT NULL DEFAULT 'GBP',provider_mode TEXT NOT NULL CHECK(provider_mode IN ('local_simulator','stripe_test','stripe_live')),provider_reference TEXT,error TEXT,metadata TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
```

Foreign keys: `order_id` → `orders.id` (delete NO ACTION, update NO ACTION); `restaurant_id` → `restaurants.id` (delete NO ACTION, update NO ACTION).

Indexes:

- `marketplace_operations_order_idx`: (order_id, created_at), explicit. SQL: `CREATE INDEX marketplace_operations_order_idx ON marketplace_operations(order_id,created_at)`
- `marketplace_operations_restaurant_idx`: (restaurant_id, created_at), explicit. SQL: `CREATE INDEX marketplace_operations_restaurant_idx ON marketplace_operations(restaurant_id,created_at)`
- `sqlite_autoindex_marketplace_operations_2`: UNIQUE (operation_key), constraint autoindex.
- `sqlite_autoindex_marketplace_operations_1`: UNIQUE (id), constraint autoindex.

## marketplace_report_jobs

```sql
CREATE TABLE marketplace_report_jobs (id TEXT PRIMARY KEY, restaurant_id TEXT REFERENCES restaurants(id), actor_user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL CHECK(kind IN ('finance_statement')), status TEXT NOT NULL CHECK(status IN ('queued','completed','failed')), request_hash TEXT NOT NULL, content BLOB, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
```

Foreign keys: `actor_user_id` → `users.id` (delete NO ACTION, update NO ACTION); `restaurant_id` → `restaurants.id` (delete NO ACTION, update NO ACTION).

Indexes:

- `marketplace_report_actor_idx`: (actor_user_id, created_at), explicit. SQL: `CREATE INDEX marketplace_report_actor_idx ON marketplace_report_jobs(actor_user_id,created_at)`
- `sqlite_autoindex_marketplace_report_jobs_1`: UNIQUE (id), constraint autoindex.

## marketplace_worker_jobs

```sql
CREATE TABLE marketplace_worker_jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, entity_id TEXT NOT NULL, operation_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('queued','claimed','completed','failed','delayed')), lease_owner TEXT, lease_expires_at TEXT, attempts INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL DEFAULT '{}', error TEXT, available_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
```

Foreign keys: none.

Indexes:

- `sqlite_autoindex_marketplace_worker_jobs_2`: UNIQUE (operation_key), constraint autoindex.
- `sqlite_autoindex_marketplace_worker_jobs_1`: UNIQUE (id), constraint autoindex.

## media_assets

```sql
CREATE TABLE media_assets (id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE, mime_type TEXT NOT NULL CHECK(mime_type IN ('image/png','image/jpeg')), data BLOB NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, byte_length INTEGER NOT NULL, created_at TEXT NOT NULL);
```

Foreign keys: `restaurant_id` → `restaurants.id` (delete CASCADE, update NO ACTION).

Indexes:

- `sqlite_autoindex_media_assets_1`: UNIQUE (id), constraint autoindex.

## menu_imports

```sql
CREATE TABLE menu_imports (id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE, actor_user_id TEXT NOT NULL REFERENCES users(id), idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, item_ids TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(actor_user_id,idempotency_key));
```

Foreign keys: `actor_user_id` → `users.id` (delete NO ACTION, update NO ACTION); `restaurant_id` → `restaurants.id` (delete CASCADE, update NO ACTION).

Indexes:

- `sqlite_autoindex_menu_imports_2`: UNIQUE (actor_user_id, idempotency_key), constraint autoindex.
- `sqlite_autoindex_menu_imports_1`: UNIQUE (id), constraint autoindex.

## menu_items

```sql
CREATE TABLE menu_items (id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', price_minor INTEGER NOT NULL CHECK(price_minor >= 0), available INTEGER NOT NULL DEFAULT 1 CHECK(available IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, category TEXT NOT NULL DEFAULT '', allergens TEXT NOT NULL DEFAULT '[]', dietary_tags TEXT NOT NULL DEFAULT '[]', modifier_groups TEXT NOT NULL DEFAULT '[]', photo_media_id TEXT REFERENCES media_assets(id), sort_order INTEGER NOT NULL DEFAULT 0, product_type TEXT NOT NULL DEFAULT '', energy_kcal INTEGER CHECK(energy_kcal IS NULL OR energy_kcal BETWEEN 0 AND 20000), energy_kj INTEGER CHECK(energy_kj IS NULL OR energy_kj BETWEEN 0 AND 84000));
```

Foreign keys: `photo_media_id` → `media_assets.id` (delete NO ACTION, update NO ACTION); `restaurant_id` → `restaurants.id` (delete CASCADE, update NO ACTION).

Indexes:

- `sqlite_autoindex_menu_items_1`: UNIQUE (id), constraint autoindex.

## native_business_sessions

```sql
CREATE TABLE native_business_sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT
);
```

Foreign keys: `user_id` → `users.id` (delete CASCADE, update NO ACTION).

Indexes:

- `native_business_sessions_user_idx`: (user_id, expires_at), explicit. SQL: `CREATE INDEX native_business_sessions_user_idx ON native_business_sessions(user_id,expires_at)`
- `sqlite_autoindex_native_business_sessions_2`: UNIQUE (token_hash), constraint autoindex.
- `sqlite_autoindex_native_business_sessions_1`: UNIQUE (id), constraint autoindex.

## native_sessions

```sql
CREATE TABLE native_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT);
```

Foreign keys: `user_id` → `users.id` (delete CASCADE, update NO ACTION).

Indexes:

- `native_sessions_user_idx`: (user_id, expires_at), explicit. SQL: `CREATE INDEX native_sessions_user_idx ON native_sessions(user_id,expires_at)`
- `sqlite_autoindex_native_sessions_2`: UNIQUE (token_hash), constraint autoindex.
- `sqlite_autoindex_native_sessions_1`: UNIQUE (id), constraint autoindex.

## notification_outbox

```sql
CREATE TABLE notification_outbox (id TEXT PRIMARY KEY, event_type TEXT NOT NULL, entity_id TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','delivered','failed')), attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(event_type,entity_id));
```

Foreign keys: none.

Indexes:

- `sqlite_autoindex_notification_outbox_2`: UNIQUE (event_type, entity_id), constraint autoindex.
- `sqlite_autoindex_notification_outbox_1`: UNIQUE (id), constraint autoindex.

## offer_campaigns

```sql
CREATE TABLE offer_campaigns (id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL REFERENCES restaurants(id), created_by_user_id TEXT NOT NULL REFERENCES users(id), idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, menu_item_id TEXT NOT NULL REFERENCES menu_items(id), item_name TEXT NOT NULL, item_value_minor INTEGER NOT NULL CHECK(item_value_minor >= 0), min_subtotal_minor INTEGER NOT NULL CHECK(min_subtotal_minor >= 0), expires_at TEXT NOT NULL, created_at TEXT NOT NULL, offer_type TEXT NOT NULL DEFAULT 'free_item' CHECK(offer_type IN ('free_item','percent_off','fixed_off')), offer_value INTEGER NOT NULL DEFAULT 0 CHECK(offer_value >= 0), starts_at TEXT, redemption_limit INTEGER NOT NULL DEFAULT 100000 CHECK(redemption_limit BETWEEN 1 AND 100000), budget_minor INTEGER CHECK(budget_minor IS NULL OR budget_minor >= 0), eligible_item_ids TEXT NOT NULL DEFAULT '[]', eligible_categories TEXT NOT NULL DEFAULT '[]', recipient_segment TEXT NOT NULL DEFAULT 'selected' CHECK(recipient_segment IN ('selected','new','returning','regular','lapsed','first_order')), stacking_policy TEXT NOT NULL DEFAULT 'exclusive' CHECK(stacking_policy='exclusive'), funding_party TEXT NOT NULL DEFAULT 'restaurant' CHECK(funding_party='restaurant'), segment_snapshot TEXT NOT NULL DEFAULT '{}', UNIQUE(created_by_user_id,idempotency_key));
```

Foreign keys: `menu_item_id` → `menu_items.id` (delete NO ACTION, update NO ACTION); `created_by_user_id` → `users.id` (delete NO ACTION, update NO ACTION); `restaurant_id` → `restaurants.id` (delete NO ACTION, update NO ACTION).

Indexes:

- `loyalty_campaign_window`: (restaurant_id, starts_at, expires_at), explicit. SQL: `CREATE INDEX loyalty_campaign_window ON offer_campaigns(restaurant_id,starts_at,expires_at)`
- `sqlite_autoindex_offer_campaigns_2`: UNIQUE (created_by_user_id, idempotency_key), constraint autoindex.
- `sqlite_autoindex_offer_campaigns_1`: UNIQUE (id), constraint autoindex.

## offer_grants

```sql
CREATE TABLE offer_grants (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES offer_campaigns(id) ON DELETE CASCADE, restaurant_id TEXT NOT NULL REFERENCES restaurants(id), customer_id TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL CHECK(status IN ('available','reserved','redeemed','expired')), viewed_at TEXT, reserved_order_id TEXT REFERENCES orders(id), redeemed_order_id TEXT REFERENCES orders(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, reserved_discount_minor INTEGER NOT NULL DEFAULT 0 CHECK(reserved_discount_minor >= 0), UNIQUE(campaign_id,customer_id));
```

Foreign keys: `redeemed_order_id` → `orders.id` (delete NO ACTION, update NO ACTION); `reserved_order_id` → `orders.id` (delete NO ACTION, update NO ACTION); `customer_id` → `users.id` (delete NO ACTION, update NO ACTION); `restaurant_id` → `restaurants.id` (delete NO ACTION, update NO ACTION); `campaign_id` → `offer_campaigns.id` (delete CASCADE, update NO ACTION).

Indexes:

- `offer_grants_customer_idx`: (customer_id, created_at), explicit. SQL: `CREATE INDEX offer_grants_customer_idx ON offer_grants(customer_id,created_at)`
- `sqlite_autoindex_offer_grants_2`: UNIQUE (campaign_id, customer_id), constraint autoindex.
- `sqlite_autoindex_offer_grants_1`: UNIQUE (id), constraint autoindex.

## operational_jobs

```sql
CREATE TABLE operational_jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, entity_id TEXT, status TEXT NOT NULL CHECK(status IN ('completed','failed')), attempts INTEGER NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(kind,entity_id));
```

Foreign keys: none.

Indexes:

- `sqlite_autoindex_operational_jobs_2`: UNIQUE (kind, entity_id), constraint autoindex.
- `sqlite_autoindex_operational_jobs_1`: UNIQUE (id), constraint autoindex.

## order_confirmation_email_outbox

```sql
CREATE TABLE "order_confirmation_email_outbox" (
  id TEXT PRIMARY KEY,order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  recipient TEXT NOT NULL,subject TEXT NOT NULL,body TEXT NOT NULL,message_id TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK(mode IN ('local','smtp','graph','off')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','claimed','local_saved','sent','failed','unknown','cancelled')),
  lease_owner TEXT,lease_expires_at TEXT,dispatch_started_at TEXT,attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT,
  queued_at TEXT NOT NULL,sent_at TEXT,updated_at TEXT NOT NULL
);
```

Foreign keys: `restaurant_id` → `restaurants.id` (delete NO ACTION, update NO ACTION); `order_id` → `orders.id` (delete NO ACTION, update NO ACTION).

Indexes:

- `order_confirmation_email_dispatch_idx`: (status, queued_at, lease_expires_at), explicit. SQL: `CREATE INDEX order_confirmation_email_dispatch_idx ON order_confirmation_email_outbox(status,queued_at,lease_expires_at)`
- `sqlite_autoindex_order_confirmation_email_outbox_3`: UNIQUE (message_id), constraint autoindex.
- `sqlite_autoindex_order_confirmation_email_outbox_2`: UNIQUE (order_id), constraint autoindex.
- `sqlite_autoindex_order_confirmation_email_outbox_1`: UNIQUE (id), constraint autoindex.

## order_events

```sql
CREATE TABLE order_events (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE, actor_user_id TEXT REFERENCES users(id), kind TEXT NOT NULL, from_status TEXT, to_status TEXT, created_at TEXT NOT NULL);
```

Foreign keys: `actor_user_id` → `users.id` (delete NO ACTION, update NO ACTION); `order_id` → `orders.id` (delete CASCADE, update NO ACTION).

Indexes:

- `sqlite_autoindex_order_events_1`: UNIQUE (id), constraint autoindex.

## order_items

```sql
CREATE TABLE order_items (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE, menu_item_id TEXT NOT NULL REFERENCES menu_items(id), name TEXT NOT NULL, unit_price_minor INTEGER NOT NULL CHECK(unit_price_minor >= 0), quantity INTEGER NOT NULL CHECK(quantity > 0), base_price_minor INTEGER NOT NULL DEFAULT 0, selected_modifiers TEXT NOT NULL DEFAULT '[]', allergens TEXT NOT NULL DEFAULT '[]', category TEXT NOT NULL DEFAULT '', is_offer_item INTEGER NOT NULL DEFAULT 0 CHECK(is_offer_item IN (0,1)));
```

Foreign keys: `menu_item_id` → `menu_items.id` (delete NO ACTION, update NO ACTION); `order_id` → `orders.id` (delete CASCADE, update NO ACTION).

Indexes:

- `sqlite_autoindex_order_items_1`: UNIQUE (id), constraint autoindex.

## order_message_incidents

```sql
CREATE TABLE order_message_incidents (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  reporter_user_id TEXT NOT NULL REFERENCES users(id),
  reporter_role TEXT NOT NULL CHECK(reporter_role IN ('customer','restaurant')),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reported' CHECK(status IN ('reported','under_review','resolved')),
  admin_note TEXT NOT NULL DEFAULT '',
  reviewed_by_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Foreign keys: `reviewed_by_user_id` → `users.id` (delete NO ACTION, update NO ACTION); `reporter_user_id` → `users.id` (delete NO ACTION, update NO ACTION); `order_id` → `orders.id` (delete CASCADE, update NO ACTION).

Indexes:

- `order_message_incidents_order_idx`: (order_id, created_at), explicit. SQL: `CREATE INDEX order_message_incidents_order_idx ON order_message_incidents(order_id,created_at)`
- `order_message_incidents_status_idx`: (status, created_at), explicit. SQL: `CREATE INDEX order_message_incidents_status_idx ON order_message_incidents(status,created_at)`
- `sqlite_autoindex_order_message_incidents_1`: UNIQUE (id), constraint autoindex.

## order_message_rate_limits

```sql
CREATE TABLE order_message_rate_limits (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  window_start_ms INTEGER NOT NULL,
  message_count INTEGER NOT NULL CHECK(message_count > 0),
  PRIMARY KEY(user_id,order_id)
);
```

Foreign keys: `order_id` → `orders.id` (delete CASCADE, update NO ACTION); `user_id` → `users.id` (delete CASCADE, update NO ACTION).

Indexes:

- `sqlite_autoindex_order_message_rate_limits_1`: UNIQUE (user_id, order_id), constraint autoindex.

## order_message_reads

```sql
CREATE TABLE order_message_reads (
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_created_at TEXT NOT NULL,
  last_read_message_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(order_id,user_id)
);
```

Foreign keys: `user_id` → `users.id` (delete CASCADE, update NO ACTION); `order_id` → `orders.id` (delete CASCADE, update NO ACTION).

Indexes:

- `sqlite_autoindex_order_message_reads_1`: UNIQUE (order_id, user_id), constraint autoindex.

## order_message_settings

```sql
CREATE TABLE order_message_settings (
  restaurant_id TEXT PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  quick_responses TEXT NOT NULL,
  support_window_minutes INTEGER NOT NULL DEFAULT 120 CHECK(support_window_minutes BETWEEN 0 AND 1440),
  updated_by_user_id TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL
);
```

Foreign keys: `updated_by_user_id` → `users.id` (delete NO ACTION, update NO ACTION); `restaurant_id` → `restaurants.id` (delete CASCADE, update NO ACTION).

Indexes:

- `sqlite_autoindex_order_message_settings_1`: UNIQUE (restaurant_id), constraint autoindex.

## order_messages

```sql
CREATE TABLE order_messages (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sender_user_id TEXT NOT NULL REFERENCES users(id),
  sender_role TEXT NOT NULL CHECK(sender_role IN ('customer','restaurant')),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  key_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(sender_user_id,order_id,idempotency_key)
);
```

Foreign keys: `sender_user_id` → `users.id` (delete NO ACTION, update NO ACTION); `order_id` → `orders.id` (delete CASCADE, update NO ACTION).

Indexes:

- `order_messages_expiry_idx`: (expires_at), explicit. SQL: `CREATE INDEX order_messages_expiry_idx ON order_messages(expires_at)`
- `order_messages_order_created_idx`: (order_id, created_at, id), explicit. SQL: `CREATE INDEX order_messages_order_created_idx ON order_messages(order_id,created_at,id)`
- `sqlite_autoindex_order_messages_2`: UNIQUE (sender_user_id, order_id, idempotency_key), constraint autoindex.
- `sqlite_autoindex_order_messages_1`: UNIQUE (id), constraint autoindex.

## orders

```sql
CREATE TABLE "orders" (id TEXT PRIMARY KEY,restaurant_id TEXT NOT NULL REFERENCES restaurants(id),restaurant_name TEXT NOT NULL,customer_id TEXT NOT NULL REFERENCES users(id),status TEXT NOT NULL CHECK(status IN ('placed','accepted','preparing','ready','out_for_delivery','completed','rejected')),currency TEXT NOT NULL DEFAULT 'GBP',subtotal_minor INTEGER NOT NULL CHECK(subtotal_minor>=0),delivery_fee_minor INTEGER NOT NULL DEFAULT 0 CHECK(delivery_fee_minor>=0),total_minor INTEGER NOT NULL DEFAULT 0 CHECK(total_minor>=0),delivery_address TEXT,commission_minor INTEGER NOT NULL CHECK(commission_minor>=0),payment_method TEXT NOT NULL CHECK(payment_method IN ('mock_card','card','cash')),payment_status TEXT NOT NULL,fulfillment TEXT NOT NULL CHECK(fulfillment IN ('collection','delivery')),idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,contract_rate_bps INTEGER NOT NULL DEFAULT 700,contract_policy_version TEXT NOT NULL DEFAULT 'demo-v1',contract_demo_only INTEGER NOT NULL DEFAULT 1,customer_name TEXT NOT NULL DEFAULT '',customer_email TEXT NOT NULL DEFAULT '',customer_phone TEXT NOT NULL DEFAULT '',delivery_instructions TEXT NOT NULL DEFAULT '',allergy_notes TEXT NOT NULL DEFAULT '',offer_grant_id TEXT REFERENCES offer_grants(id),offer_snapshot TEXT,estimated_ready_at TEXT,commission_base TEXT NOT NULL DEFAULT 'food' CHECK(commission_base IN ('food','food_plus_delivery')),gross_food_minor INTEGER NOT NULL DEFAULT 0,restaurant_discount_minor INTEGER NOT NULL DEFAULT 0,promotion_snapshot TEXT, merchant_visible_at TEXT, confirmation_due_at TEXT, confirmed_at TEXT,UNIQUE(customer_id,idempotency_key));
```

Foreign keys: `offer_grant_id` → `offer_grants.id` (delete NO ACTION, update NO ACTION); `customer_id` → `users.id` (delete NO ACTION, update NO ACTION); `restaurant_id` → `restaurants.id` (delete NO ACTION, update NO ACTION).

Indexes:

- `order_confirmation_due_idx`: (status, confirmation_due_at, restaurant_id), explicit. SQL: `CREATE INDEX order_confirmation_due_idx ON orders(status,confirmation_due_at,restaurant_id)`
- `customer_directory_history_idx`: (restaurant_id, customer_id, created_at, id), explicit. SQL: `CREATE INDEX customer_directory_history_idx ON orders(restaurant_id,customer_id,created_at,id)`
- `loyalty_orders_restaurant_customer`: (restaurant_id, customer_id, status, created_at), explicit. SQL: `CREATE INDEX loyalty_orders_restaurant_customer ON orders(restaurant_id,customer_id,status,created_at)`
- `orders_customer_created_idx`: (customer_id, created_at), explicit. SQL: `CREATE INDEX orders_customer_created_idx ON orders(customer_id,created_at)`
- `orders_restaurant_created_idx`: (restaurant_id, created_at), explicit. SQL: `CREATE INDEX orders_restaurant_created_idx ON orders(restaurant_id,created_at)`
- `sqlite_autoindex_orders_2`: UNIQUE (customer_id, idempotency_key), constraint autoindex.
- `sqlite_autoindex_orders_1`: UNIQUE (id), constraint autoindex.

## payout_batches

```sql
CREATE TABLE "payout_batches" (id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL REFERENCES restaurants(id), operation_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('scheduled','in_transit','pending','paid','failed','held')), amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0), provider_mode TEXT NOT NULL, scheduled_for TEXT, provider_reference TEXT, failure TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
```

Foreign keys: `restaurant_id` → `restaurants.id` (delete NO ACTION, update NO ACTION).

Indexes:

- `sqlite_autoindex_payout_batches_2`: UNIQUE (operation_key), constraint autoindex.
- `sqlite_autoindex_payout_batches_1`: UNIQUE (id), constraint autoindex.

## payout_items

```sql
CREATE TABLE payout_items (payout_id TEXT NOT NULL REFERENCES payout_batches(id), operation_id TEXT NOT NULL REFERENCES marketplace_operations(id), amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0), PRIMARY KEY(payout_id,operation_id));
```

Foreign keys: `operation_id` → `marketplace_operations.id` (delete NO ACTION, update NO ACTION); `payout_id` → `payout_batches.id` (delete NO ACTION, update NO ACTION).

Indexes:

- `sqlite_autoindex_payout_items_1`: UNIQUE (payout_id, operation_id), constraint autoindex.

## print_jobs

```sql
CREATE TABLE print_jobs (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), requested_by_user_id TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL CHECK(status IN ('requested','browser_opened','failed')), error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
```

Foreign keys: `requested_by_user_id` → `users.id` (delete NO ACTION, update NO ACTION); `order_id` → `orders.id` (delete NO ACTION, update NO ACTION).

Indexes:

- `sqlite_autoindex_print_jobs_1`: UNIQUE (id), constraint autoindex.

## printer_devices

```sql
CREATE TABLE printer_devices (id TEXT PRIMARY KEY, printer_id TEXT NOT NULL REFERENCES restaurant_printers(id), restaurant_id TEXT NOT NULL REFERENCES restaurants(id), name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, revoked_at TEXT, last_seen_at TEXT, created_at TEXT NOT NULL);
```

Foreign keys: `restaurant_id` → `restaurants.id` (delete NO ACTION, update NO ACTION); `printer_id` → `restaurant_printers.id` (delete NO ACTION, update NO ACTION).

Indexes:

- `sqlite_autoindex_printer_devices_2`: UNIQUE (token_hash), constraint autoindex.
- `sqlite_autoindex_printer_devices_1`: UNIQUE (id), constraint autoindex.

## printer_job_claim_tokens

```sql
CREATE TABLE printer_job_claim_tokens (job_id TEXT NOT NULL REFERENCES device_print_jobs(id) ON DELETE CASCADE, device_id TEXT NOT NULL REFERENCES printer_devices(id), token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, PRIMARY KEY(job_id,token_hash));
```

Foreign keys: `device_id` → `printer_devices.id` (delete NO ACTION, update NO ACTION); `job_id` → `device_print_jobs.id` (delete CASCADE, update NO ACTION).

Indexes:

- `sqlite_autoindex_printer_job_claim_tokens_2`: UNIQUE (job_id, token_hash), constraint autoindex.
- `sqlite_autoindex_printer_job_claim_tokens_1`: UNIQUE (token_hash), constraint autoindex.

## printer_pairing_codes

```sql
CREATE TABLE printer_pairing_codes (id TEXT PRIMARY KEY, printer_id TEXT NOT NULL REFERENCES restaurant_printers(id), code_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, consumed_at TEXT, created_at TEXT NOT NULL);
```

Foreign keys: `printer_id` → `restaurant_printers.id` (delete NO ACTION, update NO ACTION).

Indexes:

- `sqlite_autoindex_printer_pairing_codes_2`: UNIQUE (code_hash), constraint autoindex.
- `sqlite_autoindex_printer_pairing_codes_1`: UNIQUE (id), constraint autoindex.

## provider_accounts

```sql
CREATE TABLE "provider_accounts" (id TEXT PRIMARY KEY,restaurant_id TEXT NOT NULL UNIQUE REFERENCES restaurants(id),provider_mode TEXT NOT NULL CHECK(provider_mode IN ('local_simulator','stripe_test','stripe_live')),status TEXT NOT NULL CHECK(status IN ('not_started','pending','restricted','enabled')),capabilities TEXT NOT NULL DEFAULT '[]',requirements TEXT NOT NULL DEFAULT '[]',provider_reference TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
```

Foreign keys: `restaurant_id` → `restaurants.id` (delete NO ACTION, update NO ACTION).

Indexes:

- `sqlite_autoindex_provider_accounts_2`: UNIQUE (restaurant_id), constraint autoindex.
- `sqlite_autoindex_provider_accounts_1`: UNIQUE (id), constraint autoindex.

## provider_event_object_state

```sql
CREATE TABLE "provider_event_object_state" (provider TEXT NOT NULL CHECK(provider IN ('stripe_test','stripe_live')),object_id TEXT NOT NULL,object_type TEXT NOT NULL,restaurant_id TEXT NOT NULL REFERENCES restaurants(id),last_event_created_at TEXT NOT NULL,last_event_id TEXT NOT NULL,last_result TEXT NOT NULL DEFAULT '{}',updated_at TEXT NOT NULL,PRIMARY KEY(provider,object_id));
```

Foreign keys: `restaurant_id` → `restaurants.id` (delete NO ACTION, update NO ACTION).

Indexes:

- `provider_event_object_state_restaurant_idx`: (restaurant_id, updated_at), explicit. SQL: `CREATE INDEX provider_event_object_state_restaurant_idx ON provider_event_object_state(restaurant_id,updated_at)`
- `sqlite_autoindex_provider_event_object_state_1`: UNIQUE (provider, object_id), constraint autoindex.

## provider_events

```sql
CREATE TABLE "provider_events" (id TEXT PRIMARY KEY,provider TEXT NOT NULL CHECK(provider IN ('stripe_test','stripe_live')),provider_event_id TEXT NOT NULL,event_type TEXT NOT NULL,object_type TEXT NOT NULL,object_id TEXT NOT NULL,provider_account_reference TEXT,restaurant_id TEXT REFERENCES restaurants(id),payload_fingerprint TEXT NOT NULL,normalized_payload TEXT NOT NULL DEFAULT '{}',provider_created_at TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('queued','claimed','delayed','completed','ignored','unmatched','failed')),attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),available_at TEXT NOT NULL,lease_owner TEXT,lease_expires_at TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(provider,provider_event_id));
```

Foreign keys: `restaurant_id` → `restaurants.id` (delete NO ACTION, update NO ACTION).

Indexes:

- `provider_events_restaurant_idx`: (restaurant_id, created_at), explicit. SQL: `CREATE INDEX provider_events_restaurant_idx ON provider_events(restaurant_id,created_at)`
- `provider_events_object_idx`: (provider, object_id, provider_created_at), explicit. SQL: `CREATE INDEX provider_events_object_idx ON provider_events(provider,object_id,provider_created_at)`
- `provider_events_work_idx`: (status, available_at, created_at), explicit. SQL: `CREATE INDEX provider_events_work_idx ON provider_events(status,available_at,created_at)`
- `sqlite_autoindex_provider_events_2`: UNIQUE (provider, provider_event_id), constraint autoindex.
- `sqlite_autoindex_provider_events_1`: UNIQUE (id), constraint autoindex.

## refund_case_events

```sql
CREATE TABLE refund_case_events (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES refund_cases(id) ON DELETE CASCADE, actor_user_id TEXT REFERENCES users(id), kind TEXT NOT NULL, details TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
```

Foreign keys: `actor_user_id` → `users.id` (delete NO ACTION, update NO ACTION); `case_id` → `refund_cases.id` (delete CASCADE, update NO ACTION).

Indexes:

- `sqlite_autoindex_refund_case_events_1`: UNIQUE (id), constraint autoindex.

## refund_case_evidence

```sql
CREATE TABLE refund_case_evidence (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES refund_cases(id) ON DELETE CASCADE, actor_user_id TEXT NOT NULL REFERENCES users(id), mime_type TEXT NOT NULL CHECK(mime_type IN ('image/png','image/jpeg')), data BLOB NOT NULL, byte_length INTEGER NOT NULL, created_at TEXT NOT NULL, delete_after TEXT);
```

Foreign keys: `actor_user_id` → `users.id` (delete NO ACTION, update NO ACTION); `case_id` → `refund_cases.id` (delete CASCADE, update NO ACTION).

Indexes:

- `sqlite_autoindex_refund_case_evidence_1`: UNIQUE (id), constraint autoindex.

## refund_case_messages

```sql
CREATE TABLE refund_case_messages (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES refund_cases(id) ON DELETE CASCADE, actor_user_id TEXT NOT NULL REFERENCES users(id), audience TEXT NOT NULL CHECK(audience IN ('customer','restaurant','admin','internal')), message TEXT NOT NULL, created_at TEXT NOT NULL);
```

Foreign keys: `actor_user_id` → `users.id` (delete NO ACTION, update NO ACTION); `case_id` → `refund_cases.id` (delete CASCADE, update NO ACTION).

Indexes:

- `sqlite_autoindex_refund_case_messages_1`: UNIQUE (id), constraint autoindex.

## refund_cases

```sql
CREATE TABLE refund_cases (id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE, order_id TEXT NOT NULL REFERENCES orders(id), restaurant_id TEXT NOT NULL REFERENCES restaurants(id), customer_id TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL CHECK(status IN ('submitted','under_review','awaiting_restaurant','awaiting_customer','approved','partially_approved','awaiting_cash_return','rejected','refund_processing','refunded','refund_failed')), reason TEXT NOT NULL CHECK(reason IN ('missing_items','incorrect_items','quality','non_delivery','other')), item_ids TEXT NOT NULL DEFAULT '[]', description TEXT NOT NULL, issue_hash TEXT NOT NULL, requested_amount_minor INTEGER NOT NULL, approved_amount_minor INTEGER, remedy TEXT, execution_status TEXT, execution_operation_id TEXT REFERENCES marketplace_operations(id), execution_error TEXT, provider_mode TEXT, monthly_review_flag INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, escalated_at TEXT, escalation_reason TEXT, resolved_at TEXT);
```

Foreign keys: `execution_operation_id` → `marketplace_operations.id` (delete NO ACTION, update NO ACTION); `customer_id` → `users.id` (delete NO ACTION, update NO ACTION); `restaurant_id` → `restaurants.id` (delete NO ACTION, update NO ACTION); `order_id` → `orders.id` (delete NO ACTION, update NO ACTION).

Indexes:

- `customer_directory_refund_status_idx`: (restaurant_id, customer_id, status), explicit. SQL: `CREATE INDEX customer_directory_refund_status_idx ON refund_cases(restaurant_id,customer_id,status)`
- `refund_cases_active_issue`: UNIQUE (order_id, issue_hash), explicit, partial. SQL: `CREATE UNIQUE INDEX refund_cases_active_issue ON refund_cases(order_id,issue_hash) WHERE status NOT IN ('rejected','refunded')`
- `refund_cases_restaurant_idx`: (restaurant_id, created_at), explicit. SQL: `CREATE INDEX refund_cases_restaurant_idx ON refund_cases(restaurant_id,created_at)`
- `refund_cases_customer_idx`: (customer_id, created_at), explicit. SQL: `CREATE INDEX refund_cases_customer_idx ON refund_cases(customer_id,created_at)`
- `sqlite_autoindex_refund_cases_2`: UNIQUE (reference), constraint autoindex.
- `sqlite_autoindex_refund_cases_1`: UNIQUE (id), constraint autoindex.

## refund_decisions

```sql
CREATE TABLE refund_decisions (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES refund_cases(id), actor_user_id TEXT NOT NULL REFERENCES users(id), idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, decision TEXT NOT NULL, amount_minor INTEGER, reason TEXT NOT NULL, remedy TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(actor_user_id,idempotency_key));
```

Foreign keys: `actor_user_id` → `users.id` (delete NO ACTION, update NO ACTION); `case_id` → `refund_cases.id` (delete NO ACTION, update NO ACTION).

Indexes:

- `sqlite_autoindex_refund_decisions_2`: UNIQUE (actor_user_id, idempotency_key), constraint autoindex.
- `sqlite_autoindex_refund_decisions_1`: UNIQUE (id), constraint autoindex.

## refund_response_deadlines

```sql
CREATE TABLE refund_response_deadlines (case_id TEXT PRIMARY KEY REFERENCES refund_cases(id) ON DELETE CASCADE, awaiting_status TEXT NOT NULL CHECK(awaiting_status IN ('awaiting_customer','awaiting_restaurant')), due_at TEXT NOT NULL, reminder_sent_at TEXT, escalated_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, episode_key TEXT NOT NULL DEFAULT '');
```

Foreign keys: `case_id` → `refund_cases.id` (delete CASCADE, update NO ACTION).

Indexes:

- `sqlite_autoindex_refund_response_deadlines_1`: UNIQUE (case_id), constraint autoindex.

## refund_response_policy

```sql
CREATE TABLE refund_response_policy (id INTEGER PRIMARY KEY CHECK(id=1), customer_response_hours INTEGER NOT NULL CHECK(customer_response_hours BETWEEN 1 AND 720), restaurant_response_hours INTEGER NOT NULL CHECK(restaurant_response_hours BETWEEN 1 AND 720), reminder_lead_hours INTEGER NOT NULL CHECK(reminder_lead_hours BETWEEN 1 AND 168), updated_by_user_id TEXT REFERENCES users(id), updated_at TEXT NOT NULL);
```

Foreign keys: `updated_by_user_id` → `users.id` (delete NO ACTION, update NO ACTION).

Indexes:

None (an INTEGER PRIMARY KEY may use the rowid).

## refunds

```sql
CREATE TABLE "refunds" (id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES orders(id),actor_user_id TEXT NOT NULL REFERENCES users(id),idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL,food_amount_minor INTEGER NOT NULL CHECK(food_amount_minor>=0),delivery_amount_minor INTEGER NOT NULL CHECK(delivery_amount_minor>=0),reason TEXT NOT NULL,mode TEXT NOT NULL CHECK(mode IN ('simulated_card','manual_cash_return','stripe_card')),commission_reversal_minor INTEGER NOT NULL CHECK(commission_reversal_minor>=0),created_at TEXT NOT NULL,UNIQUE(actor_user_id,idempotency_key));
```

Foreign keys: `actor_user_id` → `users.id` (delete NO ACTION, update NO ACTION); `order_id` → `orders.id` (delete NO ACTION, update NO ACTION).

Indexes:

- `refunds_order_idx`: (order_id, created_at), explicit. SQL: `CREATE INDEX refunds_order_idx ON refunds(order_id,created_at)`
- `sqlite_autoindex_refunds_2`: UNIQUE (actor_user_id, idempotency_key), constraint autoindex.
- `sqlite_autoindex_refunds_1`: UNIQUE (id), constraint autoindex.

## restaurant_customer_message_rate_limits

```sql
CREATE TABLE restaurant_customer_message_rate_limits (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES restaurant_customer_threads(id) ON DELETE CASCADE,
  window_start_ms INTEGER NOT NULL,
  message_count INTEGER NOT NULL CHECK(message_count>0),
  PRIMARY KEY(user_id,thread_id)
);
```

Foreign keys: `thread_id` → `restaurant_customer_threads.id` (delete CASCADE, update NO ACTION); `user_id` → `users.id` (delete CASCADE, update NO ACTION).

Indexes:

- `sqlite_autoindex_restaurant_customer_message_rate_limits_1`: UNIQUE (user_id, thread_id), constraint autoindex.

## restaurant_customer_message_reads

```sql
CREATE TABLE restaurant_customer_message_reads (
  thread_id TEXT NOT NULL REFERENCES restaurant_customer_threads(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_created_at TEXT NOT NULL,
  last_read_message_id TEXT NOT NULL,
  updated_at TEXT NOT NULL, last_read_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_read_sequence>=0),
  PRIMARY KEY(thread_id,user_id)
);
```

Foreign keys: `user_id` → `users.id` (delete CASCADE, update NO ACTION); `thread_id` → `restaurant_customer_threads.id` (delete CASCADE, update NO ACTION).

Indexes:

- `sqlite_autoindex_restaurant_customer_message_reads_1`: UNIQUE (thread_id, user_id), constraint autoindex.

## restaurant_customer_messages

```sql
CREATE TABLE restaurant_customer_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES restaurant_customer_threads(id) ON DELETE CASCADE,
  sender_user_id TEXT NOT NULL REFERENCES users(id),
  sender_role TEXT NOT NULL CHECK(sender_role IN ('customer','restaurant')),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  key_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL, ingest_sequence INTEGER NOT NULL DEFAULT 0 CHECK(ingest_sequence>=0),
  UNIQUE(sender_user_id,thread_id,idempotency_key)
);
```

Foreign keys: `sender_user_id` → `users.id` (delete NO ACTION, update NO ACTION); `thread_id` → `restaurant_customer_threads.id` (delete CASCADE, update NO ACTION).

Indexes:

- `restaurant_customer_message_sequence_idx`: UNIQUE (thread_id, ingest_sequence), explicit. SQL: `CREATE UNIQUE INDEX restaurant_customer_message_sequence_idx ON restaurant_customer_messages(thread_id,ingest_sequence)`
- `restaurant_customer_messages_expiry_idx`: (expires_at), explicit. SQL: `CREATE INDEX restaurant_customer_messages_expiry_idx ON restaurant_customer_messages(expires_at)`
- `restaurant_customer_messages_cursor_idx`: (thread_id, created_at, id), explicit. SQL: `CREATE INDEX restaurant_customer_messages_cursor_idx ON restaurant_customer_messages(thread_id,created_at,id)`
- `sqlite_autoindex_restaurant_customer_messages_2`: UNIQUE (sender_user_id, thread_id, idempotency_key), constraint autoindex.
- `sqlite_autoindex_restaurant_customer_messages_1`: UNIQUE (id), constraint autoindex.

## restaurant_customer_thread_sequences

```sql
CREATE TABLE restaurant_customer_thread_sequences (
  thread_id TEXT PRIMARY KEY REFERENCES restaurant_customer_threads(id) ON DELETE CASCADE,
  last_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_sequence>=0)
);
```

Foreign keys: `thread_id` → `restaurant_customer_threads.id` (delete CASCADE, update NO ACTION).

Indexes:

- `sqlite_autoindex_restaurant_customer_thread_sequences_1`: UNIQUE (thread_id), constraint autoindex.

## restaurant_customer_threads

```sql
CREATE TABLE restaurant_customer_threads (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','awaiting_customer','awaiting_restaurant','resolved')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_message_at TEXT NOT NULL,
  UNIQUE(restaurant_id,customer_id)
);
```

Foreign keys: `customer_id` → `users.id` (delete CASCADE, update NO ACTION); `restaurant_id` → `restaurants.id` (delete CASCADE, update NO ACTION).

Indexes:

- `customer_conversations_idx`: (customer_id, last_message_at, id), explicit. SQL: `CREATE INDEX customer_conversations_idx ON restaurant_customer_threads(customer_id,last_message_at,id)`
- `restaurant_customer_inbox_idx`: (restaurant_id, status, last_message_at, id), explicit. SQL: `CREATE INDEX restaurant_customer_inbox_idx ON restaurant_customer_threads(restaurant_id,status,last_message_at,id)`
- `sqlite_autoindex_restaurant_customer_threads_2`: UNIQUE (restaurant_id, customer_id), constraint autoindex.
- `sqlite_autoindex_restaurant_customer_threads_1`: UNIQUE (id), constraint autoindex.

## restaurant_customer_workflows

```sql
CREATE TABLE restaurant_customer_workflows (
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workflow_status TEXT NOT NULL DEFAULT 'active' CHECK(workflow_status IN ('active','follow_up','vip','resolved')),
  note TEXT NOT NULL DEFAULT '',
  updated_by_user_id TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(restaurant_id,customer_id)
);
```

Foreign keys: `updated_by_user_id` → `users.id` (delete NO ACTION, update NO ACTION); `customer_id` → `users.id` (delete CASCADE, update NO ACTION); `restaurant_id` → `restaurants.id` (delete CASCADE, update NO ACTION).

Indexes:

- `restaurant_customer_workflow_status_idx`: (restaurant_id, workflow_status, customer_id), explicit. SQL: `CREATE INDEX restaurant_customer_workflow_status_idx ON restaurant_customer_workflows(restaurant_id,workflow_status,customer_id)`
- `sqlite_autoindex_restaurant_customer_workflows_1`: UNIQUE (restaurant_id, customer_id), constraint autoindex.

## restaurant_memberships

```sql
CREATE TABLE restaurant_memberships (restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL, permission TEXT NOT NULL DEFAULT 'owner' CHECK(permission IN ('owner','staff')), PRIMARY KEY (restaurant_id,user_id));
```

Foreign keys: `user_id` → `users.id` (delete CASCADE, update NO ACTION); `restaurant_id` → `restaurants.id` (delete CASCADE, update NO ACTION).

Indexes:

- `sqlite_autoindex_restaurant_memberships_1`: UNIQUE (restaurant_id, user_id), constraint autoindex.

## restaurant_printers

```sql
CREATE TABLE restaurant_printers (id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL REFERENCES restaurants(id), name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), revoked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
```

Foreign keys: `restaurant_id` → `restaurants.id` (delete NO ACTION, update NO ACTION).

Indexes:

- `sqlite_autoindex_restaurant_printers_1`: UNIQUE (id), constraint autoindex.

## restaurants

```sql
CREATE TABLE restaurants (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')), created_at TEXT NOT NULL, delivery_enabled INTEGER NOT NULL DEFAULT 0 CHECK(delivery_enabled IN (0,1)), delivery_outcodes TEXT NOT NULL DEFAULT '[]', delivery_fee_minor INTEGER NOT NULL DEFAULT 0 CHECK(delivery_fee_minor >= 0), min_delivery_subtotal_minor INTEGER NOT NULL DEFAULT 0 CHECK(min_delivery_subtotal_minor >= 0), description TEXT NOT NULL DEFAULT '', cuisine TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '', collection_enabled INTEGER NOT NULL DEFAULT 1 CHECK(collection_enabled IN (0,1)), cash_enabled INTEGER NOT NULL DEFAULT 1 CHECK(cash_enabled IN (0,1)), paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)), busy_minutes INTEGER NOT NULL DEFAULT 0, estimated_delivery_minutes INTEGER NOT NULL DEFAULT 35, estimated_collection_minutes INTEGER NOT NULL DEFAULT 20, opening_hours TEXT NOT NULL DEFAULT '[]', holiday_dates TEXT NOT NULL DEFAULT '[]', always_open INTEGER NOT NULL DEFAULT 0 CHECK(always_open IN (0,1)), suspended INTEGER NOT NULL DEFAULT 0 CHECK(suspended IN (0,1)), suspension_reason TEXT NOT NULL DEFAULT '', food_verification_status TEXT NOT NULL DEFAULT 'unverified', food_source TEXT, food_checked_at TEXT, cover_media_id TEXT REFERENCES media_assets(id));
```

Foreign keys: `cover_media_id` → `media_assets.id` (delete NO ACTION, update NO ACTION).

Indexes:

- `sqlite_autoindex_restaurants_1`: UNIQUE (id), constraint autoindex.

## saved_addresses

```sql
CREATE TABLE saved_addresses (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, label TEXT NOT NULL, line1 TEXT NOT NULL, line2 TEXT, city TEXT NOT NULL, postcode TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
```

Foreign keys: `user_id` → `users.id` (delete CASCADE, update NO ACTION).

Indexes:

- `saved_addresses_user_idx`: (user_id, created_at), explicit. SQL: `CREATE INDEX saved_addresses_user_idx ON saved_addresses(user_id,created_at)`
- `sqlite_autoindex_saved_addresses_1`: UNIQUE (id), constraint autoindex.

## schema_migrations

```sql
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
```

Foreign keys: none.

Indexes:

None (an INTEGER PRIMARY KEY may use the rowid).

## service_area_settings

```sql
CREATE TABLE service_area_settings (id INTEGER PRIMARY KEY CHECK(id=1),mode TEXT NOT NULL CHECK(mode IN ('restaurant_coverage','custom')),outcodes TEXT NOT NULL,headline TEXT NOT NULL,message TEXT NOT NULL,updated_by_user_id TEXT REFERENCES users(id),updated_at TEXT NOT NULL);
```

Foreign keys: `updated_by_user_id` → `users.id` (delete NO ACTION, update NO ACTION).

Indexes:

None (an INTEGER PRIMARY KEY may use the rowid).

## sessions

```sql
CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, revoked_at TEXT, created_at TEXT NOT NULL);
```

Foreign keys: `user_id` → `users.id` (delete CASCADE, update NO ACTION).

Indexes:

- `sessions_token_hash_idx`: (token_hash), explicit. SQL: `CREATE INDEX sessions_token_hash_idx ON sessions(token_hash)`
- `sqlite_autoindex_sessions_2`: UNIQUE (token_hash), constraint autoindex.
- `sqlite_autoindex_sessions_1`: UNIQUE (id), constraint autoindex.

## stripe_account_readiness

```sql
CREATE TABLE stripe_account_readiness (restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,provider_mode TEXT NOT NULL CHECK(provider_mode IN ('stripe_test','stripe_live')),provider_account_id TEXT NOT NULL,charges_enabled INTEGER NOT NULL CHECK(charges_enabled IN (0,1)),payouts_enabled INTEGER NOT NULL CHECK(payouts_enabled IN (0,1)),verified_at TEXT NOT NULL,PRIMARY KEY(restaurant_id,provider_mode));
```

Foreign keys: `restaurant_id` → `restaurants.id` (delete CASCADE, update NO ACTION).

Indexes:

- `sqlite_autoindex_stripe_account_readiness_1`: UNIQUE (restaurant_id, provider_mode), constraint autoindex.

## stripe_connected_payouts

```sql
CREATE TABLE stripe_connected_payouts (id TEXT PRIMARY KEY,restaurant_id TEXT NOT NULL REFERENCES restaurants(id),provider_account_id TEXT NOT NULL,amount_minor INTEGER NOT NULL,status TEXT NOT NULL,arrival_at TEXT,failure TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
```

Foreign keys: `restaurant_id` → `restaurants.id` (delete NO ACTION, update NO ACTION).

Indexes:

- `stripe_connected_payouts_restaurant_idx`: (restaurant_id, created_at), explicit. SQL: `CREATE INDEX stripe_connected_payouts_restaurant_idx ON stripe_connected_payouts(restaurant_id,created_at)`
- `sqlite_autoindex_stripe_connected_payouts_1`: UNIQUE (id), constraint autoindex.

## stripe_order_decisions

```sql
CREATE TABLE stripe_order_decisions (
  order_id TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  desired_status TEXT NOT NULL CHECK(desired_status IN ('accepted','rejected')),
  state TEXT NOT NULL CHECK(state IN ('claimed','unknown','confirmed')),
  lease_owner TEXT,
  lease_expires_at TEXT,
  provider_mode TEXT NOT NULL CHECK(provider_mode IN ('stripe_test','stripe_live')),
  provider_result TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Foreign keys: `order_id` → `orders.id` (delete CASCADE, update NO ACTION).

Indexes:

- `sqlite_autoindex_stripe_order_decisions_1`: UNIQUE (order_id), constraint autoindex.

## stripe_order_payments

```sql
CREATE TABLE stripe_order_payments (order_id TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,provider_mode TEXT NOT NULL CHECK(provider_mode IN ('stripe_test','stripe_live')),checkout_session_id TEXT UNIQUE,payment_intent_id TEXT,latest_charge_id TEXT,status TEXT NOT NULL CHECK(status IN ('pending','authorized','captured','failed','cancelled','expired','unknown')),checkout_url TEXT,provider_cost_minor INTEGER,available_on TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
```

Foreign keys: `order_id` → `orders.id` (delete CASCADE, update NO ACTION).

Indexes:

- `stripe_order_payments_intent_idx`: (payment_intent_id), explicit. SQL: `CREATE INDEX stripe_order_payments_intent_idx ON stripe_order_payments(payment_intent_id)`
- `sqlite_autoindex_stripe_order_payments_2`: UNIQUE (checkout_session_id), constraint autoindex.
- `sqlite_autoindex_stripe_order_payments_1`: UNIQUE (order_id), constraint autoindex.

## support_case_messages

```sql
CREATE TABLE support_case_messages (
  id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES support_cases(id) ON DELETE CASCADE,
  sender_user_id TEXT NOT NULL REFERENCES users(id), sender_role TEXT NOT NULL,
  idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
  ciphertext TEXT NOT NULL, nonce TEXT NOT NULL, auth_tag TEXT NOT NULL, key_version TEXT NOT NULL,
  created_at TEXT NOT NULL, UNIQUE(case_id,sender_user_id,idempotency_key)
);
```

Foreign keys: `sender_user_id` → `users.id` (delete NO ACTION, update NO ACTION); `case_id` → `support_cases.id` (delete CASCADE, update NO ACTION).

Indexes:

- `support_case_messages_idx`: (case_id, created_at, id), explicit. SQL: `CREATE INDEX support_case_messages_idx ON support_case_messages(case_id,created_at,id)`
- `sqlite_autoindex_support_case_messages_2`: UNIQUE (case_id, sender_user_id, idempotency_key), constraint autoindex.
- `sqlite_autoindex_support_case_messages_1`: UNIQUE (id), constraint autoindex.

## support_cases

```sql
CREATE TABLE support_cases (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), order_id TEXT REFERENCES orders(id), subject TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','resolved')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, restaurant_id TEXT REFERENCES restaurants(id), waiting_for TEXT NOT NULL DEFAULT 'team' CHECK(waiting_for IN ('team','customer','none')), idempotency_key TEXT, request_hash TEXT, requester_restaurant_id TEXT REFERENCES restaurants(id));
```

Foreign keys: `requester_restaurant_id` → `restaurants.id` (delete NO ACTION, update NO ACTION); `restaurant_id` → `restaurants.id` (delete NO ACTION, update NO ACTION); `order_id` → `orders.id` (delete NO ACTION, update NO ACTION); `user_id` → `users.id` (delete NO ACTION, update NO ACTION).

Indexes:

- `support_restaurant_updated_idx`: (restaurant_id, status, updated_at, id), explicit. SQL: `CREATE INDEX support_restaurant_updated_idx ON support_cases(restaurant_id,status,updated_at DESC,id DESC)`
- `support_user_updated_idx`: (user_id, updated_at, id), explicit. SQL: `CREATE INDEX support_user_updated_idx ON support_cases(user_id,updated_at DESC,id DESC)`
- `support_request_retry_idx`: UNIQUE (user_id, idempotency_key), explicit, partial. SQL: `CREATE UNIQUE INDEX support_request_retry_idx ON support_cases(user_id,idempotency_key) WHERE idempotency_key IS NOT NULL`
- `sqlite_autoindex_support_cases_1`: UNIQUE (id), constraint autoindex.

## support_message_rate_limits

```sql
CREATE TABLE support_message_rate_limits (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, window_start_ms INTEGER NOT NULL, request_count INTEGER NOT NULL);
```

Foreign keys: `user_id` → `users.id` (delete CASCADE, update NO ACTION).

Indexes:

- `sqlite_autoindex_support_message_rate_limits_1`: UNIQUE (user_id), constraint autoindex.

## user_notifications

```sql
CREATE TABLE user_notifications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, type TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, order_id TEXT REFERENCES orders(id), offer_id TEXT REFERENCES offer_grants(id), restaurant_id TEXT REFERENCES restaurants(id), event_key TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT, conversation_id TEXT REFERENCES restaurant_customer_threads(id) ON DELETE CASCADE, customer_id TEXT REFERENCES users(id) ON DELETE CASCADE, support_case_id TEXT REFERENCES support_cases(id), UNIQUE(user_id,event_key));
```

Foreign keys: `support_case_id` → `support_cases.id` (delete NO ACTION, update NO ACTION); `customer_id` → `users.id` (delete CASCADE, update NO ACTION); `conversation_id` → `restaurant_customer_threads.id` (delete CASCADE, update NO ACTION); `restaurant_id` → `restaurants.id` (delete NO ACTION, update NO ACTION); `offer_id` → `offer_grants.id` (delete NO ACTION, update NO ACTION); `order_id` → `orders.id` (delete NO ACTION, update NO ACTION); `user_id` → `users.id` (delete CASCADE, update NO ACTION).

Indexes:

- `support_notification_idx`: (user_id, support_case_id, read_at), explicit. SQL: `CREATE INDEX support_notification_idx ON user_notifications(user_id,support_case_id,read_at)`
- `customer_message_notification_idx`: (user_id, conversation_id, type, read_at), explicit. SQL: `CREATE INDEX customer_message_notification_idx ON user_notifications(user_id,conversation_id,type,read_at)`
- `user_notifications_user_idx`: (user_id, created_at), explicit. SQL: `CREATE INDEX user_notifications_user_idx ON user_notifications(user_id,created_at)`
- `sqlite_autoindex_user_notifications_2`: UNIQUE (user_id, event_key), constraint autoindex.
- `sqlite_autoindex_user_notifications_1`: UNIQUE (id), constraint autoindex.

## users

```sql
CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('customer','restaurant','admin')), created_at TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', email_verified_at TEXT, merchant_offers INTEGER NOT NULL DEFAULT 0 CHECK(merchant_offers IN (0,1)), account_enabled INTEGER NOT NULL DEFAULT 1 CHECK(account_enabled IN (0,1)));
```

Foreign keys: none.

Indexes:

- `sqlite_autoindex_users_2`: UNIQUE (email), constraint autoindex.
- `sqlite_autoindex_users_1`: UNIQUE (id), constraint autoindex.
