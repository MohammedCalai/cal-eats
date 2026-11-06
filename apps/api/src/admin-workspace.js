import { requireRole } from "./auth/authorization.js";
import { HttpError, sendJson } from "./http.js";
import { orderConfirmationDto, PAYABLE_ORDER_SQL } from "./order-confirmation.js";
import { parseLondonDateRange } from "./marketplace-reporting.js";
import { routeAdminFinanceWorkspace } from "./admin-finance-workspace.js";
import { orderDto } from "./journey.js";
import { buildOrderFinancialBreakdown } from "./finance-details.js";
import { verifiedLoginClosure } from "./account-closure.js";

function pagination(url, maximum = 50) {
  const pageText = url.searchParams.get("page") ?? "1", sizeText = url.searchParams.get("pageSize") ?? "25";
  const page = Number(pageText), pageSize = Number(sizeText);
  if (!/^[1-9][0-9]*$/.test(pageText) || !/^[1-9][0-9]*$/.test(sizeText) || !Number.isSafeInteger(page) || page > 100000 || !Number.isSafeInteger(pageSize) || pageSize > maximum) throw new HttpError(400, "VALIDATION_ERROR", "Page and page size are invalid");
  return { page, pageSize, offset: (page - 1) * pageSize };
}
function result(items, total, {page,pageSize}) { return {items,pagination:{page,pageSize,total,totalPages:Math.ceil(total/pageSize),hasPrevious:page>1,hasNext:page*pageSize<total}}; }
function search(url) { const q = (url.searchParams.get("q") ?? "").trim(); if (q.length > 100) throw new HttpError(400,"VALIDATION_ERROR","Search must be at most 100 characters"); return q; }
const escapeLike = value => value.replace(/[\\%_]/g,"\\$&");
const parsed = value => { try { return JSON.parse(value || "{}"); } catch { return {}; } };

export function adminUnconfirmedOrders(db, url, now) {
  const paging = pagination(url), q = search(url), state = url.searchParams.get("state") || "all";
  if (!["all","confirmation","overdue","payment"].includes(state)) throw new HttpError(400,"VALIDATION_ERROR","Confirmation filter is invalid");
  const base = "o.status='placed' AND o.confirmed_at IS NULL AND r.archived_at IS NULL", args = [], where = [base];
  if (state === "confirmation") where.push(PAYABLE_ORDER_SQL);
  if (state === "payment") where.push(`NOT ${PAYABLE_ORDER_SQL}`);
  if (state === "overdue") { where.push(PAYABLE_ORDER_SQL, "o.confirmation_due_at<=?"); args.push(now.toISOString()); }
  if (q) { where.push("(r.name LIKE ? ESCAPE '\\' OR o.id LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\')"); args.push(...Array(3).fill(`%${escapeLike(q)}%`)); }
  const clause = where.join(" AND "), joins = "FROM orders o JOIN restaurants r ON r.id=o.restaurant_id JOIN users u ON u.id=o.customer_id";
  const totals = db.prepare(`SELECT COUNT(*) total,COALESCE(SUM(CASE WHEN ${PAYABLE_ORDER_SQL} THEN 1 ELSE 0 END),0) confirmation,COALESCE(SUM(CASE WHEN ${PAYABLE_ORDER_SQL} AND o.confirmation_due_at<=? THEN 1 ELSE 0 END),0) overdue ${joins} WHERE ${base}`).get(now.toISOString());
  const total = db.prepare(`SELECT COUNT(*) n ${joins} WHERE ${clause}`).get(...args).n;
  const rows = db.prepare(`SELECT o.*,r.name current_restaurant_name,r.phone restaurant_phone,u.name customer_name ${joins} WHERE ${clause} ORDER BY CASE WHEN ${PAYABLE_ORDER_SQL} THEN 0 ELSE 1 END,o.merchant_visible_at,o.created_at,o.id LIMIT ? OFFSET ?`).all(...args,paging.pageSize,paging.offset);
  return {...result(rows.map(row => ({id:row.id,reference:row.id.slice(0,8).toUpperCase(),restaurantId:row.restaurant_id,restaurantName:row.current_restaurant_name,restaurantPhone:row.restaurant_phone,customerName:row.customer_name,fulfillment:row.fulfillment,totalMinor:row.total_minor,createdAt:row.created_at,scheduledFor:row.scheduled_for,...orderConfirmationDto(row,null,now)})),total,paging),summary:{total:totals.total,needsConfirmation:totals.confirmation,overdue:totals.overdue,awaitingPayment:totals.total-totals.confirmation},checkedAt:now.toISOString()};
}

export function adminUserDirectory(db,url) {
  const paging = pagination(url), q = search(url), role = url.searchParams.get("role") || "all", access = url.searchParams.get("access") || "all", where = [], args=[];
  if (!["all","customer","restaurant","admin"].includes(role) || !["all","enabled","disabled"].includes(access)) throw new HttpError(400,"VALIDATION_ERROR","Account filter is invalid");
  if (q) { where.push("(u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR COALESCE(u.phone,'') LIKE ? ESCAPE '\\')"); args.push(...Array(3).fill(`%${escapeLike(q)}%`)); }
  if (role !== "all") { where.push("u.role=?"); args.push(role); }
  if (access !== "all") { where.push("u.account_enabled=?"); args.push(Number(access === "enabled")); }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "", total = db.prepare(`SELECT COUNT(*) n FROM users u ${clause}`).get(...args).n;
  const rows = db.prepare(`SELECT u.id,u.name,u.email,u.role,u.phone,u.email_verified_at,u.account_enabled,u.created_at FROM users u ${clause} ORDER BY u.created_at DESC,u.id DESC LIMIT ? OFFSET ?`).all(...args,paging.pageSize,paging.offset);
  return result(rows.map((row,index)=>({id:row.id,number:paging.offset+index+1,name:row.name,email:row.email,role:row.role,phone:row.phone,emailVerified:Boolean(row.email_verified_at),enabled:Boolean(row.account_enabled),createdAt:row.created_at})),total,paging);
}

function dashboard(db,url,now) {
  const range=parseLondonDateRange(url),where=["o.status IN ('accepted','preparing','ready','out_for_delivery','completed')","(o.payment_method!='card' OR o.payment_status IN ('stripe_captured','stripe_partially_refunded','stripe_refunded'))"],args=[];
  if(range.from){where.push("o.created_at>=?");args.push(range.from);}if(range.toExclusive){where.push("o.created_at<?");args.push(range.toExclusive);}
  const orders=db.prepare(`SELECT COUNT(*) order_count,COALESCE(SUM(o.total_minor),0) order_value,COALESCE(SUM(o.commission_minor),0) order_commission FROM orders o WHERE ${where.join(" AND ")}`).get(...args);
  const restaurants=db.prepare("SELECT COUNT(*) total,COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),0) pending FROM restaurants WHERE archived_at IS NULL").get();
  return {restaurants:{total:restaurants.total,pending:restaurants.pending},customers:db.prepare("SELECT COUNT(*) n FROM users WHERE role='customer'").get().n,orders:{count:orders.order_count,valueMinor:orders.order_value,commissionMinor:orders.order_commission},liveOrders:db.prepare("SELECT COUNT(*) n FROM orders WHERE status IN ('placed','accepted','preparing','ready') AND EXISTS(SELECT 1 FROM restaurants ar WHERE ar.id=orders.restaurant_id AND ar.archived_at IS NULL)").get().n,checkedAt:now.toISOString()};
}

function operations(db,url) {
  const paging=pagination(url),kind=url.searchParams.get("kind")||"jobs";
  if(kind==="jobs") {
    const sql="SELECT id,kind,entity_id,status,attempts,error,created_at,updated_at FROM operational_jobs UNION ALL SELECT id,'notification_outbox',entity_id,status,attempts,last_error,created_at,updated_at FROM notification_outbox UNION ALL SELECT id,'receipt',order_id,status,1,error,created_at,updated_at FROM print_jobs UNION ALL SELECT id,kind,entity_id,status,attempts,error,created_at,updated_at FROM marketplace_worker_jobs";
    const total=db.prepare(`SELECT COUNT(*) n FROM (${sql})`).get().n;
    return result(db.prepare(`SELECT * FROM (${sql}) ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).all(paging.pageSize,paging.offset).map(row=>({id:row.id,kind:row.kind,entityId:row.entity_id,status:row.status,attempts:row.attempts,error:row.error,createdAt:row.created_at,updatedAt:row.updated_at})),total,paging);
  }
  if(kind==="audit") {
    const sql="SELECT id,actor_user_id,entity_type,entity_id,action,details,created_at FROM audit_events UNION ALL SELECT id,actor_user_id,entity_type,entity_id,action,details,created_at FROM governance_audit",total=db.prepare(`SELECT COUNT(*) n FROM (${sql})`).get().n;
    return result(db.prepare(`SELECT a.*,u.name actor_name FROM (${sql}) a LEFT JOIN users u ON u.id=a.actor_user_id ORDER BY a.created_at DESC,a.id DESC LIMIT ? OFFSET ?`).all(paging.pageSize,paging.offset).map(row=>({id:row.id,actorName:row.actor_name||"System",entityType:row.entity_type,entityId:row.entity_id,action:row.action,details:parsed(row.details),createdAt:row.created_at})),total,paging);
  }
  if(kind==="deletions") {
    const total=db.prepare("SELECT COUNT(*) n FROM deletion_requests").get().n;
    return result(db.prepare("SELECT d.*,u.name user_name,u.email user_email,u.role user_role,u.account_enabled FROM deletion_requests d JOIN users u ON u.id=d.user_id ORDER BY d.created_at DESC,d.id DESC LIMIT ? OFFSET ?").all(paging.pageSize,paging.offset).map(row=>{const closure=verifiedLoginClosure(db,row.id);return {id:row.id,userId:row.user_id,userName:row.user_name,userEmail:row.user_email,userRole:row.user_role,accountEnabled:Boolean(row.account_enabled),loginClosedAt:closure?.closedAt??null,closureNote:closure?.note??null,reason:row.reason,status:row.status,note:row.note,createdAt:row.created_at,updatedAt:row.updated_at};}),total,paging);
  }
  if(kind==="integrations") {
    const total=db.prepare("SELECT COUNT(*) n FROM integration_status").get().n;
    return result(db.prepare("SELECT * FROM integration_status ORDER BY name,id LIMIT ? OFFSET ?").all(paging.pageSize,paging.offset).map(row=>({id:row.id,name:row.name,mode:row.mode,enabled:Boolean(row.enabled),detail:row.detail,updatedAt:row.updated_at})),total,paging);
  }
  throw new HttpError(400,"VALIDATION_ERROR","Operations section is invalid");
}

export async function routeAdminWorkspace({req,res,url,db,config,session}) {
  if(!url.pathname.startsWith("/api/admin/workspace/"))return false;
  requireRole(session,"admin");
  if(req.method!=="GET")return false;
  if(url.pathname.startsWith("/api/admin/workspace/finance/"))return routeAdminFinanceWorkspace({req,res,url,db,config,session});
  let data;
  if(url.pathname==="/api/admin/workspace/dashboard")data=dashboard(db,url,config.now());
  else if(url.pathname==="/api/admin/workspace/unconfirmed-orders")data=adminUnconfirmedOrders(db,url,config.now());
  else if(url.pathname==="/api/admin/workspace/users")data=adminUserDirectory(db,url);
  else if(url.pathname==="/api/admin/workspace/operations")data=operations(db,url);
  else if(url.pathname==="/api/admin/workspace/orders")data=adminOrderDirectory(db,url,config);
  else if(url.pathname==="/api/admin/workspace/restaurant-options"){
    const q=search(url),id=url.searchParams.get("restaurantId");
    if(id&&id.length>100)throw new HttpError(400,"VALIDATION_ERROR","Restaurant is invalid");
    data={items:db.prepare("SELECT id,name FROM restaurants WHERE archived_at IS NULL AND name LIKE ? ESCAPE '\\' ORDER BY name,id LIMIT 25").all(`%${escapeLike(q)}%`),selected:id?db.prepare("SELECT id,name FROM restaurants WHERE id=?").get(id)??null:null};
  }
  else if(url.pathname.match(/^\/api\/admin\/workspace\/orders\/[^/]+(?:\/breakdown)?$/)){
    const match=url.pathname.match(/^\/api\/admin\/workspace\/orders\/([^/]+)(\/breakdown)?$/),row=db.prepare("SELECT * FROM orders WHERE id=?").get(match[1]);
    if(!row)throw new HttpError(404,"NOT_FOUND","Order not found");
    data=match[2]?buildOrderFinancialBreakdown(db,row):orderDto(db,row,true,true,config);
  }
  else return false;
  return sendJson(res,200,{data});
}

export function adminOrderDirectory(db,url,config){
  const paging=pagination(url),range=parseLondonDateRange(url),q=search(url),status=url.searchParams.get("status")||"all",restaurantId=url.searchParams.get("restaurantId"),fulfillment=url.searchParams.get("fulfillment")||"all",where=[],args=[];
  if(!["all","live","unconfirmed","placed","accepted","preparing","ready","out_for_delivery","completed","rejected"].includes(status)||!["all","delivery","collection"].includes(fulfillment))throw new HttpError(400,"VALIDATION_ERROR","Order filter is invalid");
  if(restaurantId&&restaurantId.length>100)throw new HttpError(400,"VALIDATION_ERROR","Restaurant is invalid");
  if(["live","unconfirmed","placed","accepted","preparing","ready","out_for_delivery"].includes(status))where.push("EXISTS(SELECT 1 FROM restaurants r WHERE r.id=o.restaurant_id AND r.archived_at IS NULL)");
  if(status==="live")where.push("o.status IN ('placed','accepted','preparing','ready')");
  else if(status==="unconfirmed")where.push("o.status='placed' AND o.confirmed_at IS NULL");
  else if(status!=="all"){where.push("o.status=?");args.push(status);}
  if(restaurantId){where.push("o.restaurant_id=?");args.push(restaurantId);}
  if(fulfillment!=="all"){where.push("o.fulfillment=?");args.push(fulfillment);}
  if(range.from){where.push("o.created_at>=?");args.push(range.from);}if(range.toExclusive){where.push("o.created_at<?");args.push(range.toExclusive);}
  if(q){where.push("(o.id LIKE ? ESCAPE '\\' OR o.restaurant_name LIKE ? ESCAPE '\\' OR COALESCE(o.customer_name,u.name) LIKE ? ESCAPE '\\' OR COALESCE(o.customer_email,u.email) LIKE ? ESCAPE '\\')");args.push(...Array(4).fill(`%${escapeLike(q)}%`));}
  const clause=where.length?`WHERE ${where.join(" AND ")}`:"",joins="FROM orders o JOIN users u ON u.id=o.customer_id",total=db.prepare(`SELECT COUNT(*) n ${joins} ${clause}`).get(...args).n;
  const rows=db.prepare(`SELECT o.*,u.name account_name,(SELECT COUNT(*) FROM order_items i WHERE i.order_id=o.id) item_count ${joins} ${clause} ORDER BY o.created_at DESC,o.id DESC LIMIT ? OFFSET ?`).all(...args,paging.pageSize,paging.offset);
  return result(rows.map((row,index)=>({id:row.id,number:paging.offset+index+1,restaurantId:row.restaurant_id,restaurantName:row.restaurant_name,customerName:row.customer_name||row.account_name,status:row.status,fulfillment:row.fulfillment,deliveryAddress:parsed(row.delivery_address),totalMinor:row.total_minor,paymentMethod:row.payment_method,paymentStatus:row.payment_status,createdAt:row.created_at,scheduledFor:row.scheduled_for,itemCount:row.item_count,...orderConfirmationDto(row,null,config.now())})),total,paging);
}
