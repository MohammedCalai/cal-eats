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
export const outsideServiceAreaCopy=Object.freeze({headline:"We’re not delivering to your area yet",message:"We’re expanding—check back soon for restaurants near you."});
export function serviceAreaSettings(db) { const row=db.prepare("SELECT * FROM service_area_settings WHERE id=1").get();return {mode:row.mode,outcodes:JSON.parse(row.outcodes),...outsideServiceAreaCopy,updatedAt:row.updated_at}; }
function restaurantCoverage(db,fulfillment) {
  const areas=new Set();
  for(const row of db.prepare("SELECT delivery_enabled,delivery_outcodes,collection_enabled,address FROM restaurants WHERE status='approved' AND suspended=0").all()) {
    if(fulfillment==="delivery"&&!row.delivery_enabled||fulfillment==="collection"&&!row.collection_enabled)continue;
    for(const code of JSON.parse(row.delivery_outcodes))areas.add(code);
    if(fulfillment==="collection"){const match=row.address.match(/\b([A-Z]{1,2}\d[A-Z\d]?)\s*\d[A-Z]{2}\b/i);if(match)areas.add(match[1].toUpperCase());}
  }
  return [...areas].sort();
}
export function serviceAreaMapAreas(db){
  const settings=serviceAreaSettings(db),delivery=restaurantCoverage(db,"delivery"),collection=restaurantCoverage(db,"collection"),codes=[...new Set([...settings.outcodes,...delivery,...collection])].sort();
  return codes.map(outcode=>({outcode,delivery:delivery.includes(outcode),collection:collection.includes(outcode),enabled:settings.mode==="restaurant_coverage"||settings.outcodes.includes(outcode),operating:(settings.mode==="restaurant_coverage"||settings.outcodes.includes(outcode))&&(delivery.includes(outcode)||collection.includes(outcode))}));
}
const mapCaches=new WeakMap();
async function mapCoordinate(config,outcode,retryFailed=false){
  let cache=mapCaches.get(config);if(!cache){cache=new Map();mapCaches.set(config,cache);}
  const prior=cache.get(outcode);if(prior&&prior.expires>Date.now()&&!(retryFailed&&prior.failed))return prior.promise;
  const promise=(async()=>{try{let value;if(config.serviceAreaMapProvider)value=await config.serviceAreaMapProvider(outcode);else{const response=await fetch(`https://api.postcodes.io/outcodes/${encodeURIComponent(outcode)}`,{signal:AbortSignal.timeout(2500),redirect:"error",headers:{Accept:"application/json","User-Agent":"Cal-Eats coverage map (https://eats.calai.info)"}});if(!response.ok)return null;value=(await response.json()).result;}return Number.isFinite(value?.latitude)&&Number.isFinite(value?.longitude)&&Math.abs(value.latitude)<=90&&Math.abs(value.longitude)<=180?{latitude:value.latitude,longitude:value.longitude}:null;}catch{return null;}})();
  cache.set(outcode,{promise,expires:Date.now()+7*86400000});const value=await promise;if(!value)cache.set(outcode,{promise:Promise.resolve(null),expires:Date.now()+600000,failed:true});return value;
}
export async function serviceAreaMapCoordinates(db,config,requested,{retryFailed=false}={}){
  const areas=serviceAreaMapAreas(db),allowed=new Map(areas.map(area=>[area.outcode,area]));
  const codes=[...new Set(requested)];if(!codes.length||codes.length>20||codes.some(code=>!allowed.has(code)))throw new HttpError(400,"VALIDATION_ERROR","Select up to 20 configured postcode areas to show on the map");
  const items=[];let next=0;await Promise.all(Array.from({length:Math.min(4,codes.length)},async()=>{while(next<codes.length){const outcode=codes[next++],coordinate=await mapCoordinate(config,outcode,retryFailed);items.push({...allowed.get(outcode),...(coordinate||{}),mapped:Boolean(coordinate)});}}));return items.sort((a,b)=>a.outcode.localeCompare(b.outcode));
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
  if(req.method==="GET"&&url.pathname==="/api/admin/service-areas/map"){
    requireRole(session,"admin");const codes=(url.searchParams.get("outcodes")||"").split(",").map(code=>code.trim().toUpperCase()).filter(Boolean);return sendJson(res,200,{data:{items:await serviceAreaMapCoordinates(db,config,codes,{retryFailed:url.searchParams.get("retry")==="true"})}});
  }
  if(req.method==="GET"&&url.pathname==="/api/service-availability")return sendJson(res,200,{data:serviceAvailability(db,url.searchParams.get("postcode")||"",url.searchParams.get("fulfillment")||"delivery")});
  if(url.pathname==="/api/admin/service-areas"&&["GET","PUT"].includes(req.method)) {
    const user=requireRole(session,"admin");
    if(req.method==="GET")return sendJson(res,200,{data:{...serviceAreaSettings(db),restaurantOutcodes:{delivery:restaurantCoverage(db,"delivery"),collection:restaurantCoverage(db,"collection")},mapAreas:serviceAreaMapAreas(db)}});
    const body=await readJson(req,config.bodyLimit);exactObject(body,["mode","outcodes","headline","message"]);
    if(!["restaurant_coverage","custom"].includes(body.mode)||!Array.isArray(body.outcodes)||body.outcodes.length>500||body.outcodes.some(code=>typeof code!=="string"||!serviceOutcode(code)||serviceOutcode(code)!==code.trim().toUpperCase())||body.mode==="custom"&&!body.outcodes.length)throw new HttpError(400,"VALIDATION_ERROR","Choose restaurant coverage or provide valid postcode areas such as LU1 and WD5");
    if(body.headline!==undefined&&body.headline!==outsideServiceAreaCopy.headline||body.message!==undefined&&body.message!==outsideServiceAreaCopy.message)throw new HttpError(400,"OUTSIDE_AREA_MESSAGE_FIXED","The outside-area message is managed by Cal-Eats");
    const {headline,message}=outsideServiceAreaCopy;
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
