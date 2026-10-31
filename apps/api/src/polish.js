import { createHash, randomUUID } from "node:crypto";
import { VALIDATION } from "../../../packages/contracts/src/index.js";
import { requireRestaurantOwner, requireRole, requireUser } from "./auth/authorization.js";
import { clearCookie } from "./auth/sessions.js";
import { USER_SESSION_TABLES, userSessions, revokeUserSessions } from "./auth/session-management.js";
import { normalizeAddress } from "./address-validation.js";
import { withTransaction } from "./db/index.js";
import { HttpError, exactObject, readJson, sendJson } from "./http.js";
import { updateMarketingPreferences } from "./loyalty.js";
import { integer, itemDto, stringList, text, validateModifierGroups } from "./journey.js";
import { restaurantReadiness } from "./readiness.js";
import { assertMediaCapacity, mediaIsReferenced, mediaStorage } from "./media-policy.js";

const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const hash = (value) => createHash("sha256").update(canonical(value)).digest("hex");
const addressDto = (row) => ({ id: row.id, label: row.label, line1: row.line1, ...(row.line2 ? { line2: row.line2 } : {}), city: row.city, postcode: row.postcode, createdAt: row.created_at, updatedAt: row.updated_at });
const mediaDto = (row) => ({ id: row.id, url: `/api/media/${row.id}`, mimeType: row.mime_type, width: row.width, height: row.height });

function normalizedMenuItem(value) {
  exactObject(value, ["name", "description", "priceMinor", "category", "allergens", "dietaryTags", "modifierGroups"]);
  return { name: text(value.name, 1, VALIDATION.menuNameMax, "Item name"), description: text(value.description ?? "", 0, VALIDATION.descriptionMax, "Description"), priceMinor: integer(value.priceMinor, 0, VALIDATION.priceMaxMinor, "Price"), category: text(value.category ?? "", 0, 80, "Category"), allergens: stringList(value.allergens ?? [], "Allergens"), dietaryTags: stringList(value.dietaryTags ?? [], "Dietary tags"), modifierGroups: validateModifierGroups(value.modifierGroups ?? []) };
}
function dimensions(buffer) {
  if (buffer.length >= 32 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && buffer.subarray(12,16).toString() === "IHDR" && buffer.subarray(buffer.length-8,buffer.length-4).toString() === "IEND") return { mimeType: "image/png", width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[buffer.length-2] === 0xff && buffer[buffer.length-1] === 0xd9) { let at = 2; while (at + 8 < buffer.length) { if (buffer[at] !== 0xff) { at += 1; continue; } const marker = buffer[at + 1]; if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) return { mimeType: "image/jpeg", height: buffer.readUInt16BE(at + 5), width: buffer.readUInt16BE(at + 7) }; if (marker === 0xd8 || marker === 0xd9) { at += 2; continue; } if(at+4>buffer.length)break;const size = buffer.readUInt16BE(at + 2); if (size < 2 || at+2+size>buffer.length) break; at += 2 + size; } }
  throw new HttpError(400, "INVALID_IMAGE", "Image must be a valid JPEG or PNG");
}
export function decodeImage(body) {
  exactObject(body, ["mimeType", "dataBase64"]); if (typeof body.dataBase64 !== "string" || body.dataBase64.length > 1_400_000 || body.dataBase64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(body.dataBase64)) throw new HttpError(400, "INVALID_IMAGE", "Image encoding is invalid");
  const data = Buffer.from(body.dataBase64, "base64"); if (!data.length || data.length > 1024 * 1024 || data.toString("base64") !== body.dataBase64) throw new HttpError(400, "INVALID_IMAGE", "Image is too large or invalid");
  const parsed = dimensions(data); if (body.mimeType !== parsed.mimeType || parsed.width < 1 || parsed.height < 1 || parsed.width > 4096 || parsed.height > 4096) throw new HttpError(400, "INVALID_IMAGE", "Image type or dimensions are invalid"); return { ...parsed, data };
}

export async function routePolish({ req, res, url, db, config, session }) {
  if (req.method === "GET" && url.pathname === "/api/account/preferences") { const u = requireUser(session); const row = db.prepare("SELECT merchant_offers FROM users WHERE id=?").get(u.id); return sendJson(res, 200, { data: { merchantOffers: Boolean(row.merchant_offers) } }); }
  if (req.method === "PATCH" && url.pathname === "/api/account/preferences") { const u = requireUser(session); const body = await readJson(req, config.bodyLimit); exactObject(body, ["merchantOffers"]); if (typeof body.merchantOffers !== "boolean") throw new HttpError(400, "VALIDATION_ERROR", "Preference is invalid"); const current=db.prepare("SELECT push_promotions FROM marketing_preferences WHERE user_id=?").get(u.id); updateMarketingPreferences(db,u,{inAppPromotions:body.merchantOffers,pushPromotions:Boolean(current?.push_promotions),source:"legacy-account-preferences"},config); return sendJson(res, 200, { data: { merchantOffers: body.merchantOffers } }); }
  if (req.method === "GET" && url.pathname === "/api/account/sessions") { const u = requireUser(session); return sendJson(res, 200, { data: userSessions(db,u.id,config.now().toISOString(),session.sessionId) }); }
  let match = url.pathname.match(/^\/api\/account\/sessions\/([^/]+)$/);
  if (match && req.method === "DELETE") { const u = requireUser(session); const count=withTransaction(db,()=>USER_SESSION_TABLES.reduce((sum,table)=>sum+Number(db.prepare(`UPDATE ${table} SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL`).run(config.now().toISOString(),match[1],u.id).changes),0)); if (!count) throw new HttpError(404, "NOT_FOUND", "Resource not found"); return sendJson(res, 200, { data: { revoked: true } }, match[1] === session.sessionId && !session.native ? { "Set-Cookie": clearCookie(config.secureCookies) } : {}); }
  if (req.method === "POST" && url.pathname === "/api/account/sessions/revoke-others") { const u = requireUser(session); const body = await readJson(req, config.bodyLimit); exactObject(body, []); const count=withTransaction(db,()=>revokeUserSessions(db,u.id,config.now().toISOString(),{exceptSessionId:session.sessionId})); return sendJson(res, 200, { data: { revokedCount: count } }); }
  if (req.method === "GET" && url.pathname === "/api/account/addresses") { const u = requireUser(session); return sendJson(res, 200, { data: db.prepare("SELECT * FROM saved_addresses WHERE user_id=? ORDER BY created_at").all(u.id).map(addressDto) }); }
  if (req.method === "POST" && url.pathname === "/api/account/addresses") { const u = requireUser(session); const a = normalizeAddress(await readJson(req, config.bodyLimit), { withLabel: true }); const now = config.now().toISOString(); const created=withTransaction(db,()=>{if (db.prepare("SELECT COUNT(*) count FROM saved_addresses WHERE user_id=?").get(u.id).count >= 10) throw new HttpError(409, "ADDRESS_LIMIT", "Saved address limit reached");const id=randomUUID();db.prepare("INSERT INTO saved_addresses VALUES(?,?,?,?,?,?,?,?,?)").run(id,u.id,a.label,a.line1,a.line2??null,a.city,a.postcode,now,now);return db.prepare("SELECT * FROM saved_addresses WHERE id=?").get(id);}); return sendJson(res,201,{data:addressDto(created)}); }
  match = url.pathname.match(/^\/api\/account\/addresses\/([^/]+)$/);
  if (match && req.method === "PATCH") { const u=requireUser(session); if(!db.prepare("SELECT 1 FROM saved_addresses WHERE id=? AND user_id=?").get(match[1],u.id)) throw new HttpError(404,"NOT_FOUND","Resource not found"); const a=normalizeAddress(await readJson(req,config.bodyLimit),{withLabel:true}); db.prepare("UPDATE saved_addresses SET label=?,line1=?,line2=?,city=?,postcode=?,updated_at=? WHERE id=? AND user_id=?").run(a.label,a.line1,a.line2??null,a.city,a.postcode,config.now().toISOString(),match[1],u.id); return sendJson(res,200,{data:addressDto(db.prepare("SELECT * FROM saved_addresses WHERE id=?").get(match[1]))}); }
  if (match && req.method === "DELETE") { const u=requireUser(session); const out=db.prepare("DELETE FROM saved_addresses WHERE id=? AND user_id=?").run(match[1],u.id); if(!out.changes) throw new HttpError(404,"NOT_FOUND","Resource not found"); return sendJson(res,200,{data:{deleted:true}}); }
  match=url.pathname.match(/^\/api\/restaurant\/restaurants\/([^/]+)\/readiness$/); if(match&&req.method==="GET"){requireRestaurantOwner(db,session,match[1]);return sendJson(res,200,{data:restaurantReadiness(db,match[1])});}
  match=url.pathname.match(/^\/api\/admin\/restaurants\/([^/]+)\/readiness$/); if(match&&req.method==="GET"){requireRole(session,"admin");return sendJson(res,200,{data:restaurantReadiness(db,match[1])});}
  match=url.pathname.match(/^\/api\/restaurant\/restaurants\/([^/]+)\/menu\/order$/); if(match&&req.method==="PUT"){requireRestaurantOwner(db,session,match[1]);const body=await readJson(req,config.bodyLimit);exactObject(body,["itemIds"]);const existing=db.prepare("SELECT id FROM menu_items WHERE restaurant_id=?").all(match[1]).map(x=>x.id);if(!Array.isArray(body.itemIds)||body.itemIds.length!==existing.length||new Set(body.itemIds).size!==existing.length||body.itemIds.some(id=>!existing.includes(id)))throw new HttpError(400,"VALIDATION_ERROR","Item order must be an exact permutation");withTransaction(db,()=>body.itemIds.forEach((id,index)=>db.prepare("UPDATE menu_items SET sort_order=? WHERE id=? AND restaurant_id=?").run(index,id,match[1])));return sendJson(res,200,{data:db.prepare("SELECT * FROM menu_items WHERE restaurant_id=? ORDER BY sort_order,created_at,rowid").all(match[1]).map(itemDto)});}
  match=url.pathname.match(/^\/api\/restaurant\/restaurants\/([^/]+)\/menu\/import$/); if(match&&req.method==="POST")return importMenu({req,res,db,config,session,restaurantId:match[1]});
  match=url.pathname.match(/^\/api\/restaurant\/restaurants\/([^/]+)\/(cover|menu\/([^/]+)\/photo)$/); if(match&&req.method==="POST")return uploadMedia({req,res,db,config,session,restaurantId:match[1],itemId:match[3]??null});
  if(match&&req.method==="DELETE")return removeMedia({res,db,session,restaurantId:match[1],itemId:match[3]??null});
  match=url.pathname.match(/^\/api\/media\/([^/]+)$/); if(match&&req.method==="GET")return serveMedia({res,db,session,id:match[1]});
  return false;
}

async function importMenu({req,res,db,config,session,restaurantId}){const user=requireRestaurantOwner(db,session,restaurantId);const key=text(req.headers["idempotency-key"],1,100,"Idempotency-Key");const body=await readJson(req,256*1024);exactObject(body,["items"]);if(!Array.isArray(body.items)||body.items.length<1||body.items.length>100)throw new HttpError(400,"VALIDATION_ERROR","Import must contain 1 to 100 items");const items=body.items.map(normalizedMenuItem);const requestHash=hash({restaurantId,items});const prior=db.prepare("SELECT * FROM menu_imports WHERE actor_user_id=? AND idempotency_key=?").get(user.id,key);if(prior){if(prior.request_hash!==requestHash||prior.restaurant_id!==restaurantId)throw new HttpError(409,"IDEMPOTENCY_CONFLICT","Idempotency key was already used");const ids=JSON.parse(prior.item_ids);return sendJson(res,200,{data:ids.map(id=>itemDto(db.prepare("SELECT * FROM menu_items WHERE id=? AND restaurant_id=?").get(id,restaurantId)))});}const created=withTransaction(db,()=>{const again=db.prepare("SELECT * FROM menu_imports WHERE actor_user_id=? AND idempotency_key=?").get(user.id,key);if(again){if(again.request_hash!==requestHash||again.restaurant_id!==restaurantId)throw new HttpError(409,"IDEMPOTENCY_CONFLICT","Idempotency key was already used");return {ids:JSON.parse(again.item_ids),replay:true};}const now=config.now().toISOString();let order=db.prepare("SELECT COALESCE(MAX(sort_order),-1)+1 next FROM menu_items WHERE restaurant_id=?").get(restaurantId).next;const ids=[];for(const item of items){const id=randomUUID();ids.push(id);db.prepare("INSERT INTO menu_items(id,restaurant_id,name,description,price_minor,available,created_at,updated_at,category,allergens,dietary_tags,modifier_groups,sort_order) VALUES(?,?,?,?,?,1,?,?,?,?,?,?,?)").run(id,restaurantId,item.name,item.description,item.priceMinor,now,now,item.category,JSON.stringify(item.allergens),JSON.stringify(item.dietaryTags),JSON.stringify(item.modifierGroups),order++);}db.prepare("INSERT INTO menu_imports VALUES(?,?,?,?,?,?,?)").run(randomUUID(),restaurantId,user.id,key,requestHash,JSON.stringify(ids),now);return {ids,replay:false};});return sendJson(res,created.replay?200:201,{data:created.ids.map(id=>itemDto(db.prepare("SELECT * FROM menu_items WHERE id=? AND restaurant_id=?").get(id,restaurantId)))});}

function mediaTarget(db, restaurantId, itemId) {
  const target = itemId
    ? db.prepare("SELECT photo_media_id current FROM menu_items WHERE id=? AND restaurant_id=?").get(itemId, restaurantId)
    : db.prepare("SELECT cover_media_id current FROM restaurants WHERE id=?").get(restaurantId);
  if (!target) throw new HttpError(404, "NOT_FOUND", "Resource not found");
  const old = target.current ? db.prepare("SELECT id,byte_length FROM media_assets WHERE id=? AND restaurant_id=?").get(target.current, restaurantId) : null;
  if (target.current && !old) throw new HttpError(404, "NOT_FOUND", "Resource not found");
  return { target, old };
}

async function uploadMedia({ req, res, db, config, session, restaurantId, itemId }) {
  requireRestaurantOwner(db, session, restaurantId);
  mediaTarget(db, restaurantId, itemId);
  const image = decodeImage(await readJson(req, 1_450_000));
  const created = withTransaction(db, () => {
    // Recheck ownership and target after reading the asynchronous request body.
    requireRestaurantOwner(db, session, restaurantId);
    const { target, old } = mediaTarget(db, restaurantId, itemId);
    if (itemId) db.prepare("UPDATE menu_items SET photo_media_id=NULL WHERE id=? AND restaurant_id=?").run(itemId, restaurantId);
    else db.prepare("UPDATE restaurants SET cover_media_id=NULL WHERE id=?").run(restaurantId);
    const reclaim = old && !mediaIsReferenced(db, old.id) ? old.byte_length : 0;
    assertMediaCapacity(mediaStorage(db, restaurantId).usedBytes, image.data.length, reclaim);
    const id = randomUUID(), now = config.now().toISOString();
    db.prepare("INSERT INTO media_assets VALUES(?,?,?,?,?,?,?,?)").run(id, restaurantId, image.mimeType, image.data, image.width, image.height, image.data.length, now);
    if (itemId) db.prepare("UPDATE menu_items SET photo_media_id=? WHERE id=? AND restaurant_id=?").run(id, itemId, restaurantId);
    else db.prepare("UPDATE restaurants SET cover_media_id=? WHERE id=?").run(id, restaurantId);
    if (target.current && reclaim) db.prepare("DELETE FROM media_assets WHERE id=? AND restaurant_id=?").run(target.current, restaurantId);
    return { id, mime_type: image.mimeType, width: image.width, height: image.height };
  });
  return sendJson(res, 201, { data: { ...mediaDto(created), storage: mediaStorage(db, restaurantId) } });
}

function removeMedia({ res, db, session, restaurantId, itemId }) {
  requireRestaurantOwner(db, session, restaurantId);
  withTransaction(db, () => {
    const { target } = mediaTarget(db, restaurantId, itemId);
    if (itemId) db.prepare("UPDATE menu_items SET photo_media_id=NULL WHERE id=? AND restaurant_id=?").run(itemId, restaurantId);
    else db.prepare("UPDATE restaurants SET cover_media_id=NULL WHERE id=?").run(restaurantId);
    if (target.current && !mediaIsReferenced(db, target.current)) db.prepare("DELETE FROM media_assets WHERE id=? AND restaurant_id=?").run(target.current, restaurantId);
  });
  return sendJson(res, 200, { data: { removed: true, storage: mediaStorage(db, restaurantId) } });
}
function serveMedia({res,db,session,id}){const row=db.prepare("SELECT m.*,r.status,r.suspended FROM media_assets m JOIN restaurants r ON r.id=m.restaurant_id WHERE m.id=?").get(id);if(!row)throw new HttpError(404,"NOT_FOUND","Resource not found");const user=session?.user;const owner=user?.role==="restaurant"&&db.prepare("SELECT 1 FROM restaurant_memberships WHERE restaurant_id=? AND user_id=? AND permission='owner'").get(row.restaurant_id,user.id);if(!(row.status==="approved"&&!row.suspended)&&user?.role!=="admin"&&!owner)throw new HttpError(404,"NOT_FOUND","Resource not found");res.setHeader("Content-Security-Policy","sandbox; default-src 'none'");res.writeHead(200,{"Content-Type":row.mime_type,"Content-Length":row.data.length,"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});res.end(row.data);return true;}
