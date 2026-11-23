import {HttpError} from './http.js';

// This policy belongs to the protected Cal-Eats application identity. It neither
// changes Windows startup nor delegates access to an independent Calai website.
export function tabletApplicationSelection(db, terminalId, businessId) {
  if (!terminalId || !businessId) return null;
  return db.prepare('SELECT application_products FROM admin_tablets WHERE terminal_id=? AND business_id=? AND archived_at IS NULL').get(terminalId, businessId)?.application_products ?? null;
}

export function tabletApplicationConfiguration(db, terminalId, businessId) {
  if(!terminalId||!businessId)return null;
  const row=db.prepare('SELECT id,revision,application_products FROM admin_tablets WHERE terminal_id=? AND business_id=? AND archived_at IS NULL AND authority_blocked_at IS NULL').get(terminalId,businessId);
  if(!row?.application_products)return null;
  const receipt=db.prepare('SELECT received_at FROM tablet_application_receipts WHERE tablet_id=? AND record_revision=? AND terminal_id=? AND business_id=?').get(row.id,row.revision,terminalId,businessId);
  return{tabletId:row.id,revision:row.revision,selection:row.application_products,status:receipt?'received':'waiting_for_tablet',receivedAt:receipt?.received_at??null};
}

export function recordTabletConfigurationReceipt(db,config,session,body) {
  if(typeof body.configurationTabletId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.configurationTabletId))throw new HttpError(400,'VALIDATION_ERROR','The current tablet configuration identity is required.');
  if(!Number.isSafeInteger(body.configurationRevision)||body.configurationRevision<1)throw new HttpError(400,'VALIDATION_ERROR','A current tablet configuration revision is required.');
  const current=tabletApplicationConfiguration(db,session.terminalId,session.businessId);
  if(!current||current.tabletId!==body.configurationTabletId||current.revision!==body.configurationRevision)throw new HttpError(409,'TABLET_CONFIGURATION_CHANGED','The tablet application configuration changed. Read its current context before acknowledging it.');
  db.prepare('INSERT OR IGNORE INTO tablet_application_receipts(tablet_id,record_revision,terminal_id,business_id,received_at) VALUES(?,?,?,?,?)').run(current.tabletId,current.revision,session.terminalId,session.businessId,config.now().toISOString());
  return tabletApplicationConfiguration(db,session.terminalId,session.businessId);
}

export function tabletProductPermitted(db, terminalId, businessId, product) {
  const selection = tabletApplicationSelection(db, terminalId, businessId);
  return selection === null || selection === 'both' || selection === product;
}

export function tabletApplicationProducts(db, terminalId, businessId, products) {
  return Object.fromEntries(Object.entries(products).map(([product, state]) => {
    const permitted = tabletProductPermitted(db, terminalId, businessId, product);
    return [product, { ...state, nativeLinked: state.linked, linked: state.linked && permitted,
      active: state.active && permitted, allowedOnTablet: permitted }];
  }));
}

export function tabletPrinterProductPermitted(db, restaurantId) {
  const terminal = db.prepare("SELECT t.id,t.business_id FROM business_product_links p JOIN business_terminals t ON t.business_id=p.business_id AND t.revoked_at IS NULL WHERE p.product='cal-eats' AND p.restaurant_id=?").get(restaurantId);
  // The existing legacy printer credential/protocol is unchanged. An explicit
  // policy on its location's active application registration can only restrict
  // new Eats dispatches; it never grants printer/device authority.
  return !terminal || tabletProductPermitted(db, terminal.id, terminal.business_id, 'cal-eats');
}

export function hasNativeCalaiSetupAuthority(db,userId,businessId){
  return Boolean(db.prepare("SELECT 1 FROM business_product_authorities a JOIN business_product_links p ON p.business_id=a.business_id AND p.product=a.product AND p.source_account_id=a.source_account_id AND p.upstream_user_id=a.source_user_id JOIN users u ON u.id=a.user_id AND u.account_enabled=1 AND u.principal_kind='human' WHERE a.business_id=? AND a.product='calai' AND a.user_id=? AND p.status='active'").get(businessId,userId));
}
