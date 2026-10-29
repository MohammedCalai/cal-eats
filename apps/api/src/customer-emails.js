import { randomUUID } from "node:crypto";
import { withTransaction } from "./db/index.js";
import { requireRole } from "./auth/authorization.js";
import { HttpError, sendJson } from "./http.js";
import { createOrderAlertEmailAdapter, orderAlertEmailTransportReadiness } from "./order-alert-email.js";
import { supportEmailSource } from "./support-email-source.js";

const TYPES = new Map([["order_status","order_update"],["order_eta","order_update"],["order_refund","order_update"],["order_expired","order_update"],["order_message","order_message"],["customer_message","customer_message"],["support_reply","support_reply"],["support_request","support_update"],["support_receipt","support_update"],["support_status","support_update"],["dispute_restaurant_reply","case_update"],["dispute_remedy_proposed","case_update"]]);
const STATUS_LABELS = { accepted:"Order confirmed",preparing:"Your order is being prepared",ready:"Your order is ready",out_for_delivery:"Out for delivery",completed:"Order completed",rejected:"Order cancelled",refunded:"Order refund recorded" };
const email = value => typeof value === "string" && /^[^\s<>@,;\r\n]+@[^\s<>@,;\r\n]+\.[A-Za-z]{2,}$/.test(value) && value.length<=254;
const demoRecipient = value => /(?:\.(?:invalid|local|test)|@example\.(?:com|net|org))$/i.test(value);
const escape = value => String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[char]);
const safe = (value,max=500) => String(value??"").replace(/[\r\n\0]+/g," ").trim().slice(0,max);
const parse = value => {try{return JSON.parse(value);}catch{return null;}};
const money = value => Number.isSafeInteger(value)&&value>=0?new Intl.NumberFormat("en-GB",{style:"currency",currency:"GBP"}).format(value/100):"Not available";
const workers = new WeakMap();
const adapters = new WeakMap();

export function initializeCustomerEmailDelivery(db,config) {
  db.prepare("INSERT INTO customer_email_delivery_settings VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET mode=excluded.mode,payment_provider_mode=excluded.payment_provider_mode,updated_at=excluded.updated_at").run(config.orderAlertEmail.mode,config.paymentProviderMode,config.now().toISOString());
}

function sourceData(db,notification) {
  const kind=TYPES.get(notification.type);if(!kind)return null;
  if(kind==="support_reply"||kind==="support_update"){
    const source=supportEmailSource(db,notification),delivery=db.prepare("SELECT * FROM customer_email_delivery_settings WHERE id=1").get();
    if(!source||!email(source.recipient??source.user.email)||!delivery)return null;
    return {kind,user:source.user,recipient:source.recipient??source.user.email,payload:{...source.payload,notificationType:notification.type,simulation:delivery.payment_provider_mode!=="stripe_live"},mode:delivery.mode,sourceMessageId:source.sourceMessageId,orderId:null,conversationId:null,supportCaseId:source.support.id,refundCaseId:null};
  }
  const user=db.prepare("SELECT id,email FROM users WHERE id=? AND role='customer' AND account_enabled=1").get(notification.user_id);
  if(!user||!email(user.email))return null;
  const delivery=db.prepare("SELECT * FROM customer_email_delivery_settings WHERE id=1").get(),parts=notification.event_key.split(":"),sourceMessageId=kind==="order_message"||kind==="customer_message"?parts[1]:kind==="support_reply"?parts.at(-1):null;
  const payload={title:safe(notification.title,150),summary:safe(notification.message,500),notificationType:notification.type,simulation:delivery.payment_provider_mode!=="stripe_live"};
  let order=null,conversation=null,support=null,refundCase=null;
  if(notification.order_id) {
    order=db.prepare("SELECT * FROM orders WHERE id=? AND customer_id=?").get(notification.order_id,user.id);if(!order)return null;
    payload.orderStatus=kind==="order_update"&&notification.type!=="order_eta"?parts[2]:order.status;
    payload.order={id:order.id,reference:order.id.slice(0,8).toUpperCase(),restaurantName:safe(order.restaurant_name,150),fulfillment:order.fulfillment,totalMinor:order.total_minor,currency:order.currency,etaAt:order.estimated_ready_at??null,paymentMethod:order.payment_method,items:db.prepare("SELECT name,quantity,unit_price_minor FROM order_items WHERE order_id=? ORDER BY rowid").all(order.id).map(item=>({name:safe(item.name,150),quantity:item.quantity,lineTotalMinor:item.quantity*item.unit_price_minor}))};
  }
  if(kind==="order_update"&&!order)return null;
  if(kind==="order_message") {
    if(!order||!sourceMessageId)return null;
    const message=db.prepare("SELECT 1 FROM order_messages WHERE id=? AND order_id=? AND sender_role='restaurant'").get(sourceMessageId,order?.id);if(!message)return null;
    payload.title="New message about your order";payload.summary="Your restaurant sent you a new message. Open Cal-Eats to read it and reply securely.";
  }
  if(kind==="customer_message") {
    if(!sourceMessageId)return null;
    conversation=db.prepare("SELECT t.*,r.name restaurant_name FROM restaurant_customer_threads t JOIN restaurants r ON r.id=t.restaurant_id WHERE t.id=? AND t.customer_id=?").get(notification.conversation_id,user.id);
    if(!conversation||!db.prepare("SELECT 1 FROM restaurant_customer_messages WHERE id=? AND thread_id=? AND sender_role='restaurant'").get(sourceMessageId,conversation.id))return null;
    payload.restaurantName=safe(conversation.restaurant_name,150);payload.title="A new message from your restaurant";payload.summary="Your restaurant sent you a new message. Open Cal-Eats to read it and reply securely.";
  }
  if(kind==="support_reply") {
    support=db.prepare("SELECT * FROM support_cases WHERE id=? AND user_id=?").get(notification.support_case_id,user.id);
    if(!support||!db.prepare("SELECT 1 FROM support_case_messages WHERE id=? AND case_id=? AND sender_role IN ('restaurant','admin')").get(sourceMessageId,support.id))return null;
    payload.title="A reply to your Cal-Eats help request";payload.summary="Your help request has a new reply. Open Cal-Eats to view it and respond securely.";payload.supportReference=support.id.slice(0,8).toUpperCase();
  }
  if(kind==="case_update") {
    const caseId=parts[0]==="dispute"?parts[1]:null;
    refundCase=caseId&&db.prepare("SELECT * FROM refund_cases WHERE id=? AND customer_id=?").get(caseId,user.id);if(!refundCase)return null;
    payload.caseReference=refundCase.reference;payload.summary="Your restaurant has updated your order support case. Open Cal-Eats to review the reply or proposed remedy.";
  }
  if(notification.restaurant_id&&!db.prepare("SELECT 1 FROM restaurants WHERE id=?").get(notification.restaurant_id))return null;
  return {kind,user,payload,mode:delivery.mode,sourceMessageId,orderId:order?.id??refundCase?.order_id??null,conversationId:conversation?.id??null,supportCaseId:support?.id??null,refundCaseId:refundCase?.id??null};
}

export function queueCustomerEmailForNotification(db,userId,eventKey) {
  const notification=db.prepare("SELECT * FROM user_notifications WHERE user_id=? AND event_key=?").get(userId,eventKey);if(!notification)return null;
  const data=sourceData(db,notification);if(!data)return null;
  const id=randomUUID();
  db.prepare("INSERT OR IGNORE INTO customer_transactional_email_outbox(id,customer_id,notification_id,source_key,event_kind,source_message_id,order_id,restaurant_id,conversation_id,support_case_id,refund_case_id,recipient,payload,message_id,mode,status,queued_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)").run(id,data.user.id,notification.id,eventKey,data.kind,data.sourceMessageId,data.orderId,notification.restaurant_id,data.conversationId,data.supportCaseId,data.refundCaseId,data.recipient??data.user.email,JSON.stringify(data.payload),`<cal-eats-customer-email-${id}@calai.info>`,data.mode,notification.created_at,notification.created_at);
  return db.prepare("SELECT id FROM customer_transactional_email_outbox WHERE customer_id=? AND source_key=?").get(userId,eventKey)?.id??null;
}

function sourceIsCurrent(db,row,config) {
  if(row.event_kind==="support_reply"||row.event_kind==="support_update"){
    const notification=db.prepare("SELECT * FROM user_notifications WHERE id=? AND user_id=? AND event_key=? AND support_case_id=?").get(row.notification_id,row.customer_id,row.source_key,row.support_case_id);
    const source=notification&&supportEmailSource(db,notification),payload=parse(row.payload);
    if(!source||(source.recipient??source.user.email).toLowerCase()!==row.recipient.toLowerCase())return{ok:false,code:"SUPPORT_RECIPIENT_OR_SOURCE_CHANGED"};
    if(TYPES.get(notification.type)!==row.event_kind||row.source_message_id!==source.sourceMessageId)return{ok:false,code:"SUPPORT_EMAIL_SOURCE_MISMATCH"};
    if((payload?.recipientRole||"customer")!==source.user.role)return{ok:false,code:"SUPPORT_RECIPIENT_ROLE_CHANGED"};
    if(row.mode!==config.orderAlertEmail.mode)return{ok:false,code:"EMAIL_MODE_CHANGED"};
    if(row.mode!=="local"&&demoRecipient(row.recipient))return{ok:false,code:"DEMO_RECIPIENT_EXTERNAL_SEND_DISABLED"};
    if(!payload)return{ok:false,code:"EMAIL_PAYLOAD_INVALID"};
    return{ok:true,payload};
  }
  const user=db.prepare("SELECT email FROM users WHERE id=? AND role='customer' AND account_enabled=1").get(row.customer_id);
  if(!user||user.email.toLowerCase()!==row.recipient.toLowerCase())return{ok:false,code:"CUSTOMER_RECIPIENT_CHANGED_OR_DISABLED"};
  if(row.mode!==config.orderAlertEmail.mode)return{ok:false,code:"EMAIL_MODE_CHANGED"};
  if(row.mode!=="local"&&demoRecipient(row.recipient))return{ok:false,code:"DEMO_RECIPIENT_EXTERNAL_SEND_DISABLED"};
  if(!row.notification_id||!db.prepare("SELECT 1 FROM user_notifications WHERE id=? AND user_id=?").get(row.notification_id,row.customer_id))return{ok:false,code:"SOURCE_NOTIFICATION_UNAVAILABLE"};
  const payload=parse(row.payload);if(!payload)return{ok:false,code:"EMAIL_PAYLOAD_INVALID"};
  const now=config.now().toISOString();
  const order=row.order_id?db.prepare("SELECT * FROM orders WHERE id=? AND customer_id=?").get(row.order_id,row.customer_id):null;
  if(row.order_id&&!order)return{ok:false,code:"ORDER_RECIPIENT_MISMATCH"};
  if(row.event_kind==="order_update"&&order?.status==="rejected"&&!["rejected","refunded"].includes(payload.orderStatus))return{ok:false,code:"ORDER_UPDATE_SUPERSEDED_BY_CANCELLATION"};
  if(row.event_kind==="order_update"&&payload.notificationType==="order_eta"&&order?.estimated_ready_at!==payload.order?.etaAt)return{ok:false,code:"ORDER_ETA_SUPERSEDED"};
  if(row.event_kind==="order_message") {
    const message=db.prepare("SELECT m.* FROM order_messages m JOIN users u ON u.id=m.sender_user_id WHERE m.id=? AND m.order_id=? AND m.sender_role='restaurant' AND m.expires_at>? AND u.account_enabled=1").get(row.source_message_id,row.order_id,now);
    if(!message||!db.prepare("SELECT 1 FROM restaurant_memberships WHERE restaurant_id=? AND user_id=?").get(row.restaurant_id,message.sender_user_id))return{ok:false,code:"ORDER_MESSAGE_UNAVAILABLE"};
    if(!["placed","accepted","preparing","ready","out_for_delivery"].includes(order.status)) {
      const terminal=db.prepare("SELECT created_at FROM order_events WHERE order_id=? AND to_status IN ('completed','rejected') ORDER BY created_at DESC LIMIT 1").get(order.id)?.created_at??order.updated_at,minutes=Math.min(1440,Math.max(0,db.prepare("SELECT support_window_minutes n FROM order_message_settings WHERE restaurant_id=?").get(order.restaurant_id)?.n??(config.messagingSupportHours??2)*60));
      if(config.now().getTime()>=Date.parse(terminal)+minutes*60000)return{ok:false,code:"ORDER_MESSAGE_WINDOW_CLOSED"};
    }
  }
  if(row.event_kind==="customer_message") {
    const message=db.prepare("SELECT m.sender_user_id,t.restaurant_id FROM restaurant_customer_messages m JOIN restaurant_customer_threads t ON t.id=m.thread_id JOIN users u ON u.id=m.sender_user_id WHERE m.id=? AND m.thread_id=? AND t.customer_id=? AND m.sender_role='restaurant' AND m.expires_at>? AND u.account_enabled=1").get(row.source_message_id,row.conversation_id,row.customer_id,now);
    if(!message||!db.prepare("SELECT 1 FROM restaurant_memberships WHERE restaurant_id=? AND user_id=? AND permission='owner'").get(message.restaurant_id,message.sender_user_id))return{ok:false,code:"CUSTOMER_MESSAGE_UNAVAILABLE"};
  }
  if(row.event_kind==="support_reply") {
    const message=db.prepare("SELECT m.sender_user_id,m.sender_role,s.restaurant_id FROM support_case_messages m JOIN support_cases s ON s.id=m.case_id JOIN users u ON u.id=m.sender_user_id WHERE m.id=? AND s.id=? AND s.user_id=? AND m.sender_role IN ('restaurant','admin') AND u.account_enabled=1").get(row.source_message_id,row.support_case_id,row.customer_id);
    if(!message)return{ok:false,code:"SUPPORT_REPLY_UNAVAILABLE"};
    if(message.sender_role==="restaurant"&&!db.prepare("SELECT 1 FROM restaurant_memberships WHERE restaurant_id=? AND user_id=?").get(message.restaurant_id,message.sender_user_id))return{ok:false,code:"SUPPORT_SENDER_ACCESS_REMOVED"};
  }
  if(row.event_kind==="case_update"&&!db.prepare("SELECT 1 FROM refund_cases WHERE id=? AND customer_id=?").get(row.refund_case_id,row.customer_id))return{ok:false,code:"CASE_RECIPIENT_MISMATCH"};
  return{ok:true,payload};
}

export function buildCustomerEmail(row,config) {
  const payload=parse(row.payload);if(!payload)throw new Error("Invalid customer email payload");
  const sender=config.orderAlertEmail.from,order=payload.order,link=new URL(row.support_case_id&&payload.recipientRole==="admin"?"/business/admin/support":row.support_case_id&&payload.recipientRole==="restaurant"?"/business/owner/support":"/order/",config.origin),logo=new URL("/assets/cal-eats-logo.png",config.origin).href;
  if(row.support_case_id)link.searchParams.set(["admin","restaurant"].includes(payload.recipientRole)?"case":"supportCaseId",row.support_case_id);
  else if(row.conversation_id)link.searchParams.set("conversationId",row.conversation_id);
  else if(row.order_id){link.searchParams.set("orderId",row.order_id);if(row.event_kind==="order_message")link.searchParams.set("messages","1");if(row.refund_case_id)link.searchParams.set("caseId",row.refund_case_id);}
  const title=row.event_kind==="order_update"&&payload.notificationType!=="order_eta"?(STATUS_LABELS[payload.orderStatus]??payload.title):payload.title,restaurant=order?.restaurantName??payload.restaurantName??"Cal-Eats support",eta=order?.etaAt?new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/London",weekday:"short",hour:"2-digit",minute:"2-digit"}).format(new Date(order.etaAt)):null;
  const details=order?[["Order",`#${order.reference}`],["Restaurant",restaurant],["Fulfilment",order.fulfillment==="delivery"?"Delivery":"Collection"],...(eta&&["accepted","preparing","ready","out_for_delivery"].includes(payload.orderStatus)||eta&&payload.notificationType==="order_eta"?[[order.fulfillment==="delivery"?"Estimated arrival":"Ready for collection",eta]]:[])]:[["Restaurant or team",restaurant],...(payload.supportReference?[["Help request",payload.supportReference]]:[]),...(payload.caseReference?[["Support case",payload.caseReference]]:[])];
  const includeItems=row.event_kind==="order_update",items=includeItems&&order?order.items:[],preview=payload.simulation?"Cal-Eats preview — test/simulated payments.":"",text=["Cal-Eats",title,restaurant,preview,payload.summary,"",...details.map(([key,value])=>`${key}: ${value}`),...(items.length?["","ORDER ITEMS",...items.map(item=>`${item.quantity} × ${item.name} — ${money(item.lineTotalMinor)}`),`Order total: ${money(order.totalMinor)}`]:[]),"",`Open securely in Cal-Eats: ${link.href}`,"","For messages and personal information, sign in to the Cal-Eats app.",`Cal-Eats · ${sender}`].filter((value,index,array)=>value!==""||array[index-1]!=="").join("\n");
  const html=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f3f5f8;color:#192333;font-family:Arial,Helvetica,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border:1px solid #dde4ed;border-radius:14px;overflow:hidden"><tr><td style="background:#121212;padding:22px 28px"><img src="${escape(logo)}" width="210" alt="Cal-Eats" style="display:block;width:210px;max-width:100%;height:auto;border:0"><div style="font-size:11px;letter-spacing:1.5px;color:#abb5c5;margin-top:10px">YOUR CAL-EATS UPDATE</div></td></tr><tr><td style="padding:28px;border-top:4px solid #2563eb"><div style="font-size:12px;color:#2563eb;font-weight:bold">${escape(restaurant)}</div><h1 style="font-size:26px;line-height:1.25;margin:10px 0 16px">${escape(title)}</h1>${preview?`<p style="padding:10px 12px;border-radius:6px;background:#eff6ff;color:#1e40af;font-size:12px">${escape(preview)}</p>`:""}<p style="font-size:14px;line-height:1.7;color:#536172">${escape(payload.summary)}</p><table role="presentation" width="100%" style="background:#f5f7fa;border-radius:8px">${details.map(([key,value])=>`<tr><td style="padding:9px 12px;font-size:12px;color:#64748b;width:38%">${escape(key)}</td><td style="padding:9px 12px;font-size:13px;overflow-wrap:anywhere">${escape(value)}</td></tr>`).join("")}</table>${items.length?`<h2 style="font-size:16px;margin-top:24px">Your order</h2><table role="presentation" width="100%">${items.map(item=>`<tr><td style="padding:10px 0;font-size:14px;border-bottom:1px solid #edf0f5">${item.quantity} × ${escape(item.name)}</td><td align="right" style="padding:10px 0;font-size:14px;border-bottom:1px solid #edf0f5">${money(item.lineTotalMinor)}</td></tr>`).join("")}<tr><td style="padding:16px 0;font-weight:bold">Order total</td><td align="right" style="font-size:20px;font-weight:bold">${money(order.totalMinor)}</td></tr></table>`:""}<p style="margin:26px 0"><a href="${escape(link.href)}" style="display:inline-block;background:#2563eb;color:white;text-decoration:none;font-size:14px;font-weight:bold;border-radius:7px;padding:14px 22px">Open in Cal-Eats</a></p><p style="font-size:12px;color:#64748b;line-height:1.6">Sign in to view messages and personal information securely. Reply inside Cal-Eats so your restaurant or support team receives it.</p></td></tr><tr><td style="padding:20px 28px;background:#f5f7fa;font-size:12px;color:#64748b">Cal-Eats · <a href="mailto:${escape(sender)}" style="color:#2563eb">${escape(sender)}</a></td></tr></table></td></tr></table></body></html>`;
  return{id:row.id,to:row.recipient,from:config.orderAlertEmail.from,subject:`Cal-Eats | ${safe(title,100)}${order?` #${order.reference}`:""}`,text,html,messageId:row.message_id};
}

async function run(db,config,{workerId=randomUUID(),limit=25,adapter,beforeDispatch}={}) {
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new TypeError("Customer email worker limit must be between 1 and 100");
  const result={sent:0,localSaved:0,failed:0,unknown:0,cancelled:0},stamp=config.now().toISOString();
  withTransaction(db,()=>{for(const row of db.prepare("SELECT * FROM customer_transactional_email_outbox WHERE status='claimed' AND lease_expires_at<=?").all(stamp))db.prepare("UPDATE customer_transactional_email_outbox SET status=?,last_error=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND status='claimed' AND lease_expires_at<=?").run(row.dispatch_started_at?"unknown":"pending",row.dispatch_started_at?"EMAIL_LEASE_EXPIRED_AFTER_DISPATCH":"EMAIL_LEASE_RECOVERED_BEFORE_DISPATCH",stamp,row.id,stamp);});
  if(!adapters.has(config))adapters.set(config,createOrderAlertEmailAdapter(config.orderAlertEmail));const sender=adapter??adapters.get(config);
  for(let index=0;index<limit;index++) {
    const row=withTransaction(db,()=>{
      // Preserve insertion order for events sharing the same timestamp (UUIDs are not ordered).
      const candidate=db.prepare("SELECT * FROM customer_transactional_email_outbox WHERE status='pending' ORDER BY queued_at,rowid LIMIT 1").get();if(!candidate)return null;
      const now=config.now().toISOString(),lease=new Date(Date.parse(now)+120000).toISOString();
      return db.prepare("UPDATE customer_transactional_email_outbox SET status='claimed',lease_owner=?,lease_expires_at=?,attempts=attempts+1,updated_at=? WHERE id=? AND status='pending'").run(workerId,lease,now,candidate.id).changes?candidate:null;
    });if(!row)break;
    const stillOwned=()=>Boolean(db.prepare("SELECT 1 FROM customer_transactional_email_outbox WHERE id=? AND status='claimed' AND lease_owner=? AND lease_expires_at>?").get(row.id,workerId,config.now().toISOString()));
    const cancel=code=>db.prepare("UPDATE customer_transactional_email_outbox SET status='cancelled',last_error=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND status='claimed' AND lease_owner=? AND dispatch_started_at IS NULL").run(code,config.now().toISOString(),row.id,workerId);
    const beforeSend=()=>withTransaction(db,()=>{if(!stillOwned())return false;const source=sourceIsCurrent(db,row,config);if(!source.ok){cancel(source.code);return false;}const now=config.now().toISOString();return db.prepare("UPDATE customer_transactional_email_outbox SET dispatch_started_at=COALESCE(dispatch_started_at,?),updated_at=? WHERE id=? AND status='claimed' AND lease_owner=? AND lease_expires_at>?").run(now,now,row.id,workerId,now).changes===1;});
    let outcome;
    try {
      await beforeDispatch?.(row);if(!stillOwned())continue;
      const valid=sourceIsCurrent(db,row,config);if(!valid.ok){cancel(valid.code);result.cancelled++;continue;}
      outcome=await sender(buildCustomerEmail(row,config),{beforeSend});
    }catch{outcome={status:db.prepare("SELECT dispatch_started_at FROM customer_transactional_email_outbox WHERE id=?").get(row.id)?.dispatch_started_at?"unknown":"failed",errorCode:"CUSTOMER_EMAIL_ADAPTER_ERROR"};}
    const status=["sent","local_saved","failed","unknown","cancelled"].includes(outcome?.status)?outcome.status:"unknown",now=config.now().toISOString(),code=typeof outcome?.errorCode==="string"&&/^[A-Z0-9_]{1,80}$/.test(outcome.errorCode)?outcome.errorCode:status==="unknown"?"EMAIL_OUTCOME_UNKNOWN":null;
    const saved=withTransaction(db,()=>db.prepare("UPDATE customer_transactional_email_outbox SET status=?,last_error=?,sent_at=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND status='claimed' AND lease_owner=? AND lease_expires_at>?").run(status,code,["sent","local_saved"].includes(status)?now:null,now,row.id,workerId,now));if(saved.changes)result[status==="local_saved"?"localSaved":status]++;
  }
  return result;
}

export function runCustomerTransactionalEmails(db,config,options) {
  if(workers.has(db))return workers.get(db);const work=run(db,config,options).finally(()=>workers.delete(db));workers.set(db,work);return work;
}

export async function routeCustomerTransactionalEmails({req,res,url,db,config,session}) {
  if(req.method!=="GET"||url.pathname!=="/api/admin/customer-emails")return false;requireRole(session,"admin");
  const page=Number(url.searchParams.get("page")??1),pageSize=Number(url.searchParams.get("pageSize")??25);if(!Number.isSafeInteger(page)||page<1||page>100000||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100)throw new HttpError(400,"VALIDATION_ERROR","Email pagination is invalid");
  const total=db.prepare("SELECT COUNT(*) n FROM customer_transactional_email_outbox").get().n,rows=db.prepare("SELECT * FROM customer_transactional_email_outbox ORDER BY queued_at DESC,id DESC LIMIT ? OFFSET ?").all(pageSize,(page-1)*pageSize),summary=Object.fromEntries(db.prepare("SELECT status,COUNT(*) n FROM customer_transactional_email_outbox GROUP BY status").all().map(row=>[row.status,row.n]));
  return sendJson(res,200,{data:{items:rows.map(row=>({id:row.id,customerId:row.customer_id,kind:row.event_kind,orderId:row.order_id,restaurantId:row.restaurant_id,conversationId:row.conversation_id,supportCaseId:row.support_case_id,status:row.status,mode:row.mode,attempts:row.attempts,errorCode:row.last_error,recipientMasked:row.recipient.replace(/^([^@])[^@]*(@.+)$/,"$1***$2"),queuedAt:row.queued_at,sentAt:row.sent_at,updatedAt:row.updated_at})),pagination:{page,pageSize,total,totalPages:Math.ceil(total/pageSize),hasNext:page*pageSize<total,hasPrevious:page>1},summary,email:orderAlertEmailTransportReadiness(config.orderAlertEmail)}});
}
