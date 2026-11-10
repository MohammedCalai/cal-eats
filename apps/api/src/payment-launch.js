import {requireRole} from "./auth/authorization.js";
import {HttpError,sendJson} from "./http.js";
import {resolveRestaurantCommission} from "./restaurant-commission.js";
import {restaurantReadiness} from "./readiness.js";
import {createHash} from "node:crypto";
import {merchantCommercialRestaurantIds,resolveMerchantCommercialTerms} from "./merchant-commercial.js";

const validAccount=value=>typeof value==="string"&&/^acct_[A-Za-z0-9]+$/.test(value);
const validSecret=value=>typeof value==="string"&&/^whsec_[A-Za-z0-9_]{8,}$/.test(value);
const pendingJobs="j.status IN ('queued','delayed','claimed') AND j.kind IN ('stripe_transfer','stripe_transfer_reversal','stripe_refund')";
const capabilitySql="EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(a.capabilities) THEN a.capabilities ELSE '[]' END) WHERE value='card_payments') AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(a.capabilities) THEN a.capabilities ELSE '[]' END) WHERE value='transfers')";
const hasCapabilities=value=>{try{const list=JSON.parse(value);return Array.isArray(list)&&list.includes("card_payments")&&list.includes("transfers");}catch{return false;}};
const operationalSql=`r.paused=0 AND r.suspended=0 AND TRIM(COALESCE(r.phone,''))<>'' AND TRIM(COALESCE(r.address,''))<>''
  AND (r.always_open=1 OR json_array_length(CASE WHEN json_valid(r.opening_hours) THEN r.opening_hours ELSE '[]' END)>0)
  AND EXISTS(SELECT 1 FROM menu_items mi WHERE mi.restaurant_id=r.id AND mi.available=1)
  AND (r.collection_enabled=1 OR (r.delivery_enabled=1 AND json_array_length(CASE WHEN json_valid(r.delivery_outcodes) THEN r.delivery_outcodes ELSE '[]' END)>0))`;

/** Non-mutating launch inventory. Secret values never enter this response. */
export function paymentLaunchReport(db,config,{page=1,pageSize=25,environment=process.env}={}){
  const now=config.now().toISOString(),currentMode=config.paymentProviderMode;
  const liveAccountId=environment.CALAI_STRIPE_LIVE_ACCOUNT_ID||(currentMode==="stripe_live"?config.stripePlatformAccountId:null);
  const keyConfigured=/^(?:rk|sk)_live_[A-Za-z0-9_]+$/.test(environment.CALAI_STRIPE_LIVE_SECRET_KEY||"");
  const platformEvents=environment.CALAI_STRIPE_LIVE_WEBHOOK_SECRET,connectEvents=environment.CALAI_STRIPE_LIVE_CONNECT_WEBHOOK_SECRET;
  const separateEventSecrets=validSecret(platformEvents)&&validSecret(connectEvents)&&platformEvents!==connectEvents;
  const total=db.prepare("SELECT COUNT(*) n FROM restaurants WHERE archived_at IS NULL").get().n;
  // Join the exact current commercial policy used when a new order is saved.
  const selection=`SELECT r.*,a.provider_mode AS account_mode,a.status AS account_status,a.capabilities,s.charges_enabled,s.payouts_enabled,
    c.rate_bps AS contract_rate,c.demo_only,c.accepted_at AS contract_accepted,
    p.rate_bps AS policy_rate,p.commission_base,p.development_assumption,p.accepted_at AS policy_accepted
    FROM restaurants r LEFT JOIN provider_accounts a ON a.restaurant_id=r.id
    LEFT JOIN stripe_account_readiness s ON s.restaurant_id=r.id AND s.provider_mode=a.provider_mode AND s.provider_account_id=a.provider_reference
    LEFT JOIN contracts c ON c.restaurant_id=r.id
    LEFT JOIN commission_policies p ON p.id=(SELECT id FROM commission_policies WHERE restaurant_id=r.id AND accepted_at IS NOT NULL AND starts_at<=? AND ends_at>? ORDER BY created_at DESC LIMIT 1)`;
  const merchantIds=merchantCommercialRestaurantIds(db,config);
  const termsFor=row=>resolveMerchantCommercialTerms({policy:row.policy_accepted?{accepted_at:row.policy_accepted,rate_bps:row.policy_rate,commission_base:row.commission_base,development_assumption:row.development_assumption,version:"legacy-policy"}:null,contract:row.contract_accepted?{accepted_at:row.contract_accepted,rate_bps:row.contract_rate,demo_only:row.demo_only,policy_version:"legacy-contract"}:null,agreement:merchantIds.has(row.id)?{rateBasisPoints:700,base:"food_plus_delivery",policyVersion:config.merchantCommercial.document.version,demoOnly:false}:null});
  const termsApproved=row=>{const terms=termsFor(row);return terms.accepted&&!terms.demoOnly;};
  const accountReady=row=>row.account_mode==="stripe_live"&&row.account_status==="enabled"&&Boolean(row.charges_enabled&&row.payouts_enabled)&&hasCapabilities(row.capabilities);
  const baseCorrect=row=>termsFor(row).base==="food_plus_delivery";
  const counts=db.prepare(`SELECT COUNT(*) AS approved,SUM(a.provider_mode='stripe_live' AND a.status='enabled' AND s.charges_enabled=1 AND s.payouts_enabled=1 AND ${capabilitySql}) AS bank_ready,
    SUM(CASE WHEN p.id IS NOT NULL THEN p.development_assumption=0 ELSE c.accepted_at IS NOT NULL AND c.demo_only=0 END) AS terms_ready,
    SUM(COALESCE(p.commission_base,'food_plus_delivery')='food_plus_delivery') AS base_ready,
    SUM(r.cash_enabled=1) AS cash_enabled,SUM(${operationalSql}) AS operational_ready
    FROM restaurants r LEFT JOIN provider_accounts a ON a.restaurant_id=r.id
    LEFT JOIN stripe_account_readiness s ON s.restaurant_id=r.id AND s.provider_mode=a.provider_mode AND s.provider_account_id=a.provider_reference
    LEFT JOIN contracts c ON c.restaurant_id=r.id
    LEFT JOIN commission_policies p ON p.id=(SELECT id FROM commission_policies WHERE restaurant_id=r.id AND accepted_at IS NOT NULL AND starts_at<=? AND ends_at>? ORDER BY created_at DESC LIMIT 1)
    WHERE r.status='approved' AND r.archived_at IS NULL`).get(now,now);
  const history={
    testPayments:db.prepare("SELECT COUNT(*) n FROM stripe_order_payments WHERE provider_mode='stripe_test'").get().n,
    testJobsPending:db.prepare(`SELECT COUNT(*) n FROM marketplace_worker_jobs j LEFT JOIN marketplace_operations o ON o.operation_key=j.operation_key LEFT JOIN refund_cases c ON c.id=j.entity_id AND j.kind IN ('stripe_refund','stripe_transfer_reversal') WHERE ${pendingJobs} AND COALESCE(o.provider_mode,c.provider_mode)='stripe_test'`).get().n,
    modeMismatchedAccounts:db.prepare("SELECT COUNT(*) n FROM provider_accounts WHERE provider_mode<>'stripe_live'").get().n,
    outstandingTestAuthorisations:db.prepare("SELECT COUNT(*) n FROM stripe_order_payments WHERE provider_mode='stripe_test' AND status IN ('pending','authorized','unknown')").get().n
  };
  const approved=Number(counts.approved)||0,readyAccounts=Number(counts.bank_ready)||0;
  const approvedTerms=db.prepare(`SELECT id,policy_accepted,policy_rate,commission_base,development_assumption,contract_accepted,contract_rate,demo_only FROM (${selection}) WHERE status='approved' AND archived_at IS NULL`).all(now,now).filter(row=>termsApproved(row)&&baseCorrect(row)).length;
  // Match the current-hash-bound live-banking-v1 proof used by banking access,
  // reading all candidate credentials/audits once rather than per restaurant.
  const credentialProofs=db.prepare("SELECT u.id,u.password_hash,a.details FROM users u JOIN audit_events a ON a.entity_type='user' AND a.entity_id=u.id AND a.action='password_changed' WHERE u.account_enabled=1 AND u.role IN ('admin','restaurant')").all(),fingerprints=new Map(),secureUsers=new Set();
  for(const row of credentialProofs){let proof;try{proof=JSON.parse(row.details);}catch{continue;}if(proof?.policy!=="live-banking-v1")continue;if(!fingerprints.has(row.id))fingerprints.set(row.id,createHash("sha256").update(row.password_hash).digest("hex"));if(proof.credentialFingerprint===fingerprints.get(row.id))secureUsers.add(row.id);}
  const secured=id=>secureUsers.has(id);
  const administrators=db.prepare("SELECT id FROM users WHERE role='admin' AND account_enabled=1").all(),securedAdministrators=administrators.filter(row=>secured(row.id)).length,platformSecurityReady=administrators.length>0&&securedAdministrators===administrators.length;
  const ownerRows=db.prepare("SELECT m.restaurant_id,m.user_id,r.status AS restaurant_status FROM restaurant_memberships m JOIN users u ON u.id=m.user_id AND u.role='restaurant' AND u.account_enabled=1 JOIN restaurants r ON r.id=m.restaurant_id WHERE m.permission='owner' AND r.archived_at IS NULL").all(),owners=new Map(),approvedOwnerIds=new Set(ownerRows.filter(row=>row.restaurant_status==="approved").map(row=>row.restaurant_id));
  for(const row of ownerRows){if(!owners.has(row.restaurant_id))owners.set(row.restaurant_id,[]);owners.get(row.restaurant_id).push(row.user_id);}
  const secureOwnerIds=new Set([...owners].filter(([,ids])=>ids.every(secured)).map(([id])=>id));
  const secureApprovedOwners=[...secureOwnerIds].filter(id=>approvedOwnerIds.has(id)).length;
  const scheduleConfirmed=environment.CALAI_LIVE_PAYOUT_SCHEDULE_CONFIRMED==="true";
  const checks=[
    {id:"live_mode",label:"Real card payments",state:currentMode==="stripe_live"&&config.livePaymentsEnabled?"ready":"blocked",detail:currentMode==="stripe_live"&&config.livePaymentsEnabled?"Real payment mode is enabled.":"Payments are still in testing. Live activation needs a separate reviewed change."},
    {id:"live_connection",label:"Dedicated Cal-Eats live connection",state:validAccount(liveAccountId)&&keyConfigured?"review":"blocked",detail:validAccount(liveAccountId)&&keyConfigured?"Live connection details are staged; verify the exact Stripe account before activation.":"Stage the confirmed live account and a dedicated restricted server key. Existing Calai keys must stay separate."},
    {id:"live_events",label:"Payment and restaurant payout updates",state:separateEventSecrets?"review":"blocked",detail:separateEventSecrets?"Separate signing secrets are present. Successful signed deliveries must be checked before launch.":"Two separate live event connections and signing secrets are required."},
    {id:"restaurant_accounts",label:"Real restaurant bank onboarding",state:approved>0&&readyAccounts===approved?"ready":"blocked",detail:`${readyAccounts} of ${approved} approved restaurants have a verified live payment and payout account. Test bank accounts cannot be reused.`},
    {id:"commercial_terms",label:"Approved restaurant commission terms",state:approved>0&&approvedTerms===approved?"ready":"blocked",detail:`${approvedTerms} of ${approved} approved restaurants have non-demo accepted terms. Commission must include discounted food and charged delivery.`},
    {id:"restaurant_operations",label:"Restaurant ordering setup",state:approved>0&&Number(counts.operational_ready)===approved?"ready":"blocked",detail:`${Number(counts.operational_ready)||0} of ${approved} approved restaurants have contact details, opening hours, an available menu and fulfillment configured, with new orders unpaused and no suspension.`},
    {id:"account_security",label:"Secure administrator and owner access",state:approved>0&&platformSecurityReady&&secureApprovedOwners===approved?"ready":"blocked",detail:`${securedAdministrators} of ${administrators.length} active administrators have replaced their testing password. ${secureApprovedOwners} of ${approved} approved restaurants have secure active owner access. Every active owner must secure their account before real orders.`},
    {id:"payout_schedule",label:"Restaurant bank payout schedule",state:scheduleConfirmed?"ready":"review",detail:scheduleConfirmed?"The configured weekly Monday payout plan has been confirmed.":"Weekly Monday is the development default. Confirm the live payout schedule before onboarding restaurants."},
    {id:"cash_collection",label:"Commission on cash orders",state:currentMode==="stripe_live"||!Number(counts.cash_enabled)?"ready":"blocked",detail:currentMode==="stripe_live"?"Cash checkout and enabling cash are blocked for all real orders, including restaurants with an older cash preference. Secure card checkout is required.":Number(counts.cash_enabled)?"Automatic cash-commission collection is not connected. Cash will be blocked when real payments are activated.":"Cash is not offered by the approved restaurants. It will not create an uncollected commission balance."},
    {id:"test_handover",label:"Preserve testing history",state:history.testJobsPending||history.outstandingTestAuthorisations||history.modeMismatchedAccounts?"review":"ready",detail:history.testJobsPending||history.outstandingTestAuthorisations||history.modeMismatchedAccounts?"Complete a reviewed handover or isolate live data. Do not replace test bank accounts or lose outstanding test history.":"No outstanding test account handover was found."}
  ];
  const items=db.prepare(`${selection} WHERE r.archived_at IS NULL ORDER BY r.name COLLATE NOCASE,r.id LIMIT ? OFFSET ?`).all(now,now,pageSize,(page-1)*pageSize).map(row=>{
    const terms=termsApproved(row),bank=accountReady(row),normalRate=termsFor(row).rateBasisPoints,reasons=[];
    const setup=restaurantReadiness(db,row.id),operationalReady=setup.ready&&!row.paused&&!row.suspended,ownerSecurityReady=secureOwnerIds.has(row.id);
    if(!bank)reasons.push(row.account_mode&&row.account_mode!=="stripe_live"?"Create a real restaurant payment account; retain the test account history.":"Complete real business and bank onboarding.");
    if(!terms)reasons.push("Review and accept the real commercial agreement.");
    if(!baseCorrect(row))reasons.push("The commission agreement does not include charged delivery.");
    if(row.status!=="approved")reasons.push("Restaurant approval is pending.");
    const setupReasons={contact:"Add the restaurant contact number.",address:"Add the restaurant address.",hours:"Set the restaurant opening hours.",usableMenu:"Add at least one available menu item.",fulfillment:"Enable collection or configure the delivery area."};
    for(const [key,message]of Object.entries(setupReasons))if(!setup.checks[key])reasons.push(message);
    if(row.paused)reasons.push("Unpause new orders when the restaurant is ready.");
    if(row.suspended)reasons.push("Resolve the restaurant suspension before accepting orders.");
    if(!ownerSecurityReady)reasons.push("Replace the testing password for every active restaurant owner.");
    if(!platformSecurityReady)reasons.push("Every active platform administrator must secure their account.");
    return {id:row.id,name:row.name,accountMode:row.account_mode??null,accountReady:bank,termsApproved:terms,operationalReady,ownerSecurityReady,platformSecurityReady,effectiveRateBasisPoints:resolveRestaurantCommission(db,row.id,now,normalRate).rateBasisPoints,reasons};
  });
  return {currentMode,livePaymentsEnabled:Boolean(config.livePaymentsEnabled),ready:checks.every(check=>check.state==="ready"),
    commission:{normalRateBasisPoints:700,base:"discounted_food_plus_charged_delivery",processingFeesPaidBy:"platform",captureAt:"restaurant_confirmation",settlementAt:"completed",cashCommissionCollection:currentMode==="stripe_live"?"disabled":"not_connected"},
    paymentPolicy:{cardOnly:currentMode==="stripe_live",cashAvailable:currentMode!=="stripe_live"},
    payoutSchedule:{interval:"weekly",weeklyAnchor:"monday",confirmed:scheduleConfirmed},checks,
    restaurants:{items,page,pageSize,total,hasMore:page*pageSize<total},history,
    reviews:["Current testing apps use the same public API. Review the launch audience and restaurant catalogue before changing that API to live payments.","Live business activity and payment terms must cover the Cal-Eats marketplace, in addition to the existing Calai subscription business.","Cal-Eats covers normal processing costs, including commission-free periods and any platform-funded vouchers."]};
}

export async function routePaymentLaunch({req,res,url,db,config,session}){
  if(url.pathname!=="/api/admin/finance/payment-launch")return false;
  requireRole(session,"admin");
  if(req.method!=="GET")throw new HttpError(405,"METHOD_NOT_ALLOWED","Payment launch checks are read-only");
  const page=Number(url.searchParams.get("page")??1),pageSize=Number(url.searchParams.get("pageSize")??25);
  if(!Number.isSafeInteger(page)||page<1||page>100000||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100)throw new HttpError(400,"VALIDATION_ERROR","Restaurant payment pagination is invalid");
  return sendJson(res,200,{data:paymentLaunchReport(db,config,{page,pageSize})});
}
