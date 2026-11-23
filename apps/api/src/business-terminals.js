import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { publicUser } from "../../../packages/contracts/src/index.js";
import { HttpError, exactObject, readJson, readRequestBody, sendJson } from "./http.js";
import { withTransaction } from "./db/index.js";
import {requireRestaurantMembership,requireRestaurantOwner} from './auth/authorization.js';
import { businessAccountState, hasCurrentBusinessOwner, requireBusinessAccountOwner } from "./unified-business.js";
import { buildTerminalInstaller } from "../../terminal-auth/windows/build-installer.mjs";
import { businessProductState, currentCalaiApproverProof, terminalHasCalaiAuthority } from "./business-product-policy.js";
import {assertFleetNewEnrolmentAllowed,assertFleetTerminalAllowed,assertFleetPairingAllowed,recordEnrolledTabletInventory} from './tablet-fleet-policy.js';
import {tabletApplicationProducts,tabletProductPermitted,tabletApplicationConfiguration,hasNativeCalaiSetupAuthority} from './tablet-product-policy.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const verifiedProof = Symbol("business-terminal-proof");
export const TERMINAL_GRANT_MS = 30 * 60_000;
export const TERMINAL_SIGNATURE_MAX_AGE_MS = 60_000;
const hash = value => createHash("sha256").update(value).digest("hex");
const now = config => config.now().toISOString();
const failure = (code, message, status = 403) => new HttpError(status, code, message);
const isTerminal = session => session?.principalKind === "terminal";

export function hasBusinessTerminalHeaders(req) {
  return ["x-cal-eats-terminal-id","x-cal-eats-terminal-timestamp","x-cal-eats-terminal-nonce","x-cal-eats-terminal-signature","x-cal-eats-terminal-session"].some(name => req.headers[name] !== undefined);
}

function keyDetails(value) {
  try {
    if (typeof value !== "string" || value.length > 500) throw Error();
    const bytes = Buffer.from(value, "base64");
    if (bytes.toString("base64") !== value) throw Error();
    const key = createPublicKey({ key: bytes, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw Error();
    return { key, sha256: hash(bytes) };
  } catch { throw failure("TERMINAL_KEY_INVALID", "A valid restaurant tablet public key is required.", 400); }
}

function signatureBytes(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(value)) throw failure("TERMINAL_SIGNATURE_INVALID", "The tablet request could not be verified.", 401);
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 64 || bytes.toString("base64url") !== value) throw failure("TERMINAL_SIGNATURE_INVALID", "The tablet request could not be verified.", 401);
  return bytes;
}

export function businessTerminalCanonical({ terminalId, timestamp, nonce, method, target, body = Buffer.alloc(0) }) {
  return ["CAL-EATS-TERMINAL-V1", terminalId, timestamp, nonce, method.toUpperCase(), target, hash(body)].join("\n");
}
export function businessTerminalPairingProof({ terminalId, challenge, publicKeySpki }) {
  return ["CAL-EATS-PAIR-V1", terminalId, challenge, keyDetails(publicKeySpki).sha256].join("\n");
}

function activeTerminal(db, id) {
  const terminal=db.prepare("SELECT t.* FROM business_terminals t JOIN business_accounts b ON b.id=t.business_id JOIN users u ON u.id=t.operator_user_id WHERE t.id=? AND t.revoked_at IS NULL AND b.archived_at IS NULL AND u.account_enabled=1 AND u.principal_kind='terminal'").get(id);
  assertFleetTerminalAllowed(db,terminal);return terminal;
}

function activeOwnerExists(db, businessId) {
  return hasCurrentBusinessOwner(db, businessId);
}

function owner(db, session, businessId, config) {
  if (!session || isTerminal(session)) throw failure("OWNER_SIGN_IN_REQUIRED", "Sign in as the business owner to change tablet access.", 401);
  if(session.nativeAudience==='business')throw failure("TABLET_SETUP_WEB_REQUIRED","Manage tablet registration through the authorised business website, not the monitoring phone app.");
  if(session.sessionId){
    const table=session.nativeAudience==='platform-admin'?'native_platform_sessions':'sessions';
    if(!db.prepare(`SELECT 1 FROM ${table} WHERE id=? AND user_id=? AND revoked_at IS NULL AND expires_at>?`).get(session.sessionId,session.user?.id,config.now().toISOString()))throw failure('OWNER_SIGN_IN_REQUIRED','Sign in again before changing tablet registration.',401);
  }
  const user = db.prepare("SELECT id,role,account_enabled,principal_kind FROM users WHERE id=?").get(session.user?.id);
  if (!user || !user.account_enabled || user.principal_kind !== "human" || !["admin","restaurant"].includes(user.role)) throw failure("OWNER_REQUIRED", "Business owner access is required.");
  if (!db.prepare("SELECT 1 FROM business_accounts WHERE id=? AND archived_at IS NULL").get(businessId)) throw failure("NOT_FOUND", "Business not found.", 404);
  requireBusinessAccountOwner(db, session, businessId);
  const native=db.prepare("SELECT restaurant_id FROM business_product_links WHERE business_id=? AND product='cal-eats'").get(businessId);if(native&&user.role!=='admin')requireRestaurantOwner(db,session,native.restaurant_id);
  return user;
}

function issuerAllowed(db, userId, businessId) {
  const user = db.prepare("SELECT role,account_enabled,principal_kind FROM users WHERE id=?").get(userId);
  if (!user?.account_enabled || user.principal_kind !== "human") return false;
  try {
    const session={user:{id:userId,role:user.role}};
    requireBusinessAccountOwner(db, session, businessId);
    const native=db.prepare("SELECT restaurant_id FROM business_product_links WHERE business_id=? AND product='cal-eats'").get(businessId);
    if(native&&user.role!=='admin')requireRestaurantOwner(db,session,native.restaurant_id);
    if(!native&&!hasNativeCalaiSetupAuthority(db,userId,businessId))return false;
    return true;
  } catch { return false; }
}

function audit(db, actor, businessId, action, details, stamp) {
  db.prepare("INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)").run(randomUUID(), actor, "business_terminal", businessId, action, JSON.stringify(details), stamp);
}

function terminalContext(db, config, terminal) {
  if (!activeOwnerExists(db, terminal.business_id)) throw failure("TERMINAL_BUSINESS_UNAVAILABLE", "The restaurant tablet needs its owner's attention.");
  const business = businessAccountState(db, terminal.business_id,{config});
  if (!business || business.id !== terminal.business_id) throw failure("TERMINAL_BUSINESS_CHANGED", "Register this tablet with the current business account again.");
  const products = tabletApplicationProducts(db, terminal.id, terminal.business_id, business.products);
  // Keep native location identity stable across mode changes. A location is not
  // authority: current scoped products are checked on every request below.
  const eats = business.products?.["cal-eats"]?.linked === true && business.eatsRestaurantId ? business.eatsRestaurantId : null;
  const actor = db.prepare("SELECT id,name,email,role,phone,principal_kind FROM users WHERE id=? AND account_enabled=1 AND principal_kind='terminal'").get(terminal.operator_user_id);
  if (!actor) throw failure("TERMINAL_REVOKED", "This restaurant tablet is no longer authorised.");
  // This actor never owns a merchant, and cannot keep an old product membership.
  withTransaction(db, () => {
    db.prepare("DELETE FROM restaurant_memberships WHERE user_id=? AND (? IS NULL OR restaurant_id<>?)").run(actor.id, eats, eats);
    if (eats) {
      const merchant = db.prepare("SELECT id FROM restaurants WHERE id=? AND archived_at IS NULL").get(eats);
      if (!merchant) throw failure("TERMINAL_BUSINESS_CHANGED", "The restaurant account is unavailable.");
      db.prepare("INSERT INTO restaurant_memberships(restaurant_id,user_id,created_at,permission) VALUES(?,?,?,'staff') ON CONFLICT(restaurant_id,user_id) DO UPDATE SET permission='staff'").run(eats, actor.id, now(config));
    }
  });
  return { user: publicUser(actor), principalKind: "terminal", terminalId: terminal.id, businessId: terminal.business_id, restaurantId: eats, calaiReadAuthorized:products.calai.active && terminalHasCalaiAuthority(db,terminal.id,terminal.business_id), products, tabletConfiguration:tabletApplicationConfiguration(db,terminal.id,terminal.business_id) };
}

export async function verifyBusinessTerminalRequest({ req, db, config }) {
  if (req[verifiedProof]) {
    const fresh = activeTerminal(db, req[verifiedProof]);
    if (!fresh) throw failure("TERMINAL_REVOKED", "This restaurant tablet is no longer authorised.");
    return fresh;
  }
  const id = req.headers["x-cal-eats-terminal-id"], timestamp = req.headers["x-cal-eats-terminal-timestamp"], nonce = req.headers["x-cal-eats-terminal-nonce"];
  if (typeof id !== "string" || !UUID.test(id) || typeof timestamp !== "string" || !/^\d{13}$/.test(timestamp) || typeof nonce !== "string" || !/^[A-Za-z0-9_-]{22,86}$/.test(nonce)) throw failure("TERMINAL_SIGNATURE_REQUIRED", "Use the registered restaurant tablet.", 401);
  if (Math.abs(config.now().getTime() - Number(timestamp)) > TERMINAL_SIGNATURE_MAX_AGE_MS) throw failure("TERMINAL_SIGNATURE_EXPIRED", "The tablet request expired. Reconnecting…", 401);
  const terminal = activeTerminal(db, id);
  if (!terminal) throw failure("TERMINAL_REVOKED", "This restaurant tablet is no longer authorised.");
  const body = await readRequestBody(req, config.bodyLimit);
  const url = new URL(req.url, config.origin);
  const canonical = businessTerminalCanonical({ terminalId: id, timestamp, nonce, method: req.method, target: url.pathname + url.search, body });
  if (!verify("sha256", Buffer.from(canonical), { key: keyDetails(terminal.public_key_spki).key, dsaEncoding: "ieee-p1363" }, signatureBytes(req.headers["x-cal-eats-terminal-signature"]))) throw failure("TERMINAL_SIGNATURE_INVALID", "The tablet request could not be verified.", 401);
  withTransaction(db, () => {
    const fresh=activeTerminal(db,id);
    if(!fresh||fresh.public_key_sha256!==terminal.public_key_sha256||fresh.business_id!==terminal.business_id)throw failure('TERMINAL_REVOKED','This restaurant tablet is no longer authorised.');
    db.prepare("DELETE FROM business_terminal_nonces WHERE expires_at<=?").run(now(config));
    try { db.prepare("INSERT INTO business_terminal_nonces VALUES(?,?,?)").run(id, nonce, new Date(config.now().getTime() + 120_000).toISOString()); }
    catch (error) {
      if (String(error.message).includes("UNIQUE")) throw failure("TERMINAL_REQUEST_REPLAYED", "This tablet request has already been used.", 409);
      throw error;
    }
  });
  req[verifiedProof] = id;
  return terminal;
}

export async function readBusinessTerminalSession({ req, url, db, config }) {
  if (!hasBusinessTerminalHeaders(req)) return null;
  if (req.headers.cookie || req.headers.authorization) throw failure("MIXED_TERMINAL_AUTHORITY", "Tablet access cannot be combined with another sign-in.");
  const terminal = await verifyBusinessTerminalRequest({ req, db, config });
  if (req.method === "POST" && new RegExp("^/api/terminal-devices/" + terminal.id + "/(?:operator-session|heartbeat)$").test(url.pathname)) return null;
  const token = req.headers["x-cal-eats-terminal-session"];
  if (typeof token !== "string" || !SECRET.test(token)) throw failure("TERMINAL_SESSION_REQUIRED", "The restaurant tablet is reconnecting.", 401);
  const grant = db.prepare("SELECT * FROM business_terminal_grants WHERE token_hash=? AND terminal_id=? AND revoked_at IS NULL AND expires_at>?").get(hash(token), terminal.id, now(config));
  if (!grant || grant.operator_user_id !== terminal.operator_user_id) throw failure("TERMINAL_SESSION_EXPIRED", "The restaurant tablet is reconnecting.", 401);
  const context = terminalContext(db, config, terminal);
  db.prepare("UPDATE business_terminals SET last_contact_at=? WHERE id=? AND revoked_at IS NULL").run(now(config), terminal.id);
  return { ...context, sessionId: "terminal:" + terminal.id, terminalGrantHash: hash(token) };
}

export function assertBusinessTerminalSessionLive({ db, config, session, restaurantId = null, product = 'cal-eats' }) {
  if (!isTerminal(session)) throw failure('REGISTERED_TABLET_REQUIRED','Use the registered restaurant tablet to process or print orders.');
  const terminal = activeTerminal(db, session.terminalId);
  const grant = session.terminalGrantHash && db.prepare("SELECT 1 FROM business_terminal_grants WHERE token_hash=? AND terminal_id=? AND operator_user_id=? AND revoked_at IS NULL AND expires_at>?").get(session.terminalGrantHash, session.terminalId, session.user.id, now(config));
  if (!terminal || !grant || terminal.business_id !== session.businessId || terminal.operator_user_id !== session.user.id) throw failure("TERMINAL_REVOKED", "This restaurant tablet is no longer authorised.");
  if (!activeOwnerExists(db, terminal.business_id)) throw failure("TERMINAL_BUSINESS_UNAVAILABLE", "The restaurant tablet needs its owner's attention.");
  const business = businessAccountState(db, terminal.business_id,{config});
  if (!business || business.id !== terminal.business_id) throw failure("TERMINAL_BUSINESS_CHANGED", "The business account changed.");
  if (product && !tabletProductPermitted(db, terminal.id, terminal.business_id, product)) throw failure('PRODUCT_INACTIVE', 'This service is not enabled on the registered tablet.');
  if (restaurantId && (business.products?.["cal-eats"]?.linked !== true || business.eatsRestaurantId !== restaurantId)) throw failure("PRODUCT_INACTIVE", "The Cal-Eats account is not connected to this tablet.");
}
export function requireOperationalPrinterUser(db,config,session,restaurantId){assertBusinessTerminalSessionLive({db,config,session,restaurantId});return requireRestaurantMembership(db,session,restaurantId);}

function requireEats(session) {
  if (!session.restaurantId || session.products?.["cal-eats"]?.linked !== true) throw failure("PRODUCT_INACTIVE", "The Cal-Eats account is not connected to this tablet.");
  return session.restaurantId;
}
function ownRestaurant(session, id) {
  if (id !== requireEats(session)) throw failure("NOT_FOUND", "Restaurant resource not found.", 404);
}
function ownOrder(db, session, id) {
  const row = db.prepare("SELECT restaurant_id FROM orders WHERE id=?").get(id);
  if (!row || row.restaurant_id !== requireEats(session)) throw failure("NOT_FOUND", "Order not found.", 404);
}

export function enforceBusinessTerminalCapabilities({ req, url, db, session,config }) {
  const operational=(req.method==='PATCH'&&/^\/api\/restaurant\/orders\/[^/]+\/(?:status|preparation)$/.test(url.pathname))||(req.method==='POST'&&/^\/api\/restaurant\/restaurants\/[^/]+\/printers\/[^/]+\/(?:test-receipt|reprints|jobs\/[^/]+\/check)$/.test(url.pathname))||(['POST','PATCH'].includes(req.method)&&/^\/api\/(?:print-jobs\/[^/]+\/(?:retry|status)|orders\/[^/]+\/print)$/.test(url.pathname));
  if(operational)assertBusinessTerminalSessionLive({db,config,session});
  if (!isTerminal(session)) return;
  const method = req.method, path = url.pathname;
  if (method === "GET" && ["/api/auth/me","/api/business/context","/api/business/dashboard"].includes(path)) return;
  const presence=/^\/api\/business\/accounts\/([^/]+)\/surface\/heartbeat$/.exec(path);if(method==='POST'&&presence&&presence[1]===session.businessId)return;
  if (method === "GET" && /^\/api\/business\/calai\/(?:orders|hours)$/.test(path)) {
    if (session.products?.calai?.active !== true) throw failure("PRODUCT_INACTIVE", "Calai is not active for this business.");
    return;
  }
  if (method === "GET" && path === "/api/restaurant/restaurants") { requireEats(session); return; }
  if (method === "GET" && path === "/api/restaurant/orders/pending-confirmation") {
    requireEats(session);
    const id = url.searchParams.get("restaurantId");
    if (id) ownRestaurant(session, id);
    return;
  }
  let match = /^\/api\/restaurant\/restaurants\/([^/]+)\/(?:dashboard|orders|printer-status|message-attention|surface-status|device-incidents|printers)$/.exec(path);
  if (method === "GET" && match) { ownRestaurant(session, match[1]); return; }
  match = /^\/api\/orders\/([^/]+)(?:\/(?:messages|conversation))?$/.exec(path);
  if (match && (method === "GET" || method === "POST" && path.endsWith("/messages"))) { ownOrder(db, session, match[1]); return; }
  match = /^\/api\/restaurant\/orders\/([^/]+)\/(?:status|preparation)$/.exec(path);
  if (method === "PATCH" && match) { ownOrder(db, session, match[1]); return; }
  match=/^\/api\/restaurant\/restaurants\/([^/]+)\/printers\/[^/]+\/(?:test-receipt|reprints|jobs\/[^/]+\/check)$/.exec(path);if(method==='POST'&&match){ownRestaurant(session,match[1]);return;}
  if (method === "GET" && path === "/api/notifications") return;
  throw failure("TERMINAL_CAPABILITY_REQUIRED", "Sign in as the owner to use this feature.");
}

function retire(db, terminal, actorId, stamp) {
  db.prepare("UPDATE business_terminals SET revoked_at=?,revoked_by=?,last_screen_at=NULL WHERE id=? AND revoked_at IS NULL").run(stamp, actorId, terminal.id);
  db.prepare("UPDATE business_terminal_grants SET revoked_at=? WHERE terminal_id=? AND revoked_at IS NULL").run(stamp, terminal.id);
  db.prepare("UPDATE users SET account_enabled=0 WHERE id=? AND principal_kind='terminal'").run(terminal.operator_user_id);
}
export {retire as retireBusinessTerminal};

function dto(row, config) {
  if (!row) return { registered: false, terminalId: null, online: false, lastContactAt: null };
  const stamp = Date.parse(row.last_contact_at);
  return { registered: !row.revoked_at, terminalId: row.id, name: row.name, registeredAt: row.registered_at, lastContactAt: row.last_contact_at, online: !row.revoked_at && Number.isFinite(stamp) && config.now().getTime() - stamp < 60_000 };
}

function calaiApprovalTarget(db, config, businessId, userId) {
  const proof = currentCalaiApproverProof(db, businessId, userId);
  if (!proof || !businessProductState(db, businessId, "calai", config).readiness.ready) return null;
  const terminal = db.prepare(`
    SELECT t.id, f.id AS tablet_id, f.display_name AS name
      FROM business_terminals t
      JOIN users u ON u.id=t.operator_user_id AND u.account_enabled=1 AND u.principal_kind='terminal'
      JOIN admin_tablets f ON f.terminal_id=t.id AND f.business_id=t.business_id
       AND f.lifecycle_state='assigned' AND f.archived_at IS NULL
       AND f.authority_blocked_at IS NULL AND f.handoff_requested_at IS NULL
     WHERE t.business_id=? AND t.revoked_at IS NULL
  `).get(businessId);
  return terminal ? { ...terminal, proof } : null;
}

function calaiApprovalStatus(db, target, businessId) {
  return { eligible: Boolean(target), authorized: Boolean(target && terminalHasCalaiAuthority(db, target.id, businessId)),
    terminalId: target?.id ?? null, tabletName: target?.name ?? null };
}

async function routeTerminalCalaiApproval({ req, res, db, config, session, checkRate, businessId }) {
  const requireOwner = () => {
    const user = owner(db, session, businessId, config);
    if (user.role !== "restaurant" || session.nativeAudience) {
      throw failure("CALAI_APPROVAL_OWNER_REQUIRED", "Use the verified business owner account to approve this tablet.");
    }
    return user;
  };
  const user = requireOwner();
  const headers = { "Cache-Control": "private, no-store" };
  if (req.method === "GET") {
    const target = calaiApprovalTarget(db, config, businessId, user.id);
    return sendJson(res, 200, { data: calaiApprovalStatus(db, target, businessId) }, headers);
  }
  const body = await readJson(req, config.bodyLimit);
  exactObject(body, ["expectedTerminalId"]);
  if (typeof body.expectedTerminalId !== "string" || !UUID.test(body.expectedTerminalId)) {
    throw failure("VALIDATION_ERROR", "Choose the current registered tablet.", 400);
  }
  checkRate?.(req, "terminal-calai-approval:" + user.id);
  const result = withTransaction(db, () => {
    const current = requireOwner();
    const target = calaiApprovalTarget(db, config, businessId, current.id);
    if (!target || target.id !== body.expectedTerminalId) {
      throw failure("CALAI_TABLET_APPROVAL_CHANGED", "The tablet or verified Calai account changed. Open the current connection and try again.", 409);
    }
    if (terminalHasCalaiAuthority(db, target.id, businessId)) return calaiApprovalStatus(db, target, businessId);
    const stamp = now(config);
    db.prepare(`
      INSERT INTO business_terminal_calai_approvals
        (terminal_id, tablet_id, business_id, native_link_id, source_account_id, source_user_id, approved_by, approved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(terminal_id) DO UPDATE SET tablet_id=excluded.tablet_id,
        business_id=excluded.business_id, native_link_id=excluded.native_link_id,
        source_account_id=excluded.source_account_id, source_user_id=excluded.source_user_id,
        approved_by=excluded.approved_by, approved_at=excluded.approved_at
    `).run(target.id, target.tablet_id, businessId, target.proof.link_id, target.proof.source_account_id,
      target.proof.source_user_id, current.id, stamp);
    audit(db, current.id, businessId, "terminal_calai_owner_approved", { terminalId: target.id, tabletId: target.tablet_id }, stamp);
    return calaiApprovalStatus(db, target, businessId);
  });
  return sendJson(res, 200, { data: result }, headers);
}

// Called inside the caller's transaction. Both existing owner setup and central
// secured administration share these one-use, current-registration invariants.
export function issueBusinessTerminalSetup(db,config,session,businessId,{replace=false,deviceName,expectedTerminalId=undefined}={}){
 const user=owner(db,session,businessId,config);
 const business=businessAccountState(db,businessId,{config});if(!business.eatsRestaurantId&&(!business.products.calai.active||!business.products.calai.readiness.ready||!hasNativeCalaiSetupAuthority(db,user.id,businessId)))throw failure('CALAI_AUTHORITY_REQUIRED','Verify the exact native Calai account as the current setup issuer before pairing this Calai-only tablet.');
 if(typeof replace!=='boolean')throw failure('VALIDATION_ERROR','Tablet replacement is invalid.',400);
 assertFleetNewEnrolmentAllowed(db,businessId);
 const current=db.prepare('SELECT * FROM business_terminals WHERE business_id=? AND revoked_at IS NULL').get(businessId);
 if(expectedTerminalId!==undefined&&(current?.id??null)!==expectedTerminalId)throw failure('TERMINAL_PAIRING_CHANGED','The current registered tablet changed. Reload it before issuing setup.',409);
 if(current&&!replace)throw failure('TERMINAL_ALREADY_REGISTERED','This business already has a registered tablet. Confirm its exact registration before replacement.',409);
 const terminalId=randomUUID(),code=randomBytes(24).toString('base64url'),challenge=randomBytes(32).toString('base64url'),stamp=now(config),expiresAt=new Date(config.now().getTime()+10*60000).toISOString();
 db.prepare('UPDATE business_terminal_pairings SET consumed_at=? WHERE business_id=? AND consumed_at IS NULL').run(stamp,businessId);
 db.prepare('INSERT INTO business_terminal_pairings VALUES(?,?,?,?,?,?,?,?,NULL)').run(terminalId,businessId,hash(code),challenge,user.id,current?.id??null,stamp,expiresAt);
 audit(db,user.id,businessId,'terminal_setup_issued',{terminalId,replaces:current?.id??null,expiresAt},stamp);
 return{schemaVersion:1,product:'calai-business-terminal',apiBaseUrl:config.origin,businessId,terminalId,code,challenge,expiresAt};
}

export async function routeBusinessTerminals({ req, res, url, db, config, session, checkRate }) {
  const approval = /^\/api\/business\/accounts\/([^/]+)\/terminals\/calai-authorization$/.exec(url.pathname);
  if (approval && ["GET", "POST"].includes(req.method)) {
    return routeTerminalCalaiApproval({ req, res, db, config, session, checkRate, businessId: approval[1] });
  }
  let match = /^\/api\/business\/accounts\/([^/]+)\/terminals(?:\/(setup|revoke|installer))?$/.exec(url.pathname);
  if (match) {
    const user = owner(db, session, match[1], config);
    const current = db.prepare("SELECT * FROM business_terminals WHERE business_id=? AND revoked_at IS NULL").get(match[1]);
    if (req.method === "GET" && !match[2]) return sendJson(res, 200, { data: dto(current, config) });
    if (req.method === "GET" && match[2] === "installer") {
      const bytes=Buffer.from(buildTerminalInstaller(),"utf8");
      owner(db, session, match[1], config);
      res.writeHead(200,{"Content-Type":"application/octet-stream","Content-Disposition":'attachment; filename="CalEats-Tablet-Setup.ps1"',"Content-Length":bytes.length,"Cache-Control":"private, no-store"});
      res.end(bytes);return true;
    }
    if (req.method === "POST" && match[2] === "setup") {
      const body = await readJson(req, config.bodyLimit); exactObject(body, ["replace","deviceName"]);
      if (body.replace !== undefined && typeof body.replace !== "boolean") throw failure("VALIDATION_ERROR", "Tablet replacement is invalid.", 400);
      if (current && body.replace !== true) throw failure("TERMINAL_ALREADY_REGISTERED", "This business already has a registered tablet. Choose Replace tablet to change it.", 409);
      const document=withTransaction(db,()=>issueBusinessTerminalSetup(db,config,session,match[1],body));
      return sendJson(res,201,{data:document},{'Cache-Control':'private, no-store'});
    }
    if (req.method === "POST" && match[2] === "revoke") {
      exactObject(await readJson(req, config.bodyLimit), []);
      const stamp = now(config);
      withTransaction(db, () => {
        owner(db, session, match[1], config);
        const currentNow = db.prepare("SELECT * FROM business_terminals WHERE business_id=? AND revoked_at IS NULL").get(match[1]);
        if (currentNow) retire(db, currentNow, user.id, stamp);
        db.prepare("UPDATE business_terminal_pairings SET consumed_at=? WHERE business_id=? AND consumed_at IS NULL").run(stamp, match[1]);
        audit(db, user.id, match[1], "terminal_revoked", { terminalId: currentNow?.id ?? null }, stamp);
      });
      return sendJson(res, 200, { data: { revoked: true } });
    }
    return false;
  }
  if (req.method === "POST" && url.pathname === "/api/terminal-devices/pair") {
    const body = await readJson(req, config.bodyLimit);
    exactObject(body, ["terminalId","code","deviceName","publicKeySpki","challengeSignature"]);
    checkRate?.(req, "business-terminal-pair:" + String(body.terminalId).slice(0, 36));
    if (!UUID.test(body.terminalId ?? "") || typeof body.code !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(body.code) || typeof body.deviceName !== "string" || body.deviceName.trim().length < 2 || body.deviceName.length > 80 || /[\r\n\0]/.test(body.deviceName)) throw failure("TERMINAL_PAIRING_INVALID", "Tablet setup is invalid or expired.", 401);
    const pairing = db.prepare("SELECT * FROM business_terminal_pairings WHERE terminal_id=? AND code_hash=?").get(body.terminalId, hash(body.code));
    const publicKey = keyDetails(body.publicKeySpki);
    if (!pairing || !verify("sha256", Buffer.from(businessTerminalPairingProof({ terminalId: body.terminalId, challenge: pairing.challenge, publicKeySpki: body.publicKeySpki })), { key: publicKey.key, dsaEncoding: "ieee-p1363" }, signatureBytes(body.challengeSignature))) throw failure("TERMINAL_PAIRING_INVALID", "Tablet setup is invalid or expired.", 401);
    const enrolled = withTransaction(db, () => {
      const fresh = db.prepare("SELECT * FROM business_terminal_pairings WHERE terminal_id=? AND code_hash=?").get(body.terminalId, hash(body.code));
      if(!fresh)throw failure('TERMINAL_PAIRING_INVALID','Tablet setup is invalid or expired.',401);
      assertFleetNewEnrolmentAllowed(db,fresh.business_id);
      assertFleetPairingAllowed(db,fresh,config);
      if (!issuerAllowed(db, fresh.issued_by, fresh.business_id) || !db.prepare("SELECT 1 FROM business_accounts WHERE id=? AND archived_at IS NULL").get(fresh.business_id)) throw failure("TERMINAL_PAIRING_INVALID", "Tablet setup is invalid or expired.", 401);
      const existing = activeTerminal(db, fresh.terminal_id);
      if (existing && fresh.consumed_at && existing.public_key_sha256 === publicKey.sha256 && existing.business_id === fresh.business_id) return existing;
      if (fresh.consumed_at || Date.parse(fresh.expires_at) <= config.now().getTime()) throw failure("TERMINAL_PAIRING_INVALID", "Tablet setup is invalid or expired.", 401);
      const current = db.prepare("SELECT * FROM business_terminals WHERE business_id=? AND revoked_at IS NULL").get(fresh.business_id);
      if ((current?.id ?? null) !== fresh.expected_terminal_id) throw failure("TERMINAL_PAIRING_CHANGED", "The registered tablet changed. Request fresh setup.", 409);
      const stamp = now(config), actorId = randomUUID();
      if (current) retire(db, current, fresh.issued_by, stamp);
      db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at,principal_kind) VALUES(?,?,?,?,?,?,?)").run(actorId, body.deviceName.trim(), "terminal+" + fresh.terminal_id + "@device.calai.invalid", "!device-only:" + randomBytes(32).toString("hex"), "restaurant", stamp, "terminal");
      db.prepare("INSERT INTO business_account_memberships(business_id,user_id,permission,created_at,can_view_calai) VALUES(?,?,'staff',?,1)").run(fresh.business_id, actorId, stamp);
      db.prepare("INSERT INTO business_terminals(id,business_id,operator_user_id,name,public_key_spki,public_key_sha256,registered_by,registered_at) VALUES(?,?,?,?,?,?,?,?)").run(fresh.terminal_id, fresh.business_id, actorId, body.deviceName.trim(), body.publicKeySpki, publicKey.sha256, fresh.issued_by, stamp);
      db.prepare("UPDATE business_terminal_pairings SET consumed_at=? WHERE terminal_id=? AND consumed_at IS NULL").run(stamp, fresh.terminal_id);
      audit(db, fresh.issued_by, fresh.business_id, "terminal_enrolled", { terminalId: fresh.terminal_id, replaced: current?.id ?? null, publicKeySha256: publicKey.sha256 }, stamp);
      const registered=activeTerminal(db,fresh.terminal_id);recordEnrolledTabletInventory(db,registered);return registered;
    });
    return sendJson(res, 201, { data: { paired: true, terminalId: enrolled.id, businessId: enrolled.business_id, registeredAt: enrolled.registered_at } });
  }
  match = /^\/api\/terminal-devices\/([^/]+)\/(operator-session|heartbeat)$/.exec(url.pathname);
  if (match && req.method === "POST") {
    exactObject(await readJson(req, config.bodyLimit), []);
    const terminal = await verifyBusinessTerminalRequest({ req, db, config });
    if (terminal.id !== match[1]) throw failure("TERMINAL_IDENTITY_MISMATCH", "The tablet identity changed.");
    const context = terminalContext(db, config, terminal), stamp = now(config);
    db.prepare("UPDATE business_terminals SET last_contact_at=? WHERE id=? AND revoked_at IS NULL").run(stamp, terminal.id);
    if (match[2] === "heartbeat") return sendJson(res, 200, { data: { connected: true, terminalId: terminal.id, businessId: terminal.business_id, products: context.products } });
    const token = randomBytes(32).toString("base64url"), expiresAt = new Date(config.now().getTime() + TERMINAL_GRANT_MS).toISOString();
    withTransaction(db, () => {
      db.prepare("DELETE FROM business_terminal_grants WHERE expires_at<=?").run(stamp);
      db.prepare("UPDATE business_terminal_grants SET revoked_at=? WHERE terminal_id=? AND revoked_at IS NULL").run(stamp, terminal.id);
      db.prepare("INSERT INTO business_terminal_grants VALUES(?,?,?,?,?,NULL)").run(hash(token), terminal.id, terminal.operator_user_id, stamp, expiresAt);
    });
    return sendJson(res, 201, { data: { ...context, token, expiresAt } });
  }
  return false;
}
