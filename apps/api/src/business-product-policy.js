import {HttpError} from './http.js';
import {restaurantReadiness} from './readiness.js';
import {merchantCommercialAcceptance} from './merchant-commercial.js';

export {businessProductPolicyMigration69} from './business-product-policy-migration.js';
const exists=(db,name)=>Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
// Pairing in one product never delegates another product's private records.
// The registering human must retain proof for the exact native Calai account.
export function terminalHasCalaiAuthority(db,terminalId,businessId){
 if(!terminalId||!businessId)return false;
 return Boolean(db.prepare("SELECT 1 FROM business_terminals t JOIN users u ON u.id=t.registered_by AND u.account_enabled=1 AND u.principal_kind='human' JOIN business_product_authorities a ON a.business_id=t.business_id AND a.product='calai' AND a.user_id=u.id JOIN business_product_links p ON p.business_id=a.business_id AND p.product=a.product AND p.source_account_id=a.source_account_id AND p.upstream_user_id=a.source_user_id WHERE t.id=? AND t.business_id=? AND t.revoked_at IS NULL").get(terminalId,businessId));
}
export function businessProductPermission(db,businessId,product){
 if(!exists(db,'business_product_permissions'))return product==='cal-eats';
 return db.prepare('SELECT allowed FROM business_product_permissions WHERE business_id=? AND product=?').get(businessId,product)?.allowed===1;
}
export function ensureBusinessProductPermissions(db,businessId,now,{existingEats=false}={}){
 for(const product of ['calai','cal-eats'])db.prepare('INSERT OR IGNORE INTO business_product_permissions(business_id,product,allowed,changed_at) VALUES(?,?,?,?)').run(businessId,product,product==='cal-eats'&&existingEats?1:0,now);
}
export function businessProductState(db,businessId,product,config={}){
 const row=db.prepare('SELECT * FROM business_product_links WHERE business_id=? AND product=?').get(businessId,product),reference=db.prepare('SELECT * FROM business_native_references WHERE business_id=? AND product=?').get(businessId,product),adminAllowed=businessProductPermission(db,businessId,product),tasks=[];
 let nativeStatus=null,connected=Boolean(row),sourceUnavailable=false;
 if(!row)tasks.push({code:'ACCOUNT_CONNECTION_REQUIRED',label:`Connect the correct ${product==='calai'?'Calai':'Cal-Eats'} account and location.`});
 if(product==='calai'&&row){
  nativeStatus='Verified through native Calai';
  if(!row.encrypted_credentials||!Number.isFinite(Date.parse(row.credential_expires_at))||Date.parse(row.credential_expires_at)<= (config.now?.()??new Date()).getTime())tasks.push({code:'CALAI_REAUTHENTICATION_REQUIRED',label:'Sign in to the authorised Calai account again.'});
  if(row.last_error_code){sourceUnavailable=row.last_error_code==='CALAI_UNAVAILABLE';tasks.push({code:row.last_error_code,label:sourceUnavailable?'Calai is currently unavailable.':'Verify the Calai connection again.'});}
 }
 if(product==='cal-eats'&&row){
  const restaurant=db.prepare('SELECT * FROM restaurants WHERE id=?').get(row.restaurant_id);
  connected=Boolean(restaurant&&!restaurant.archived_at);nativeStatus=restaurant?.archived_at?'archived':restaurant?.status??'not_found';
  if(!connected)tasks.push({code:'RESTAURANT_UNAVAILABLE',label:'The Cal-Eats account is unavailable.'});
  else{
   const setup=restaurantReadiness(db,restaurant.id);
   const labels={contact:'Add the business contact number.',address:'Add the business address.',hours:'Set opening hours.',usableMenu:'Upload an available menu item.',fulfillment:'Configure collection or delivery.'};
   for(const [name,ready]of Object.entries(setup.checks))if(!ready)tasks.push({code:'SETUP_'+name.toUpperCase(),label:labels[name]});
   if(restaurant.status!=='approved')tasks.push({code:'ADMIN_APPROVAL_REQUIRED',label:'Cal-Eats must approve this restaurant.'});
   if(restaurant.suspended)tasks.push({code:'ACCOUNT_SUSPENDED',label:'Contact Cal-Eats about the account restriction.'});
   if(config.paymentProviderMode?.startsWith('stripe_')){
    const ready=db.prepare("SELECT 1 FROM provider_accounts a JOIN stripe_account_readiness r ON r.restaurant_id=a.restaurant_id AND r.provider_mode=a.provider_mode AND r.provider_account_id=a.provider_reference WHERE a.restaurant_id=? AND a.provider_mode=? AND a.status='enabled' AND r.charges_enabled=1 AND r.payouts_enabled=1").get(restaurant.id,config.paymentProviderMode);
    if(!ready)tasks.push({code:'PAYMENT_SETUP_REQUIRED',label:'Complete the secure payment and bank connection.'});
   }
   if(config.merchantCommercial?.enabled&&!merchantCommercialAcceptance(db,config,restaurant.id))tasks.push({code:'COMMERCIAL_ACCEPTANCE_REQUIRED',label:'Review and accept the current merchant commercial schedule.'});
  }
 }
 const ready=connected&&tasks.length===0;
 return{adminAllowed,connected,readiness:{ready,tasks},effectiveStatus:!adminAllowed?'admin_off':sourceUnavailable?'unavailable':ready?'ready':'setup_required',nativeAccountId:row?.source_account_id??reference?.source_account_id??null,nativeStatus:nativeStatus??reference?.native_status??null};
}
export function businessMonitoringContext(db,config,restaurantId){
 const row=db.prepare("SELECT business_id FROM business_product_links WHERE product='cal-eats' AND restaurant_id=?").get(restaurantId),restaurant=db.prepare('SELECT status,archived_at FROM restaurants WHERE id=?').get(restaurantId);
 if(!row)return{adminAllowed:false,connected:false,ready:false,approvedTrading:Boolean(restaurant?.status==='approved'&&!restaurant.archived_at)};
 const state=businessProductState(db,row.business_id,'cal-eats',config);
 return{adminAllowed:state.adminAllowed,connected:state.connected,ready:state.readiness.ready,approvedTrading:Boolean(restaurant?.status==='approved'&&!restaurant.archived_at)};
}
export function assertBusinessIntakeAllowed(db,restaurantId,config={}){
 if(!exists(db,'business_product_permissions'))return;
 const row=db.prepare("SELECT p.business_id,COALESCE(a.allowed,0) allowed FROM business_product_links p LEFT JOIN business_product_permissions a ON a.business_id=p.business_id AND a.product='cal-eats' WHERE p.product='cal-eats' AND p.restaurant_id=?").get(restaurantId);
 if(!row||row.allowed!==1)throw new HttpError(409,'CAL_EATS_DISABLED','Cal-Eats ordering is unavailable for this restaurant. Existing orders remain accessible.');
 const state=businessProductState(db,row.business_id,'cal-eats',config);if(!state.connected||!state.readiness.ready)throw new HttpError(409,'CAL_EATS_SETUP_REQUIRED','This restaurant must finish its approved setup before taking new Cal-Eats orders.');
}
export function calEatsEnabledSql(alias='r'){
 if(!/^[A-Za-z][A-Za-z0-9_]*$/.test(alias))throw new TypeError('Invalid table alias');
 return `EXISTS(SELECT 1 FROM business_product_links bp JOIN business_product_permissions bpp ON bpp.business_id=bp.business_id AND bpp.product='cal-eats' WHERE bp.product='cal-eats' AND bp.restaurant_id=${alias}.id AND bpp.allowed=1)`;
}
export function assertBusinessOwnerSettings(body){
 const forbidden=['paused','active','enabled','serviceEnabled','integrationEnabled','disable','disabled','unlink','disconnect','resume','pause','calaiEnabled','calEatsEnabled'];
 if(body&&forbidden.some(key=>Object.hasOwn(body,key)))throw new HttpError(403,'ADMIN_SERVICE_CONTROL_REQUIRED','Only the platform administrator can change service or connection enablement.');
}
