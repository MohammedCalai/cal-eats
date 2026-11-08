import { randomUUID } from "node:crypto";
import { requireRestaurantOwner, requireRole } from "./auth/authorization.js";
import { withTransaction } from "./db/index.js";
import { exactObject, HttpError, readJson, sendJson } from "./http.js";
import { legalContentSha256, loadApprovedLegalText } from "./customer-legal-archive.js";

const disabled = Object.freeze({ enabled: false, document: null });
const commercial = Object.freeze({ rateBasisPoints: 700, base: "food_plus_delivery", processingFeesPaidBy: "platform" });
const payouts = Object.freeze({ interval: "weekly", weeklyAnchor: "monday" });

// No draft/default text is loaded. The operator must separately approve the
// exact bytes and metadata before providing an enabled configuration.
export function loadMerchantCommercialConfig(input) {
  if (input == null || input.enabled === false) return disabled;
  if (input.enabled !== true) throw new Error("Merchant agreement enablement must be explicit");
  const d = input.document;
  if (!d || d.approved !== true || d.demoOnly === true || d.developmentAssumption === true || typeof d.version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(d.version) || /(?:draft|demo|development|fixture|test)/i.test(d.version) || !/^[a-f0-9]{64}$/.test(d.sha256 ?? "")) throw new Error("Merchant agreement requires an approved non-development version and exact SHA-256");
  if (input.commission?.rateBasisPoints !== 700 || input.commission?.base !== commercial.base || input.commission?.processingFeesPaidBy !== "platform" || input.payoutSchedule?.interval !== "weekly" || input.payoutSchedule?.weeklyAnchor !== "monday") throw new Error("Merchant agreement commercial settings must match the approved Cal-Eats policy");
  const approved = new Date(d.approvedAt), effective = new Date(d.effectiveAt);
  if (typeof d.approvedAt !== "string" || typeof d.effectiveAt !== "string" || !Number.isFinite(approved.getTime()) || !Number.isFinite(effective.getTime()) || approved.toISOString() !== d.approvedAt || effective.toISOString() !== d.effectiveAt || effective < approved || typeof d.approvalReference !== "string" || d.approvalReference.trim().length < 10 || d.approvalReference.length > 200) throw new Error("Merchant agreement requires recorded approval and canonical effective dates");
  const text = loadApprovedLegalText(d);
  if (/\b(?:unapproved|draft|demo only|development assumption)\b/i.test(text)) throw new Error("Unapproved merchant draft text cannot be activated");
  return Object.freeze({ enabled: true, document: Object.freeze({ version: d.version, sha256: d.sha256, text, approvedAt: d.approvedAt, effectiveAt: d.effectiveAt, approvalReference: d.approvalReference.trim() }), commission: commercial, payoutSchedule: payouts });
}

const policy = config => config.merchantCommercial?.enabled ? config.merchantCommercial : disabled;
function effectivePolicy(config) {
  const current = policy(config);
  if (current.enabled && current.document.effectiveAt > config.now().toISOString()) throw new HttpError(409, "MERCHANT_AGREEMENT_NOT_EFFECTIVE", "This agreement is not effective yet. Please return on its effective date.");
  return current;
}

export function initializeMerchantCommercial(db, config) {
  const current = policy(config); if (!current.enabled) return;
  const d = current.document;
  const saved = { version: d.version, content_sha256: d.sha256, text_content: d.text, approved_at: d.approvedAt, approval_reference: d.approvalReference, effective_at: d.effectiveAt, commission_rate_bps: commercial.rateBasisPoints, commission_base: commercial.base, processing_fees_paid_by: commercial.processingFeesPaidBy, payout_interval: payouts.interval, payout_anchor: payouts.weeklyAnchor };
  withTransaction(db, () => {
    const previous = db.prepare("SELECT * FROM merchant_commercial_documents WHERE version=?").get(d.version);
    if (previous) {
      if (Object.entries(saved).some(([key, value]) => previous[key] !== value)) throw new Error("An approved merchant agreement version cannot be replaced; create a new version");
    } else db.prepare("INSERT INTO merchant_commercial_documents(version,content_sha256,text_content,approved_at,approval_reference,effective_at,commission_rate_bps,commission_base,processing_fees_paid_by,payout_interval,payout_anchor,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(...Object.values(saved), config.now().toISOString());
  });
}

function archivedDocument(db, document) {
  const row = db.prepare("SELECT * FROM merchant_commercial_documents WHERE version=? AND content_sha256=?").get(document.version, document.sha256);
  if (!row || legalContentSha256(row.text_content) !== row.content_sha256 || row.text_content !== document.text) throw new HttpError(503, "MERCHANT_AGREEMENT_UNAVAILABLE", "The approved agreement could not be verified. Please try again later.");
  return row;
}

export function merchantCommercialAcceptance(db, config, restaurantId, at = config.now().toISOString()) {
  const current = policy(config); if (!current.enabled || current.document.effectiveAt > at) return null;
  archivedDocument(db, current.document);
  return db.prepare("SELECT * FROM merchant_commercial_acceptances WHERE restaurant_id=? AND document_version=? AND document_sha256=? ORDER BY accepted_at,id LIMIT 1").get(restaurantId, current.document.version, current.document.sha256) ?? null;
}

// New-order/readiness integration only. It never rewrites the development
// contracts, pricing policies, existing orders or financial history.
export function approvedMerchantCommission(db, config, restaurantId, at = config.now().toISOString()) {
  const accepted = merchantCommercialAcceptance(db, config, restaurantId, at);
  return accepted ? { ...commercial, policyVersion: accepted.document_version, documentSha256: accepted.document_sha256, acceptanceId: accepted.id, acceptedAt: accepted.accepted_at, demoOnly: false } : null;
}

export function snapshotOrderMerchantCommercial(db, order, terms) {
  if (!terms.acceptanceId) return;
  db.prepare("INSERT INTO order_merchant_commercial_snapshots VALUES(?,?,?,?,?)").run(order.id, terms.acceptanceId, terms.policyVersion, terms.documentSha256, order.created_at);
}

export function merchantCommercialRestaurantIds(db, config) {
  const current = policy(config); if (!current.enabled || current.document.effectiveAt > config.now().toISOString()) return new Set();
  archivedDocument(db, current.document);
  return new Set(db.prepare("SELECT DISTINCT restaurant_id FROM merchant_commercial_acceptances WHERE document_version=? AND document_sha256=?").all(current.document.version, current.document.sha256).map(row=>row.restaurant_id));
}

// A genuine existing real agreement keeps its saved commercial policy. A
// development policy cannot override a newly accepted approved agreement.
export function resolveMerchantCommercialTerms({ policy: priorPolicy = null, contract = null, agreement = null }) {
  const policyTerms = priorPolicy && { accepted: Boolean(priorPolicy.accepted_at), rateBasisPoints: priorPolicy.rate_bps, base: priorPolicy.commission_base, policyVersion: priorPolicy.version, demoOnly: Boolean(priorPolicy.development_assumption) };
  if (policyTerms?.accepted && !policyTerms.demoOnly && policyTerms.base === commercial.base) return policyTerms;
  if (!priorPolicy && contract?.accepted_at && !contract.demo_only) return { accepted: true, rateBasisPoints: contract.rate_bps, base: commercial.base, policyVersion: contract.policy_version, demoOnly: false };
  if (agreement) return { ...agreement, accepted: true };
  if (policyTerms) return policyTerms;
  return { accepted: Boolean(contract?.accepted_at), rateBasisPoints: contract?.rate_bps ?? 700, base: commercial.base, policyVersion: contract?.policy_version ?? "unaccepted", demoOnly: contract ? Boolean(contract.demo_only) : true };
}

function actualOwner(db, session, restaurantId) {
  const user = requireRole(session, "restaurant");
  requireRestaurantOwner(db, session, restaurantId);
  if (!db.prepare("SELECT 1 FROM users u JOIN restaurant_memberships m ON m.user_id=u.id WHERE u.id=? AND u.role='restaurant' AND u.account_enabled=1 AND m.restaurant_id=? AND m.permission='owner'").get(user.id, restaurantId)) throw new HttpError(403, "OWNER_REQUIRED", "An active restaurant owner must review and accept this agreement.");
  return user;
}

export function merchantCommercialStatus(db, config, restaurantId, ownerUserId) {
  const current = policy(config);
  if (!current.enabled) return { enabled: false, document: null, acceptedAt: null, acceptedByCurrentOwner: false };
  const d = current.document; archivedDocument(db, d);
  const accepted = d.effectiveAt <= config.now().toISOString() ? merchantCommercialAcceptance(db, config, restaurantId) : null;
  const own = accepted && db.prepare("SELECT accepted_at FROM merchant_commercial_acceptances WHERE restaurant_id=? AND owner_user_id=? AND document_version=? AND document_sha256=?").get(restaurantId, ownerUserId, d.version, d.sha256);
  return { enabled: true, restaurantName: db.prepare("SELECT name FROM restaurants WHERE id=?").get(restaurantId)?.name, document: { version: d.version, sha256: d.sha256, text: d.text, effectiveAt: d.effectiveAt }, commission: current.commission, payoutSchedule: current.payoutSchedule, canAccept: d.effectiveAt <= config.now().toISOString(), acceptedAt: accepted?.accepted_at ?? null, acceptedByCurrentOwner: Boolean(own) };
}

export async function routeMerchantCommercial({ req, res, url, db, config, session }) {
  const match = /^\/api\/restaurant\/restaurants\/([^/]+)\/merchant-agreement(?:\/(accept))?$/.exec(url.pathname);
  if (!match) return false;
  const restaurantId = match[1], owner = actualOwner(db, session, restaurantId);
  if (req.method === "GET" && !match[2]) return sendJson(res, 200, { data: merchantCommercialStatus(db, config, restaurantId, owner.id) });
  if (req.method !== "POST" || match[2] !== "accept") throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use the agreement review or acceptance action.");
  const current = effectivePolicy(config);
  if (!current.enabled) throw new HttpError(409, "MERCHANT_AGREEMENT_NOT_ACTIVE", "A reviewed merchant agreement is not available for acceptance yet.");
  const body = await readJson(req, config.bodyLimit); exactObject(body, ["version", "sha256", "accepted"]);
  if (body.version !== current.document.version || body.sha256 !== current.document.sha256) throw new HttpError(409, "MERCHANT_AGREEMENT_CHANGED", "The agreement has changed. Review the current version before accepting.");
  if (body.accepted !== true) throw new HttpError(428, "MERCHANT_AGREEMENT_ACCEPTANCE_REQUIRED", "Read the agreement and confirm your acceptance to continue.");
  withTransaction(db, () => {
    actualOwner(db, session, restaurantId); archivedDocument(db, current.document);
    const previous = db.prepare("SELECT 1 FROM merchant_commercial_acceptances WHERE restaurant_id=? AND owner_user_id=? AND document_version=? AND document_sha256=?").get(restaurantId, owner.id, body.version, body.sha256);
    if (previous) return;
    const id = randomUUID(), now = config.now().toISOString();
    db.prepare("INSERT INTO merchant_commercial_acceptances VALUES(?,?,?,?,?,?)").run(id, restaurantId, owner.id, body.version, body.sha256, now);
    db.prepare("INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)").run(randomUUID(), owner.id, "restaurant", restaurantId, "merchant_agreement_accepted", JSON.stringify({ acceptanceId: id, documentVersion: body.version, documentSha256: body.sha256 }), now);
  });
  return sendJson(res, 200, { data: merchantCommercialStatus(db, config, restaurantId, owner.id) });
}
