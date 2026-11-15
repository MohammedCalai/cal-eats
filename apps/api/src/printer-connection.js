import {createHash,randomBytes,randomUUID} from "node:crypto";
import {requireRestaurantOwner} from "./auth/authorization.js";
import {withTransaction} from "./db/index.js";
import {HttpError,exactObject,readJson,sendJson} from "./http.js";
import {buildPrinterBridgePackage} from "./printer-bridge-package.js";

const hash=value=>createHash("sha256").update(value).digest("hex");
const invalid=()=>new HttpError(401,"INVALID_PAIRING_CODE","Printer setup is invalid or expired. Download a fresh printer setup.");

// A package contains only a scoped, single-use setup code. The Windows device
// creates its own credential before contacting us, allowing recovery if the
// pairing response is lost without storing a recoverable token on the server.
export async function pairPrinterDevice({req,res,db,config}){
  const body=await readJson(req,config.bodyLimit);exactObject(body,["code","name","clientToken"]);
  if(typeof body.code!=="string"||body.code.length<8||body.code.length>100||typeof body.name!=="string"||!body.name.trim()||body.name.length>100)throw new HttpError(400,"VALIDATION_ERROR","Printer setup details are invalid");
  if(body.clientToken!==undefined&&(typeof body.clientToken!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(body.clientToken)))throw new HttpError(400,"VALIDATION_ERROR","Printer device credential is invalid");
  const token=body.clientToken??randomBytes(32).toString("base64url"),now=config.now().toISOString(),tokenHash=hash(token);
  const device=withTransaction(db,()=>{
    const pairing=db.prepare("SELECT c.*,p.restaurant_id,p.enabled,p.revoked_at,r.archived_at FROM printer_pairing_codes c JOIN restaurant_printers p ON p.id=c.printer_id JOIN restaurants r ON r.id=p.restaurant_id WHERE c.code_hash=?").get(hash(body.code.trim()));
    if(!pairing||!pairing.enabled||pairing.revoked_at||pairing.archived_at)throw invalid();
    if(pairing.consumed_at){
      const existing=body.clientToken&&db.prepare("SELECT id,printer_id,restaurant_id,ordering_terminal_id FROM printer_devices WHERE token_hash=? AND printer_id=? AND restaurant_id=? AND revoked_at IS NULL").get(tokenHash,pairing.printer_id,pairing.restaurant_id);
      if(!existing||!req.terminal||existing.ordering_terminal_id!==req.terminal.id)throw invalid();
      return existing;
    }
    if(pairing.expires_at<=now)throw invalid();
    if(db.prepare("SELECT 1 FROM printer_devices WHERE token_hash=?").get(tokenHash))throw new HttpError(409,"DEVICE_CREDENTIAL_IN_USE","Create a new printer device credential");
    const id=randomUUID();
    if(!db.prepare("UPDATE printer_pairing_codes SET consumed_at=? WHERE id=? AND consumed_at IS NULL").run(now,pairing.id).changes)throw invalid();
    if(!req.terminal||req.terminal.restaurant_id!==pairing.restaurant_id)throw invalid();
    db.prepare("INSERT INTO printer_devices(id,printer_id,restaurant_id,name,token_hash,revoked_at,last_seen_at,created_at,ordering_terminal_id) VALUES(?,?,?,?,?,NULL,NULL,?,?)").run(id,pairing.printer_id,pairing.restaurant_id,body.name.trim(),tokenHash,now,req.terminal.id);
    return{id,printer_id:pairing.printer_id,restaurant_id:pairing.restaurant_id};
  });
  return sendJson(res,201,{data:{deviceId:device.id,printerId:device.printer_id,restaurantId:device.restaurant_id,token}});
}

export async function downloadAutomaticPrinterSetup({req,res,db,config,session,restaurantId,printerId}){
  const owner=requireRestaurantOwner(db,session,restaurantId),body=await readJson(req,config.bodyLimit);exactObject(body,[]);
  const printer=db.prepare("SELECT * FROM restaurant_printers WHERE id=? AND restaurant_id=? AND enabled=1 AND revoked_at IS NULL").get(printerId,restaurantId);
  if(!printer)throw new HttpError(404,"NOT_FOUND","Enabled restaurant printer not found");
  const now=config.now().toISOString(),code=randomBytes(24).toString("base64url"),expiresAt=new Date(Date.parse(now)+7*86400000).toISOString();
  const setup={schemaVersion:1,product:"cal-eats",restaurantId,printerId,code,expiresAt};
  const zip=await buildPrinterBridgePackage(printer,config.origin,{setup});
  withTransaction(db,()=>{
    db.prepare("INSERT INTO printer_pairing_codes(id,printer_id,code_hash,expires_at,consumed_at,created_at) VALUES(?,?,?,?,NULL,?)").run(randomUUID(),printerId,hash(code),expiresAt,now);
    db.prepare("INSERT INTO audit_events(id,actor_user_id,entity_type,entity_id,action,details,created_at) VALUES(?,?,?,?,?,?,?)").run(randomUUID(),owner.id,"printer",printerId,"printer_setup_downloaded",JSON.stringify({expiresAt,scope:"one printer",singleUse:true}),now);
  });
  res.writeHead(200,{"Content-Type":"application/zip","Content-Disposition":'attachment; filename="Cal-Eats-Printer-Setup.zip"',"Content-Length":zip.length,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"});res.end(zip);return true;
}
