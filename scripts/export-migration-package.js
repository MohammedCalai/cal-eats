import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

export const MIGRATION_CONTRACT = "cal-eats.migration-package.v1";
export const MIGRATION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SYSTEM = "cal-eats";
const MAX_INTEGER = Number.MAX_SAFE_INTEGER;
const quote = name => `"${name.replaceAll('"', '""')}"`;
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const inside = (root, value) => { const relative = path.relative(root, value); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); };
const protectedPath = value => value.split(/[\\/]/).some(part => ["reference", ".git", ".codex", ".agents", ".aws"].includes(part.toLowerCase()));
export const sourceId = (entity, ...keys) => `${SYSTEM}:${entity}:${keys.map(key => encodeURIComponent(String(key))).join(":")}`;

// Each exported value and relation is named explicitly. Authentication/session,
// provider payload, device-token, pairing, ciphertext and worker-lease tables
// cannot become exportable merely because a new database column is added.
const spec = (table, entity, group, keys, fields, refs = {}, json = {}) => ({ table, entity, group, keys, fields: fields.split(" ").filter(Boolean), refs, json });
const SPECS = [
  spec("restaurants", "restaurant", "catalog", ["id"], "name status created_at delivery_enabled delivery_fee_minor min_delivery_subtotal_minor description cuisine phone address collection_enabled cash_enabled paused busy_minutes estimated_delivery_minutes estimated_collection_minutes always_open suspended food_verification_status food_source food_checked_at", { cover_media_id: "media_asset" }, { delivery_outcodes: "strings", opening_hours: "hours", holiday_dates: "strings" }),
  spec("menu_items", "menu_item", "catalog", ["id"], "name description price_minor available category sort_order created_at updated_at", { restaurant_id: "restaurant", photo_media_id: "media_asset" }, { allergens: "strings", dietary_tags: "strings", modifier_groups: "modifiers" }),
  spec("media_assets", "media_asset", "catalog", ["id"], "mime_type width height byte_length created_at", { restaurant_id: "restaurant" }),
  spec("loyalty_settings", "loyalty_setting", "catalog", ["restaurant_id"], "regular_order_count regular_window_days lapsed_after_days updated_at", { restaurant_id: "restaurant", updated_by_user_id: "user" }),
  spec("order_message_settings", "order_message_setting", "catalog", ["restaurant_id"], "support_window_minutes updated_at", { restaurant_id: "restaurant", updated_by_user_id: "user" }, { quick_responses: "strings" }),
  spec("users", "user", "accounts", ["id"], "name email phone role created_at email_verified_at merchant_offers account_enabled"),
  spec("saved_addresses", "saved_address", "accounts", ["id"], "label line1 line2 city postcode created_at updated_at", { user_id: "user" }),
  spec("restaurant_memberships", "membership", "accounts", ["restaurant_id", "user_id"], "permission created_at", { restaurant_id: "restaurant", user_id: "user" }),
  spec("marketing_preferences", "marketing_preference", "accounts", ["user_id"], "in_app_promotions push_promotions consent_version consent_source consented_at updated_at", { user_id: "user" }),
  spec("restaurant_customer_workflows", "customer_workflow", "accounts", ["restaurant_id", "customer_id"], "workflow_status updated_at", { restaurant_id: "restaurant", customer_id: "user", updated_by_user_id: "user" }),
  spec("restaurant_printers", "printer", "accounts", ["id"], "name enabled revoked_at created_at updated_at", { restaurant_id: "restaurant" }),
  spec("contracts", "contract", "orders", ["id"], "rate_bps duration_months policy_version demo_only accepted_at created_at", { restaurant_id: "restaurant", accepted_by_user_id: "user" }),
  spec("commission_policies", "commission_policy", "orders", ["id"], "rate_bps commission_base starts_at ends_at duration_months version development_assumption accepted_at created_at", { restaurant_id: "restaurant", accepted_by_user_id: "user" }),
  spec("orders", "order", "orders", ["id"], "restaurant_name status currency subtotal_minor delivery_fee_minor total_minor commission_minor payment_method payment_status fulfillment created_at updated_at contract_rate_bps contract_policy_version contract_demo_only customer_name customer_email customer_phone delivery_instructions allergy_notes estimated_ready_at merchant_visible_at confirmation_due_at confirmed_at commission_base gross_food_minor restaurant_discount_minor", { restaurant_id: "restaurant", customer_id: "user", offer_grant_id: "offer_grant" }, { delivery_address: "address", offer_snapshot: "offer", promotion_snapshot: "promotion" }),
  spec("order_items", "order_item", "orders", ["id"], "name unit_price_minor quantity base_price_minor category is_offer_item", { order_id: "order", menu_item_id: "menu_item" }, { selected_modifiers: "selections", allergens: "strings" }),
  spec("order_events", "order_event", "orders", ["id"], "kind from_status to_status created_at", { order_id: "order", actor_user_id: "user" }),
  spec("ledger_entries", "ledger_entry", "orders", ["id"], "kind amount_minor currency reference_type reference_id created_at", { order_id: "order", restaurant_id: "restaurant" }),
  spec("journal_postings", "journal_posting", "orders", ["id"], "group_id account direction amount_minor currency source_type source_id provider_mode created_at", { order_id: "order", restaurant_id: "restaurant" }),
  spec("refunds", "refund", "orders", ["id"], "food_amount_minor delivery_amount_minor reason mode commission_reversal_minor created_at", { order_id: "order", actor_user_id: "user" }),
  spec("refund_cases", "refund_case", "orders", ["id"], "reference status reason description requested_amount_minor approved_amount_minor remedy execution_status provider_mode monthly_review_flag created_at updated_at escalated_at escalation_reason resolved_at", { order_id: "order", restaurant_id: "restaurant", customer_id: "user", execution_operation_id: "marketplace_operation" }, { item_ids: "order_item_ids" }),
  spec("refund_decisions", "refund_decision", "orders", ["id"], "decision amount_minor reason remedy created_at", { case_id: "refund_case", actor_user_id: "user" }),
  spec("refund_case_evidence", "refund_evidence_inventory", "orders", ["id"], "mime_type byte_length created_at delete_after", { case_id: "refund_case", actor_user_id: "user" }),
  spec("dispute_remedy_proposals", "remedy_proposal", "orders", ["id"], "type status amount_minor voucher_value_minor description expires_at redemption_conditions financial_party responded_at created_at updated_at", { case_id: "refund_case", restaurant_id: "restaurant", created_by_user_id: "user" }, { item_ids: "order_item_ids" }),
  spec("dispute_customer_responses", "remedy_response", "orders", ["id"], "decision created_at", { proposal_id: "remedy_proposal", customer_id: "user" }),
  spec("offer_campaigns", "offer_campaign", "orders", ["id"], "title message item_name item_value_minor min_subtotal_minor expires_at created_at offer_type offer_value starts_at redemption_limit budget_minor recipient_segment stacking_policy funding_party", { restaurant_id: "restaurant", created_by_user_id: "user", menu_item_id: "menu_item" }, { eligible_item_ids: "menu_item_ids", eligible_categories: "strings", segment_snapshot: "segment" }),
  spec("offer_grants", "offer_grant", "orders", ["id"], "status viewed_at created_at updated_at reserved_discount_minor", { campaign_id: "offer_campaign", restaurant_id: "restaurant", customer_id: "user", reserved_order_id: "order", redeemed_order_id: "order" }),
  spec("marketplace_operations", "marketplace_operation", "orders", ["id"], "kind status amount_minor currency provider_mode provider_reference created_at updated_at", { restaurant_id: "restaurant", order_id: "order" }),
  spec("payout_batches", "payout_batch", "orders", ["id"], "status amount_minor provider_mode scheduled_for provider_reference created_at updated_at", { restaurant_id: "restaurant" }),
  spec("payout_items", "payout_item", "orders", ["payout_id", "operation_id"], "amount_minor", { payout_id: "payout_batch", operation_id: "marketplace_operation" }),
  spec("cash_settlements", "cash_settlement", "orders", ["id"], "amount_minor reference created_at", { restaurant_id: "restaurant", actor_user_id: "user" }),
  spec("cash_mandates", "cash_mandate_inventory", "orders", ["id"], "status provider_mode provider_reference created_at updated_at", { restaurant_id: "restaurant" }),
  spec("cash_collections", "cash_collection", "orders", ["id"], "amount_minor status provider_mode created_at updated_at", { restaurant_id: "restaurant", mandate_id: "cash_mandate_inventory" }),
  spec("provider_accounts", "provider_account", "orders", ["id"], "provider_mode status provider_reference created_at updated_at", { restaurant_id: "restaurant" }, { capabilities: "strings" }),
  spec("stripe_account_readiness", "stripe_account_readiness", "orders", ["restaurant_id", "provider_mode"], "provider_mode provider_account_id charges_enabled payouts_enabled verified_at", { restaurant_id: "restaurant" }),
  spec("stripe_order_payments", "stripe_order_payment", "orders", ["order_id"], "provider_mode checkout_session_id payment_intent_id latest_charge_id status provider_cost_minor available_on created_at updated_at", { order_id: "order" }),
  spec("stripe_connected_payouts", "stripe_bank_payout", "orders", ["id"], "provider_account_id amount_minor status arrival_at created_at updated_at", { restaurant_id: "restaurant" })
];

export function resolveMigrationSource(source = path.join(MIGRATION_ROOT, "data", "calai-eats.sqlite")) {
  const candidate = path.resolve(source), root = fs.realpathSync(MIGRATION_ROOT);
  const allowed = ["data", "artifacts", "backups"].map(name => path.join(MIGRATION_ROOT, name));
  if (protectedPath(candidate) || !allowed.some(folder => inside(folder, candidate)) || path.extname(candidate).toLowerCase() !== ".sqlite") throw new Error("Source must be a Cal-Eats .sqlite database under data, artifacts or backups; original/reference paths are forbidden.");
  const real = fs.realpathSync(candidate);
  const realAllowed = allowed.filter(folder => fs.existsSync(folder)).map(folder => fs.realpathSync(folder));
  if (!inside(root, real) || protectedPath(real) || !realAllowed.some(folder => inside(root, folder) && !protectedPath(folder) && inside(folder, real)) || !fs.statSync(real).isFile()) throw new Error("The database source resolves outside the managed Cal-Eats directories.");
  return real;
}

function schema(db) { return new Map(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => [name, db.prepare(`PRAGMA table_info(${quote(name)})`).all().map(column => column.name)])); }
function has(tables, table, columns) { return tables.has(table) && columns.every(name => tables.get(table).includes(name)); }
function count(db, table) { return db.prepare(`SELECT COUNT(*) n FROM ${quote(table)}`).get().n; }
function countIf(db, tables, requirements, sql) { return requirements.every(([table, fields]) => has(tables, table, fields)) ? db.prepare(sql).get().n : null; }
function constraints(db, tables, selected) {
  const integrityOk = db.prepare("PRAGMA integrity_check").all().every(row => Object.values(row)[0] === "ok"), foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
  const tenantChecks = [
    [[["menu_items", ["restaurant_id"]], ["restaurants", ["id"]]], "SELECT COUNT(*) n FROM menu_items i LEFT JOIN restaurants r ON r.id=i.restaurant_id WHERE r.id IS NULL"],
    [[["menu_items", ["restaurant_id", "photo_media_id"]], ["media_assets", ["id", "restaurant_id"]]], "SELECT COUNT(*) n FROM menu_items i JOIN media_assets m ON m.id=i.photo_media_id WHERE i.restaurant_id<>m.restaurant_id"],
    [[["restaurants", ["id", "cover_media_id"]], ["media_assets", ["id", "restaurant_id"]]], "SELECT COUNT(*) n FROM restaurants r JOIN media_assets m ON m.id=r.cover_media_id WHERE r.id<>m.restaurant_id"],
    [[["restaurant_memberships", ["user_id", "permission"]], ["users", ["id", "role"]]], "SELECT COUNT(*) n FROM restaurant_memberships m JOIN users u ON u.id=m.user_id WHERE u.role<>'restaurant' OR m.permission NOT IN ('owner','staff')"],
    [[["order_items", ["order_id", "menu_item_id"]], ["orders", ["id", "restaurant_id"]], ["menu_items", ["id", "restaurant_id"]]], "SELECT COUNT(*) n FROM order_items i JOIN orders o ON o.id=i.order_id JOIN menu_items m ON m.id=i.menu_item_id WHERE o.restaurant_id<>m.restaurant_id"],
    [[["orders", ["customer_id"]], ["users", ["id", "role"]]], "SELECT COUNT(*) n FROM orders o JOIN users u ON u.id=o.customer_id WHERE u.role<>'customer'"],
    [[["refund_cases", ["order_id", "restaurant_id", "customer_id"]], ["orders", ["id", "restaurant_id", "customer_id"]]], "SELECT COUNT(*) n FROM refund_cases c JOIN orders o ON o.id=c.order_id WHERE c.restaurant_id<>o.restaurant_id OR c.customer_id<>o.customer_id"]
  ];
  const checked = tenantChecks.map(([requirements, sql]) => countIf(db, tables, requirements, sql));
  let invalidMoneyValues = 0;
  for (const item of selected) for (const field of item.fields.filter(name => /_minor$|^rate_bps$|^contract_rate_bps$/.test(name) && tables.get(item.table)?.includes(name))) {
    invalidMoneyValues += db.prepare(`SELECT COUNT(*) n FROM ${quote(item.table)} WHERE ${quote(field)} IS NOT NULL AND (typeof(${quote(field)})<>'integer' OR ${quote(field)}>? OR ${quote(field)}<?)`).get(MAX_INTEGER, -MAX_INTEGER).n;
  }
  const orderTotalMismatches = countIf(db, tables, [["orders", ["total_minor", "subtotal_minor", "delivery_fee_minor"]]], "SELECT COUNT(*) n FROM orders WHERE total_minor<>subtotal_minor+delivery_fee_minor");
  const unbalancedJournalGroups = countIf(db, tables, [["journal_postings", ["group_id", "restaurant_id", "provider_mode", "currency", "direction", "amount_minor"]]], "SELECT COUNT(*) n FROM (SELECT group_id,restaurant_id,provider_mode,currency,SUM(CASE direction WHEN 'debit' THEN amount_minor ELSE -amount_minor END) balance FROM journal_postings GROUP BY group_id,restaurant_id,provider_mode,currency HAVING balance<>0)");
  const invalidJournalDirections = countIf(db, tables, [["journal_postings", ["direction", "amount_minor"]]], "SELECT COUNT(*) n FROM journal_postings WHERE direction NOT IN ('debit','credit') OR amount_minor<0");
  return { integrityOk, foreignKeyViolations, crossTenantViolations: checked.reduce((sum, value) => sum + (value || 0), 0), tenantChecksRun: checked.filter(value => value !== null).length, invalidMoneyValues, orderTotalMismatches, unbalancedJournalGroups, invalidJournalDirections, passed: integrityOk && !foreignKeyViolations && !invalidMoneyValues && checked.every(value => !value) && !orderTotalMismatches && !unbalancedJournalGroups && !invalidJournalDirections };
}

const pick = (value, names) => Object.fromEntries(names.filter(name => Object.prototype.hasOwnProperty.call(value, name)).map(name => [name, value[name]]));
function jsonValue(kind, raw, row, descriptor) {
  if (raw === null || raw === undefined) return null;
  let value; try { value = JSON.parse(raw); } catch { throw new Error(`Invalid structured data in ${descriptor.table}; no complete package produced.`); }
  if (kind === "strings" || kind.endsWith("_ids")) { if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new Error(`Invalid list in ${descriptor.table}.`); return kind.endsWith("_ids") ? value.map(id => sourceId(kind === "menu_item_ids" ? "menu_item" : "order_item", id)) : value; }
  if (kind === "hours") { if (!Array.isArray(value)) throw new Error("Opening hours are invalid."); return value.map(item => pick(item, ["day", "open", "close"])); }
  if (kind === "modifiers") { if (!Array.isArray(value)) throw new Error("Menu choices are invalid."); return value.map(group => ({ ...pick(group, ["id", "name", "minSelections", "maxSelections"]), sourceId: `${sourceId("menu_item", row.id)}#group/${encodeURIComponent(group.id)}`, options: (group.options || []).map(option => ({ ...pick(option, ["id", "name", "priceMinor", "available"]), sourceId: `${sourceId("menu_item", row.id)}#group/${encodeURIComponent(group.id)}/option/${encodeURIComponent(option.id)}` })) })); }
  if (kind === "selections") { if (!Array.isArray(value)) throw new Error("Order choices are invalid."); return value.map(item => ({ ...pick(item, ["groupId", "optionId", "name", "priceMinor"]), groupSourceId: `${sourceId("menu_item", row.menu_item_id)}#group/${encodeURIComponent(item.groupId)}`, optionSourceId: `${sourceId("menu_item", row.menu_item_id)}#group/${encodeURIComponent(item.groupId)}/option/${encodeURIComponent(item.optionId)}` })); }
  if (kind === "address") return pick(value, ["label", "line1", "line2", "city", "postcode", "country"]);
  if (kind === "offer") return { ...pick(value, ["offerId", "title", "offerType", "menuItemId", "itemName", "itemValueMinor", "discountMinor"]), ...(value.offerId ? { grantSourceId: sourceId("offer_grant", value.offerId) } : {}), ...(value.menuItemId ? { menuItemSourceId: sourceId("menu_item", value.menuItemId) } : {}) };
  if (kind === "promotion") return { ...pick(value, ["grantId", "campaignId", "title", "offerType", "fundingParty", "grossFoodMinor", "discountMinor", "netFoodMinor"]), ...(value.grantId ? { grantSourceId: sourceId("offer_grant", value.grantId) } : {}), ...(value.campaignId ? { campaignSourceId: sourceId("offer_campaign", value.campaignId) } : {}), allocations: (value.allocations || []).map(item => ({ ...pick(item, ["menuItemId", "name", "grossMinor", "discountMinor", "netMinor"]), menuItemSourceId: sourceId("menu_item", item.menuItemId) })) };
  if (kind === "segment") return { ...pick(value, ["asOf", "segment", "matchedCustomerCount", "consentedRecipientCount"]), settings: pick(value.settings || {}, ["regularOrderCount", "regularWindowDays", "lapsedAfterDays"]), definitions: pick(value.definitions || {}, ["new", "returning", "regular", "lapsed", "frequency", "periodComparison", "note"]) };
  throw new Error("Unsupported structured export field.");
}
function noCredentialMaterial(value) {
  if (typeof value === "string" && /\b(?:sk|rk)_(?:test|live)_[A-Za-z0-9_]+|\bwhsec_[A-Za-z0-9_]+|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9_.-]{20,}|[?&](?:api[_-]?key|access_token|token|secret)=/i.test(value)) throw new Error("A supported data field contains credential-like material. Review the source privately; no complete package produced.");
  if (Array.isArray(value)) value.forEach(noCredentialMaterial);
  else if (value && typeof value === "object") Object.values(value).forEach(noCredentialMaterial);
  else if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("An export field contains non-integer or unsafe numeric data.");
}
function record(descriptor, row) {
  const values = Object.fromEntries(descriptor.fields.filter(name => name in row).map(name => [name, row[name]]));
  const links = Object.fromEntries(Object.entries(descriptor.refs).filter(([field]) => row[field] != null).map(([field, entity]) => [field, sourceId(entity, row[field])]));
  if (descriptor.table === "journal_postings") {
    values.group_source_id = sourceId("journal_group", row.group_id);
    values.source_reference = { system: SYSTEM, kind: row.source_type, key: row.source_id, qualifiedId: sourceId("audit_reference", row.source_type, row.source_id) };
  }
  if (descriptor.table === "ledger_entries" && row.reference_id) {
    const entity = { order: "order", refund_case: "refund_case", refund: "refund", cash_settlement: "cash_settlement", marketplace_operation: "marketplace_operation" }[row.reference_type];
    if (entity) links.reference_id = sourceId(entity, row.reference_id);
    else values.source_reference = { system: SYSTEM, kind: row.reference_type, key: row.reference_id, qualifiedId: sourceId("audit_reference", row.reference_type, row.reference_id) };
  }
  for (const [field, kind] of Object.entries(descriptor.json)) if (field in row) { const parsed = jsonValue(kind, row[field], row, descriptor); if (kind.endsWith("_ids")) links[field] = parsed; else values[field] = parsed; }
  const result = { sourceId: sourceId(descriptor.entity, ...descriptor.keys.map(name => row[name])), sourceKeys: Object.fromEntries(descriptor.keys.map(name => [name, row[name]])), values, links };
  noCredentialMaterial(result); return result;
}
function prepareDestination(now) {
  const root = fs.realpathSync(MIGRATION_ROOT), artifacts = fs.realpathSync(path.join(MIGRATION_ROOT, "artifacts"));
  if (path.relative(path.join(root, "artifacts"), artifacts) !== "" || protectedPath(artifacts)) throw new Error("Migration output must remain within Cal-Eats artifacts.");
  const migrations = path.join(artifacts, "migrations");
  if (!fs.existsSync(migrations)) fs.mkdirSync(migrations, { mode: 0o700 });
  const real = fs.realpathSync(migrations); if (path.relative(path.join(artifacts, "migrations"), real) !== "" || protectedPath(real)) throw new Error("Migration output directory resolves outside Cal-Eats artifacts.");
  const destination = path.join(real, now.toISOString().replace(/[:.]/g, "-"));
  try { fs.mkdirSync(destination, { mode: 0o700 }); } catch (e) { if (e.code === "EEXIST") throw new Error("Refusing to overwrite an existing migration package."); throw e; }
  fs.writeFileSync(path.join(destination, "INCOMPLETE.txt"), "Incomplete package. Import is forbidden unless manifest.json and manifest.sha256 exist and this marker is absent.\n", { flag: "wx", mode: 0o600 });
  return destination;
}

export function exportMigrationPackage({ source, write = false, includeAccounts = false, includeOrders = false, includeMedia = false, now = new Date() } = {}) {
  const sourcePath = resolveMigrationSource(source), db = new DatabaseSync(sourcePath, { readOnly: true }); let begun = false;
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN"); begun = true;
    const tables = schema(db); if (!["schema_migrations", "restaurants", "menu_items"].every(table => tables.has(table))) throw new Error("Source is not a recognised Cal-Eats database.");
    const groups = new Set(["catalog", ...(includeAccounts ? ["accounts"] : []), ...(includeOrders ? ["orders"] : [])]);
    const selected = SPECS.filter(item => groups.has(item.group) && tables.has(item.table));
    const counts = Object.fromEntries([...tables.keys()].map(table => [table, count(db, table)]));
    const coverage = selected.map(item => { const supported = [...new Set([...item.keys, ...item.fields, ...Object.keys(item.refs), ...Object.keys(item.json)])]; return { table: item.table, entity: item.entity, records: counts[item.table], includedFields: supported.filter(name => tables.get(item.table).includes(name)), excludedFields: tables.get(item.table).filter(name => !supported.includes(name)), missingSupportedFields: supported.filter(name => !tables.get(item.table).includes(name)) }; });
    for (const item of selected) if (!has(tables, item.table, item.keys)) throw new Error("The source schema is missing an export identity key.");
    const checks = constraints(db, tables, selected), schemaVersion = db.prepare("SELECT COALESCE(MAX(version),0) version FROM schema_migrations").get().version;
    const report = { contract: MIGRATION_CONTRACT, dryRun: !write, sourceSystem: SYSTEM, source: path.relative(MIGRATION_ROOT, sourcePath).replaceAll(path.sep, "/"), sourceSchemaVersion: schemaVersion, groups: [...groups], includeMedia, counts, selectedCounts: Object.fromEntries(selected.map(item => [item.table, counts[item.table]])), coverage, omittedTables: [...tables.keys()].filter(table => !selected.some(item => item.table === table)), validation: checks, readOnly: true, importReady: false };
    if (!write) return { report, destination: null };
    if (!checks.passed) throw new Error("Source integrity, tenant links or money checks failed. No migration package was written.");
    const destination = prepareDestination(now), files = [], ids = new Set(), pendingLinks = [], mapping = [];
    const put = (relative, contents, records) => { const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents); const target = path.join(destination, relative); if (!inside(destination, target)) throw new Error("Invalid package path."); fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o600 }); files.push({ path: relative.replaceAll(path.sep, "/"), bytes: bytes.length, sha256: sha(bytes), ...(records === undefined ? {} : { records }) }); };
    for (const descriptor of selected) {
      const fields = coverage.find(item => item.table === descriptor.table).includedFields;
      const rows = db.prepare(`SELECT ${fields.map(quote).join(",")}${descriptor.table === "media_assets" ? ',"data"' : ""} FROM ${quote(descriptor.table)} ORDER BY ${descriptor.keys.map(quote).join(",")}`).all();
      const records = rows.map(row => { const item = record(descriptor, row); if (ids.has(item.sourceId)) throw new Error("Duplicate source identity in export."); ids.add(item.sourceId); mapping.push({ sourceId: item.sourceId, targetSystem: null, targetEntity: null, targetId: null, decision: "unreviewed" }); for (const value of Object.values(item.links)) for (const reference of Array.isArray(value) ? value : [value]) pendingLinks.push(reference);
        if (descriptor.table === "media_assets") { const bytes = Buffer.from(row.data); if (bytes.length !== row.byte_length) throw new Error("Media byte length does not match the recorded catalog asset."); item.values.content_sha256 = sha(bytes); item.values.asset_path = null; if (includeMedia) { const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[row.mime_type]; if (!extension) throw new Error("Unsupported catalog media type."); if (!fs.existsSync(path.join(destination, "assets"))) fs.mkdirSync(path.join(destination, "assets"), { mode: 0o700 }); const assetPath = `assets/${sha(item.sourceId)}.${extension}`; put(assetPath, bytes); item.values.asset_path = assetPath; } }
        return item; });
      put(`${descriptor.table}.json`, `${JSON.stringify({ contract: MIGRATION_CONTRACT, entity: descriptor.entity, records }, null, 2)}\n`, records.length);
    }
    const deferredIdentityLinks = pendingLinks.filter(reference => !ids.has(reference) && reference.startsWith(`${SYSTEM}:user:`)).length;
    const unresolvedLinks = [...new Set(pendingLinks.filter(reference => !ids.has(reference) && !reference.startsWith(`${SYSTEM}:user:`)))];
    if (unresolvedLinks.length) throw new Error("An exported relationship is not covered by this package. Review the incomplete package privately.");
    put("source-id-mapping-template.json", `${JSON.stringify({ contract: "cal-eats.source-id-map.v1", instructions: "Explicitly review each target mapping. Never merge accounts by email or name alone. Null target fields are intentional.", mappings: mapping }, null, 2)}\n`, mapping.length);
    const manifest = { ...report, dryRun: false, generatedAt: now.toISOString(), sourceIds: [...ids].sort(), files, identityLinksDeferred: deferredIdentityLinks, linkage: { unresolvedExportedEntityLinks: 0, userMappingRequired: !includeAccounts }, constraints: { sqliteSnapshotTransaction: true, queryOnly: db.prepare("PRAGMA query_only").get().query_only === 1, sourceObjectsNeverWritten: true }, financialReconciliation: includeOrders ? financialSummary(db, tables) : null, limitations: ["This is an export contract and developer handoff, not a production importer or a completed Calai merge.", "Passwords, sessions, reset tokens, device/pairing credentials, API secrets, encryption keys and worker execution state are never exported.", "Temporary order/customer chats, support content, private CRM notes, formal case correspondence and evidence blobs require a separate approved retention and privacy handoff.", "Provider object IDs are historical references, not authority to replay jobs or move money. Confirm the Cal-Eats Stripe platform and mode independently.", ...(includeMedia ? [] : ["Catalog media hashes and IDs are included; image bytes were not copied."])] };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    fs.writeFileSync(path.join(destination, "manifest.json"), manifestBytes, { flag: "wx", mode: 0o600 });
    fs.writeFileSync(path.join(destination, "manifest.sha256"), `${sha(manifestBytes)}  manifest.json\n`, { flag: "wx", mode: 0o600 });
    fs.unlinkSync(path.join(destination, "INCOMPLETE.txt"));
    return { report: { ...report, dryRun: false, filesWritten: files.length + 2, sourceIdentityCount: ids.size }, destination };
  } finally { try { if (begun) db.exec("ROLLBACK"); } finally { db.close(); } }
}

function financialSummary(db, tables) {
  return {
    orders: has(tables, "orders", ["currency", "total_minor", "commission_minor"]) ? db.prepare("SELECT restaurant_id,currency,payment_method,COUNT(*) count,SUM(total_minor) total_minor,SUM(commission_minor) commission_minor FROM orders GROUP BY restaurant_id,currency,payment_method ORDER BY restaurant_id,currency,payment_method").all() : [],
    ledger: has(tables, "ledger_entries", ["currency", "kind", "amount_minor"]) ? db.prepare("SELECT restaurant_id,currency,kind,COUNT(*) count,SUM(amount_minor) amount_minor FROM ledger_entries GROUP BY restaurant_id,currency,kind ORDER BY restaurant_id,currency,kind").all() : [],
    journal: has(tables, "journal_postings", ["currency", "account", "direction", "amount_minor"]) ? db.prepare("SELECT restaurant_id,provider_mode,currency,account,direction,COUNT(*) count,SUM(amount_minor) amount_minor FROM journal_postings GROUP BY restaurant_id,provider_mode,currency,account,direction ORDER BY restaurant_id,provider_mode,currency,account,direction").all() : [],
    note: "Reconciliation totals retain historical snapshots. Transfers, bank payouts and cash receivables remain distinct; these records must never be re-executed during import."
  };
}
function argumentsFor(args) { const options = {}; for (let index = 0; index < args.length; index++) { const arg = args[index]; if (arg === "--source") { if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error("--source needs a managed Cal-Eats database path."); options.source = args[++index]; } else if (["--write", "--include-accounts", "--include-orders", "--include-media"].includes(arg)) options[{ "--write": "write", "--include-accounts": "includeAccounts", "--include-orders": "includeOrders", "--include-media": "includeMedia" }[arg]] = true; else throw new Error("Unknown export option. Use --source, --write, --include-accounts, --include-orders or --include-media."); } return options; }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { try { const result = exportMigrationPackage(argumentsFor(process.argv.slice(2))); console.log(JSON.stringify(result, null, 2)); if (!result.report.validation.passed) process.exitCode = 1; } catch (error) { console.error(`Migration export failed: ${error.message}`); process.exitCode = 1; } }
