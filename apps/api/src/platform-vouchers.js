import { createHash, randomUUID } from "node:crypto";
import { requireRole } from "./auth/authorization.js";
import { withTransaction } from "./db/index.js";
import { HttpError, exactObject, readJson, sendJson } from "./http.js";
import { addNotification } from "./offers.js";

const fail = (status, code, message) => { throw new HttpError(status, code, message); };
const clean = (value, min, max, label) => { const result=typeof value==="string"?value.trim():"";if(result.length<min||result.length>max)fail(400,"VALIDATION_ERROR",`${label} is invalid`);return result; };
const stamp = config => config.now().toISOString();
const balanceSql = `SELECT v.*,COALESCE((SELECT SUM(r.amount_minor) FROM platform_voucher_redemptions r WHERE r.voucher_id=v.id AND r.status IN ('reserved','redeemed')),0) committed_minor FROM platform_vouchers v`;
export const customerPayableMinor = order => order.customer_payable_minor ?? order.total_minor;
export const platformVoucherMinor = order => order.platform_voucher_minor ?? 0;
export const fullyVoucherFunded = order => order.payment_method === "voucher" && customerPayableMinor(order)===0 && platformVoucherMinor(order)===order.total_minor && order.total_minor>0;
function voucherDto(row, now) { const remaining=Math.max(0,row.amount_minor-row.committed_minor);return {id:row.id,title:row.title,message:row.message,amountMinor:row.amount_minor,remainingMinor:remaining,status:row.revoked_at?"revoked":row.expires_at<=now?"expired":remaining?"available":"used",expiresAt:row.expires_at,createdAt:row.created_at,...(row.issued_by_user_id?{issuedByUserId:row.issued_by_user_id}:{})}; }
function audit(db,user,action,id,details,now){db.prepare("INSERT INTO governance_audit VALUES(?,?,?,?,?,?,?)").run(randomUUID(),user.id,action,"platform_voucher",id,JSON.stringify(details),now);}
function requestKey(req){return clean(req.headers["idempotency-key"],8,255,"Idempotency-Key");}

/** Price a single platform-funded voucher without reserving money. Cash is excluded;
 * fully covered orders use the internal voucher method and never create a charge. */
export function quotePlatformVoucher(db,{customerId,totalMinor,now,voucherId=null,automatic=false,paymentMethod=null}) {
  if(voucherId!==null&&typeof voucherId!=="string")fail(400,"VALIDATION_ERROR","Voucher is invalid");
  if(!voucherId&&!automatic)return {voucherId:null,platformVoucherMinor:0,customerPayableMinor:totalMinor,orderValueMinor:totalMinor,voucher:null};
  const rows=db.prepare(`${balanceSql} WHERE v.customer_id=? AND v.revoked_at IS NULL AND v.expires_at>?${voucherId?" AND v.id=?":""} AND v.amount_minor>COALESCE((SELECT SUM(x.amount_minor) FROM platform_voucher_redemptions x WHERE x.voucher_id=v.id AND x.status IN ('reserved','redeemed')),0) ORDER BY v.expires_at,v.created_at,v.id LIMIT 100`).all(...[customerId,now,...(voucherId?[voucherId]:[])]);
  let choice=null;
  for(const row of rows){let applied=Math.min(totalMinor,Math.max(0,row.amount_minor-row.committed_minor));if(paymentMethod==="cash"&&applied<totalMinor)applied=0;if((paymentMethod==="card"||paymentMethod===null)&&applied<totalMinor&&totalMinor-applied<30)applied=Math.max(0,totalMinor-30);if(applied>0&&(!choice||applied>choice.amount))choice={row,amount:applied};}
  if(voucherId&&!choice)fail(409,"VOUCHER_UNAVAILABLE","This voucher is unavailable for this order. Your total will be checked again.");
  return {voucherId:choice?.row.id??null,platformVoucherMinor:choice?.amount??0,customerPayableMinor:totalMinor-(choice?.amount??0),orderValueMinor:totalMinor,voucher:choice?{id:choice.row.id,title:choice.row.title,expiresAt:choice.row.expires_at,fundingParty:"platform",amountMinor:choice.amount,remainingAfterOrderMinor:choice.row.amount_minor-choice.row.committed_minor-choice.amount,retainedForMinimumPaymentMinor:Math.min(totalMinor,choice.row.amount_minor-choice.row.committed_minor)-choice.amount}:null};
}

export function reservePlatformVoucher(db,order,quote,now) {
  if(!quote.voucherId||!quote.platformVoucherMinor)return;
  // Caller holds BEGIN IMMEDIATE. Recheck the balance under that same lock.
  const row=db.prepare(`${balanceSql} WHERE v.id=? AND v.customer_id=? AND v.revoked_at IS NULL AND v.expires_at>?`).get(quote.voucherId,order.customer_id,now);
  if(!row||row.amount_minor-row.committed_minor<quote.platformVoucherMinor)fail(409,"VOUCHER_UNAVAILABLE","This voucher is already being used by another order.");
  db.prepare("INSERT INTO platform_voucher_redemptions(order_id,voucher_id,customer_id,restaurant_id,amount_minor,status,created_at,updated_at) VALUES(?,?,?,?,?,'reserved',?,?)").run(order.id,row.id,order.customer_id,order.restaurant_id,quote.platformVoucherMinor,now,now);
}
export function releasePlatformVoucher(db,order,now) {db.prepare("UPDATE platform_voucher_redemptions SET status='released',updated_at=? WHERE order_id=? AND status='reserved'").run(now,order.id);}
export function redeemPlatformVoucher(db,order,now) {
  if(!platformVoucherMinor(order))return;
  const redemption=db.prepare("SELECT * FROM platform_voucher_redemptions WHERE order_id=?").get(order.id);
  if(!redemption||!["reserved","redeemed"].includes(redemption.status)||redemption.amount_minor!==order.platform_voucher_minor||redemption.customer_id!==order.customer_id||redemption.restaurant_id!==order.restaurant_id)fail(409,"VOUCHER_BINDING_MISMATCH","The voucher funding for this order needs review.");
  db.prepare("UPDATE platform_voucher_redemptions SET status='redeemed',updated_at=? WHERE order_id=? AND status='reserved'").run(now,order.id);
}
export function voucherProviderBinding(order,config){try{const snapshot=JSON.parse(order.platform_voucher_snapshot);return snapshot.providerMode===config.paymentProviderMode&&(snapshot.platformAccountId??null)===(config.stripePlatformAccountId??null);}catch{return false;}}
export function assertVoucherFunding(db,order) {let snapshot;try{snapshot=JSON.parse(order.platform_voucher_snapshot);}catch{return false;}const row=db.prepare("SELECT * FROM platform_voucher_redemptions WHERE order_id=? AND status='redeemed'").get(order.id);return Boolean(row&&snapshot?.id===row.voucher_id&&snapshot?.amountMinor===row.amount_minor&&snapshot?.fundingParty==="platform"&&row.customer_id===order.customer_id&&row.restaurant_id===order.restaurant_id&&row.amount_minor===platformVoucherMinor(order)&&customerPayableMinor(order)+row.amount_minor===order.total_minor);}

export async function routePlatformVouchers({req,res,url,db,config,session}) {
  if(url.pathname==="/api/account/vouchers"&&req.method==="GET"){const user=requireRole(session,"customer");const now=stamp(config);return sendJson(res,200,{data:db.prepare(`${balanceSql} WHERE v.customer_id=? ORDER BY v.created_at DESC,v.id DESC LIMIT 100`).all(user.id).map(row=>voucherDto(row,now))});}
  if(url.pathname==="/api/admin/voucher-customers"&&req.method==="GET"){
    requireRole(session,"admin");const q=(url.searchParams.get("q")||"").trim(),page=Number(url.searchParams.get("page")||1),size=Number(url.searchParams.get("pageSize")||25);if(q.length>160||!Number.isSafeInteger(page)||page<1||page>1000000||![10,25,50].includes(size))fail(400,"VALIDATION_ERROR","Customer search is invalid");
    const pattern=`%${q.replace(/[\\%_]/g,"\\$&")}%`,filter="u.role='customer' AND (?='' OR u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR u.phone LIKE ? ESCAPE '\\')",args=[q,pattern,pattern,pattern];const total=db.prepare(`SELECT COUNT(*) n FROM users u WHERE ${filter}`).get(...args).n;
    const items=db.prepare(`SELECT u.id,u.name,u.email,u.phone,u.created_at,u.account_enabled,(SELECT COUNT(*) FROM orders o WHERE o.customer_id=u.id) order_count,(SELECT MAX(created_at) FROM orders o WHERE o.customer_id=u.id) last_order_at FROM users u WHERE ${filter} ORDER BY u.created_at DESC,u.id DESC LIMIT ? OFFSET ?`).all(...args,size,(page-1)*size).map(row=>({id:row.id,name:row.name,email:row.email,phone:row.phone,enabled:Boolean(row.account_enabled),createdAt:row.created_at,orderCount:row.order_count,lastOrderAt:row.last_order_at}));return sendJson(res,200,{data:{items,total,page,pageSize:size,totalPages:Math.ceil(total/size)}});
  }
  let match=url.pathname.match(/^\/api\/admin\/customers\/([^/]+)\/vouchers$/);
  if(match){const user=requireRole(session,"admin"),customer=db.prepare("SELECT id,name,email,phone,account_enabled FROM users WHERE id=? AND role='customer'").get(match[1]);if(!customer)fail(404,"NOT_FOUND","Customer not found");const now=stamp(config);
    if(req.method==="GET"){const vouchers=db.prepare(`${balanceSql} WHERE v.customer_id=? ORDER BY v.created_at DESC,v.id DESC LIMIT 100`).all(customer.id).map(row=>({...voucherDto(row,now),reason:row.reason,redemptions:db.prepare("SELECT r.order_id,r.amount_minor,r.status,r.created_at,r.updated_at,o.restaurant_name FROM platform_voucher_redemptions r JOIN orders o ON o.id=r.order_id WHERE r.voucher_id=? ORDER BY r.created_at DESC LIMIT 50").all(row.id).map(r=>({orderId:r.order_id,restaurantName:r.restaurant_name,amountMinor:r.amount_minor,status:r.status,createdAt:r.created_at,updatedAt:r.updated_at}))}));return sendJson(res,200,{data:{customer:{id:customer.id,name:customer.name,email:customer.email,phone:customer.phone,enabled:Boolean(customer.account_enabled)},vouchers}});}
    if(req.method==="POST"){
      const body=await readJson(req,config.bodyLimit);exactObject(body,["title","amountMinor","expiresAt","message","reason"]);const title=clean(body.title,1,100,"Voucher title"),message=clean(body.message??"",0,500,"Message"),reason=clean(body.reason,5,500,"Reason"),amount=body.amountMinor,date=new Date(body.expiresAt);if(!Number.isSafeInteger(amount)||amount<50||amount>100000||typeof body.expiresAt!=="string"||!Number.isFinite(+date)||+date<=Date.parse(now)||+date>Date.parse(now)+366*86400000)fail(400,"VALIDATION_ERROR","Use an amount from £0.50 to £1,000 and an expiry within one year");const expires=date.toISOString(),key=requestKey(req),hash=createHash("sha256").update(JSON.stringify({customerId:customer.id,title,message,reason,amount,expires})).digest("hex");
      const outcome=withTransaction(db,()=>{const prior=db.prepare("SELECT * FROM platform_vouchers WHERE issued_by_user_id=? AND idempotency_key=?").get(user.id,key);if(prior){if(prior.request_hash!==hash)fail(409,"IDEMPOTENCY_CONFLICT","This request key was used for a different voucher");return {id:prior.id,replay:true};}if(!db.prepare("SELECT account_enabled FROM users WHERE id=?").get(customer.id)?.account_enabled)fail(409,"ACCOUNT_DISABLED","Enable this customer before issuing a voucher");const id=randomUUID();db.prepare("INSERT INTO platform_vouchers VALUES(?,?,?,?,?,?,?,?,?,?,NULL,NULL,?,?)").run(id,customer.id,title,message,amount,expires,user.id,reason,key,hash,now,now);audit(db,user,"platform_voucher_issued",id,{customerId:customer.id,amountMinor:amount,expiresAt:expires,reason},now);addNotification(db,{userId:customer.id,type:"platform_voucher",title:"A Cal-Eats voucher for you",message:`${title} · £${(amount/100).toFixed(2)}${message?` · ${message}`:""}`,eventKey:`platform-voucher:${id}:issued`,now});return{id,replay:false};});return sendJson(res,outcome.replay?200:201,{data:{...voucherDto(db.prepare(`${balanceSql} WHERE v.id=?`).get(outcome.id),now),replay:outcome.replay}});
    }
  }
  match=url.pathname.match(/^\/api\/admin\/vouchers\/([^/]+)$/);
  if(match&&req.method==="PATCH"){const user=requireRole(session,"admin"),body=await readJson(req,config.bodyLimit);exactObject(body,["action","reason"]);if(body.action!=="revoke")fail(400,"VALIDATION_ERROR","Voucher action is invalid");const reason=clean(body.reason,5,500,"Reason"),now=stamp(config);const row=withTransaction(db,()=>{const found=db.prepare(`${balanceSql} WHERE v.id=?`).get(match[1]);if(!found)fail(404,"NOT_FOUND","Voucher not found");if(!found.revoked_at){db.prepare("UPDATE platform_vouchers SET revoked_at=?,revoked_reason=?,updated_at=? WHERE id=?").run(now,reason,now,found.id);audit(db,user,"platform_voucher_revoked",found.id,{reason,unspentMinor:found.amount_minor-found.committed_minor},now);}return db.prepare(`${balanceSql} WHERE v.id=?`).get(found.id);});return sendJson(res,200,{data:voucherDto(row,now)});}
  return false;
}
