import { createHash, randomUUID } from "node:crypto";
import { publicUser, VALIDATION } from "../../../packages/contracts/src/index.js";
import { hashPassword, verifyPassword } from "./auth/passwords.js";
import { cookieFor, createSession } from "./auth/sessions.js";
import { requireRole } from "./auth/authorization.js";
import { withTransaction } from "./db/index.js";
import { HttpError, exactObject, readJson, sendJson } from "./http.js";
import { isDemoEmail } from "./seed.js";
import { queueBusinessApplicationEmail } from "./customer-emails.js";

function validateApplication(body) {
  exactObject(body, ["name", "email", "password", "restaurantName", "address", "mobile"]);
  const clean = key => typeof body[key] === "string" ? body[key].trim() : "";
  const name = clean("name"), email = clean("email").toLowerCase(), restaurantName = clean("restaurantName"), address = clean("address"), mobile = clean("mobile"), password = typeof body.password === "string" ? body.password : "";
  if (name.length < VALIDATION.nameMin || name.length > VALIDATION.nameMax || /[\r\n\0]/.test(name) || email.length > VALIDATION.emailMax || !/^[^\s<>@,;]+@[^\s<>@,;]+\.[A-Za-z]{2,}$/.test(email)) throw new HttpError(400, "VALIDATION_ERROR", "Enter your name and a valid email address");
  if (!restaurantName || restaurantName.length > VALIDATION.restaurantNameMax || /[\r\n\0]/.test(restaurantName)) throw new HttpError(400, "VALIDATION_ERROR", "Enter your business name");
  if (address.length < 10 || address.length > 500 || address.includes("\0") || !/\b(?:GIR\s?0AA|[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})\b/i.test(address)) throw new HttpError(400, "VALIDATION_ERROR", "Enter the full business address, including its postcode");
  if (mobile.length > 30 || !/^\+?[\d ()-]+$/.test(mobile) || mobile.replace(/\D/g, "").length < 7 || mobile.replace(/\D/g, "").length > 15) throw new HttpError(400, "VALIDATION_ERROR", "Enter your mobile number");
  if (password.length < VALIDATION.passwordMin || password.length > VALIDATION.passwordMax) throw new HttpError(400, "VALIDATION_ERROR", `Set a new password of ${VALIDATION.passwordMin} to ${VALIDATION.passwordMax} characters`);
  return { name, email, restaurantName, address, mobile, password };
}

export async function routeBusinessApplications({ req, res, url, db, config, checkRate, session }) {
  const detail=url.pathname.match(/^\/api\/admin\/restaurants\/([^/]+)\/application$/);
  if(req.method==="GET"&&detail){
    requireRole(session,"admin");
    const restaurant=db.prepare("SELECT name,address,phone,status FROM restaurants WHERE id=?").get(detail[1]);
    if(!restaurant)throw new HttpError(404,"NOT_FOUND","Application not found");
    const applicant=db.prepare("SELECT u.name,u.email,u.phone FROM users u JOIN restaurant_memberships m ON m.user_id=u.id WHERE m.restaurant_id=? AND m.permission='owner' ORDER BY m.created_at LIMIT 1").get(detail[1]);
    return sendJson(res,200,{data:{businessName:restaurant.name,address:restaurant.address,mobile:restaurant.phone,status:restaurant.status,applicant:applicant??null}});
  }
  if (req.method !== "POST" || !["/api/auth/restaurant-register", "/api/native/business/auth/apply"].includes(url.pathname)) return false;
  const application = validateApplication(await readJson(req, config.bodyLimit));
  if (config.runMode === "hosted-preview" && isDemoEmail(application.email)) throw new HttpError(400, "RESERVED_EMAIL", "Email is reserved");
  const suppliedKey = req.headers["idempotency-key"];
  if (suppliedKey !== undefined && (typeof suppliedKey !== "string" || !/^[A-Za-z0-9_-]{16,120}$/.test(suppliedKey))) throw new HttpError(400, "VALIDATION_ERROR", "Application reference is invalid");
  const key = suppliedKey ?? randomUUID(), { password, ...details } = application;
  const requestHash = createHash("sha256").update(JSON.stringify(details)).digest("hex");
  checkRate(req, application.email);
  const previous = () => db.prepare("SELECT s.*,u.password_hash,u.account_enabled FROM business_application_submissions s JOIN users u ON u.id=s.user_id WHERE s.idempotency_key=?").get(key);
  let submitted = previous(), replay = Boolean(submitted);
  if (!submitted) {
    const passwordHash = await hashPassword(password), now = config.now().toISOString();
    try {
      submitted = withTransaction(db, () => {
        const raced = previous();
        if (raced) { replay = true; return raced; }
        const userId = randomUUID(), restaurantId = randomUUID();
        db.prepare("INSERT INTO users(id,name,email,password_hash,role,phone,created_at) VALUES(?,?,?,?, 'restaurant',?,?)").run(userId, application.name, application.email, passwordHash, application.mobile, now);
        db.prepare("INSERT INTO restaurants(id,name,status,address,phone,created_at) VALUES(?,?,'pending',?,?,?)").run(restaurantId, application.restaurantName, application.address, application.mobile, now);
        db.prepare("INSERT INTO restaurant_memberships(restaurant_id,user_id,created_at,permission) VALUES(?,?,?,'owner')").run(restaurantId, userId, now);
        db.prepare("INSERT INTO contracts VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID(), restaurantId, 700, 24, "demo-v1", 1, null, null, now);
        db.prepare("INSERT INTO business_application_submissions VALUES(?,?,?,?,?)").run(key, requestHash, userId, restaurantId, now);
        queueBusinessApplicationEmail(db, config, { userId, restaurantId, restaurantName: application.restaurantName, recipient: application.email, now });
        return previous();
      });
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) throw new HttpError(409, "EMAIL_EXISTS", "An account with this email already exists. Sign in to view your application.");
      throw error;
    }
  }
  if (submitted.request_hash !== requestHash || !submitted.account_enabled || (replay && !(await verifyPassword(password, submitted.password_hash)))) throw new HttpError(409, "APPLICATION_CONFLICT", "This application reference has already been used. Sign in to view an existing application.");
  const user = db.prepare("SELECT * FROM users WHERE id=? AND role='restaurant' AND account_enabled=1").get(submitted.user_id);
  const restaurant = db.prepare("SELECT status FROM restaurants WHERE id=? AND EXISTS(SELECT 1 FROM restaurant_memberships WHERE restaurant_id=? AND user_id=? AND permission='owner')").get(submitted.restaurant_id, submitted.restaurant_id, submitted.user_id);
  if (!user || user.password_hash !== submitted.password_hash || !restaurant) throw new HttpError(409, "APPLICATION_CONFLICT", "Sign in to view your existing application");
  const data = { user: publicUser(user), restaurantId: submitted.restaurant_id, applicationStatus: restaurant.status, acknowledgementQueued: true, message: "Application received. The Calai team will contact you within 72 hours. Your restaurant stays private until approved." };
  if (url.pathname === "/api/native/business/auth/apply") return sendJson(res, replay ? 200 : 201, { data });
  const created = withTransaction(db, () => createSession(db, user.id, config));
  return sendJson(res, replay ? 200 : 201, { data }, { "Set-Cookie": cookieFor(created.token, created.expires, config.now(), config.secureCookies) });
}
