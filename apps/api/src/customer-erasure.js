import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import { requireRole } from "./auth/authorization.js";
import { verifyPassword } from "./auth/passwords.js";
import { withTransaction } from "./db/index.js";
import { exactObject, HttpError, readJson, sendJson } from "./http.js";
import { messageEncryptionKey } from "./message-encryption.js";
import { createOrderAlertEmailAdapter } from "./order-alert-email.js";
import { customerErasureDueAt } from "./privacy-deadline.js";

const ORDERS = "SELECT id FROM orders WHERE customer_id=?";
const THREADS = "SELECT id FROM restaurant_customer_threads WHERE customer_id=?";
const CASES = `SELECT id FROM support_cases WHERE user_id=? OR order_id IN (${ORDERS})`;
const REFUNDS = "SELECT id FROM refund_cases WHERE customer_id=?";
const NOTIFICATIONS = `SELECT id FROM user_notifications WHERE user_id=? OR customer_id=? OR order_id IN (${ORDERS}) OR conversation_id IN (${THREADS}) OR support_case_id IN (${CASES})`;
const ENTITIES = `SELECT ? UNION ${ORDERS} UNION ${THREADS} UNION ${CASES} UNION ${REFUNDS} UNION SELECT id FROM deletion_requests WHERE user_id=? UNION SELECT id FROM offer_grants WHERE customer_id=?`;
const params = (sql, userId) => Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => userId);
const run = (db, sql, userId) => db.prepare(sql).run(...params(sql, userId));
const rows = (db, sql, userId) => db.prepare(sql).all(...params(sql, userId));
const count = (db, table, where, userId) => db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`).get(...params(where, userId)).n;
const hasTable = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
const protectedErasureWrites = new Set([
  "Customer account has been erased",
  "Erased customer profiles cannot be restored",
  "Erased order contact information cannot be restored",
  "Erased support content cannot be restored"
]);

// A request can authenticate before erasure and finish reading its body after
// completion. Keep the database suppression intact, but return a clear conflict
// for these exact privacy guards instead of reporting an internal server error.
export function customerErasureWriteError(error) {
  return error?.code === "ERR_SQLITE_ERROR" && protectedErasureWrites.has(error.message)
    ? new HttpError(409, "ACCOUNT_ERASED", "This customer account has been deleted. Its personal details can no longer be changed.")
    : null;
}

export const CUSTOMER_ERASURE_RETAINED_CATEGORIES = Object.freeze([
  "Pseudonymous order, payment, commission, voucher and accounting records: necessary statutory accounting retention, normally six years from the relevant financial-year end, with documented longer exceptions.",
  "Minimal legal acceptance versions, hashes and timestamps: necessary contract evidence under the reviewed retention policy.",
  "Minimal request, review and suppression evidence: prevents restoration of erased accounts from backups.",
  "A purpose-limited encrypted completion-email recipient: removed after dispatch or within seven days. Backup copies expire under the reviewed backup schedule; suppression is required before restoration."
]);

// These are the local proposal, not evidence of owner approval. Enablement requires an
// explicitly approved, dated notice and matching configured retention values.
function approvedPolicy(config) {
  const policy = config?.customerPrivacy;
  const retention = policy?.retention;
  return Boolean(policy?.enabled === true && typeof policy.version === "string" && policy.version.length > 0
    && Number.isFinite(Date.parse(policy.approvedAt)) && typeof policy.approvalReference === "string" && policy.approvalReference.trim().length >= 10 && policy.deletionTargetCalendarMonths === 1 && policy.deletionTargetDays === 30
    && retention?.chatDays === 30 && retention?.allergyDays === 30 && retention?.orderContactDays === 90
    && retention?.resolvedSupportDays === 30 && retention?.accountingYears === 6);
}
function requirePolicy(config) {
  if (!approvedPolicy(config)) throw new HttpError(503, "PRIVACY_REVIEW_REQUIRED", "Account deletion is not activated until the privacy notice and retention arrangements have been reviewed. Your request has not been submitted.");
  return config.customerPrivacy;
}
function customerOnly(db, userId) {
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(userId);
  if (!user) throw new HttpError(404, "NOT_FOUND", "Customer account not found");
  if (user.role !== "customer" || db.prepare("SELECT 1 FROM restaurant_memberships WHERE user_id=? UNION SELECT 1 FROM business_application_submissions WHERE user_id=? LIMIT 1").get(userId, userId)) {
    throw new HttpError(409, "CUSTOMER_ERASURE_ONLY", "Business and administrator accounts require a separate review; this action erases customer accounts only.");
  }
  return user;
}

export function hasCustomerErasureHold(db, userId, now = new Date().toISOString()) {
  return Boolean(db.prepare("SELECT 1 FROM customer_erasure_holds WHERE user_id=? AND released_at IS NULL AND (expires_at IS NULL OR expires_at>?) LIMIT 1").get(userId, now));
}

const scopedTables = [
  ["customer_restaurant_safety", "customer_id=?", "restaurantBlocks"],
  ["customer_safety_reports", "customer_id=?", "safetyReportLinks"],
  ["saved_addresses", "user_id=?", "savedAddresses"],
  ["sessions", "user_id=?", "browserSessions"], ["native_sessions", "user_id=?", "mobileSessions"],
  ["native_business_sessions", "user_id=?", "legacySessions"],
  ["account_access_tokens", "user_id=?", "recoveryCredentials"], ["account_access_email_outbox", "user_id=?", "recoveryEmails"],
  ["local_mail_sink", "user_id=?", "localMailCopies"], ["marketing_preferences", "user_id=?", "marketingPreferences"],
  ["restaurant_customer_workflows", "customer_id=?", "restaurantCustomerNotes"],
  ["restaurant_customer_threads", "customer_id=?", "customerConversations"],
  ["restaurant_customer_messages", `thread_id IN (${THREADS}) OR sender_user_id=?`, "customerMessages"],
  ["order_messages", `order_id IN (${ORDERS}) OR sender_user_id=?`, "orderMessages"],
  ["support_cases", `user_id=? OR order_id IN (${ORDERS})`, "supportCasesToMinimise"],
  ["support_case_messages", `case_id IN (${CASES}) OR sender_user_id=?`, "supportMessages"],
  ["refund_case_evidence", `case_id IN (${REFUNDS}) OR actor_user_id=?`, "supportAttachments"],
  ["refund_case_messages", `case_id IN (${REFUNDS}) OR actor_user_id=?`, "legacyCaseMessages"],
  ["restaurant_order_ratings", "customer_id=?", "ratings"],
  ["offer_grants", "customer_id=?", "offerRelationships"], ["platform_vouchers", "customer_id=?", "voucherDescriptionsToMinimise"],
  ["user_notifications", `id IN (${NOTIFICATIONS})`, "notifications"],
  ["customer_transactional_email_outbox", `customer_id=? OR order_id IN (${ORDERS}) OR support_case_id IN (${CASES})`, "transactionalEmailCopies"],
  ["order_confirmation_email_outbox", `order_id IN (${ORDERS})`, "receiptEmailCopies"],
  ["customer_push_devices", "user_id=?", "pushDevices"], ["customer_push_outbox", "user_id=?", "pushDeliveries"],
  ["customer_order_live_activities", "user_id=?", "liveActivities"],
  ["device_print_jobs", `order_id IN (${ORDERS})`, "printReceiptCopies"],
  ["orders", "customer_id=?", "orderContactsToMinimise"],
  ["audit_events", `actor_user_id=? OR entity_id IN (${ENTITIES})`, "auditDetailsToMinimise"],
  ["governance_audit", `actor_user_id=? OR entity_id IN (${ENTITIES})`, "governanceDetailsToMinimise"]
];
const blockers = [
  ["ACTIVE_ORDERS", "Active orders must finish before account data can be removed.", "orders", "customer_id=? AND status IN ('placed','accepted','preparing','ready','out_for_delivery')"],
  ["UNSETTLED_PAYMENTS", "Payment authorisation or settlement is still outstanding.", "stripe_order_payments", `order_id IN (${ORDERS}) AND status IN ('pending','authorized','unknown')`],
  ["UNSETTLED_ORDER_BALANCE", "An order still has a pending or uncertain payment state.", "orders", "customer_id=? AND payment_status IN ('pending','authorized','unknown','processing')"],
  // cash_sale_recorded/held deliberately means “excluded from card settlement”,
  // not an unsettled customer payment. Keep that accounting record unchanged.
  ["UNFINISHED_FINANCIAL_OPERATIONS", "Financial operations must be reconciled first.", "marketplace_operations", `order_id IN (${ORDERS}) AND ((status IN ('pending','delayed','held','unknown') AND NOT(kind='cash_sale_recorded' AND status='held')) OR (kind='order_refund' AND status='failed'))`],
  ["OPEN_ORDER_CASES", "An unresolved order case needs a support review.", "refund_cases", "customer_id=? AND resolved_at IS NULL AND status NOT IN ('rejected','refunded')"],
  ["OPEN_SUPPORT_CASES", "Open help requests need a support review before their content is removed.", "support_cases", `(user_id=? OR order_id IN (${ORDERS})) AND status<>'resolved'`],
  ["OPEN_MESSAGE_INCIDENTS", "A reported messaging incident needs a review.", "order_message_incidents", `(order_id IN (${ORDERS}) OR reporter_user_id=?) AND status<>'resolved'`],
  ["FINANCIAL_WORKER_PENDING", "A payment or case worker still has unfinished work.", "marketplace_worker_jobs", `(entity_id IN (${ORDERS}) OR entity_id IN (${REFUNDS})) AND status IN ('queued','delayed','claimed','failed')`],
  ["EMAIL_DISPATCH_IN_PROGRESS", "An email dispatch must finish or be reconciled first.", "customer_transactional_email_outbox", `(customer_id=? OR order_id IN (${ORDERS}) OR support_case_id IN (${CASES})) AND (status='claimed' OR status='unknown')`],
  ["RECEIPT_DISPATCH_IN_PROGRESS", "A receipt dispatch must finish or be reconciled first.", "order_confirmation_email_outbox", `order_id IN (${ORDERS}) AND status IN ('claimed','unknown')`],
  ["RECOVERY_DISPATCH_IN_PROGRESS", "An account email dispatch must finish or be reconciled first.", "account_access_email_outbox", "user_id=? AND status IN ('claimed','unknown')"],
  ["PUSH_DISPATCH_IN_PROGRESS", "A notification dispatch must finish or be reconciled first.", "customer_push_outbox", "user_id=? AND status IN ('claimed','unknown')"],
  ["LIVE_ACTIVITY_DISPATCH_IN_PROGRESS", "A live-order dispatch must finish or be reconciled first.", "order_live_activity_outbox", "activity_id IN (SELECT id FROM customer_order_live_activities WHERE user_id=?) AND status IN ('claimed','unknown')"],
  ["PRINT_DISPATCH_IN_PROGRESS", "A claimed printer receipt must finish or be reconciled first.", "device_print_jobs", `order_id IN (${ORDERS}) AND status IN ('claimed','uncertain')`]
];

function planFingerprint(db, userId, config, requestId, now) {
  const { key } = messageEncryptionKey(config), digest = createHmac("sha256", key).update("cal-eats:erasure-preview:v1\0").update(userId).update(requestId ?? "");
  // Hash locally without returning any row, message, contact, token or password.
  for (const [table, where] of [...scopedTables, ["users", "id=?"], ["customer_erasure_holds", "user_id=?"], ["customer_erasure_requests", "user_id=?"]]) {
    digest.update(table);
    for (const row of db.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY rowid`).iterate(...params(where, userId))) digest.update(JSON.stringify(row));
  }
  digest.update(JSON.stringify(blockers.map(([code,,table,where]) => [code,count(db,table,where,userId)])));
  digest.update(JSON.stringify({ version: config.customerPrivacy?.version, activeHold: hasCustomerErasureHold(db,userId,now) }));
  return digest.digest("hex");
}

export function planCustomerErasure(db, userId, { now = new Date().toISOString(), config, requestId } = {}) {
  customerOnly(db, userId);
  const found = [];
  if (!approvedPolicy(config)) found.push({ code: "PRIVACY_REVIEW_REQUIRED", count: 1, message: "The privacy notice and retention arrangements must be approved and activated first." });
  if (hasCustomerErasureHold(db,userId,now)) found.push({ code: "LEGAL_HOLD", count: 1, message: "An active legal, statutory or dispute hold requires a separate review." });
  if (requestId && !db.prepare("SELECT 1 FROM customer_erasure_requests WHERE request_id=? AND user_id=?").get(requestId,userId)) found.push({ code: "VERIFIED_REQUEST_REQUIRED", count: 1, message: "The customer must submit an authenticated, password-confirmed deletion request in the app." });
  for (const [code,message,table,where] of blockers) { const n=count(db,table,where,userId); if(n)found.push({code,count:n,message}); }
  const counts = Object.fromEntries(scopedTables.map(([table,where,label]) => [label,count(db,table,where,userId)]));
  counts.financialOrdersRetained = counts.orderContactsToMinimise;
  counts.legalAcceptancesRetained = count(db,"customer_legal_acceptances","user_id=?",userId);
  if(hasTable(db,"order_customer_legal_snapshots"))counts.orderLegalSnapshotsRetained=count(db,"order_customer_legal_snapshots",`order_id IN (${ORDERS})`,userId);
  return { requestId:requestId??null,userId,eligible:found.length===0,blockers:found,counts,retainedCategories:[...CUSTOMER_ERASURE_RETAINED_CATEGORIES],
    previewHash: config && approvedPolicy(config) ? planFingerprint(db,userId,config,requestId,now) : null,policyVersion:config?.customerPrivacy?.version??null };
}

function requestView(row) {
  return { id:row.request_id,status:row.status,requestedAt:row.created_at,verifiedAt:row.verified_at,dueAt:row.due_at,
    completedAt:row.completed_at??null,retainedCategories:[...CUSTOMER_ERASURE_RETAINED_CATEGORIES],accountEnabled:row.status!=="completed" };
}
function completionSeal(config, id, recipient) {
  const {key,version}=messageEncryptionKey(config),nonce=randomBytes(12),cipher=createCipheriv("aes-256-gcm",key,nonce);
  cipher.setAAD(Buffer.from(`cal-eats:erasure-confirmation:v1:${id}`));
  return {ciphertext:Buffer.concat([cipher.update(recipient,"utf8"),cipher.final()]).toString("base64"),nonce:nonce.toString("base64"),authTag:cipher.getAuthTag().toString("base64"),keyVersion:version};
}

// Only safe contract/financial snapshot fields survive. All numeric values are
// preserved; arbitrary titles, messages, notes and contact strings are removed.
const retainedSnapshotStrings = new Set(["id","currency","type","offerType","campaignType","fundingParty","stackingPolicy","providerMode","commissionBase","base","policyVersion","version","startsAt","endsAt","expiresAt","createdAt","freePeriodStartsAt","freePeriodEndsAt","scheduledFor","status","financialParty","paymentMethod","borneBy","source","stage","caseReference","providerReference","requestHash"]);
const retainSnapshotString=key=>retainedSnapshotStrings.has(key)||/Ids?$/.test(key);
function minimiseSnapshot(value,property="") {
  if(Array.isArray(value))return value.filter(item=>typeof item!=="string"||retainSnapshotString(property)).map(item=>minimiseSnapshot(item,property));
  if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).flatMap(([key,item])=>typeof item==="string"?(retainSnapshotString(key)?[[key,item]]:[]):[[key,minimiseSnapshot(item,key)]]));
  return typeof value==="string"?(retainSnapshotString(property)?value:""):value;
}
function minimiseJson(text) {
  if(text==null)return text;try{return JSON.stringify(minimiseSnapshot(JSON.parse(text)));}catch{return null;}
}

export function applyCustomerErasure(db,userId,{requestId,adminId,config,note,previewHash}={}) {
  requirePolicy(config);
  if(typeof note!=="string"||note.trim().length<20||note.trim().length>1000)throw new HttpError(400,"VALIDATION_ERROR","Enter a review note of 20 to 1000 characters; do not include customer contact details.");
  return withTransaction(db,()=>{
    const admin=db.prepare("SELECT role,account_enabled FROM users WHERE id=?").get(adminId);
    if(admin?.role!=="admin"||!admin.account_enabled)throw new HttpError(403,"FORBIDDEN","Administrator review is required");
    const user=customerOnly(db,userId),previous=db.prepare("SELECT * FROM customer_erasure_tombstones WHERE user_id=?").get(userId);
    if(previous){if(previous.request_id!==requestId)throw new HttpError(409,"ACCOUNT_ALREADY_ERASED","This customer account has already been erased.");return {requestId,status:"completed",completedAt:previous.completed_at,retainedCategories:JSON.parse(previous.retained_classes),confirmationQueued:true};}
    const verified=db.prepare("SELECT * FROM customer_erasure_requests WHERE request_id=? AND user_id=? AND status='requested'").get(requestId,userId);
    if(!verified)throw new HttpError(409,"VERIFIED_REQUEST_REQUIRED","The customer must submit an authenticated, password-confirmed deletion request in the app.");
    if(verified.policy_version!==config.customerPrivacy.version)throw new HttpError(409,"PRIVACY_POLICY_CHANGED","Review this request against its notice version before proceeding; a changed policy cannot silently replace the customer's request.");
    const now=config.now().toISOString(),plan=planCustomerErasure(db,userId,{now,config,requestId});
    if(!plan.eligible)throw new HttpError(409,"CUSTOMER_ERASURE_BLOCKED","Outstanding orders, support, dispatches, payments or a legal hold require review. Refresh the deletion preview for details.");
    if(typeof previewHash!=="string"||previewHash!==plan.previewHash)throw new HttpError(409,"ERASURE_PREVIEW_CHANGED","Review a fresh deletion preview before completing this action.");
    const completionId=randomUUID(),seal=completionSeal(config,completionId,user.email);
    // Scrub free-text audit copies before removing the entity IDs used to scope them.
    for(const table of ["audit_events","governance_audit"])run(db,`UPDATE ${table} SET details='{"privacyMinimised":true}' WHERE actor_user_id=? OR entity_id IN (${ENTITIES})`,userId);
    for(const table of ["notification_outbox","local_notifications"])run(db,`DELETE FROM ${table} WHERE entity_id IN (${ENTITIES})`,userId);
    for(const order of rows(db,"SELECT id,offer_snapshot,promotion_snapshot,platform_voucher_snapshot,commission_control_snapshot FROM orders WHERE customer_id=?",userId)) {
      db.prepare("UPDATE orders SET offer_snapshot=?,promotion_snapshot=?,platform_voucher_snapshot=?,commission_control_snapshot=? WHERE id=?").run(minimiseJson(order.offer_snapshot),minimiseJson(order.promotion_snapshot),minimiseJson(order.platform_voucher_snapshot),minimiseJson(order.commission_control_snapshot),order.id);
    }
    const deletes=[
      ["customer_safety_reports","customer_id=?"],["customer_restaurant_safety","customer_id=?"],
      ["order_live_activity_outbox","activity_id IN (SELECT id FROM customer_order_live_activities WHERE user_id=?)"],
      ["customer_order_live_activities","user_id=?"],["customer_push_outbox",`user_id=? OR notification_id IN (${NOTIFICATIONS})`],["customer_push_devices","user_id=?"],
      ["customer_transactional_email_outbox",`customer_id=? OR notification_id IN (${NOTIFICATIONS}) OR order_id IN (${ORDERS}) OR support_case_id IN (${CASES})`],
      ["order_confirmation_email_outbox",`order_id IN (${ORDERS})`],["account_access_email_outbox","user_id=?"],["account_access_tokens","user_id=?"],["local_mail_sink","user_id=?"],
      ["user_notifications",`id IN (${NOTIFICATIONS})`],
      ["restaurant_customer_message_reads",`thread_id IN (${THREADS}) OR user_id=?`],["restaurant_customer_message_rate_limits",`thread_id IN (${THREADS}) OR user_id=?`],
      ["restaurant_customer_messages",`thread_id IN (${THREADS}) OR sender_user_id=?`],["restaurant_customer_threads","customer_id=?"],["restaurant_customer_workflows","customer_id=?"],
      ["order_message_reads",`order_id IN (${ORDERS}) OR user_id=?`],["order_message_rate_limits",`order_id IN (${ORDERS}) OR user_id=?`],["order_messages",`order_id IN (${ORDERS}) OR sender_user_id=?`],
      ["support_case_messages",`case_id IN (${CASES}) OR sender_user_id=?`],["support_message_rate_limits","user_id=?"],
      ["refund_case_evidence",`case_id IN (${REFUNDS}) OR actor_user_id=?`],["refund_case_messages",`case_id IN (${REFUNDS}) OR actor_user_id=?`],
      ["restaurant_order_ratings","customer_id=?"],["marketing_preferences","user_id=?"],["saved_addresses","user_id=?"],
      ["device_print_jobs",`order_id IN (${ORDERS})`],["print_jobs",`order_id IN (${ORDERS}) OR requested_by_user_id=?`],
      ["offer_grants",`customer_id=? AND id NOT IN (SELECT offer_grant_id FROM orders WHERE offer_grant_id IS NOT NULL)`],
      ["platform_vouchers","customer_id=? AND id NOT IN (SELECT voucher_id FROM platform_voucher_redemptions)"],
      ["sessions","user_id=?"],["native_sessions","user_id=?"],["native_business_sessions","user_id=?"]
    ];
    for(const [table,where]of deletes)run(db,`DELETE FROM ${table} WHERE ${where}`,userId);
    run(db,`UPDATE support_cases SET subject='Account data removed',message='',idempotency_key='erased:'||id,request_hash='erased' WHERE user_id=? OR order_id IN (${ORDERS})`,userId);
    run(db,`UPDATE order_message_incidents SET reason='Content removed after completed review',admin_note='' WHERE order_id IN (${ORDERS}) OR reporter_user_id=?`,userId);
    run(db,`UPDATE refund_cases SET description='',issue_hash='erased',remedy=NULL,execution_error=NULL,escalation_reason=NULL WHERE customer_id=?`,userId);
    run(db,`UPDATE refund_case_events SET details='{}' WHERE case_id IN (${REFUNDS}) OR actor_user_id=?`,userId);
    run(db,`UPDATE refund_decisions SET reason='Reviewed financial decision',remedy='Removed personal text' WHERE case_id IN (${REFUNDS})`,userId);
    run(db,`UPDATE refunds SET reason='Settled financial adjustment' WHERE order_id IN (${ORDERS})`,userId);
    run(db,`UPDATE dispute_remedy_proposals SET description='',redemption_conditions='' WHERE case_id IN (${REFUNDS})`,userId);
    run(db,`UPDATE dispute_remedy_fulfilments SET evidence='',reason='' WHERE proposal_id IN (SELECT id FROM dispute_remedy_proposals WHERE case_id IN (${REFUNDS}))`,userId);
    for(const job of rows(db,`SELECT id,payload FROM marketplace_worker_jobs WHERE entity_id IN (${ORDERS}) OR entity_id IN (${REFUNDS})`,userId))db.prepare("UPDATE marketplace_worker_jobs SET payload=?,error=NULL WHERE id=?").run(minimiseJson(job.payload)??"{}",job.id);
    for(const operation of rows(db,`SELECT id,metadata FROM marketplace_operations WHERE order_id IN (${ORDERS})`,userId))db.prepare("UPDATE marketplace_operations SET metadata=?,error=NULL WHERE id=?").run(minimiseJson(operation.metadata)??"{}",operation.id);
    run(db,`UPDATE stripe_order_payments SET checkout_url=NULL,error=NULL WHERE order_id IN (${ORDERS})`,userId);
    run(db,"UPDATE offer_grants SET viewed_at=NULL,dismissed_at=NULL WHERE customer_id=?",userId);
    db.prepare("UPDATE platform_vouchers SET title='Account data removed',message='',reason='',revoked_at=COALESCE(revoked_at,?),revoked_reason='ACCOUNT_ERASED',updated_at=? WHERE customer_id=?").run(now,now,userId);
    run(db,`UPDATE order_items SET selected_modifiers='[]',allergens='[]' WHERE order_id IN (${ORDERS})`,userId);
    run(db,"UPDATE orders SET customer_name='',customer_email='',customer_phone='',delivery_address=NULL,delivery_instructions='',allergy_notes='',idempotency_key='erased:'||id,request_hash='erased' WHERE customer_id=?",userId);
    if(hasTable(db,"order_health_consents"))db.prepare("UPDATE order_health_consents SET withdrawn_at=COALESCE(withdrawn_at,?) WHERE user_id=?").run(now,userId);
    db.prepare("UPDATE users SET name='Deleted customer',email=?,password_hash='!deleted',phone='',email_verified_at=NULL,merchant_offers=0,account_enabled=0 WHERE id=?").run(`deleted-${userId}@account.invalid`,userId);
    db.prepare("UPDATE deletion_requests SET reason='',note='',status='resolved',updated_at=? WHERE user_id=?").run(now,userId);
    db.prepare("UPDATE customer_erasure_requests SET status='completed',completed_at=? WHERE request_id=?").run(now,requestId);
    db.prepare("INSERT INTO customer_erasure_tombstones(user_id,request_id,completed_at,policy_version,retained_classes,counts_json,reviewed_by,review_note) VALUES(?,?,?,?,?,?,?,?)").run(userId,requestId,now,config.customerPrivacy.version,JSON.stringify(plan.retainedCategories),JSON.stringify(plan.counts),adminId,note.trim());
    db.prepare("INSERT INTO customer_erasure_confirmation_outbox(id,request_id,ciphertext,nonce,auth_tag,key_version,mode,status,created_at,expires_at,updated_at) VALUES(?,?,?,?,?,?,?,'pending',?,?,?)").run(completionId,requestId,seal.ciphertext,seal.nonce,seal.authTag,seal.keyVersion,config.orderAlertEmail.mode,now,new Date(Date.parse(now)+7*86400000).toISOString(),now);
    db.prepare("INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)").run(randomUUID(),adminId,"deletion_request",requestId,"customer_data_erased",JSON.stringify({requestId,status:"completed",policyVersion:config.customerPrivacy.version,retainedCategories:plan.retainedCategories,counts:plan.counts}),now);
    return {requestId,status:"completed",completedAt:now,retainedCategories:plan.retainedCategories,confirmationQueued:true};
  });
}

export async function handleCustomerErasure({req,res,url,db,config,session,checkRate}) {
  if(req.method==="GET"&&url.pathname==="/api/customer/privacy-policy")return sendJson(res,200,{data:{enabled:approvedPolicy(config),version:config.customerPrivacy?.version??null,deletionTargetDays:30,deletionTargetCalendarMonths:1}});
  if(req.method==="GET"&&["/api/account/erasure-requests","/api/native/account/erasure-requests"].includes(url.pathname)) {
    const user=requireRole(session,"customer");customerOnly(db,user.id);
    return sendJson(res,200,{data:db.prepare("SELECT e.*,d.created_at FROM customer_erasure_requests e JOIN deletion_requests d ON d.id=e.request_id WHERE e.user_id=? ORDER BY e.verified_at DESC").all(user.id).map(requestView)});
  }
  if(req.method==="POST"&&["/api/account/deletion-requests/verified","/api/native/account/deletion-request/verified"].includes(url.pathname)) {
    const actor=requireRole(session,"customer"),policy=requirePolicy(config),body=await readJson(req,config.bodyLimit);exactObject(body,["password","confirm","reason"]);
    if(body.confirm!=="DELETE MY ACCOUNT"||typeof body.password!=="string"||!body.password||body.password.length>256||body.reason!=null&&(typeof body.reason!=="string"||body.reason.length>1000))throw new HttpError(400,"VALIDATION_ERROR","Confirm account deletion with your current password. A reason is optional.");
    checkRate?.(req,`customer-erasure:${actor.id}`);
    const before=customerOnly(db,actor.id),verifiedHash=before.password_hash;
    if(!before.account_enabled||!(await verifyPassword(body.password,verifiedHash)))throw new HttpError(401,"INVALID_CREDENTIALS","Your current password is incorrect");
    const data=withTransaction(db,()=>{
      const current=customerOnly(db,actor.id);
      if(!current.account_enabled||current.password_hash!==verifiedHash)throw new HttpError(401,"AUTH_REQUIRED","Sign in again before confirming account deletion.");
      const existing=db.prepare("SELECT e.*,d.created_at FROM customer_erasure_requests e JOIN deletion_requests d ON d.id=e.request_id WHERE e.user_id=? AND e.status='requested'").get(actor.id);if(existing)return requestView(existing);
      const now=config.now().toISOString();
      // Upgrade an unverified legacy intake; never treat legacy login closure as erasure.
      const legacy=db.prepare("SELECT id,created_at FROM deletion_requests WHERE user_id=? AND status<>'resolved' AND id NOT IN (SELECT request_id FROM customer_erasure_requests) ORDER BY created_at ASC,rowid ASC LIMIT 1").get(actor.id);
      const id=legacy?.id??randomUUID(),createdAt=legacy?.created_at??now;
      if(legacy)db.prepare("UPDATE deletion_requests SET reason=?,status='requested',note='',updated_at=? WHERE id=?").run(body.reason?.trim()??"",now,id);
      else db.prepare("INSERT INTO deletion_requests(id,user_id,reason,status,note,created_at,updated_at) VALUES(?,?,?,'requested','',?,?)").run(id,actor.id,body.reason?.trim()??"",now,now);
      const dueAt=customerErasureDueAt(createdAt);
      db.prepare("INSERT INTO customer_erasure_requests(request_id,user_id,verified_at,due_at,policy_version,status) VALUES(?,?,?,?,?,'requested')").run(id,actor.id,now,dueAt,policy.version);
      db.prepare("INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)").run(randomUUID(),actor.id,"deletion_request",id,"customer_erasure_requested_verified",JSON.stringify({requestId:id,policyVersion:policy.version,verification:"current_password",dueAt}),now);
      return requestView({request_id:id,status:"requested",created_at:createdAt,verified_at:now,due_at:dueAt});
    });return sendJson(res,201,{data});
  }
  const match=url.pathname.match(/^\/api\/admin\/deletion-requests\/([^/]+)\/(erasure-preview|erase-customer)$/);
  if(!match||!["GET","POST"].includes(req.method)||req.method==="GET"&&match[2]!=="erasure-preview"||req.method==="POST"&&match[2]!=="erase-customer")return false;
  const admin=requireRole(session,"admin"),target=db.prepare("SELECT user_id FROM deletion_requests WHERE id=?").get(match[1]);
  if(!target)throw new HttpError(404,"NOT_FOUND","Deletion request not found");
  if(req.method==="GET")return sendJson(res,200,{data:planCustomerErasure(db,target.user_id,{now:config.now().toISOString(),config,requestId:match[1]})});
  const body=await readJson(req,config.bodyLimit);exactObject(body,["confirm","previewHash","note"]);
  if(body.confirm!=="ERASE CUSTOMER DATA")throw new HttpError(400,"VALIDATION_ERROR","Explicitly confirm ERASE CUSTOMER DATA after reviewing the preview.");
  return sendJson(res,200,{data:applyCustomerErasure(db,target.user_id,{requestId:match[1],adminId:admin.id,config,note:body.note,previewHash:body.previewHash})});
}

const confirmationWorkers=new WeakMap();
export function runCustomerErasureConfirmations(db,config,options={}) {
  if(confirmationWorkers.has(db))return confirmationWorkers.get(db);
  const work=dispatchConfirmations(db,config,options).finally(()=>confirmationWorkers.delete(db));confirmationWorkers.set(db,work);return work;
}
async function dispatchConfirmations(db,config,{adapter,limit=10,workerId=randomUUID(),beforeDispatch}={}) {
  const result={sent:0,localSaved:0,failed:0,unknown:0,cancelled:0};if(!approvedPolicy(config))return result;
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new TypeError("Invalid privacy confirmation worker limit");
  const now=config.now().toISOString();
  db.prepare("UPDATE customer_erasure_confirmation_outbox SET ciphertext=NULL,nonce=NULL,auth_tag=NULL,status=CASE WHEN status IN ('pending','failed') THEN 'cancelled' ELSE status END,last_error=CASE WHEN status IN ('pending','failed') THEN 'RECIPIENT_EXPIRED' ELSE last_error END,updated_at=? WHERE expires_at<=? AND (status<>'claimed' OR lease_expires_at<=?)").run(now,now,now);
  db.prepare("UPDATE customer_erasure_confirmation_outbox SET status=CASE WHEN dispatch_started_at IS NULL THEN 'pending' ELSE 'unknown' END,ciphertext=CASE WHEN dispatch_started_at IS NULL THEN ciphertext ELSE NULL END,nonce=CASE WHEN dispatch_started_at IS NULL THEN nonce ELSE NULL END,auth_tag=CASE WHEN dispatch_started_at IS NULL THEN auth_tag ELSE NULL END,last_error='LEASE_EXPIRED',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE status='claimed' AND lease_expires_at<=?").run(now,now);
  const sender=adapter??createOrderAlertEmailAdapter(config.orderAlertEmail);
  for(let i=0;i<limit;i++) {
    const row=withTransaction(db,()=>{const candidate=db.prepare("SELECT * FROM customer_erasure_confirmation_outbox WHERE status='pending' AND ciphertext IS NOT NULL AND expires_at>? ORDER BY created_at,rowid LIMIT 1").get(config.now().toISOString());if(!candidate)return null;const stamp=config.now().toISOString();db.prepare("UPDATE customer_erasure_confirmation_outbox SET status='claimed',attempts=attempts+1,lease_owner=?,lease_expires_at=?,updated_at=? WHERE id=?").run(workerId,new Date(Date.parse(stamp)+120000).toISOString(),stamp,candidate.id);return candidate;});if(!row)break;
    const owned=()=>Boolean(db.prepare("SELECT 1 FROM customer_erasure_confirmation_outbox WHERE id=? AND status='claimed' AND lease_owner=? AND lease_expires_at>? AND expires_at>?").get(row.id,workerId,config.now().toISOString(),config.now().toISOString()));
    const beforeSend=()=>{if(!owned()||!approvedPolicy(config)||row.mode!==config.orderAlertEmail.mode)return false;const stamp=config.now().toISOString();return db.prepare("UPDATE customer_erasure_confirmation_outbox SET dispatch_started_at=COALESCE(dispatch_started_at,?),updated_at=? WHERE id=? AND status='claimed' AND lease_owner=?").run(stamp,stamp,row.id,workerId).changes===1;};
    let outcome;
    try {
      await beforeDispatch?.(row.id);if(!owned())continue;
      if(row.mode!==config.orderAlertEmail.mode)outcome={status:"cancelled",errorCode:"EMAIL_MODE_CHANGED"};
      else {
        const {key,version}=messageEncryptionKey(config);if(version!==row.key_version)throw new Error("Key version changed");
        const decipher=createDecipheriv("aes-256-gcm",key,Buffer.from(row.nonce,"base64"));decipher.setAAD(Buffer.from(`cal-eats:erasure-confirmation:v1:${row.id}`));decipher.setAuthTag(Buffer.from(row.auth_tag,"base64"));
        const recipient=Buffer.concat([decipher.update(Buffer.from(row.ciphertext,"base64")),decipher.final()]).toString("utf8");
        if(row.mode!=="local"&&/(?:\.(?:invalid|local|test)|@example\.(?:com|net|org))$/i.test(recipient))outcome={status:"cancelled",errorCode:"DEMO_RECIPIENT_EXTERNAL_SEND_DISABLED"};
        else outcome=await sender({id:row.id,to:recipient,from:config.orderAlertEmail.from,subject:"Cal-Eats | Your account deletion has been completed",messageId:`<cal-eats-account-email-${row.id}@${new URL(config.origin).hostname}>`,text:["Your Cal-Eats account deletion has been completed.","Your login, saved addresses, optional messages, marketing preferences and device notification registrations have been removed. Necessary order and financial records and minimal legal evidence remain pseudonymised for the retention periods in our privacy notice. Backup copies expire under our backup schedule and must not restore your erased account.","This confirmation does not require you to sign in. For a privacy query, contact support@calai.info."].join("\n\n")},{beforeSend});
      }
    }catch{outcome={status:db.prepare("SELECT dispatch_started_at FROM customer_erasure_confirmation_outbox WHERE id=?").get(row.id)?.dispatch_started_at?"unknown":"failed",errorCode:"PRIVACY_CONFIRMATION_DELIVERY_FAILED"};}
    const status=["sent","local_saved","failed","unknown","cancelled"].includes(outcome?.status)?outcome.status:"unknown",stamp=config.now().toISOString(),purge=["sent","local_saved","unknown","cancelled"].includes(status);
    const saved=db.prepare("UPDATE customer_erasure_confirmation_outbox SET status=?,ciphertext=CASE WHEN ? THEN NULL ELSE ciphertext END,nonce=CASE WHEN ? THEN NULL ELSE nonce END,auth_tag=CASE WHEN ? THEN NULL ELSE auth_tag END,last_error=?,sent_at=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND status='claimed' AND lease_owner=?").run(status,+purge,+purge,+purge,/^[A-Z0-9_]{1,80}$/.test(outcome?.errorCode??"")?outcome.errorCode:null,["sent","local_saved"].includes(status)?stamp:null,stamp,row.id,workerId);
    if(saved.changes)result[status==="local_saved"?"localSaved":status]++;
  }
  return result;
}
