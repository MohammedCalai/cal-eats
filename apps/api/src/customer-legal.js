import { randomUUID } from "node:crypto";
import { requireRole } from "./auth/authorization.js";
import { withTransaction } from "./db/index.js";
import { exactObject, HttpError, readJson, sendJson } from "./http.js";

const fields = ["termsVersion", "termsSha256", "termsAccepted", "privacyVersion", "privacySha256", "privacyNoticeAcknowledged"];
const disabled = Object.freeze({ enabled: false, documents: null });

// This has no default documents, draft copy or approval. Activation is a later,
// separate operator step after the exact customer-facing texts are approved.
export function loadCustomerLegalConfig(input, origin) {
  if (input == null || input.enabled === false) return disabled;
  if (input.enabled !== true) throw new Error("Customer legal enablement must be an explicit boolean");
  const documents = {};
  for (const kind of ["terms", "privacy"]) {
    const value = input.documents?.[kind];
    if (!value || typeof value.version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value.version) || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error("Approved legal documents require a string version and exact SHA-256");
    if (typeof value.url !== "string" || typeof value.approvedAt !== "string" || typeof value.effectiveAt !== "string") throw new Error("Approved legal URL and dates must be strings");
    let url; try { url = new URL(value.url, origin); } catch { throw new Error("Approved legal document URL is invalid"); }
    if (url.origin !== origin || url.username || url.password || url.search || url.hash || !url.pathname.startsWith("/legal/")) throw new Error("Approved legal documents must have a dedicated same-origin /legal/ URL");
    const approved = new Date(value.approvedAt), effective = new Date(value.effectiveAt);
    if (!Number.isFinite(approved.getTime()) || !Number.isFinite(effective.getTime()) || approved.toISOString() !== value.approvedAt || effective.toISOString() !== value.effectiveAt || effective < approved || typeof value.approvalReference !== "string" || value.approvalReference.trim().length < 10 || value.approvalReference.length > 200) throw new Error("Approved legal documents require operator approval and canonical UTC effective dates");
    documents[kind] = Object.freeze({ version: value.version, sha256: value.sha256, url: url.href, approvedAt: approved.toISOString(), approvalReference: value.approvalReference.trim(), effectiveAt: effective.toISOString() });
  }
  return Object.freeze({ enabled: true, documents: Object.freeze(documents) });
}

function policy(config) { return config.customerLegal?.enabled ? config.customerLegal : disabled; }
function requireEffective(config) {
  const active = policy(config);
  if (active.enabled && Object.values(active.documents).some(document => document.effectiveAt > config.now().toISOString())) throw new HttpError(503, "LEGAL_POLICY_NOT_EFFECTIVE", "The approved customer documents are not effective yet. Please try again later.");
  return active;
}

export function initializeCustomerLegal(db, config) {
  const active = policy(config); if (!active.enabled) return;
  withTransaction(db, () => {
    for (const [kind, document] of Object.entries(active.documents)) {
      const old = db.prepare("SELECT * FROM customer_legal_documents WHERE kind=? AND version=?").get(kind, document.version);
      if (old) {
        for (const [field, value] of Object.entries({ content_sha256: document.sha256, public_url: document.url, approved_at: document.approvedAt, approval_reference: document.approvalReference, effective_at: document.effectiveAt })) if (old[field] !== value) throw new Error("An approved legal document version cannot be replaced; create a new version");
      } else db.prepare("INSERT INTO customer_legal_documents VALUES(?,?,?,?,?,?,?,?)").run(kind, document.version, document.sha256, document.url, document.approvedAt, document.approvalReference, document.effectiveAt, config.now().toISOString());
    }
  });
}

export function customerLegalStatus(db, config, userId = null) {
  const active = requireEffective(config);
  if (!active.enabled) return { enabled: false, terms: null, privacy: null, termsAcceptanceRequired: false, privacyAcknowledgementRequired: false };
  const has = kind => Boolean(userId && db.prepare("SELECT 1 FROM customer_legal_acceptances WHERE user_id=? AND document_kind=? AND document_version=? AND document_sha256=?").get(userId, kind, active.documents[kind].version, active.documents[kind].sha256));
  const publicDocument = ({ version, sha256, url, effectiveAt }) => ({ version, sha256, url, effectiveAt });
  return { enabled: true, terms: publicDocument(active.documents.terms), privacy: publicDocument(active.documents.privacy), termsAcceptanceRequired: !has("terms"), privacyAcknowledgementRequired: !has("privacy") };
}

export function validateCustomerLegalSubmission(db, config, userId, submitted) {
  const status = customerLegalStatus(db, config, userId); if (!status.enabled) return null;
  const body = submitted ?? {}; exactObject(body, fields);
  for (const kind of ["terms", "privacy"]) {
    const version = body[`${kind}Version`], hash = body[`${kind}Sha256`];
    const required = kind === "terms" ? status.termsAcceptanceRequired : status.privacyAcknowledgementRequired;
    if (version !== undefined || hash !== undefined || required) {
      if (version !== status[kind].version || hash !== status[kind].sha256) throw new HttpError(409, "LEGAL_DOCUMENT_CHANGED", "Review the current Terms and Privacy Notice before continuing.");
    }
  }
  if (status.termsAcceptanceRequired && body.termsAccepted !== true) throw new HttpError(428, "TERMS_ACCEPTANCE_REQUIRED", "Please read and accept the current Terms before continuing.");
  if (status.privacyAcknowledgementRequired && body.privacyNoticeAcknowledged !== true) throw new HttpError(428, "PRIVACY_ACKNOWLEDGEMENT_REQUIRED", "Please read and acknowledge the current Privacy Notice before continuing.");
  if ((body.termsAccepted !== undefined && typeof body.termsAccepted !== "boolean") || (body.privacyNoticeAcknowledged !== undefined && typeof body.privacyNoticeAcknowledged !== "boolean")) throw new HttpError(400, "VALIDATION_ERROR", "Legal acknowledgement fields must be booleans");
  return status;
}

// The caller includes this in the account/order transaction. Existing records
// are never rewritten when a request is retried or a document version changes.
export function recordCustomerLegalSubmission(db, config, userId, submitted, channel, context) {
  const status = validateCustomerLegalSubmission(db, config, userId, submitted); if (!status) return;
  for (const kind of ["terms", "privacy"]) {
    const affirmative = kind === "terms" ? submitted?.termsAccepted : submitted?.privacyNoticeAcknowledged;
    if (!affirmative) continue;
    db.prepare("INSERT OR IGNORE INTO customer_legal_acceptances VALUES(?,?,?,?,?,?,?,?)").run(randomUUID(), userId, kind, status[kind].version, status[kind].sha256, config.now().toISOString(), channel, context);
  }
}

export function requireCurrentCustomerLegal(db, config, userId) {
  const status = customerLegalStatus(db, config, userId);
  if (status.termsAcceptanceRequired || status.privacyAcknowledgementRequired) throw new HttpError(428, "CUSTOMER_LEGAL_REVIEW_REQUIRED", "Review the current Terms and Privacy Notice before placing a new order.");
}

export async function routeCustomerLegal({ req, res, url, db, config, session }) {
  if (url.pathname === "/api/customer/legal" && req.method === "GET") return sendJson(res, 200, { data: customerLegalStatus(db, config, session?.user.role === "customer" ? session.user.id : null) });
  if (url.pathname !== "/api/customer/legal/acceptances" || req.method !== "POST") return false;
  const user = requireRole(session, "customer"), body = await readJson(req, config.bodyLimit);
  exactObject(body, fields);
  if (!policy(config).enabled) throw new HttpError(409, "CUSTOMER_LEGAL_NOT_ACTIVE", "Customer legal documents have not been activated.");
  withTransaction(db, () => {
    if (!db.prepare("SELECT 1 FROM users WHERE id=? AND role='customer' AND account_enabled=1").get(user.id)) throw new HttpError(401, "AUTH_REQUIRED", "Authentication required");
    recordCustomerLegalSubmission(db, config, user.id, body, session.native ? "native" : "web", "new_order");
  });
  return sendJson(res, 200, { data: customerLegalStatus(db, config, user.id) });
}
