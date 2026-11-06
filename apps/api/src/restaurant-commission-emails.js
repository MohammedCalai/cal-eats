import {randomUUID} from "node:crypto";
import {withTransaction} from "./db/index.js";
import {createOrderAlertEmailAdapter} from "./order-alert-email.js";

const workers=new WeakMap(),adapters=new WeakMap();
const MAX_ATTEMPTS=5,LEASE_MS=120000,RETRY_MS=[60000,300000,900000,3600000];
const validEmail=value=>typeof value==="string"&&value.length<=254&&/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(value);
const safeText=value=>String(value??"").replace(/[\r\n\0]/g," ").trim();
const escape=value=>String(value).replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
const ukTime=value=>new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/London",weekday:"long",day:"numeric",month:"long",year:"numeric",hour:"2-digit",minute:"2-digit",timeZoneName:"short"}).format(new Date(value));
const mode=config=>config.orderAlertEmail.mode;
const rowsFor=(db,restaurantId,revision)=>db.prepare("SELECT o.* FROM restaurant_commission_email_outbox o JOIN restaurant_commission_email_events e ON e.id=o.event_id WHERE e.restaurant_id=? AND e.settings_revision=?").all(restaurantId,revision);

/** Must run in the same transaction as the commission revision and audit event. */
export function enqueueRestaurantCommissionEmails(db,config,{restaurantId,revision,before,after,normalRateBasisPoints,now}){
  if(!db.prepare("SELECT 1 FROM restaurants WHERE id=? AND archived_at IS NULL").get(restaurantId))return;
  // Never allow an earlier queued confirmation to describe a replaced or cancelled promise.
  db.prepare("UPDATE restaurant_commission_email_outbox SET status='cancelled',last_error='COMMISSION_SETTINGS_SUPERSEDED',next_attempt_at=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE event_id IN (SELECT id FROM restaurant_commission_email_events WHERE restaurant_id=? AND settings_revision<?) AND (status IN ('pending','failed') OR (status='claimed' AND dispatch_started_at IS NULL))").run(now,restaurantId,revision);
  const hadPeriod=Boolean(before.freePeriod&&before.freePeriod.endsAt>now);
  if(!after.freePeriod&&!hadPeriod)return;
  const kind=after.freePeriod?(hadPeriod?"updated":"scheduled"):after.enabled?"cancelled":"disabled";
  const name=db.prepare("SELECT name FROM restaurants WHERE id=?").get(restaurantId)?.name??"Your restaurant";
  const eventId=randomUUID(),payload=JSON.stringify({restaurantName:safeText(name),normalRateBasisPoints,before,after});
  const inserted=db.prepare("INSERT OR IGNORE INTO restaurant_commission_email_events(id,restaurant_id,settings_revision,kind,payload,created_at) VALUES(?,?,?,?,?,?)").run(eventId,restaurantId,revision,kind,payload,now);
  if(!inserted.changes)return;
  const owners=db.prepare("SELECT u.id,u.email FROM restaurant_memberships m JOIN users u ON u.id=m.user_id WHERE m.restaurant_id=? AND m.permission='owner' AND u.role='restaurant' AND u.account_enabled=1 ORDER BY u.id").all(restaurantId);
  for(const owner of owners){
    if(!validEmail(owner.email))continue;
    const id=randomUUID();
    db.prepare("INSERT INTO restaurant_commission_email_outbox(id,event_id,user_id,recipient,message_id,mode,status,next_attempt_at,queued_at,updated_at) VALUES(?,?,?,?,?,?,'pending',?,?,?)").run(id,eventId,owner.id,owner.email,`<cal-eats-commission-email-${id}@calai.info>`,mode(config),now,now,now);
  }
}

/** Admin-facing receipt of queue state; 'sent' means provider acceptance, never inbox delivery. */
export function restaurantCommissionEmailSummary(db,restaurantId,revision){
  const event=db.prepare("SELECT id FROM restaurant_commission_email_events WHERE restaurant_id=? AND settings_revision=?").get(restaurantId,revision);
  if(!event)return null;
  const rows=rowsFor(db,restaurantId,revision),sentCount=rows.filter(row=>row.status==="sent").length,localSavedCount=rows.filter(row=>row.status==="local_saved").length,pendingCount=rows.filter(row=>["pending","claimed"].includes(row.status)||row.status==="failed"&&row.next_attempt_at).length;
  const status=!rows.length?"unavailable":rows.some(row=>row.status==="unknown")?"unknown":pendingCount?"queued":rows.some(row=>row.status==="failed")?"failed":sentCount?"sent":localSavedCount?"local_saved":"cancelled";
  return {status,recipientCount:rows.length,sentCount,pendingCount,localSavedCount};
}

export function buildRestaurantCommissionEmail(row,config){
  const payload=JSON.parse(row.payload),name=safeText(payload.restaurantName)||"Your restaurant",rate=`${Number((payload.normalRateBasisPoints/100).toFixed(2))}%`,free=payload.after.freePeriod;
  const title=free?(row.kind==="updated"?"Commission-free period updated":"Commission-free period confirmed"):row.kind==="disabled"?"Commission settings updated":"Commission-free period cancelled";
  const paragraphs=free?[
    `Your commission-free period for ${name} is ${row.kind==="updated"?"updated":"confirmed"}.`,
    `Start: ${ukTime(free.startsAt)}.`,
    `End: ${ukTime(free.endsAt)}.`,
    "The commission rate is 0% on new orders placed during this period.",
    `Your normal commission resumes automatically at ${ukTime(free.endsAt)}. Your current normal rate is ${rate}.`
  ]:row.kind==="disabled"?[
    `The previously scheduled commission-free period for ${name} has been replaced.`,
    "Commission is now switched off (0%) until the Cal-Eats team changes this setting. There is no scheduled end date."
  ]:[
    `The previously scheduled commission-free period for ${name} has been cancelled.`,
    `Your normal ${rate} commission applies to new orders from now.`
  ];
  paragraphs.push("Existing orders keep their recorded commission rate.","All dates and times shown are UK time (Europe/London).");
  const origin=new URL(config.publicOrigin??config.origin).origin,link=`${origin}/business/owner/earnings`,sender=config.orderAlertEmail.from;
  return {id:row.id,to:row.recipient,from:sender,messageId:row.message_id,subject:`Cal-Eats | ${title} — ${name}`.slice(0,220),text:["Cal-Eats",title,"",...paragraphs,"",`View earnings and payouts: ${link}`,"",`Cal-Eats · ${sender}`].join("\n"),html:`<!doctype html><html><body style="margin:0;background:#eef5fc;font-family:Arial,Helvetica,sans-serif;color:#192b45"><table role="presentation" width="100%"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="600" style="max-width:600px;width:100%;background:#fff;border:1px solid #d6e4f2;border-radius:12px"><tr><td style="background:#164b7c;padding:22px 26px"><img src="${escape(origin)}/assets/cal-eats-logo.png" alt="Cal-Eats" width="210" style="display:block;max-width:100%;height:auto"></td></tr><tr><td style="padding:26px"><h1 style="font-size:24px;margin:0 0 18px">${escape(title)}</h1>${paragraphs.map(value=>`<p style="line-height:1.6;font-size:15px">${escape(value)}</p>`).join("")}<p style="margin-top:24px"><a href="${escape(link)}" style="display:inline-block;background:#2563eb;color:#fff;padding:13px 18px;border-radius:7px;text-decoration:none">View earnings and payouts</a></p><p style="font-size:12px;color:#64748b">Cal-Eats · ${escape(sender)}</p></td></tr></table></td></tr></table></body></html>`};
}

function sourceFailure(db,row,now,config){
  if(!db.prepare("SELECT 1 FROM restaurants WHERE id=? AND archived_at IS NULL").get(row.restaurant_id))return "COMMISSION_EMAIL_RESTAURANT_ARCHIVED";
  if(row.mode!==mode(config))return "COMMISSION_EMAIL_TRANSPORT_CHANGED";
  const owner=db.prepare("SELECT u.email FROM users u JOIN restaurant_memberships m ON m.user_id=u.id AND m.restaurant_id=? AND m.permission='owner' WHERE u.id=? AND u.role='restaurant' AND u.account_enabled=1").get(row.restaurant_id,row.user_id);
  if(!owner||!validEmail(owner.email)||owner.email.toLowerCase()!==row.recipient.toLowerCase())return "COMMISSION_EMAIL_OWNER_CHANGED";
  // Seed/demo accounts must never trigger a real email transport.
  if(["graph","smtp"].includes(mode(config))&&/(?:@[^@]*\.(?:local|invalid|test)$|@(?:example\.(?:com|org|net))$)/i.test(owner.email))return "COMMISSION_EMAIL_TEST_RECIPIENT";
  const current=db.prepare("SELECT * FROM restaurant_commission_controls WHERE restaurant_id=?").get(row.restaurant_id),payload=JSON.parse(row.payload),free=payload.after.freePeriod;
  if(!current||current.revision!==row.settings_revision||Boolean(current.enabled)!==payload.after.enabled||(current.free_period_starts_at??null)!==(free?.startsAt??null)||(current.free_period_ends_at??null)!==(free?.endsAt??null))return "COMMISSION_SETTINGS_SUPERSEDED";
  if(free&&free.endsAt<=now)return "COMMISSION_PERIOD_ENDED_BEFORE_SEND";
  return null;
}

async function run(db,config,{workerId=randomUUID(),limit=25,adapter,beforeDispatch}={}){
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new TypeError("Commission email worker limit must be 1–100");
  const result={sent:0,localSaved:0,failed:0,unknown:0,cancelled:0},stamp=config.now().toISOString();
  withTransaction(db,()=>{
    db.prepare("UPDATE restaurant_commission_email_outbox SET status=CASE WHEN dispatch_started_at IS NULL THEN 'pending' ELSE 'unknown' END,last_error=CASE WHEN dispatch_started_at IS NULL THEN 'EMAIL_LEASE_RECOVERED_BEFORE_DISPATCH' ELSE 'EMAIL_LEASE_EXPIRED_AFTER_DISPATCH' END,next_attempt_at=CASE WHEN dispatch_started_at IS NULL THEN ? ELSE NULL END,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE status='claimed' AND lease_expires_at<=?").run(stamp,stamp,stamp);
    result.cancelled+=db.prepare("UPDATE restaurant_commission_email_outbox SET status='cancelled',last_error='COMMISSION_EMAIL_RESTAURANT_ARCHIVED',next_attempt_at=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE status IN ('pending','failed') AND dispatch_started_at IS NULL AND EXISTS(SELECT 1 FROM restaurant_commission_email_events e JOIN restaurants r ON r.id=e.restaurant_id WHERE e.id=restaurant_commission_email_outbox.event_id AND r.archived_at IS NOT NULL)").run(stamp).changes;
  });
  if(!adapters.has(config))adapters.set(config,createOrderAlertEmailAdapter(config.orderAlertEmail));
  const sender=adapter??adapters.get(config);
  for(let index=0;index<limit;index++){
    const row=withTransaction(db,()=>{
      const now=config.now().toISOString(),candidate=db.prepare("SELECT o.*,e.restaurant_id,e.settings_revision,e.kind,e.payload FROM restaurant_commission_email_outbox o JOIN restaurant_commission_email_events e ON e.id=o.event_id WHERE o.status IN ('pending','failed') AND o.next_attempt_at IS NOT NULL AND o.next_attempt_at<=? ORDER BY o.queued_at,o.rowid LIMIT 1").get(now);
      if(!candidate)return null;
      const saved=db.prepare("UPDATE restaurant_commission_email_outbox SET status='claimed',lease_owner=?,lease_expires_at=?,dispatch_started_at=NULL,attempts=attempts+1,updated_at=? WHERE id=? AND status IN ('pending','failed') AND next_attempt_at<=?").run(workerId,new Date(Date.parse(now)+LEASE_MS).toISOString(),now,candidate.id,now);
      return saved.changes?{...candidate,attempts:candidate.attempts+1}:null;
    });if(!row)break;
    const owned=()=>Boolean(db.prepare("SELECT 1 FROM restaurant_commission_email_outbox WHERE id=? AND status='claimed' AND lease_owner=? AND lease_expires_at>?").get(row.id,workerId,config.now().toISOString()));
    const cancel=code=>db.prepare("UPDATE restaurant_commission_email_outbox SET status='cancelled',last_error=?,next_attempt_at=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND status='claimed' AND lease_owner=? AND dispatch_started_at IS NULL").run(code,config.now().toISOString(),row.id,workerId);
    const beforeSend=()=>withTransaction(db,()=>{
      if(!owned())return false;
      const now=config.now().toISOString(),failure=sourceFailure(db,row,now,config);
      if(failure){cancel(failure);return false;}
      return db.prepare("UPDATE restaurant_commission_email_outbox SET dispatch_started_at=?,updated_at=? WHERE id=? AND status='claimed' AND lease_owner=? AND dispatch_started_at IS NULL AND lease_expires_at>?").run(now,now,row.id,workerId,now).changes===1;
    });
    let outcome;
    try{
      await beforeDispatch?.(row);if(!owned())continue;
      const failure=sourceFailure(db,row,config.now().toISOString(),config);if(failure){cancel(failure);result.cancelled++;continue;}
      outcome=await sender(buildRestaurantCommissionEmail(row,config),{beforeSend});
    }catch{
      outcome={status:db.prepare("SELECT dispatch_started_at FROM restaurant_commission_email_outbox WHERE id=?").get(row.id)?.dispatch_started_at?"unknown":"failed",errorCode:"COMMISSION_EMAIL_ADAPTER_ERROR"};
    }
    const status=["sent","local_saved","failed","unknown","cancelled"].includes(outcome?.status)?outcome.status:"unknown",now=config.now().toISOString(),code=typeof outcome?.errorCode==="string"&&/^[A-Z0-9_]{1,80}$/.test(outcome.errorCode)?outcome.errorCode:status==="unknown"?"EMAIL_OUTCOME_UNKNOWN":null;
    const retryAt=status==="failed"&&row.attempts<MAX_ATTEMPTS?new Date(Date.parse(now)+RETRY_MS[row.attempts-1]).toISOString():null;
    const saved=db.prepare("UPDATE restaurant_commission_email_outbox SET status=?,last_error=?,next_attempt_at=?,sent_at=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND status='claimed' AND lease_owner=? AND lease_expires_at>?").run(status,code,retryAt,["sent","local_saved"].includes(status)?now:null,now,row.id,workerId,now);
    if(saved.changes)result[status==="local_saved"?"localSaved":status]++;
  }
  return result;
}

export function runRestaurantCommissionEmails(db,config,options){
  if(workers.has(db))return workers.get(db);
  const work=run(db,config,options).finally(()=>workers.delete(db));workers.set(db,work);return work;
}
