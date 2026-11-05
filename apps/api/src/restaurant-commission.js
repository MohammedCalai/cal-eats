import {randomUUID} from "node:crypto";
import {requireRole} from "./auth/authorization.js";
import {withTransaction} from "./db/index.js";
import {HttpError,exactObject,readJson,sendJson} from "./http.js";

const DAY=86400000;
const settings=(db,restaurantId)=>db.prepare("SELECT * FROM restaurant_commission_controls WHERE restaurant_id=?").get(restaurantId);
const period=row=>row?.free_period_starts_at?{startsAt:row.free_period_starts_at,endsAt:row.free_period_ends_at}:null;
const londonDay=value=>{const p=Object.fromEntries(new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/London",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date(value)).filter(part=>part.type!=="literal").map(part=>[part.type,part.value]));return `${p.year}-${p.month}-${p.day}`;};

/** Stable metadata belongs in both a quote signature and the immutable order snapshot. */
export function resolveRestaurantCommission(db,restaurantId,asOf,normalRateBasisPoints=700){
  if(!Number.isSafeInteger(normalRateBasisPoints)||normalRateBasisPoints<0||normalRateBasisPoints>10000)throw new TypeError("Normal commission rate is invalid");
  const timestamp=new Date(asOf).getTime();if(!Number.isFinite(timestamp))throw new TypeError("Commission evaluation time is invalid");
  const row=settings(db,restaurantId),free=period(row),disabled=row?.enabled===0,within=Boolean(free&&timestamp>=Date.parse(free.startsAt)&&timestamp<Date.parse(free.endsAt));
  const mode=disabled?"disabled":within?"free_period":"standard",rateBasisPoints=mode==="standard"?normalRateBasisPoints:0;
  return {rateBasisPoints,snapshot:{settingsRevision:row?.revision??0,mode,rateBasisPoints,normalRateBasisPoints,freePeriodStartsAt:free?.startsAt??null,freePeriodEndsAt:free?.endsAt??null}};
}

function normalRate(db,restaurantId,now){
  return db.prepare("SELECT rate_bps FROM commission_policies WHERE restaurant_id=? AND accepted_at IS NOT NULL AND starts_at<=? AND ends_at>? ORDER BY created_at DESC LIMIT 1").get(restaurantId,now,now)?.rate_bps
    ??db.prepare("SELECT rate_bps FROM contracts WHERE restaurant_id=? AND accepted_at IS NOT NULL").get(restaurantId)?.rate_bps??700;
}
function dto(db,restaurantId,now){
  const row=settings(db,restaurantId),normalRateBasisPoints=normalRate(db,restaurantId,now),resolved=resolveRestaurantCommission(db,restaurantId,now,normalRateBasisPoints),free=period(row);
  return {restaurantId,enabled:row?.enabled!==0,revision:row?.revision??0,normalRateBasisPoints,effectiveRateBasisPoints:resolved.rateBasisPoints,state:resolved.snapshot.mode,freePeriod:free,nextChangeAt:row?.enabled===0||!free?null:now<free.startsAt?free.startsAt:now<free.endsAt?free.endsAt:null,timeZone:"Europe/London",serverNow:now,updatedAt:row?.updated_at??null,snapshot:resolved.snapshot};
}
function timestamp(value,label){
  if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)||!Number.isFinite(Date.parse(value)))throw new HttpError(400,"VALIDATION_ERROR",`${label} needs an ISO date and explicit time zone`);
  // Date.parse normalises impossible dates such as February 30; reject those too.
  const day=value.slice(0,10),check=new Date(`${day}T00:00:00Z`);if(check.toISOString().slice(0,10)!==day)throw new HttpError(400,"VALIDATION_ERROR",`${label} is not a valid calendar date`);
  return new Date(value).toISOString();
}
export async function routeRestaurantCommission({req,res,url,db,config,session}){
  const match=url.pathname.match(/^\/api\/admin\/restaurants\/([^/]+)\/commission$/);if(!match)return false;
  const admin=requireRole(session,"admin"),restaurantId=match[1];
  if(!db.prepare("SELECT 1 FROM restaurants WHERE id=?").get(restaurantId))throw new HttpError(404,"NOT_FOUND","Restaurant not found");
  if(req.method==="GET")return sendJson(res,200,{data:dto(db,restaurantId,config.now().toISOString())});
  if(req.method!=="PATCH")throw new HttpError(405,"METHOD_NOT_ALLOWED","Use GET or PATCH for commission settings");
  const body=await readJson(req,config.bodyLimit);exactObject(body,["action","expectedRevision","freePeriod","reason"]);
  if(!["enable","disable","schedule_free","cancel_free"].includes(body.action)||!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0)throw new HttpError(400,"VALIDATION_ERROR","Choose a commission action and the current settings revision");
  if(body.action!=="schedule_free"&&body.freePeriod!==undefined)throw new HttpError(400,"VALIDATION_ERROR","A free period is only allowed when scheduling one");
  const reason=body.reason===undefined?"Platform administrator updated restaurant commission.":typeof body.reason==="string"?body.reason.trim():"";
  if(reason.length<1||reason.length>300||/[\r\n\0]/.test(reason))throw new HttpError(400,"VALIDATION_ERROR","Commission change reason must be 1–300 characters");
  let free=null;
  if(body.action==="schedule_free"){
    exactObject(body.freePeriod,["startsAt","endsAt"]);free={startsAt:timestamp(body.freePeriod.startsAt,"Free-period start"),endsAt:timestamp(body.freePeriod.endsAt,"Free-period end")};
  }
  const result=withTransaction(db,()=>{
    const now=config.now().toISOString(),current=settings(db,restaurantId);
    if((current?.revision??0)!==body.expectedRevision)throw new HttpError(409,"COMMISSION_SETTINGS_CHANGED","Commission settings changed. Refresh them before saving again.");
    if(free&&(free.endsAt<=now||londonDay(free.startsAt)<londonDay(now)||Date.parse(free.startsAt)>Date.parse(now)+366*DAY||free.endsAt<=free.startsAt||Date.parse(free.endsAt)-Date.parse(free.startsAt)>366*DAY))throw new HttpError(400,"VALIDATION_ERROR","Choose a current or future free period, starting within one year, lasting at most one year and ending in the future");
    const enabled=body.action==="disable"?0:body.action==="cancel_free"?(current?.enabled??1):1;
    const before={enabled:current?.enabled!==0,freePeriod:period(current),revision:current?.revision??0},after={enabled:Boolean(enabled),freePeriod:free};
    if(before.enabled===after.enabled&&JSON.stringify(before.freePeriod)===JSON.stringify(free))return dto(db,restaurantId,now);
    const revision=(current?.revision??0)+1;
    db.prepare("INSERT INTO restaurant_commission_controls(restaurant_id,enabled,free_period_starts_at,free_period_ends_at,revision,updated_by_user_id,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(restaurant_id) DO UPDATE SET enabled=excluded.enabled,free_period_starts_at=excluded.free_period_starts_at,free_period_ends_at=excluded.free_period_ends_at,revision=excluded.revision,updated_by_user_id=excluded.updated_by_user_id,updated_at=excluded.updated_at").run(restaurantId,enabled,free?.startsAt??null,free?.endsAt??null,revision,admin.id,now);
    db.prepare("INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)").run(randomUUID(),admin.id,"restaurant_commission",restaurantId,`commission_${body.action}`,JSON.stringify({before,after:{...after,revision},reason,timeZone:"Europe/London",historicalOrdersChanged:false}),now);
    return dto(db,restaurantId,now);
  });
  return sendJson(res,200,{data:result});
}
