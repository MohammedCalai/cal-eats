import { requireRole } from "./auth/authorization.js";
import { HttpError, sendJson } from "./http.js";
import { buildFinanceSummary, parseLondonDateRange, resolveFinanceScope, operationFinancePredicate } from "./marketplace-reporting.js";
import { orderEnvironmentPredicate } from "./financial-environment.js";

function paging(url){const raw=url.searchParams.get("page")??"1",size=url.searchParams.get("pageSize")??"25",page=Number(raw),pageSize=Number(size);if(!/^[1-9][0-9]*$/.test(raw)||!/^[1-9][0-9]*$/.test(size)||!Number.isSafeInteger(page)||page>100000||pageSize>50)throw new HttpError(400,"VALIDATION_ERROR","Finance pagination is invalid");return{page,pageSize,offset:(page-1)*pageSize};}
const pageResult=(items,total,p)=>({items,pagination:{page:p.page,pageSize:p.pageSize,total,totalPages:Math.ceil(total/p.pageSize),hasPrevious:p.page>1,hasNext:p.page*p.pageSize<total}});
function restaurantSearch(url){const q=(url.searchParams.get("q")||"").trim();if(q.length>100)throw new HttpError(400,"VALIDATION_ERROR","Restaurant search is too long");return q?`%${q.replace(/[\\%_]/g,"\\$&")}%`:"%";}
function temporal(range,alias,bindings){const clauses=[];if(range.from){clauses.push(`${alias}.created_at>=$from`);bindings.from=range.from;}if(range.toExclusive){clauses.push(`${alias}.created_at<$to`);bindings.to=range.toExclusive;}return clauses.length?` AND ${clauses.join(" AND ")}`:"";}
const recognisedOrder="o.status IN ('accepted','preparing','ready','out_for_delivery','completed') AND (o.payment_method!='card' OR o.payment_status IN ('stripe_captured','stripe_partially_refunded','stripe_refunded'))";

export function adminFinanceSummary(db,url,config=null){
  const scope=resolveFinanceScope(config,url),p=paging(url),range=parseLondonDateRange(url),pattern=restaurantSearch(url),bindings={},orderTime=temporal(range,"o",bindings),operationTime=temporal(range,"m",bindings),refundTime=temporal(range,"f",bindings),orderScope=orderEnvironmentPredicate("o",scope),operationScope=operationFinancePredicate("m",scope);
  const historical=db.prepare(`SELECT COALESCE(SUM(o.total_minor),0) gross,COALESCE(SUM(o.commission_minor),0) commission FROM orders o JOIN restaurants r ON r.id=o.restaurant_id WHERE ${recognisedOrder} AND ${orderScope} AND r.name LIKE $pattern ESCAPE '\\' AND NOT EXISTS(SELECT 1 FROM marketplace_operations m WHERE m.order_id=o.id AND m.kind IN ('payment_capture','cash_order_accepted'))${orderTime}`).get({...bindings,pattern});
  const operation=db.prepare(`SELECT COALESCE(SUM(CASE WHEN m.kind IN ('payment_capture','cash_order_accepted','platform_voucher_credit') THEN m.amount_minor ELSE 0 END),0) gross,COALESCE(SUM(CASE WHEN m.kind IN ('commission','cash_commission_receivable') THEN m.amount_minor ELSE 0 END),0) commission,COALESCE(SUM(CASE WHEN m.kind='provider_cost' THEN m.amount_minor ELSE 0 END),0) fees,COALESCE(SUM(CASE WHEN m.kind='platform_voucher_credit' THEN m.amount_minor ELSE 0 END),0) vouchers FROM marketplace_operations m JOIN restaurants r ON r.id=m.restaurant_id WHERE m.status='confirmed' AND ${operationScope} AND r.name LIKE $pattern ESCAPE '\\'${operationTime}`).get({...bindings,pattern});
  const refunds=db.prepare(`SELECT COALESCE(SUM(f.food_amount_minor+f.delivery_amount_minor),0) amount,COALESCE(SUM(f.commission_reversal_minor),0) reversal FROM refunds f JOIN orders o ON o.id=f.order_id JOIN restaurants r ON r.id=o.restaurant_id WHERE ${orderScope} AND r.name LIKE $pattern ESCAPE '\\'${refundTime}`).get({...bindings,pattern});
  const commissionMinor=historical.commission+operation.commission-refunds.reversal,total=db.prepare("SELECT COUNT(*) n FROM restaurants r WHERE r.name LIKE ? ESCAPE '\\'").get(pattern).n;
  const items=db.prepare("SELECT id,name FROM restaurants WHERE name LIKE ? ESCAPE '\\' ORDER BY name,id LIMIT ? OFFSET ?").all(pattern,p.pageSize,p.offset).map(row=>({...buildFinanceSummary(db,row.id,url,config),restaurantName:row.name}));
  const providerModes=db.prepare(`SELECT DISTINCT m.provider_mode FROM marketplace_operations m JOIN restaurants r ON r.id=m.restaurant_id WHERE m.amount_minor>0 AND ${operationScope} AND r.name LIKE ? ESCAPE '\\' LIMIT 3`).all(pattern).map(row=>row.provider_mode);
  const providerCostsPendingCount=db.prepare(`SELECT COUNT(*) n FROM stripe_order_payments s JOIN orders o ON o.id=s.order_id JOIN restaurants r ON r.id=o.restaurant_id WHERE s.status='captured' AND s.provider_cost_minor IS NULL AND ${recognisedOrder} AND ${orderScope} AND r.name LIKE ? ESCAPE '\\'`).get(pattern).n;
  return {...pageResult(items,total,p),totals:{grossSalesMinor:historical.gross+operation.gross,commissionMinor,refundsMinor:refunds.amount,providerCostMinor:operation.fees,platformVoucherCostMinor:operation.vouchers,marginMinor:commissionMinor-operation.fees-operation.vouchers,providerCostsPendingCount},providerModes,providerMode:providerModes.length>1?"mixed":providerModes[0]||(scope==="live"?"stripe_live":"local_simulator"),financialScope:scope,financialScopeLabel:scope==="live"?"Live payments":"Test/unclassified history"};
}

export function adminFinanceRecords(db,url,kind,config=null){
  const scope=resolveFinanceScope(config,url),p=paging(url),pattern=restaurantSearch(url),range=parseLondonDateRange(url),bindings={pattern},time=temporal(range,"m",bindings);
  if(kind==="exceptions"){
    const where=`m.status IN ('failed','delayed','held') AND NOT (m.kind='cash_sale_recorded' AND m.status='held') AND ${operationFinancePredicate("m",scope)} AND r.name LIKE $pattern ESCAPE '\\'`+time,total=db.prepare(`SELECT COUNT(*) n FROM marketplace_operations m JOIN restaurants r ON r.id=m.restaurant_id WHERE ${where}`).get(bindings).n;
    return pageResult(db.prepare(`SELECT m.*,r.name restaurant_name FROM marketplace_operations m JOIN restaurants r ON r.id=m.restaurant_id WHERE ${where} ORDER BY m.created_at DESC,m.id DESC LIMIT $limit OFFSET $offset`).all({...bindings,limit:p.pageSize,offset:p.offset}).map(row=>({id:row.id,restaurantId:row.restaurant_id,restaurantName:row.restaurant_name,orderId:row.order_id,kind:row.kind,amountMinor:row.amount_minor,status:row.status,error:row.error,updatedAt:row.updated_at})),total,p);
  }
  const total=db.prepare(`SELECT COUNT(*) n FROM ${kind==="contracts"?"contracts c JOIN restaurants r ON r.id=c.restaurant_id":"restaurants r"} WHERE r.name LIKE ? ESCAPE '\\'`).get(pattern).n;
  if(kind==="contracts")return pageResult(db.prepare("SELECT c.*,r.name restaurant_name FROM contracts c JOIN restaurants r ON r.id=c.restaurant_id WHERE r.name LIKE ? ESCAPE '\\' ORDER BY r.name,c.id LIMIT ? OFFSET ?").all(pattern,p.pageSize,p.offset).map(row=>({id:row.id,restaurantId:row.restaurant_id,restaurantName:row.restaurant_name,rateBasisPoints:row.rate_bps,durationMonths:row.duration_months,policyVersion:row.policy_version,demoOnly:Boolean(row.demo_only),acceptedAt:row.accepted_at})),total,p);
  if(kind==="statements"){
    const items=db.prepare("SELECT id,name FROM restaurants r WHERE r.name LIKE ? ESCAPE '\\' ORDER BY r.name,r.id LIMIT ? OFFSET ?").all(pattern,p.pageSize,p.offset).map(restaurant=>{
      const row=db.prepare(`SELECT COALESCE(SUM(CASE WHEN kind IN ('commission_mock','commission_mock_refund','commission_stripe','commission_stripe_refund','commission_voucher') THEN amount_minor ELSE 0 END),0) card,COALESCE(SUM(CASE WHEN kind IN ('commission_cash_receivable','commission_cash_refund') THEN amount_minor ELSE 0 END),0) cash,COALESCE(SUM(CASE WHEN kind='cash_settlement' THEN amount_minor ELSE 0 END),0) settled FROM ledger_entries l LEFT JOIN orders o ON o.id=l.order_id WHERE l.restaurant_id=? AND ${orderEnvironmentPredicate("o",scope)}`).get(restaurant.id);
      return{restaurantId:restaurant.id,restaurantName:restaurant.name,commissionCardMinor:row.card,cashReceivableMinor:row.cash,cashSettledMinor:row.settled,cashOutstandingMinor:row.cash-row.settled};
    });return pageResult(items,total,p);
  }
  throw new HttpError(400,"VALIDATION_ERROR","Finance section is invalid");
}

export async function routeAdminFinanceWorkspace({req,res,url,db,session,config}){
  const match=url.pathname.match(/^\/api\/admin\/workspace\/finance\/(summary|exceptions|contracts|statements)$/);if(req.method!=="GET"||!match)return false;
  requireRole(session,"admin");const data=match[1]==="summary"?adminFinanceSummary(db,url,config):adminFinanceRecords(db,url,match[1],config);return sendJson(res,200,{data:{...data,financialScope:resolveFinanceScope(config,url),financialScopeLabel:resolveFinanceScope(config,url)==="live"?"Live payments":"Test/unclassified history"}});
}
