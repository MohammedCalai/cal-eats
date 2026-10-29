import { randomUUID } from "node:crypto";
import { requireRole } from "./auth/authorization.js";
import { withTransaction } from "./db/index.js";
import { HttpError, exactObject, readJson, sendJson } from "./http.js";

export const serviceAreaMigration31 = {version:31,name:"customer_locations_and_service_areas",sql:`CREATE TABLE service_area_settings (id INTEGER PRIMARY KEY CHECK(id=1),mode TEXT NOT NULL CHECK(mode IN ('restaurant_coverage','custom')),outcodes TEXT NOT NULL,headline TEXT NOT NULL,message TEXT NOT NULL,updated_by_user_id TEXT REFERENCES users(id),updated_at TEXT NOT NULL);
INSERT INTO service_area_settings VALUES(1,'restaurant_coverage','[]','We’re not delivering to your area yet','We’re expanding—check back soon for restaurants near you.',NULL,'1970-01-01T00:00:00.000Z');`};
export function serviceOutcode(value) {
  const compact=typeof value==="string"?value.trim().toUpperCase().replace(/\s+/g,""):"";
  return compact.match(/^([A-Z]{1,2}\d[A-Z\d]?)(?:\d[A-Z]{2})?$/)?.[1] ?? null;
}
export function serviceAreaSettings(db) { const row=db.prepare("SELECT * FROM service_area_settings WHERE id=1").get();return {mode:row.mode,outcodes:JSON.parse(row.outcodes),headline:row.headline,message:row.message,updatedAt:row.updated_at}; }
function restaurantCoverage(db,fulfillment) {
  const areas=new Set();
  for(const row of db.prepare("SELECT delivery_enabled,delivery_outcodes,collection_enabled,address FROM restaurants WHERE status='approved' AND suspended=0").all()) {
    if(fulfillment==="delivery"&&!row.delivery_enabled||fulfillment==="collection"&&!row.collection_enabled)continue;
    for(const code of JSON.parse(row.delivery_outcodes))areas.add(code);
    if(fulfillment==="collection"){const match=row.address.match(/\b([A-Z]{1,2}\d[A-Z\d]?)\s*\d[A-Z]{2}\b/i);if(match)areas.add(match[1].toUpperCase());}
  }
  return [...areas].sort();
}
export function serviceAvailability(db,postcode,fulfillment="delivery") {
  if(!["delivery","collection"].includes(fulfillment))throw new HttpError(400,"VALIDATION_ERROR","Fulfilment is invalid");
  const settings=serviceAreaSettings(db),outcode=serviceOutcode(postcode);
  if(postcode&&!outcode)throw new HttpError(400,"VALIDATION_ERROR","Enter a valid UK postcode or postcode area");
  const coverage=restaurantCoverage(db,fulfillment),configured=settings.mode==="restaurant_coverage"||settings.outcodes.includes(outcode);
  return {outcode,fulfillment,available:outcode?Boolean(configured&&coverage.includes(outcode)):null,headline:settings.headline,message:settings.message};
}
export function assertServiceArea(db,postcode,fulfillment) {
  const result=serviceAvailability(db,postcode,fulfillment);
  // Collection is governed by the restaurant's enabled area, not the customer's home.
  if(result.available===false)throw new HttpError(409,"SERVICE_AREA_UNAVAILABLE",result.headline+". "+result.message);
}
export function assertRestaurantServiceArea(db,restaurant,fulfillment,address) {
  const settings=serviceAreaSettings(db);if(settings.mode!=="custom")return;
  const match=restaurant.address.match(/\b([A-Z]{1,2}\d[A-Z\d]?)\s*\d[A-Z]{2}\b/i);
  const codes=fulfillment==="delivery"?[address?.outcode||serviceOutcode(address?.postcode)]:match?[match[1].toUpperCase()]:JSON.parse(restaurant.delivery_outcodes);
  if(!codes.some(code=>settings.outcodes.includes(code)))throw new HttpError(409,"SERVICE_AREA_UNAVAILABLE",settings.headline+". "+settings.message);
}
function recentAddresses(db,userId) {
  const seen=new Set(),items=[];
  for(const row of db.prepare("SELECT delivery_address FROM orders WHERE customer_id=? AND delivery_address IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 50").all(userId)) {
    const address=JSON.parse(row.delivery_address),key=JSON.stringify([address.line1,address.line2||"",address.city,address.postcode].map(value=>String(value||"").toUpperCase()));
    if(seen.has(key))continue;seen.add(key);items.push({label:"Recent address",...address});if(items.length===5)break;
  }
  return items;
}
async function gpsPostcode(config,latitude,longitude) {
  let value;
  try {
    if(config.locationProvider)value=await config.locationProvider({latitude,longitude});
    else {const url=new URL("https://api.postcodes.io/postcodes");url.search=new URLSearchParams({lat:String(latitude),lon:String(longitude),radius:"2000",limit:"1",filter:"postcode,admin_district,distance"}).toString();const response=await fetch(url,{signal:AbortSignal.timeout(5000),redirect:"error",headers:{Accept:"application/json"}});if(!response.ok)throw Error();value=(await response.json()).result?.[0];}
  } catch {throw new HttpError(503,"LOCATION_LOOKUP_UNAVAILABLE","Your location could not be checked. Please enter your postcode instead.");}
  if(!value||!serviceOutcode(value.postcode)||!/\d[A-Z]{2}$/.test(value.postcode?.replace(/\s/g,"")))throw new HttpError(404,"LOCATION_NOT_FOUND","We could not find a nearby UK postcode. Please enter your address instead.");
  return {postcode:value.postcode.trim().toUpperCase(),city:String(value.admin_district||value.city||"").slice(0,100),approximate:true};
}
export async function routeServiceAreas({req,res,url,db,config,session,checkRate}) {
  if(req.method==="GET"&&url.pathname==="/api/service-availability")return sendJson(res,200,{data:serviceAvailability(db,url.searchParams.get("postcode")||"",url.searchParams.get("fulfillment")||"delivery")});
  if(url.pathname==="/api/admin/service-areas"&&["GET","PUT"].includes(req.method)) {
    const user=requireRole(session,"admin");
    if(req.method==="GET")return sendJson(res,200,{data:{...serviceAreaSettings(db),restaurantOutcodes:{delivery:restaurantCoverage(db,"delivery"),collection:restaurantCoverage(db,"collection")}}});
    const body=await readJson(req,config.bodyLimit);exactObject(body,["mode","outcodes","headline","message"]);
    if(!["restaurant_coverage","custom"].includes(body.mode)||!Array.isArray(body.outcodes)||body.outcodes.length>500||body.outcodes.some(code=>typeof code!=="string"||!serviceOutcode(code)||serviceOutcode(code)!==code.trim().toUpperCase())||body.mode==="custom"&&!body.outcodes.length)throw new HttpError(400,"VALIDATION_ERROR","Choose restaurant coverage or provide valid postcode areas such as LU1 and WD5");
    const text=(value,max)=>typeof value==="string"&&value.trim().length>=5&&value.trim().length<=max?value.trim():null,headline=text(body.headline,100),message=text(body.message,300);if(!headline||!message)throw new HttpError(400,"VALIDATION_ERROR","Enter a heading and message within the displayed limits");
    const outcodes=[...new Set(body.outcodes.map(code=>code.trim().toUpperCase()))].sort(),now=config.now().toISOString();
    withTransaction(db,()=>{db.prepare("UPDATE service_area_settings SET mode=?,outcodes=?,headline=?,message=?,updated_by_user_id=?,updated_at=? WHERE id=1").run(body.mode,JSON.stringify(outcodes),headline,message,user.id,now);db.prepare("INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)").run(randomUUID(),user.id,"service_areas","platform","service_areas_updated",JSON.stringify({mode:body.mode,outcodes}),now);});
    return sendJson(res,200,{data:serviceAreaSettings(db)});
  }
  if(req.method==="GET"&&url.pathname==="/api/account/recent-addresses"){const user=requireRole(session,"customer");return sendJson(res,200,{data:recentAddresses(db,user.id)});}
  if(req.method==="POST"&&url.pathname==="/api/location/postcode") {
    checkRate(req,"gps-postcode");const body=await readJson(req,config.bodyLimit);exactObject(body,["latitude","longitude","consent"]);
    if(body.consent!==true||!Number.isFinite(body.latitude)||!Number.isFinite(body.longitude)||Math.abs(body.latitude)>90||Math.abs(body.longitude)>180)throw new HttpError(400,"VALIDATION_ERROR","Location permission and valid coordinates are required");
    return sendJson(res,200,{data:await gpsPostcode(config,body.latitude,body.longitude)});
  }
  return false;
}
