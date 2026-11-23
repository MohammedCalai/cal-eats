import {HttpError} from './http.js';
import {randomUUID} from 'node:crypto';
import {assertTabletSelectionActivation} from './tablet-assignment-safety.js';
const present=db=>Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_tablets'").get());
const denied=()=>new HttpError(403,'TABLET_QUARANTINED','Tablet access is quarantined pending authorised physical sign-out/profile cleanup. No device handoff has been verified.');
export function assertFleetNewEnrolmentAllowed(db,businessId){
 if(!present(db))return;
 const blocked=db.prepare(`WITH RECURSIVE family(id) AS (
  SELECT ? UNION SELECT a.old_id FROM business_account_aliases a JOIN family f ON a.business_id=f.id
  UNION SELECT a.business_id FROM business_account_aliases a JOIN family f ON a.old_id=f.id
 ) SELECT 1 FROM admin_tablets WHERE authority_blocked_at IS NOT NULL AND(business_id IN(SELECT id FROM family) OR requested_business_id IN(SELECT id FROM family)) LIMIT 1`).get(businessId);
 if(blocked)throw denied();
}
export function assertFleetTerminalAllowed(db,terminal){
 if(!terminal||!present(db))return;
 if(db.prepare('SELECT 1 FROM admin_tablets WHERE terminal_id=? AND authority_blocked_at IS NOT NULL LIMIT 1').get(terminal.id))throw denied();
}
export function recordEnrolledTabletInventory(db,terminal){
 if(!terminal||!present(db))return;
 const bound=Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='tablet_fleet_pairing_requests'").get())&&db.prepare('SELECT * FROM tablet_fleet_pairing_requests WHERE terminal_id=?').get(terminal.id);
 if(bound){
  db.prepare("UPDATE admin_tablets SET terminal_id=?,lifecycle_state='assigned',revision=revision+1,updated_at=? WHERE id=? AND revision=? AND business_id=? AND authority_blocked_at IS NULL AND archived_at IS NULL").run(terminal.id,terminal.registered_at,bound.tablet_id,bound.record_revision,bound.business_id);
  db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)').run(randomUUID(),bound.issued_by,'tablet_fleet',bound.tablet_id,'tablet_central_enrolment_paired',JSON.stringify({terminalId:terminal.id,businessId:bound.business_id,previousRevision:bound.record_revision,currentRevision:bound.record_revision+1,source:'signed_device_pairing',physicalHardwareIdentityProven:false,windowsConfigurationChanged:false,calaiUnchanged:true}),terminal.registered_at);
  return;
 }
 db.prepare("INSERT OR IGNORE INTO admin_tablets(id,display_name,business_id,terminal_id,lifecycle_state,inventory_source,created_by,created_at,updated_at) VALUES(?,?,?,?,'assigned','application_registration',?,?,?)").run(terminal.id,terminal.name,terminal.business_id,terminal.id,terminal.registered_by,terminal.registered_at,terminal.registered_at);
}
export function assertFleetPairingAllowed(db,pairing,config){
 if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='tablet_fleet_pairing_requests'").get())return;
 const bound=db.prepare('SELECT * FROM tablet_fleet_pairing_requests WHERE terminal_id=?').get(pairing.terminal_id);if(!bound)return;
 if(!db.prepare("SELECT 1 FROM users WHERE id=? AND role='admin' AND principal_kind='human' AND account_enabled=1").get(bound.issued_by))throw new HttpError(403,'FLEET_ENROLMENT_ISSUER_REVOKED','The system administrator that issued this setup is no longer authorised.');
 const row=db.prepare('SELECT * FROM admin_tablets WHERE id=?').get(bound.tablet_id);
 const alreadyPaired=Boolean(pairing.consumed_at&&row?.terminal_id===pairing.terminal_id);
 if(!row||!alreadyPaired&&row.revision!==bound.record_revision||row.business_id!==bound.business_id||pairing.business_id!==bound.business_id||row.archived_at||row.authority_blocked_at||row.handoff_requested_at||['disabled','pending_handoff'].includes(row.lifecycle_state))throw new HttpError(409,'FLEET_ENROLMENT_CHANGED','The fleet record changed. Request fresh setup from system administration.');
 if(!alreadyPaired)assertTabletSelectionActivation(db,config,row.business_id,row.application_products);
}
