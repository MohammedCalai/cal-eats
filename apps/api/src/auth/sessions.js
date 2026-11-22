import { createHash, randomBytes, randomUUID } from "node:crypto";
import { publicUser } from "../../../../packages/contracts/src/index.js";

export const SESSION_COOKIE = "calai_session";
export const tokenHash = (token) => createHash("sha256").update(token).digest("hex");

export function createSession(db, userId, config) {
  if (db.prepare("SELECT principal_kind FROM users WHERE id=?").get(userId)?.principal_kind === "terminal") throw Object.assign(new Error("A tablet identity cannot sign in as a person."), { status: 403, code: "TERMINAL_IDENTITY_ONLY" });
  const token = randomBytes(32).toString("base64url");
  const created = config.now();
  const expires = new Date(created.getTime() + config.sessionHours * 3_600_000);
  db.prepare("INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)")
    .run(randomUUID(), userId, tokenHash(token), expires.toISOString(), created.toISOString());
  return { token, expires };
}

export function readSession(db, token, config) {
  if (!token) return null;
  const row = db.prepare(`SELECT u.id,u.name,u.email,u.role,u.phone,s.id AS session_id,s.expires_at
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.revoked_at IS NULL AND u.account_enabled=1 AND u.principal_kind='human' AND (u.role<>'customer' OR u.password_reset_required=0)`).get(tokenHash(token));
  if (!row || Date.parse(row.expires_at) <= config.now().getTime()) return null;
  const platformTable=db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='platform_admin_sessions'").get();
  const platform=platformTable?db.prepare("SELECT encrypted_tokens,revoked_at,absolute_expires_at FROM platform_admin_sessions WHERE session_id=?").get(row.session_id):null;
  if(platform&&(platform.revoked_at||!platform.encrypted_tokens||Date.parse(platform.absolute_expires_at)<=config.now().getTime()))return null;
  return { sessionId: row.session_id, user: publicUser(row),...(platform?{platformFederated:true}:{}) };
}

export function revokeSession(db, token, now) {
  if (token) db.prepare("UPDATE sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL").run(now.toISOString(), tokenHash(token));
}

export function cookieFor(token, expires, now, secure = false) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}; Max-Age=${Math.max(0, Math.floor((expires.getTime() - now.getTime()) / 1000))}`;
}

export const clearCookie = (secure = false) => `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}; Max-Age=0`;

export function parseSessionCookie(header = "") {
  for (const part of header.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === SESSION_COOKIE) return value.join("=");
  }
  return null;
}
