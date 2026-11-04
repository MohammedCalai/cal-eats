import { requireRole, requireUser } from "./auth/authorization.js";
import { HttpError, sendJson } from "./http.js";

export const financialRemediesEnabled = config => config.financialRemediesEnabled === true;

export function businessDirectResolutionSummary(db,config) {
  const enabled=financialRemediesEnabled(config);
  const outstanding=db.prepare(`SELECT j.id,j.kind,j.status,j.attempts,j.entity_id case_id,j.operation_key,
    c.order_id,c.restaurant_id,c.approved_amount_minor,c.execution_status,
    o.payment_status,r.name restaurant_name,m.provider_reference
    FROM marketplace_worker_jobs j
    JOIN refund_cases c ON c.id=j.entity_id JOIN orders o ON o.id=c.order_id JOIN restaurants r ON r.id=c.restaurant_id
    LEFT JOIN marketplace_operations m ON m.operation_key=j.operation_key
    WHERE j.kind IN ('refund_execution','stripe_refund') AND j.status IN ('queued','delayed','claimed','failed')
    ORDER BY j.created_at,j.id LIMIT 101`).all();
  return {mode:enabled?"legacy_financial_remedies":"business_direct",financialRemediesEnabled:enabled,
    message:"Order issues are sent to the restaurant to put right. Cal-Eats does not issue refunds.",
    reviewRequired:!enabled&&outstanding.length>0,hasMore:outstanding.length>100,
    items:outstanding.slice(0,100).map(row=>({id:row.id,caseId:row.case_id,orderId:row.order_id,restaurantId:row.restaurant_id,restaurantName:row.restaurant_name,amountMinor:row.approved_amount_minor,paymentStatus:row.payment_status,executionStatus:row.execution_status,jobStatus:row.status,providerReference:row.provider_reference??null,action:row.kind==="stripe_refund"&&row.provider_reference?"reconciling_existing_provider_refund":"business_review_required",note:row.kind==="stripe_refund"&&row.provider_reference?"The provider refund was already submitted; its existing outcome can still be checked.":"Execution is paused by the business resolution policy. The restaurant must review and settle this issue directly; no refund is sent by Cal-Eats."}))};
}

export function routeBusinessDirectResolution({req,res,url,db,config,session}) {
  if(req.method==="GET"&&url.pathname==="/api/admin/resolution-policy"){
    requireRole(session,"admin");return sendJson(res,200,{data:businessDirectResolutionSummary(db,config)});
  }
  if(financialRemediesEnabled(config)||!["POST","PATCH","PUT","DELETE"].includes(req.method))return false;
  const blocked=/(?:^|\/)refund-cases(?:\/|$)/.test(url.pathname)||/^\/api\/admin\/orders\/[^/]+\/refunds(?:\/|$)/.test(url.pathname)||url.pathname==="/api/admin/governance/refund-policy";
  if(!blocked)return false;
  requireUser(session);
  throw new HttpError(409,"BUSINESS_DIRECT_RESOLUTION","Please contact the restaurant through order help so it can put things right. Cal-Eats does not issue refunds.");
}
