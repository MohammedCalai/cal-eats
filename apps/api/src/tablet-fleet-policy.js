import {HttpError} from './http.js';
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
 db.prepare("INSERT OR IGNORE INTO admin_tablets(id,display_name,business_id,terminal_id,lifecycle_state,inventory_source,created_by,created_at,updated_at) VALUES(?,?,?,?,'assigned','application_registration',?,?,?)").run(terminal.id,terminal.name,terminal.business_id,terminal.id,terminal.registered_by,terminal.registered_at,terminal.registered_at);
}
