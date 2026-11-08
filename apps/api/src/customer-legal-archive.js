import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { HttpError } from "./http.js";

const kinds = ["terms", "privacy"];
const escape = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
export const legalContentSha256 = text => createHash("sha256").update(text, "utf8").digest("hex");
export const legalVersionPath = (kind, version) => `/legal/${kind}/${encodeURIComponent(version)}`;

// Document bytes are never trimmed or normalised: a different newline is a
// different approved document. Only packaged, named archive files can be used.
export function loadApprovedLegalText(document) {
  if ((typeof document.text === "string") === (typeof document.archiveFile === "string")) throw new Error("Approved legal documents require exactly one text or archiveFile source");
  let text = document.text;
  if (document.archiveFile !== undefined) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.txt$/.test(document.archiveFile)) throw new Error("Approved legal archive filename is invalid");
    const bytes = readFileSync(new URL(`../legal-documents/${document.archiveFile}`, import.meta.url));
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  }
  if (!text || Buffer.byteLength(text, "utf8") > 500000 || text.includes("\0") || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)) throw new Error("Approved legal text must be non-empty valid UTF-8 of at most 500000 bytes");
  if (legalContentSha256(text) !== document.sha256) throw new Error("Approved legal document text does not match its SHA-256");
  return text;
}

export function archiveCustomerLegalDocument(db, kind, document, now) {
  const old = db.prepare("SELECT * FROM customer_legal_document_archive WHERE document_kind=? AND document_version=?").get(kind, document.version);
  if (old) {
    if (old.content_sha256 !== document.sha256 || old.text_content !== document.text || legalContentSha256(old.text_content) !== old.content_sha256) throw new Error("An approved legal archive version cannot be replaced; create a new version");
    return;
  }
  db.prepare("INSERT INTO customer_legal_document_archive VALUES(?,?,?,?,?)").run(kind, document.version, document.sha256, document.text, now);
}

function archivedDocument(db, kind, version) {
  const document = db.prepare("SELECT a.*,d.public_url,d.approved_at,d.effective_at FROM customer_legal_document_archive a JOIN customer_legal_documents d ON d.kind=a.document_kind AND d.version=a.document_version WHERE a.document_kind=? AND a.document_version=?").get(kind, version);
  if (document && legalContentSha256(document.text_content) !== document.content_sha256) throw new HttpError(503, "LEGAL_ARCHIVE_UNAVAILABLE", "This document is temporarily unavailable.");
  return document;
}

// Called only inside the new-order transaction, after its INSERT. Replayed
// requests return before this hook and cannot adopt a later document version.
export function snapshotOrderCustomerLegal(db, config, order) {
  if (!config.customerLegal?.enabled) return;
  for (const kind of kinds) {
    const document = config.customerLegal.documents[kind];
    const acceptance = db.prepare("SELECT * FROM customer_legal_acceptances WHERE user_id=? AND document_kind=? AND document_version=? AND document_sha256=?").get(order.customer_id, kind, document.version, document.sha256);
    const archive = archivedDocument(db, kind, document.version);
    if (!acceptance || !archive || archive.content_sha256 !== document.sha256) throw new HttpError(503, "LEGAL_ARCHIVE_UNAVAILABLE", "Your accepted documents could not be saved with this order. Please try again later.");
    db.prepare("INSERT INTO order_customer_legal_snapshots VALUES(?,?,?,?,?,?,?,?)").run(order.id, kind, document.version, document.sha256, acceptance.id, acceptance.acknowledged_at, acceptance.channel, order.created_at);
  }
}

export function orderCustomerLegalSnapshot(db, orderId) {
  const rows = db.prepare("SELECT s.*,d.public_url,d.effective_at FROM order_customer_legal_snapshots s JOIN customer_legal_documents d ON d.kind=s.document_kind AND d.version=s.document_version WHERE s.order_id=?").all(orderId);
  if (!rows.length) return null; // Older orders never receive invented acceptance.
  return Object.fromEntries(rows.map(row => [row.document_kind, { version: row.document_version, sha256: row.document_sha256, url: row.public_url, effectiveAt: row.effective_at, acknowledgedAt: row.acknowledged_at, channel: row.channel }]));
}

export function orderCustomerTermsCopy(db, orderId) {
  const snapshot = orderCustomerLegalSnapshot(db, orderId)?.terms;
  if (!snapshot) return null;
  const archive = archivedDocument(db, "terms", snapshot.version);
  if (!archive || archive.content_sha256 !== snapshot.sha256) throw new HttpError(503, "LEGAL_ARCHIVE_UNAVAILABLE", "The accepted Terms copy is unavailable.");
  return { ...snapshot, text: archive.text_content };
}

function page(document, kind) {
  const title = kind === "terms" ? "Customer Terms and Conditions" : "Customer Privacy Notice";
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cal-Eats ${title}</title><style>body{margin:0;background:#f2f7fc;color:#19334a;font:17px/1.65 system-ui,sans-serif}main{max-width:820px;margin:auto;padding:28px 20px 64px}header{border-bottom:1px solid #cadbe8;margin-bottom:24px;padding-bottom:18px}h1{font-size:clamp(1.6rem,5vw,2.2rem);line-height:1.2}p{margin:.7em 0}a{color:#145ab6}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}small{overflow-wrap:anywhere}@media print{body{background:white}main{max-width:none;padding:0}}</style></head><body><main><header><p>Cal-Eats · CALAI LTD</p><h1>${title}</h1><p>Version ${escape(document.document_version)} · Effective ${escape(document.effective_at.slice(0,10))}</p><a href="${legalVersionPath(kind, document.document_version)}.txt" download>Download this exact version as text</a></header><pre>${escape(document.text_content)}</pre><footer><small>Document SHA-256: ${escape(document.content_sha256)}</small></footer></main></body></html>`;
}

export function routeCustomerLegalArchive({ req, res, url, db, config }) {
  if (!["GET", "HEAD"].includes(req.method) || !url.pathname.startsWith("/legal/")) return false;
  const match = /^\/legal\/(terms|privacy)(?:\/([A-Za-z0-9][A-Za-z0-9._-]{0,83}))?$/.exec(url.pathname);
  if (!match || url.search) throw new HttpError(404, "NOT_FOUND", "Document not found");
  const kind = match[1], raw = match[2], downloadable = raw?.endsWith(".txt"), version = downloadable ? raw.slice(0,-4) : raw;
  if (!version) {
    const current = config.customerLegal?.enabled && config.customerLegal.documents[kind];
    if (!current || current.effectiveAt > config.now().toISOString()) throw new HttpError(404, "NOT_FOUND", "Document not found");
    res.writeHead(302, { Location: legalVersionPath(kind,current.version), "Cache-Control": "no-store" }); res.end(); return true;
  }
  if (version.length > 80) throw new HttpError(404, "NOT_FOUND", "Document not found");
  const document = archivedDocument(db, kind, version);
  if (!document || document.effective_at > config.now().toISOString()) throw new HttpError(404, "NOT_FOUND", "Document not found");
  const body = downloadable ? document.text_content : page(document,kind);
  res.writeHead(200, { "Content-Type": downloadable ? "text/plain; charset=utf-8" : "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "public,max-age=31536000,immutable", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'", ETag: `"${document.content_sha256}${downloadable ? "-text" : "-html"}"`, ...(downloadable ? { "Content-Disposition": `attachment; filename="cal-eats-${kind}-${version}.txt"` } : {}) });
  res.end(req.method === "HEAD" ? undefined : body); return true;
}
