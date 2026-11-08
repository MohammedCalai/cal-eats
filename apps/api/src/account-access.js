import { createHash, randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "./auth/passwords.js";
import { requireUser } from "./auth/authorization.js";
import { revokeUserSessions } from "./auth/session-management.js";
import { withTransaction } from "./db/index.js";
import { HttpError, exactObject, readJson, sendJson } from "./http.js";
import { VALIDATION } from "../../../packages/contracts/src/index.js";
import {accountAccessEmailDelivery,enqueueAccountAccessEmail} from "./account-access-email.js";

const RESET_MS = 30 * 60_000;
const VERIFY_MS = 24 * 60 * 60_000;
const VERIFY_RESEND_MS = 60_000;
const tokenHash = (token) => createHash("sha256").update(token).digest("hex");
const validEmail = (value) => typeof value === "string" && value.trim().length <= VALIDATION.emailMax && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
const newToken = () => randomBytes(32).toString("base64url");

function storeMail(db, { user, purpose, token, origin, now }) {
  const verification = purpose === "email_verification";
  const welcome = verification && user.role === "customer" && user.email_verification_required === 1;
  const link = `${origin}/order/#${verification ? "verify-email" : "reset-password"}=${encodeURIComponent(token)}`;
  db.prepare("INSERT INTO local_mail_sink(id,user_id,kind,recipient,subject,body,created_at) VALUES(?,?,?,?,?,?,?)").run(randomUUID(), user.id, purpose, user.email, verification ? `${welcome ? "Welcome to Cal-Eats — verify your email" : "Verify your Cal-Eats email"} (local simulation)` : "Reset your Cal-Eats password (local simulation)", `${welcome ? "Welcome to Cal-Eats. You're nearly ready to order.\n\n" : ""}${verification ? "Verify your email address" : "Reset your local password"}: ${link}\n\n${verification ? "This secure link expires in 24 hours and can be used once. Open it, then press Confirm email to confirm." : ""}\n\nThis message was stored locally and was not sent by email.`, now);
}

export function assertCustomerSignupEmailReady(config) {
  if (config.runMode !== "local" && accountAccessEmailDelivery(config) !== "email") throw new HttpError(503,"SIGNUP_EMAIL_UNAVAILABLE","We cannot send verification emails right now. Please try creating your account again later.");
}

export function customerEmailVerificationStatus(db, config, userId) {
  const user=db.prepare("SELECT email,role,email_verified_at,email_verification_required,account_enabled FROM users WHERE id=? AND account_enabled=1").get(userId);
  if(!user)throw new HttpError(401,"AUTH_REQUIRED","Sign in to check your email verification.");
  const pending=user.role==="customer"&&user.email_verification_required===1&&!user.email_verified_at;
  const latest=!user.email_verified_at?db.prepare("SELECT created_at FROM account_access_tokens WHERE user_id=? AND purpose='email_verification' AND issued_email=? COLLATE NOCASE ORDER BY created_at DESC,rowid DESC LIMIT 1").get(userId,user.email):null;
  const resendAt=latest?Date.parse(latest.created_at)+VERIFY_RESEND_MS:0;
  return {email:user.email,emailVerified:Boolean(user.email_verified_at),verificationRequired:pending,canOrder:user.role==="customer"&&!pending,resendAvailableAt:resendAt>config.now().getTime()?new Date(resendAt).toISOString():null,delivery:accountAccessEmailDelivery(config)};
}

// The signup caller owns the transaction. Queue failure rolls back the new
// account, its legal acceptance, token and session together; no network call.
export function issueCustomerSignupVerification(db, config, userId) {
  assertCustomerSignupEmailReady(config);
  const user=db.prepare("SELECT id,email,role,email_verification_required FROM users WHERE id=? AND role='customer' AND account_enabled=1").get(userId);
  if(!user||user.email_verification_required!==1)throw new HttpError(409,"SIGNUP_VERIFICATION_REQUIRED","New customer signup must require email verification.");
  issue(db,config,user,"email_verification",VERIFY_MS);
  return customerEmailVerificationStatus(db,config,userId);
}

export function requireVerifiedCustomerEmail(db,userId) {
  const user=db.prepare("SELECT role,account_enabled,email_verification_required,email_verified_at FROM users WHERE id=?").get(userId);
  if(!user||!user.account_enabled||user.role!=="customer")throw new HttpError(401,"AUTH_REQUIRED","Sign in with an active customer account to place an order.");
  if(user.email_verification_required===1&&!user.email_verified_at)throw new HttpError(428,"EMAIL_VERIFICATION_REQUIRED","Verify your email address before placing your first order. You can resend the email in your account.");
}

function issue(db, config, user, purpose, lifetimeMs) {
  const token = newToken(); const nowDate = config.now(); const now = nowDate.toISOString(); const expires = new Date(nowDate.getTime() + lifetimeMs).toISOString();
  db.prepare("UPDATE account_access_tokens SET consumed_at=? WHERE user_id=? AND purpose=? AND consumed_at IS NULL").run(now, user.id, purpose);
  const id=randomUUID();
  db.prepare("INSERT INTO account_access_tokens(id,user_id,purpose,token_hash,expires_at,consumed_at,created_at,issued_email) VALUES(?,?,?,?,?,NULL,?,?)").run(id, user.id, purpose, tokenHash(token), expires, now,user.email);
  if(config.runMode==="local")storeMail(db, { user, purpose, token, origin: config.origin, now });
  else enqueueAccountAccessEmail(db,config,{id,user,purpose,token,expiresAt:expires,now});
}

function readToken(body) {
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) throw new HttpError(400, "TOKEN_INVALID", "Token is invalid or expired");
  return token;
}

export async function routeAccountAccess({ req, res, url, db, config, session, checkRate }) {
  if (req.method === "POST" && ["/api/auth/password/forgot", "/api/native/auth/forgot-password"].includes(url.pathname)) {
    const body = await readJson(req, config.bodyLimit); exactObject(body, ["email"]);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!validEmail(email)) throw new HttpError(400, "VALIDATION_ERROR", "Email is invalid");
    checkRate(req, email); const user = db.prepare("SELECT id,email FROM users WHERE email=? AND account_enabled=1").get(email),delivery=accountAccessEmailDelivery(config);
    // Delivery/configuration errors must never reveal whether an address exists.
    if(user&&delivery!=="unavailable")try{withTransaction(db, () => issue(db, config, user, "password_reset", RESET_MS));}catch{}
    return sendJson(res, 202, { data: { accepted: true,delivery } });
  }
  if (req.method === "POST" && ["/api/auth/password/reset", "/api/native/auth/reset-password"].includes(url.pathname)) {
    const body = await readJson(req, config.bodyLimit); exactObject(body, ["token", "password"]); checkRate(req, "password-reset");
    const token = readToken(body); const password = typeof body.password === "string" ? body.password : "";
    if (password.length < VALIDATION.passwordMin || password.length > VALIDATION.passwordMax) throw new HttpError(400, "VALIDATION_ERROR", "Password is invalid");
    const passwordHash = await hashPassword(password); const now = config.now().toISOString();
    withTransaction(db, () => {
      const row = db.prepare("SELECT t.* FROM account_access_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=? AND t.purpose='password_reset' AND t.consumed_at IS NULL AND t.expires_at>? AND u.account_enabled=1 AND u.email=t.issued_email COLLATE NOCASE").get(tokenHash(token), now);
      if (!row) throw new HttpError(400, "TOKEN_INVALID", "Token is invalid or expired");
      const consumed = db.prepare("UPDATE account_access_tokens SET consumed_at=? WHERE id=? AND consumed_at IS NULL").run(now, row.id); if (consumed.changes !== 1) throw new HttpError(400, "TOKEN_INVALID", "Token is invalid or expired");
      db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(passwordHash, row.user_id);
      db.prepare("UPDATE account_access_tokens SET consumed_at=? WHERE user_id=? AND purpose='password_reset' AND consumed_at IS NULL").run(now, row.user_id);
      db.prepare("UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL").run(now, row.user_id);
      revokeUserSessions(db, row.user_id, now);
    });
    return sendJson(res, 200, { data: { passwordReset: true } });
  }
  if(req.method==="GET"&&["/api/auth/email-verification/status","/api/native/auth/email-verification/status"].includes(url.pathname)) {
    const user=requireUser(session);return sendJson(res,200,{data:customerEmailVerificationStatus(db,config,user.id)});
  }
  if (req.method === "POST" && ["/api/auth/email-verification/send","/api/native/auth/email-verification/send"].includes(url.pathname)) {
    const user = requireUser(session); const body = await readJson(req, config.bodyLimit); exactObject(body, []); checkRate(req, `email-verification:${user.id}`);
    const data=withTransaction(db,()=>{
      let status=customerEmailVerificationStatus(db,config,user.id);
      if(status.emailVerified||status.resendAvailableAt||status.delivery==="unavailable")return {...status,accepted:true,resent:false};
      const row=db.prepare("SELECT id,email,role,email_verification_required FROM users WHERE id=? AND account_enabled=1").get(user.id);
      issue(db,config,row,"email_verification",VERIFY_MS);
      status=customerEmailVerificationStatus(db,config,user.id);return {...status,accepted:true,resent:true};
    });
    return sendJson(res, 202, { data });
  }
  if (req.method === "POST" && ["/api/auth/email-verification/confirm","/api/native/auth/email-verification/confirm"].includes(url.pathname)) {
    const body = await readJson(req, config.bodyLimit); exactObject(body, ["token"]); checkRate(req, "email-verification"); const token = readToken(body); const now = config.now().toISOString();
    withTransaction(db, () => {
      const row = db.prepare("SELECT t.* FROM account_access_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=? AND t.purpose='email_verification' AND t.consumed_at IS NULL AND t.expires_at>? AND u.account_enabled=1 AND u.email=t.issued_email COLLATE NOCASE").get(tokenHash(token), now);
      if (!row) throw new HttpError(400, "TOKEN_INVALID", "Token is invalid or expired");
      const consumed = db.prepare("UPDATE account_access_tokens SET consumed_at=? WHERE id=? AND consumed_at IS NULL").run(now, row.id); if (consumed.changes !== 1) throw new HttpError(400, "TOKEN_INVALID", "Token is invalid or expired");
      db.prepare("UPDATE users SET email_verified_at=COALESCE(email_verified_at,?) WHERE id=?").run(now, row.user_id);
      db.prepare("UPDATE account_access_tokens SET consumed_at=? WHERE user_id=? AND purpose='email_verification' AND consumed_at IS NULL").run(now, row.user_id);
    });
    return sendJson(res, 200, { data: { emailVerified: true } });
  }
  return false;
}
