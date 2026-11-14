import { createHash, randomBytes, randomUUID } from "node:crypto";
import { VALIDATION } from "../../../packages/contracts/src/index.js";
import { hashPassword } from "./auth/passwords.js";
import { requireRole } from "./auth/authorization.js";
import { withTransaction } from "./db/index.js";
import { HttpError, exactObject, readJson, sendJson } from "./http.js";
import { isDemoEmail } from "./seed.js";
import { queueBusinessApplicationEmail } from "./customer-emails.js";
import {businessApplicationAccessStatus,setBusinessApplicationPassword} from "./business-application-access.js";

function validateApplication(body) {
  exactObject(body, ["name", "email", "restaurantName", "address", "mobile"]);
  const clean = key => typeof body[key] === "string" ? body[key].trim() : "";
  const name = clean("name"), email = clean("email").toLowerCase(), restaurantName = clean("restaurantName"), address = clean("address"), mobile = clean("mobile");
  if (name.length < VALIDATION.nameMin || name.length > VALIDATION.nameMax || /[\r\n\0]/.test(name) || email.length > VALIDATION.emailMax || !/^[^\s<>@,;]+@[^\s<>@,;]+\.[A-Za-z]{2,}$/.test(email)) throw new HttpError(400, "VALIDATION_ERROR", "Enter your name and a valid email address");
  if (!restaurantName || restaurantName.length > VALIDATION.restaurantNameMax || /[\r\n\0]/.test(restaurantName)) throw new HttpError(400, "VALIDATION_ERROR", "Enter your business name");
  if (address.length < 10 || address.length > 500 || address.includes("\0") || !/\b(?:GIR\s?0AA|[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})\b/i.test(address)) throw new HttpError(400, "VALIDATION_ERROR", "Enter the full business address, including its postcode");
  if (mobile.length > 30 || !/^\+?[\d ()-]+$/.test(mobile) || mobile.replace(/\D/g, "").length < 7 || mobile.replace(/\D/g, "").length > 15) throw new HttpError(400, "VALIDATION_ERROR", "Enter your mobile number");
  return { name, email, restaurantName, address, mobile };
}

export async function routeBusinessApplications({ req, res, url, db, config, checkRate, session }) {
  const detail=url.pathname.match(/^\/api\/admin\/restaurants\/([^/]+)\/application$/);
  if(req.method==="GET"&&detail){
    requireRole(session,"admin");
    const restaurant=db.prepare("SELECT name,address,phone,status FROM restaurants WHERE id=?").get(detail[1]);
    if(!restaurant)throw new HttpError(404,"NOT_FOUND","Application not found");
    const applicant=db.prepare("SELECT u.name,u.email,u.phone FROM users u JOIN restaurant_memberships m ON m.user_id=u.id WHERE m.restaurant_id=? AND m.permission='owner' ORDER BY m.created_at LIMIT 1").get(detail[1]);
    return sendJson(res,200,{data:{businessName:restaurant.name,address:restaurant.address,mobile:restaurant.phone,status:restaurant.status,applicant:applicant??null,access:businessApplicationAccessStatus(db,detail[1])}});
  }
  const passwordSetup=url.pathname.match(/^\/api\/admin\/restaurants\/([^/]+)\/application\/password$/);
  if(req.method==="POST"&&passwordSetup)return setBusinessApplicationPassword({req,res,db,config,session,checkRate,restaurantId:passwordSetup[1]});
  if (req.method !== "POST" || !["/api/auth/restaurant-register", "/api/native/business/auth/apply"].includes(url.pathname)) return false;
  const application = validateApplication(await readJson(req, config.bodyLimit));
  if (config.runMode === "hosted-preview" && isDemoEmail(application.email)) throw new HttpError(400, "RESERVED_EMAIL", "Email is reserved");
  const suppliedKey = req.headers["idempotency-key"];
  if (suppliedKey !== undefined && (typeof suppliedKey !== "string" || !/^[A-Za-z0-9_-]{16,120}$/.test(suppliedKey))) throw new HttpError(400, "VALIDATION_ERROR", "Application reference is invalid");
  const key = suppliedKey ?? randomUUID();
  const requestHash = createHash("sha256").update(JSON.stringify(application)).digest("hex");
  checkRate(req, application.email);
  const previous = () => db.prepare("SELECT * FROM business_application_submissions WHERE idempotency_key=?").get(key);
  let submitted = previous(), replay = Boolean(submitted);
  if (!submitted) {
    // The discarded random credential cannot be used by an applicant. Login is
    // disabled until an administrator prepares this application's initial access.
    const passwordHash = await hashPassword(randomBytes(48).toString("base64url")), now = config.now().toISOString();
    try {
      submitted = withTransaction(db, () => {
        const raced = previous();
        if (raced) { replay = true; return raced; }
        const userId = randomUUID(), restaurantId = randomUUID();
        db.prepare("INSERT INTO users(id,name,email,password_hash,role,phone,created_at,account_enabled) VALUES(?,?,?,?, 'restaurant',?,?,0)").run(userId, application.name, application.email, passwordHash, application.mobile, now);
        db.prepare("INSERT INTO restaurants(id,name,status,address,phone,created_at) VALUES(?,?,'pending',?,?,?)").run(restaurantId, application.restaurantName, application.address, application.mobile, now);
        db.prepare("INSERT INTO restaurant_memberships(restaurant_id,user_id,created_at,permission) VALUES(?,?,?,'owner')").run(restaurantId, userId, now);
        db.prepare("INSERT INTO contracts VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID(), restaurantId, 700, 24, "demo-v1", 1, null, null, now);
        db.prepare("INSERT INTO business_application_submissions VALUES(?,?,?,?,?)").run(key, requestHash, userId, restaurantId, now);
        db.prepare("INSERT INTO business_application_access(restaurant_id,user_id,created_at) VALUES(?,?,?)").run(restaurantId,userId,now);
        queueBusinessApplicationEmail(db, config, { userId, restaurantId, restaurantName: application.restaurantName, recipient: application.email, now });
        return previous();
      });
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) throw new HttpError(409, "EMAIL_EXISTS", "An account already uses this email. Contact Cal-Eats if you need help with your application.");
      throw error;
    }
  }
  if (submitted.request_hash !== requestHash) throw new HttpError(409, "APPLICATION_CONFLICT", "This application reference has already been used. Contact Cal-Eats about an existing application.");
  const user = db.prepare("SELECT id FROM users WHERE id=? AND role='restaurant'").get(submitted.user_id);
  const restaurant = db.prepare("SELECT status FROM restaurants WHERE id=? AND EXISTS(SELECT 1 FROM restaurant_memberships WHERE restaurant_id=? AND user_id=? AND permission='owner')").get(submitted.restaurant_id, submitted.restaurant_id, submitted.user_id);
  if (!user || !restaurant) throw new HttpError(409, "APPLICATION_CONFLICT", "Contact Cal-Eats about your existing application");
  const data = { applicationReference:key,restaurantId: submitted.restaurant_id, applicationStatus: restaurant.status, acknowledgementQueued: true, loginPreparedByAdmin:true, message: "Application received. The Calai team will contact you within 72 hours and prepare your business login. Your restaurant stays private until approved." };
  return sendJson(res, replay ? 200 : 201, { data });
}
