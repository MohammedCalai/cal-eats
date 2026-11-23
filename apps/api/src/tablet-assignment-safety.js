import {HttpError} from './http.js';
import {businessProductState} from './business-product-policy.js';

export function assertTabletSelectionReady(db,config,businessId,mode){
  if(!['calai','cal-eats','both'].includes(mode))throw new HttpError(400,'VALIDATION_ERROR','Choose Calai, Cal-Eats or both.');
  for(const product of mode==='both'?['calai','cal-eats']:[mode]){
    const state=businessProductState(db,businessId,product,config),link=db.prepare('SELECT status FROM business_product_links WHERE business_id=? AND product=?').get(businessId,product);
    if(!state.adminAllowed||!state.connected||!state.readiness.ready||link?.status!=='active')throw new HttpError(409,'TABLET_PRODUCT_NOT_READY',`${product==='calai'?'Calai':'Cal-Eats'} must be enabled, connected and ready for this location before selecting it on a tablet.`);
  }
}

export function assertTabletSelectionDoesNotStrandWork(db,businessId,mode){
  if(mode!=='calai')return;
  const native=db.prepare("SELECT restaurant_id FROM business_product_links WHERE business_id=? AND product='cal-eats'").get(businessId);
  if(native&&db.prepare("SELECT 1 FROM orders WHERE restaurant_id=? AND status IN('placed','accepted','preparing','ready','out_for_delivery') LIMIT 1").get(native.restaurant_id))throw new HttpError(409,'TABLET_ACTIVE_ORDERS','Finish the location’s active Cal-Eats orders before removing Cal-Eats from this tablet.');
  if(native&&['device_print_jobs','printer_test_jobs'].some(table=>db.prepare(`SELECT 1 FROM ${table} j JOIN restaurant_printers p ON p.id=j.printer_id WHERE p.restaurant_id=? AND j.status IN('queued','claimed','dispatched','submitted') LIMIT 1`).get(native.restaurant_id)))throw new HttpError(409,'TABLET_PRINT_JOBS_PENDING','Finish or check the location’s pending print jobs before removing Cal-Eats from this tablet.');
}

export function assertTabletSelectionActivation(db,config,businessId,mode){
  if(mode===null||mode===undefined)return;
  assertTabletSelectionReady(db,config,businessId,mode);
  assertTabletSelectionDoesNotStrandWork(db,businessId,mode);
}
