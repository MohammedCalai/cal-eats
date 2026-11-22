import {createHash,randomUUID} from "node:crypto";
import path from "node:path";
import {requireRole,requireRestaurantCapability,restaurantCapabilities} from "./auth/authorization.js";
import {withTransaction} from "./db/index.js";
import {HttpError,exactObject,readJson,sendJson} from "./http.js";
import {buildOwnerDashboardCsv} from "./dashboard-exports.js";
import {parseLondonDateRange,resolveFinanceScope,operationFinancePredicate,statementCsv} from "./marketplace-reporting.js";
import {listBusinessPaymentAdjustments,exportBusinessPaymentAdjustmentsCsv} from "./business-payment-adjustment-reporting.js";
import {createOrderAlertEmailAdapter,orderAlertEmailTransportReadiness} from "./order-alert-email.js";

const MAX_BYTES=1024*1024,MAX_ROWS=10000,DAY=86400000,workers=new WeakMap(),adapters=new WeakMap();
const identifier="[A-Za-z0-9_-]{8,100}",hash=value=>createHash("sha256").update(value).digest("hex"),fail=(code,message,status=400)=>new HttpError(status,code,message);
const email=value=>typeof value==="string"&&value.length<=254&&/^[^\s<>@,;\r\n]+@[^\s<>@,;\r\n]+\.[A-Za-z]{2,}$/.test(value);
const demo=value=>/(?:@[^@]*\.(?:local|invalid|test)$|@example\.(?:com|net|org)$)/i.test(value);
const parse=value=>{try{return JSON.parse(value);}catch{return null;}};
const csvText=value=>typeof value==="string"?value:Buffer.from(value??[]).toString("utf8");
const mode=config=>config.runMode==="local"?"local":config.orderAlertEmail.mode;
const deliveryAllowed=config=>config.runMode==="local"||Boolean(config.businessStatements?.sendEnabled&&orderAlertEmailTransportReadiness(config.orderAlertEmail).realDeliveryEnabled);
const tooLarge=()=>fail("REPORT_TOO_LARGE","This report is too large to email. Choose a shorter date range or a smaller report (maximum 1 MB and 10,000 rows).",413);

function boundedCsv(value){
  const csv=csvText(value);if(!csv||Buffer.byteLength(csv)>MAX_BYTES)throw tooLarge();
  let quoted=false,rows=0;
  for(let i=0;i<csv.length;i++){
    if(csv[i]==='"'){if(quoted&&csv[i+1]==='"')i++;else quoted=!quoted;}
    else if(csv[i]==='\n'&&!quoted)rows++;
    if(rows>MAX_ROWS+1)throw tooLarge();
  }
  if(quoted)throw fail("REPORT_INVALID","This report could not be prepared safely.",409);
  if(!csv.endsWith("\n"))rows++;if(rows>MAX_ROWS+1)throw tooLarge();return csv;
}
const reportCapability=kind=>kind==="menu-template"?"manageMenu":"viewFinance";
function owner(db,session,restaurantId,capability="viewFinance"){
  const actor=requireRole(session,"restaurant");requireRestaurantCapability(db,session,restaurantId,capability);
  const row=db.prepare("SELECT u.id,u.email,r.name restaurant_name FROM users u JOIN restaurant_memberships m ON m.user_id=u.id JOIN restaurants r ON r.id=m.restaurant_id WHERE u.id=? AND u.role='restaurant' AND u.account_enabled=1 AND r.id=? AND r.archived_at IS NULL").get(actor.id,restaurantId);
  if(!row)throw fail("OWNER_REQUIRED","An active restaurant owner is required.",403);
  if(!email(row.email))throw fail("REPORT_OWNER_EMAIL_UNAVAILABLE","Update your business account email before requesting a report.",409);return row;
}

export function resolveBusinessReport(db,config,session,reportPath){
  requireRole(session,"restaurant");
  if(typeof reportPath!=="string"||reportPath.length>2000||!reportPath.startsWith("/api/")||/[\\#\r\n\0]/.test(reportPath))throw fail("REPORT_NOT_ALLOWED","Choose an available business CSV report.");
  const url=new URL(reportPath,config.origin);if(url.origin!==config.origin||url.pathname!==reportPath.split("?")[0])throw fail("REPORT_NOT_ALLOWED","Choose an available business CSV report.");
  let match,restaurantId,kind,allowed;
  if((match=new RegExp(`^/api/restaurant/restaurants/(${identifier})/dashboard/(metrics|orders)\\.csv$`).exec(url.pathname))){restaurantId=match[1];kind=`dashboard-${match[2]}`;allowed=["period","scope"];}
  else if((match=new RegExp(`^/api/restaurant/restaurants/(${identifier})/finance/statement\\.csv$`).exec(url.pathname))){restaurantId=match[1];kind="finance-activity";allowed=["from","to","scope"];}
  else if((match=new RegExp(`^/api/restaurant/restaurants/(${identifier})/weekly-statements/(${identifier})\\.csv$`).exec(url.pathname))){restaurantId=match[1];kind="weekly-statement";allowed=["scope"];}
  else if((match=new RegExp(`^/api/restaurant/restaurants/(${identifier})/menu-template\\.csv$`).exec(url.pathname))){restaurantId=match[1];kind="menu-template";allowed=[];}
  else if(url.pathname==="/api/owner/business-payment-adjustments/export.csv"){restaurantId=url.searchParams.get("restaurantId");kind="payment-adjustments";allowed=["restaurantId","weekStart"];}
  else if((match=new RegExp(`^/api/report-jobs/(${identifier})/download$`).exec(url.pathname))){
    const row=db.prepare("SELECT * FROM marketplace_report_jobs WHERE id=?").get(match[1]);
    if(!row||row.actor_user_id!==session.user.id||row.kind!=="finance_statement")throw fail("NOT_FOUND","Report not found.",404);
    restaurantId=row.restaurant_id;kind="saved-finance-report";allowed=["scope"];
  }else throw fail("REPORT_NOT_ALLOWED","Choose an available business CSV report.");
  const seen=new Set();for(const[key,value]of url.searchParams){if(seen.has(key)||!allowed.includes(key)||!value)throw fail("REPORT_QUERY_INVALID","The report options are invalid.");seen.add(key);}
  if(!new RegExp(`^${identifier}$`).test(restaurantId??""))throw fail("REPORT_QUERY_INVALID","Choose a restaurant.");
  const recipient=owner(db,session,restaurantId,reportCapability(kind)),scope=resolveFinanceScope(config,url);url.searchParams.sort();
  return {url,restaurantId,kind,scope,owner:recipient,reportPath:url.pathname+(url.search?url.search:"")};
}
function render(db,config,session,report){
  const {url,restaurantId,kind}=report;let csv,scope=report.scope;
  if(kind.startsWith("dashboard-"))csv=buildOwnerDashboardCsv({db,config,session,url,rowLimit:MAX_ROWS}).body;
  else if(kind==="finance-activity"){
    const range=parseLondonDateRange(url),clauses=["m.restaurant_id=?",operationFinancePredicate("m",scope)],args=[restaurantId];
    if(range.from){clauses.push("m.created_at>=?");args.push(range.from);}if(range.toExclusive){clauses.push("m.created_at<?");args.push(range.toExclusive);}
    const rows=db.prepare(`SELECT m.* FROM marketplace_operations m WHERE ${clauses.join(" AND ")} ORDER BY m.created_at,m.id LIMIT ?`).all(...args,MAX_ROWS+1);
    if(rows.length>MAX_ROWS)throw tooLarge();csv=statementCsv(rows,scope);
  }else if(kind==="weekly-statement"){
    const id=url.pathname.split("/").at(-1).slice(0,-4),row=db.prepare("SELECT csv,summary FROM business_weekly_statement_outbox WHERE id=? AND restaurant_id=? AND user_id=?").get(id,restaurantId,session.user.id);
    if(!row||!row.csv||(parse(row.summary)?.scope??"testing")!==scope)throw fail("NOT_FOUND","Statement unavailable.",404);csv=row.csv;
  }else if(kind==="payment-adjustments"){
    const result=listBusinessPaymentAdjustments(db,{restaurantId,providerMode:config.paymentProviderMode,platformAccountId:config.stripePlatformAccountId,weekStart:url.searchParams.get("weekStart")||undefined,page:1,pageSize:MAX_ROWS,exportMode:true,includeDrafts:false,now:config.now()});
    csv=exportBusinessPaymentAdjustmentsCsv(result.items,{asOf:result.positionGeneratedAt});
  }else if(kind==="menu-template")csv="name,description,pricepence,category,allergens,dietarytags\r\nExample bowl,Description,1250,Mains,milk|egg,halal\r\n";
  else{
    const id=url.pathname.split("/")[3],row=db.prepare("SELECT * FROM marketplace_report_jobs WHERE id=? AND actor_user_id=? AND restaurant_id=?").get(id,session.user.id,restaurantId);
    if(row?.status!=="completed"||!row.content)throw fail("REPORT_NOT_READY","This report is still being prepared. Try again when it is ready.",409);
    const job=db.prepare("SELECT payload FROM marketplace_worker_jobs WHERE kind='report_generation' AND entity_id=? AND operation_key=?").get(id,`report:${id}`),stored=parse(job?.payload)?.scope??"testing";
    if(!["live","testing"].includes(stored)||url.searchParams.has("scope")&&scope!==stored)throw fail("REPORT_SCOPE_MISMATCH","Choose the matching financial history for this report.",409);
    scope=resolveFinanceScope(config,new URL(`/?scope=${stored}`,config.origin));csv=row.content;
  }
  return {csv:boundedCsv(csv),scope,filename:`Cal-Eats-${kind}.csv`};
}
function dto(row){return {id:row.id,status:row.status,recipient:row.recipient,errorCode:row.last_error,createdAt:row.created_at,sentAt:row.sent_at,reportKind:row.report_kind,financialScope:row.financial_scope};}
function rate(db,userId,stamp){
  if(db.prepare("SELECT COUNT(*) n FROM business_report_email_outbox WHERE user_id=? AND created_at>?").get(userId,new Date(Date.parse(stamp)-10*60000).toISOString()).n>=10||db.prepare("SELECT COUNT(*) n FROM business_report_email_outbox WHERE user_id=? AND created_at>?").get(userId,new Date(Date.parse(stamp)-DAY).toISOString()).n>=40)throw fail("REPORT_EMAIL_RATE_LIMITED","Please wait before requesting more report emails.",429);
}
export async function routeBusinessReportEmails({req,res,url,db,config,session}){
  if(req.method==="GET"&&/^\/api\/restaurant\/restaurants\/[^/]+\/menu-template\.csv$/.test(url.pathname)){
    const report=resolveBusinessReport(db,config,session,url.pathname),snapshot=render(db,config,session,report);
    res.writeHead(200,{"Content-Type":"text/csv; charset=utf-8","Content-Disposition":`attachment; filename="${snapshot.filename}"`});res.end(snapshot.csv);return true;
  }
  const status=/^\/api\/restaurant\/report-emails\/([A-Za-z0-9_-]{8,100})$/.exec(url.pathname);
  if(req.method==="GET"&&status){
    const user=requireRole(session,"restaurant"),row=db.prepare("SELECT * FROM business_report_email_outbox WHERE id=? AND user_id=?").get(status[1],user.id);
    if(!row)throw fail("NOT_FOUND","Report email not found.",404);owner(db,session,row.restaurant_id,reportCapability(row.report_kind));return sendJson(res,200,{data:dto(row)});
  }
  if(req.method!=="POST"||url.pathname!=="/api/restaurant/report-emails")return false;
  const body=await readJson(req,config.bodyLimit);exactObject(body,["reportPath"]);
  const report=resolveBusinessReport(db,config,session,body.reportPath),key=req.headers["idempotency-key"];
  if(typeof key!=="string"||!/^[A-Za-z0-9_-]{16,120}$/.test(key))throw fail("VALIDATION_ERROR","A valid report request reference is required.");
  const digest=hash(report.reportPath),prior=()=>db.prepare("SELECT * FROM business_report_email_outbox WHERE user_id=? AND idempotency_key=?").get(session.user.id,key);
  const replay=prior();if(replay){if(replay.request_hash!==digest)throw fail("IDEMPOTENCY_CONFLICT","This report request reference was already used for different options.",409);return sendJson(res,200,{data:dto(replay)});}
  if(!deliveryAllowed(config))throw fail("REPORT_EMAIL_UNAVAILABLE","Report email delivery is currently unavailable. Contact Cal-Eats support.",503);
  if(config.runMode!=="local"&&demo(report.owner.email))throw fail("REPORT_EMAIL_UNAVAILABLE","A real business email address is needed for report delivery.",409);
  const stamp=config.now().toISOString();rate(db,session.user.id,stamp);const snapshot=render(db,config,session,report);
  const row=withTransaction(db,()=>{
    const previous=prior();if(previous){if(previous.request_hash!==digest)throw fail("IDEMPOTENCY_CONFLICT","This request reference was already used.",409);return previous;}
    const current=owner(db,session,report.restaurantId,reportCapability(report.kind));if(current.email!==report.owner.email)throw fail("REPORT_OWNER_CHANGED","Your business account changed. Refresh and try again.",409);
    rate(db,session.user.id,stamp);
    const uncertain=db.prepare("SELECT id FROM business_report_email_outbox WHERE user_id=? AND report_path=? AND (status='unknown' OR (status='claimed' AND dispatch_started_at IS NOT NULL)) AND created_at>?").get(session.user.id,report.reportPath,new Date(Date.parse(stamp)-DAY).toISOString());
    if(uncertain)throw fail("REPORT_DELIVERY_UNCERTAIN","This report may already have been sent. Contact support before requesting it again.",409);
    const id=randomUUID();
    db.prepare(`INSERT INTO business_report_email_outbox(id,restaurant_id,user_id,recipient,idempotency_key,request_hash,report_path,report_kind,financial_scope,provider_mode,platform_account_id,filename,csv,content_sha256,mode,message_id,status,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)`).run(id,report.restaurantId,session.user.id,current.email,key,digest,report.reportPath,report.kind,snapshot.scope,config.paymentProviderMode,config.stripePlatformAccountId??null,snapshot.filename,snapshot.csv,hash(snapshot.csv),mode(config),`<cal-eats-business-statement-${id}@calai.info>`,stamp,stamp,new Date(Date.parse(stamp)+DAY).toISOString());
    db.prepare("INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)").run(randomUUID(),session.user.id,"business_report_email",id,"report_email_requested",JSON.stringify({restaurantId:report.restaurantId,reportKind:report.kind,scope:snapshot.scope,reportPath:report.reportPath,bytes:Buffer.byteLength(snapshot.csv),sha256:hash(snapshot.csv)}),stamp);
    return prior();
  });return sendJson(res,202,{data:dto(row)});
}
export function buildBusinessReportEmail(row,config){
  const csv=boundedCsv(row.csv);if(hash(csv)!==row.content_sha256)throw Error("Report snapshot changed");
  const link=new URL("/business/owner/earnings",config.origin).href,label=row.financial_scope==="testing"?"Testing history":"Live business activity";
  return {id:row.id,to:row.recipient,from:config.orderAlertEmail.from,messageId:row.message_id,subject:`Cal-Eats | Your requested ${row.report_kind.replaceAll("-"," ")} report`,text:`Cal-Eats\n\nYour requested report is attached as a CSV file, which opens in Excel and other spreadsheet apps.\n${label}. Prepared ${row.created_at}.\n\nKeep the attachment private. The file reflects the recorded information when requested; it is not proof of a bank deposit.\n\nView your business platform: ${link}\nFor help: support@calai.info`,attachments:[{filename:row.filename,contentType:"text/csv",contentBase64:Buffer.from(csv).toString("base64")}]};
}
function sourceFailure(db,config,row){
  if(!restaurantCapabilities(db,{user:{id:row.user_id,role:"restaurant"}},row.restaurant_id)[reportCapability(row.report_kind)])return "REPORT_PERMISSION_CHANGED";
  const user=db.prepare("SELECT u.email FROM users u JOIN restaurant_memberships m ON m.user_id=u.id JOIN restaurants r ON r.id=m.restaurant_id WHERE u.id=? AND u.account_enabled=1 AND u.role='restaurant' AND r.id=? AND r.archived_at IS NULL").get(row.user_id,row.restaurant_id);
  if(!user||!email(user.email)||user.email.toLowerCase()!==row.recipient.toLowerCase())return "REPORT_OWNER_OR_EMAIL_CHANGED";
  if(!deliveryAllowed(config)||mode(config)!==row.mode)return "REPORT_DELIVERY_DISABLED_OR_CHANGED";
  if(row.provider_mode!==config.paymentProviderMode||(row.platform_account_id??null)!==(config.stripePlatformAccountId??null))return "REPORT_FINANCIAL_ENVIRONMENT_CHANGED";
  if(row.mode!=="local"&&demo(row.recipient))return "REPORT_TEST_RECIPIENT_DISABLED";
  if(row.expires_at<=config.now().toISOString())return "REPORT_EXPIRED";
  if(!row.csv||Buffer.byteLength(row.csv)>MAX_BYTES||hash(row.csv)!==row.content_sha256)return "REPORT_SNAPSHOT_INVALID";return null;
}
async function run(db,config,{workerId=randomUUID(),limit=10,adapter,beforeDispatch}={}){
  if(!Number.isInteger(limit)||limit<1||limit>25)throw new TypeError("Report email worker limit must be1–25");
  const result={sent:0,localSaved:0,failed:0,unknown:0,cancelled:0},stamp=config.now().toISOString();
  withTransaction(db,()=>{
    db.prepare("UPDATE business_report_email_outbox SET status=CASE WHEN dispatch_started_at IS NULL THEN 'pending' ELSE 'unknown' END,last_error=CASE WHEN dispatch_started_at IS NULL THEN 'REPORT_LEASE_RECOVERED' ELSE 'REPORT_DELIVERY_UNKNOWN' END,csv=CASE WHEN dispatch_started_at IS NULL THEN csv ELSE NULL END,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE status='claimed' AND lease_expires_at<=?").run(stamp,stamp);
    result.cancelled+=db.prepare("UPDATE business_report_email_outbox SET status='cancelled',csv=NULL,last_error='REPORT_EXPIRED',updated_at=? WHERE status='pending' AND expires_at<=?").run(stamp,stamp).changes;
    db.prepare("DELETE FROM business_report_email_outbox WHERE created_at<? AND status NOT IN ('pending','claimed')").run(new Date(Date.parse(stamp)-30*DAY).toISOString());
  });
  if(!deliveryAllowed(config))return result;
  if(!adapters.has(config))adapters.set(config,createOrderAlertEmailAdapter({...config.orderAlertEmail,mode:mode(config),localDirectory:path.join(config.orderAlertEmail.localDirectory,"requested-business-reports")}));
  const sender=adapter??adapters.get(config);
  for(let i=0;i<limit;i++){
    const row=withTransaction(db,()=>{
      const candidate=db.prepare("SELECT * FROM business_report_email_outbox WHERE status='pending' ORDER BY created_at,id LIMIT 1").get();if(!candidate)return null;
      const now=config.now().toISOString();return db.prepare("UPDATE business_report_email_outbox SET status='claimed',attempts=attempts+1,lease_owner=?,lease_expires_at=?,updated_at=? WHERE id=? AND status='pending'").run(workerId,new Date(Date.parse(now)+120000).toISOString(),now,candidate.id).changes?candidate:null;
    });if(!row)break;
    const owned=()=>Boolean(db.prepare("SELECT 1 FROM business_report_email_outbox WHERE id=? AND status='claimed' AND lease_owner=? AND lease_expires_at>?").get(row.id,workerId,config.now().toISOString()));
    const cancel=code=>db.prepare("UPDATE business_report_email_outbox SET status='cancelled',csv=NULL,last_error=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND status='claimed' AND lease_owner=? AND dispatch_started_at IS NULL").run(code,config.now().toISOString(),row.id,workerId);
    const beforeSend=()=>withTransaction(db,()=>{if(!owned())return false;const invalid=sourceFailure(db,config,row);if(invalid){cancel(invalid);return false;}const now=config.now().toISOString();return db.prepare("UPDATE business_report_email_outbox SET dispatch_started_at=?,updated_at=? WHERE id=? AND status='claimed' AND lease_owner=? AND dispatch_started_at IS NULL AND lease_expires_at>?").run(now,now,row.id,workerId,now).changes===1;});
    let outcome;
    try{await beforeDispatch?.(row);if(!owned())continue;const invalid=sourceFailure(db,config,row);if(invalid){cancel(invalid);result.cancelled++;continue;}outcome=await sender(buildBusinessReportEmail(row,config),{beforeSend});}
    catch{outcome={status:db.prepare("SELECT dispatch_started_at FROM business_report_email_outbox WHERE id=?").get(row.id)?.dispatch_started_at?"unknown":"failed",errorCode:"REPORT_EMAIL_ADAPTER_ERROR"};}
    let status=["sent","local_saved","failed","unknown","cancelled"].includes(outcome?.status)?outcome.status:"unknown";
    const dispatched=db.prepare("SELECT dispatch_started_at FROM business_report_email_outbox WHERE id=?").get(row.id)?.dispatch_started_at;
    if(["sent","local_saved"].includes(status)&&!dispatched)status="unknown";
    const now=config.now().toISOString(),code=status==="sent"||status==="local_saved"?null:/^[A-Z0-9_]{1,80}$/.test(outcome?.errorCode??"")?outcome.errorCode:"REPORT_DELIVERY_UNKNOWN";
    const saved=withTransaction(db,()=>{
      const changed=db.prepare("UPDATE business_report_email_outbox SET status=?,csv=NULL,last_error=?,sent_at=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND status='claimed' AND lease_owner=? AND lease_expires_at>?").run(status,code,["sent","local_saved"].includes(status)?now:null,now,row.id,workerId,now);
      if(changed.changes)db.prepare("INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)").run(randomUUID(),row.user_id,"business_report_email",row.id,"report_email_delivery_recorded",JSON.stringify({status,errorCode:code}),now);return changed;
    });if(saved.changes)result[status==="local_saved"?"localSaved":status]++;
  }return result;
}
export function runBusinessReportEmails(db,config,options){if(workers.has(db))return workers.get(db);const work=run(db,config,options).finally(()=>workers.delete(db));workers.set(db,work);return work;}
