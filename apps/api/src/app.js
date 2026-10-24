import { randomUUID } from "node:crypto";
import { publicUser, VALIDATION } from "../../../packages/contracts/src/index.js";
import { hashPassword, passwordNeedsRehash, verifyPassword } from "./auth/passwords.js";
import { clearCookie, cookieFor, createSession, parseSessionCookie, readSession, revokeSession } from "./auth/sessions.js";
import { HttpError, exactObject, readJson, sendJson } from "./http.js";
import { isDatabaseReady, withTransaction } from "./db/index.js";
import { routeJourney } from "./journey.js";
import { routeOffers } from "./offers.js";
import { routeOperations } from "./operations.js";
import { serveStatic } from "./static.js";
import { routeProduct } from "./product.js";
import { routeAccountAccess } from "./account-access.js";
import { isDemoEmail } from "./seed.js";
import { routePolish } from "./polish.js";

const securityHeaders = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY"
};

function validateIdentity(body) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (name.length < VALIDATION.nameMin || name.length > VALIDATION.nameMax || email.length > VALIDATION.emailMax || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < VALIDATION.passwordMin || password.length > VALIDATION.passwordMax) {
    throw new HttpError(400, "VALIDATION_ERROR", "Name, email or password is invalid");
  }
  return { name, email, password };
}

function clientKey(req, email = "") { return `${req.socket.remoteAddress ?? "unknown"}|${email}`; }

export function createApp({ db, config }) {
  function incrementRateBucket(key, now) {
    const entry = db.prepare("SELECT * FROM auth_rate_limits WHERE bucket_key=?").get(key);
    if (!entry || now - entry.window_start_ms >= config.rateLimit.windowMs) db.prepare("INSERT INTO auth_rate_limits(bucket_key,window_start_ms,attempt_count) VALUES(?,?,1) ON CONFLICT(bucket_key) DO UPDATE SET window_start_ms=excluded.window_start_ms,attempt_count=1").run(key, now);
    else {
      const count = entry.attempt_count + 1; db.prepare("UPDATE auth_rate_limits SET attempt_count=? WHERE bucket_key=?").run(count, key);
      if (count > config.rateLimit.attempts) throw new HttpError(429, "RATE_LIMITED", "Too many attempts; try again later");
    }
  }
  function checkRate(req, email) {
    const now = config.now().getTime();
    db.prepare("DELETE FROM auth_rate_limits WHERE window_start_ms<=?").run(now - config.rateLimit.windowMs);
    const excess = db.prepare("SELECT COUNT(*) count FROM auth_rate_limits").get().count - 10_000;
    if (excess > 0) db.prepare("DELETE FROM auth_rate_limits WHERE bucket_key IN (SELECT bucket_key FROM auth_rate_limits ORDER BY window_start_ms LIMIT ?)").run(excess);
    const ip = req.socket.remoteAddress ?? "unknown";
    incrementRateBucket(`ip:${ip}`, now);
    incrementRateBucket(`identity:${clientKey(req, email)}`, now);
  }

  return async function app(req, res) {
    try {
      for (const [key, value] of Object.entries(securityHeaders)) res.setHeader(key, value);
      const url = new URL(req.url, config.origin);
      const healthcheckHostAllowed = req.method === "GET" && ["/health/live", "/health/ready"].includes(url.pathname) && config.runMode === "hosted-preview" && config.healthcheckHost && req.headers.host === config.healthcheckHost;
      if (req.headers.host !== config.expectedHost && !healthcheckHostAllowed) throw new HttpError(403, "INVALID_HOST", "Request host is not allowed");
      if (req.method === "GET" && url.pathname === "/api/runtime") return sendJson(res, 200, { data: { mode: config.runMode, demoShortcuts: config.demoShortcuts, simulatedPayments: true } });
      if (req.method === "GET" && url.pathname === "/health/live") return sendJson(res, 200, { data: { status: "ok", service: "calai-eats-api" } });
      if (req.method === "GET" && url.pathname === "/health/ready") {
        const ready = isDatabaseReady(db);
        return sendJson(res, ready ? 200 : 503, ready ? { data: { status: "ready", database: "ready", migrations: "current" } } : { error: { code: "NOT_READY", message: "Service is not ready" } });
      }
      if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && ((config.runMode === "hosted-preview" && req.headers.origin !== config.origin) || (req.headers.origin && req.headers.origin !== config.origin))) throw new HttpError(403, "INVALID_ORIGIN", "Request origin is not allowed");
      const token = parseSessionCookie(req.headers.cookie);
      const session = readSession(db, token, config);
      const accountAccessHandled = await routeAccountAccess({ req, res, url, db, config, session, checkRate });
      if (accountAccessHandled || res.writableEnded || res.headersSent) return;

      if (req.method === "POST" && url.pathname === "/api/auth/register") {
        const body = await readJson(req, config.bodyLimit);
        exactObject(body, ["name", "email", "password"]);
        const identity = validateIdentity(body);
        if (config.runMode === "hosted-preview" && isDemoEmail(identity.email)) throw new HttpError(400, "RESERVED_EMAIL", "Email is reserved");
        checkRate(req, identity.email);
        const passwordHash = await hashPassword(identity.password);
        const user = { id: randomUUID(), name: identity.name, email: identity.email, role: "customer" };
        let created;
        try {
          created = withTransaction(db, () => {
            db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)").run(user.id, user.name, user.email, passwordHash, user.role, config.now().toISOString());
            return createSession(db, user.id, config);
          });
        } catch (error) {
          if (String(error.message).includes("UNIQUE")) throw new HttpError(409, "EMAIL_EXISTS", "An account with this email already exists");
          throw error;
        }
        return sendJson(res, 201, { data: { user } }, { "Set-Cookie": cookieFor(created.token, created.expires, config.now(), config.secureCookies) });
      }
      if (req.method === "POST" && url.pathname === "/api/auth/restaurant-register") {
        const body = await readJson(req, config.bodyLimit);
        exactObject(body, ["name", "email", "password", "restaurantName"]);
        const identity = validateIdentity(body); const restaurantName = typeof body.restaurantName === "string" ? body.restaurantName.trim() : "";
        if (config.runMode === "hosted-preview" && isDemoEmail(identity.email)) throw new HttpError(400, "RESERVED_EMAIL", "Email is reserved");
        if (!restaurantName || restaurantName.length > VALIDATION.restaurantNameMax) throw new HttpError(400, "VALIDATION_ERROR", "Restaurant name is invalid");
        checkRate(req, identity.email);
        const passwordHash = await hashPassword(identity.password); const now = config.now().toISOString();
        const user = { id: randomUUID(), name: identity.name, email: identity.email, role: "restaurant" }; const restaurantId = randomUUID();
        let created;
        try { created = withTransaction(db, () => {
          db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)").run(user.id, user.name, user.email, passwordHash, user.role, now);
          db.prepare("INSERT INTO restaurants(id,name,status,created_at) VALUES(?,?,?,?)").run(restaurantId, restaurantName, "pending", now);
          db.prepare("INSERT INTO restaurant_memberships(restaurant_id,user_id,created_at,permission) VALUES(?,?,?,'owner')").run(restaurantId, user.id, now);
          db.prepare("INSERT INTO contracts VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID(), restaurantId, 700, 24, "demo-v1", 1, null, null, now);
          return createSession(db, user.id, config);
        }); } catch (error) { if (String(error.message).includes("UNIQUE")) throw new HttpError(409, "EMAIL_EXISTS", "An account with this email already exists"); throw error; }
        return sendJson(res, 201, { data: { user, restaurantId } }, { "Set-Cookie": cookieFor(created.token, created.expires, config.now(), config.secureCookies) });
      }
      if (req.method === "POST" && url.pathname === "/api/auth/login") {
        const body = await readJson(req, config.bodyLimit);
        exactObject(body, ["email", "password"]);
        const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
        const password = typeof body.password === "string" ? body.password : "";
        checkRate(req, email);
        for (let verificationAttempt = 0; verificationAttempt < 2; verificationAttempt += 1) {
          const row = db.prepare("SELECT * FROM users WHERE email=?").get(email);
          if (!(await verifyPassword(password, row?.password_hash)) || !row) throw new HttpError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
          const verifiedHash = row.password_hash;
          const upgradedHash = passwordNeedsRehash(verifiedHash) ? await hashPassword(password) : null;
          const created = withTransaction(db, () => {
            const current = db.prepare("SELECT password_hash FROM users WHERE id=?").get(row.id);
            if (!current || current.password_hash !== verifiedHash) return null;
            if (upgradedHash) db.prepare("UPDATE users SET password_hash=? WHERE id=? AND password_hash=?").run(upgradedHash, row.id, verifiedHash);
            return createSession(db, row.id, config);
          });
          if (created) return sendJson(res, 200, { data: { user: publicUser(row) } }, { "Set-Cookie": cookieFor(created.token, created.expires, config.now(), config.secureCookies) });
        }
        throw new HttpError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
      }
      if (req.method === "GET" && url.pathname === "/api/auth/me") {
        if (!session) throw new HttpError(401, "AUTH_REQUIRED", "Authentication required");
        return sendJson(res, 200, { data: { user: session.user } });
      }
      if (req.method === "POST" && url.pathname === "/api/auth/logout") {
        const body = await readJson(req, config.bodyLimit);
        exactObject(body, []);
        revokeSession(db, token, config.now());
        return sendJson(res, 200, { data: { loggedOut: true } }, { "Set-Cookie": clearCookie(config.secureCookies) });
      }
      if (await serveStatic(req, res, url.pathname)) return;
      const polishHandled = await routePolish({ req, res, url, db, config, session });
      if (polishHandled || res.writableEnded || res.headersSent) return;
      const offersHandled = await routeOffers({ req, res, url, db, config, session });
      if (offersHandled || res.writableEnded || res.headersSent) return;
      const productHandled = await routeProduct({ req, res, url, db, config, session });
      if (productHandled || res.writableEnded || res.headersSent) return;
      const operationHandled = await routeOperations({ req, res, url, db, config, session });
      if (operationHandled || res.writableEnded || res.headersSent) return;
      const handled = await routeJourney({ req, res, url, db, config, session });
      if (handled || res.writableEnded || res.headersSent) return;
      throw new HttpError(404, "NOT_FOUND", "Resource not found");
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      const code = error.code ?? "INTERNAL_ERROR";
      const message = status === 500 ? "Internal server error" : error.message;
      if (!res.headersSent) sendJson(res, status, { error: { code, message } }); else res.destroy();
    }
  };
}
