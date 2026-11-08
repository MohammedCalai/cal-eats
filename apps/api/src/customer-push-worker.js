import {randomUUID} from "node:crypto";
import {withTransaction} from "./db/index.js";
import {notificationRecipientAllowed} from "./notification-stream.js";
import {supportEmailSource} from "./support-email-source.js";
import {customerAndroidPushChannel,decryptCustomerPushToken,LEGACY_CUSTOMER_ANDROID_CHANNEL,revokeCustomerPushDevice} from "./customer-push.js";
import {createExpoPushAdapter} from "./expo-push-adapter.js";

const workers=new WeakMap(),adapters=new WeakMap(),LEASE_MS=30000,MAX_ATTEMPTS=5;
const updates=new Set(['order_status','order_eta','order_expired','order_refund']);
const safeCode=code=>typeof code==='string'&&/^[A-Z0-9_]{1,80}$/.test(code)?code:'PUSH_OUTCOME_UNKNOWN';

function source(db,config,row,stamp){
  const device=db.prepare("SELECT d.* FROM customer_push_devices d JOIN native_sessions s ON s.id=d.session_id AND s.user_id=d.user_id JOIN users u ON u.id=d.user_id WHERE d.id=? AND d.generation=? AND d.user_id=? AND d.revoked_at IS NULL AND d.expires_at>? AND s.revoked_at IS NULL AND s.expires_at>? AND u.account_enabled=1 AND u.role='customer'").get(row.device_id,row.generation,row.user_id,stamp,stamp);
  const n=db.prepare("SELECT rowid AS notification_sequence,* FROM user_notifications WHERE id=? AND user_id=? AND read_at IS NULL").get(row.notification_id,row.user_id);
  if(!device||!n||row.expires_at<=stamp||!notificationRecipientAllowed(db,n))return {failure:'PUSH_SOURCE_UNAVAILABLE'};
  const projects=device.platform==='ios'?config.customerPush.iosProjectIds:config.customerPush.androidProjectIds;
  if(!projects.includes(device.project_id))return {failure:'PUSH_PROJECT_CHANGED'};
  let kind='account',title='Cal-Eats',body='You have a new update. Open Cal-Eats to view it.',expiresAt=row.expires_at;
  const order=n.order_id?db.prepare('SELECT * FROM orders WHERE id=? AND customer_id=?').get(n.order_id,n.user_id):null;
  if(n.order_id&&!order)return {failure:'PUSH_ORDER_OWNER_CHANGED'};
  if(updates.has(n.type)){
    if(!order)return {failure:'PUSH_ORDER_UNAVAILABLE'};
    if(n.type==='order_status'&&n.event_key.split(':')[2]!==order.status)return {failure:'PUSH_ORDER_STATUS_SUPERSEDED'};
    if(db.prepare("SELECT 1 FROM user_notifications WHERE user_id=? AND order_id=? AND type IN ('order_status','order_eta','order_expired','order_refund') AND rowid>? LIMIT 1").get(n.user_id,order.id,n.notification_sequence))return {failure:'PUSH_ORDER_UPDATE_SUPERSEDED'};
    kind='order';title='Order update';body='Open Cal-Eats for the latest progress on your order.';
  }else if(n.type==='order_message'){
    const message=order&&db.prepare("SELECT m.* FROM order_messages m JOIN users u ON u.id=m.sender_user_id AND u.account_enabled=1 JOIN restaurant_memberships rm ON rm.user_id=m.sender_user_id AND rm.restaurant_id=? WHERE m.id=? AND m.order_id=? AND m.sender_role='restaurant' AND m.expires_at>?").get(order.restaurant_id,n.event_key.split(':')[1],order.id,stamp);
    if(!message)return {failure:'PUSH_MESSAGE_UNAVAILABLE'};
    const read=db.prepare('SELECT * FROM order_message_reads WHERE order_id=? AND user_id=?').get(order.id,n.user_id);
    if(read&&(message.created_at<read.last_read_created_at||message.created_at===read.last_read_created_at&&message.id<=read.last_read_message_id))return {failure:'PUSH_MESSAGE_ALREADY_READ'};
    if(['completed','rejected'].includes(order.status)){
      const terminal=db.prepare("SELECT created_at FROM order_events WHERE order_id=? AND to_status IN ('completed','rejected') ORDER BY rowid DESC LIMIT 1").get(order.id)?.created_at??order.updated_at,minutes=db.prepare('SELECT support_window_minutes FROM order_message_settings WHERE restaurant_id=?').get(order.restaurant_id)?.support_window_minutes??(config.messagingSupportHours??2)*60;
      if(Date.parse(stamp)>=Date.parse(terminal)+minutes*60000)return {failure:'PUSH_MESSAGE_WINDOW_CLOSED'};
      const windowEnd=new Date(Date.parse(terminal)+minutes*60000).toISOString();if(windowEnd<expiresAt)expiresAt=windowEnd;
    }
    kind='order';title='New restaurant message';body='Open Cal-Eats to read and reply securely.';expiresAt=message.expires_at<expiresAt?message.expires_at:expiresAt;
  }else if(n.type==='customer_message'){
    const message=db.prepare("SELECT m.*,t.restaurant_id FROM restaurant_customer_messages m JOIN restaurant_customer_threads t ON t.id=m.thread_id AND t.customer_id=? JOIN users u ON u.id=m.sender_user_id AND u.account_enabled=1 JOIN restaurant_memberships rm ON rm.user_id=m.sender_user_id AND rm.restaurant_id=t.restaurant_id AND rm.permission='owner' LEFT JOIN restaurant_customer_message_reads r ON r.thread_id=t.id AND r.user_id=? WHERE m.id=? AND m.thread_id=? AND m.sender_role='restaurant' AND m.expires_at>? AND m.ingest_sequence>COALESCE(r.last_read_sequence,0)").get(n.user_id,n.user_id,n.event_key.split(':')[1],n.conversation_id,stamp);
    if(!message)return {failure:'PUSH_CONVERSATION_UNAVAILABLE'};
    kind='conversation';title='New restaurant message';body='Open Cal-Eats to read and reply securely.';expiresAt=message.expires_at<expiresAt?message.expires_at:expiresAt;
  }else if(n.type.startsWith('support_')){
    const help=supportEmailSource(db,n);if(!help||help.user.role!=='customer')return {failure:'PUSH_SUPPORT_UNAVAILABLE'};
    if(db.prepare("SELECT 1 FROM user_notifications WHERE user_id=? AND support_case_id=? AND type IN ('support_request','support_receipt','support_reply','support_status') AND rowid>? LIMIT 1").get(n.user_id,n.support_case_id,n.notification_sequence))return {failure:'PUSH_SUPPORT_UPDATE_SUPERSEDED'};
    kind='support';title='Support update';body='Open Cal-Eats to view your support conversation.';
  }else if(n.type==='offer'){
    if(!db.prepare('SELECT 1 FROM marketing_preferences WHERE user_id=? AND in_app_promotions=1 AND push_promotions=1').get(n.user_id))return {failure:'PUSH_MARKETING_CONSENT_OFF'};
    const offer=db.prepare("SELECT c.expires_at,COALESCE(c.starts_at,c.created_at) starts_at FROM offer_grants g JOIN offer_campaigns c ON c.id=g.campaign_id JOIN restaurants r ON r.id=g.restaurant_id AND r.archived_at IS NULL WHERE g.id=? AND g.customer_id=? AND g.restaurant_id=? AND g.status='available' AND g.dismissed_at IS NULL AND c.expires_at>?").get(n.offer_id,n.user_id,n.restaurant_id,stamp);
    if(!offer)return {failure:'PUSH_OFFER_UNAVAILABLE'};
    if(offer.starts_at>stamp)return {deferUntil:offer.starts_at,expiresAt:offer.expires_at<new Date(Date.parse(offer.starts_at)+24*3600000).toISOString()?offer.expires_at:new Date(Date.parse(offer.starts_at)+24*3600000).toISOString()};
    kind='offers';title='A new offer for you';body='Open Cal-Eats to view your offer.';expiresAt=offer.expires_at<expiresAt?offer.expires_at:expiresAt;
  }else if(n.type==='platform_voucher'){
    const voucher=db.prepare("SELECT v.expires_at FROM platform_vouchers v WHERE v.id=? AND v.customer_id=? AND v.revoked_at IS NULL AND v.expires_at>? AND v.amount_minor>COALESCE((SELECT SUM(r.amount_minor) FROM platform_voucher_redemptions r WHERE r.voucher_id=v.id AND r.status IN ('reserved','redeemed')),0)").get(n.event_key.split(':')[1],n.user_id,stamp);
    if(!voucher)return {failure:'PUSH_VOUCHER_UNAVAILABLE'};
    kind='offers';title='A Cal-Eats voucher for you';body='Open Cal-Eats to view your account credit.';expiresAt=voucher.expires_at<expiresAt?voucher.expires_at:expiresAt;
  }else if(n.type==='shop_rating'){
    if(!order||order.status!=='completed'||db.prepare('SELECT 1 FROM restaurant_order_ratings WHERE order_id=?').get(order.id))return {failure:'PUSH_RATING_UNAVAILABLE'};
    kind='order';title='How was your order?';body='Open Cal-Eats to leave a quick shop rating.';
  }else return {failure:'PUSH_UNSUPPORTED_NOTIFICATION'};
  const data={notificationId:n.id,recipientUserId:n.user_id,kind,...(kind==='order'&&order?{orderId:order.id}:{}),...(kind==='conversation'?{conversationId:n.conversation_id}:{}),...(kind==='support'?{supportCaseId:n.support_case_id}:{}),...(n.type==='offer'?{offerId:n.offer_id}:{})};
  const ttl=Math.min(900,Math.floor((Date.parse(expiresAt)-Date.parse(stamp))/1000));if(ttl<1)return {failure:'PUSH_SOURCE_EXPIRED'};
  // Customer updates are always silent, including registrations from older apps
  // and legacy stored preferences. Business/tablet alerts use a separate path.
  return {device,payload:{title,body,data,ttl,priority:'high',channelId:customerAndroidPushChannel(device)??LEGACY_CUSTOMER_ANDROID_CHANNEL,collapseId:n.id,tag:n.id},notification:n};
}

async function run(db,config,{workerId=randomUUID(),limit=25,adapter,beforeDispatch}={}){
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new TypeError('Push worker limit must be 1–100');
  const result={accepted:0,receiptConfirmed:0,failed:0,unknown:0,cancelled:0,deferred:0};
  if(config.runMode!=='hosted-preview'&&!adapter)return {...result,disabled:true};
  const stamp=config.now().toISOString();
  withTransaction(db,()=>{
    db.prepare("UPDATE customer_push_devices SET revoked_at=?,ciphertext=NULL,nonce=NULL,auth_tag=NULL,updated_at=? WHERE revoked_at IS NULL AND (expires_at<=? OR NOT EXISTS(SELECT 1 FROM native_sessions s JOIN users u ON u.id=s.user_id WHERE s.id=customer_push_devices.session_id AND s.user_id=customer_push_devices.user_id AND s.revoked_at IS NULL AND s.expires_at>? AND u.account_enabled=1 AND u.role='customer'))").run(stamp,stamp,stamp,stamp);
    db.prepare("UPDATE customer_push_outbox SET status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,available_at=CASE WHEN attempts<5 THEN ? ELSE NULL END,last_error='PUSH_LEASE_RECOVERED_RETRY',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE status='claimed' AND lease_expires_at<=?").run(new Date(Date.parse(stamp)+60000).toISOString(),stamp,stamp);
    result.cancelled+=db.prepare("UPDATE customer_push_outbox SET status='cancelled',available_at=NULL,last_error='PUSH_NOTIFICATION_EXPIRED',updated_at=? WHERE status IN ('pending','failed') AND expires_at<=?").run(stamp,stamp).changes;
  });
  if(!adapters.has(config))adapters.set(config,adapter??createExpoPushAdapter(config.customerPush));const transport=adapter??adapters.get(config);
  for(const row of db.prepare("SELECT * FROM customer_push_outbox WHERE status='accepted' AND ticket_id IS NOT NULL AND receipt_due_at<=? ORDER BY receipt_due_at LIMIT ?").all(stamp,limit)){
    let receipt;try{receipt=await transport.receipt(row.ticket_id);}catch{receipt={status:'pending'};}
    const now=config.now().toISOString(),attempt=row.receipt_attempts+1;
    if(receipt.status==='invalid_device')revokeCustomerPushDevice(db,row.device_id,now,row.generation);
    const status=receipt.status==='receipt_confirmed'?'receipt_confirmed':['invalid_device','failed'].includes(receipt.status)?'failed':'accepted',retry=status==='accepted'&&attempt<8&&Date.parse(now)-Date.parse(row.accepted_at)<24*3600000;
    const saved=db.prepare("UPDATE customer_push_outbox SET status=?,receipt_attempts=?,receipt_due_at=?,last_error=?,updated_at=? WHERE id=? AND status='accepted'").run(status,attempt,retry?new Date(Date.parse(now)+15*60000).toISOString():null,status==='receipt_confirmed'?null:safeCode(receipt.errorCode??'PUSH_RECEIPT_PENDING'),now,row.id);if(saved.changes&&status==='receipt_confirmed')result.receiptConfirmed++;
  }
  for(let index=0;index<limit;index++){
    const row=withTransaction(db,()=>{const now=config.now().toISOString(),candidate=db.prepare("SELECT * FROM customer_push_outbox WHERE status IN ('pending','failed') AND attempts<5 AND available_at<=? ORDER BY available_at,rowid LIMIT 1").get(now);if(!candidate)return null;
      const saved=db.prepare("UPDATE customer_push_outbox SET status='claimed',attempts=attempts+1,lease_owner=?,lease_expires_at=?,dispatch_started_at=NULL,updated_at=? WHERE id=? AND status IN ('pending','failed') AND available_at<=?").run(workerId,new Date(Date.parse(now)+LEASE_MS).toISOString(),now,candidate.id,now);return saved.changes?{...candidate,attempts:candidate.attempts+1}:null;});if(!row)break;
    const owned=()=>Boolean(db.prepare("SELECT 1 FROM customer_push_outbox WHERE id=? AND status='claimed' AND lease_owner=? AND lease_expires_at>?").get(row.id,workerId,config.now().toISOString()));
    let dispatchDeferral=null;
    const beforeSend=()=>withTransaction(db,()=>{if(!owned())return false;const now=config.now().toISOString(),latest=source(db,config,row,now);if(latest.failure)return false;if(latest.deferUntil){dispatchDeferral=latest;return false;}return db.prepare("UPDATE customer_push_outbox SET dispatch_started_at=?,updated_at=? WHERE id=? AND status='claimed' AND lease_owner=? AND dispatch_started_at IS NULL AND lease_expires_at>?").run(now,now,row.id,workerId,now).changes===1;});
    let outcome;
    try{await beforeDispatch?.(row);if(!owned())continue;const current=source(db,config,row,config.now().toISOString());outcome=current.deferUntil?{status:'deferred',...current}:current.failure?{status:'cancelled',errorCode:current.failure}:await transport.send({...current.payload,to:decryptCustomerPushToken(config,current.device)},{beforeSend});if(outcome?.status==='cancelled'&&dispatchDeferral)outcome={status:'deferred',...dispatchDeferral};}
    catch{outcome={status:'retry',errorCode:'PUSH_DISPATCH_ERROR'};}
    const now=config.now().toISOString();if(outcome?.status==='invalid_device')revokeCustomerPushDevice(db,row.device_id,now,row.generation);
    let status=outcome?.status==='deferred'?'pending':outcome?.status==='accepted'?'accepted':outcome?.status==='cancelled'?'cancelled':['retry','failed','invalid_device'].includes(outcome?.status)?'failed':'unknown';
    if(status==='accepted'&&(!/^[A-Za-z0-9_-]{8,150}$/.test(outcome.ticketId??'')||!db.prepare('SELECT dispatch_started_at FROM customer_push_outbox WHERE id=?').get(row.id)?.dispatch_started_at))status='unknown';
    const retry=outcome?.status==='retry'&&row.attempts<MAX_ATTEMPTS;
    const saved=db.prepare("UPDATE customer_push_outbox SET status=?,available_at=?,expires_at=COALESCE(?,expires_at),attempts=MAX(0,attempts-?),ticket_id=?,accepted_at=?,receipt_due_at=?,last_error=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND status='claimed' AND lease_owner=? AND lease_expires_at>?").run(status,status==='pending'?outcome.deferUntil:retry?new Date(Date.parse(now)+Math.min(3600000,60000*2**(row.attempts-1))).toISOString():null,status==='pending'?outcome.expiresAt:null,status==='pending'?1:0,status==='accepted'?outcome.ticketId:null,status==='accepted'?now:null,status==='accepted'?new Date(Date.parse(now)+15*60000).toISOString():null,status==='accepted'?null:status==='pending'?'PUSH_OFFER_SCHEDULED':safeCode(outcome?.errorCode),now,row.id,workerId,now);
    if(saved.changes)result[status==='pending'?'deferred':status]++;
  }
  return result;
}

export function runCustomerPushWorker(db,config,options){if(workers.has(db))return workers.get(db);const work=run(db,config,options).finally(()=>workers.delete(db));workers.set(db,work);return work;}
