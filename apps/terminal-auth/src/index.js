import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {TerminalDevice,readManagedSetup} from "./device.js";
import {startBroker} from "./broker.js";
import {API_ORIGIN,BROKER_PORT,exactObject,encodeManagedEvidence,managedJobId,validManagedDeliveryRevision} from "./protocol.js";

async function installedConfig(configPath){
  const config=JSON.parse(await fs.readFile(configPath,"utf8"));
  exactObject(config,["schemaVersion","product","apiBaseUrl","port","deviceName"]);
  if(config.schemaVersion!==1||config.product!=="calai-business-terminal"||config.apiBaseUrl!==API_ORIGIN||config.port!==BROKER_PORT||typeof config.deviceName!=="string"||config.deviceName.length<2||config.deviceName.length>80)throw Error("Installed tablet configuration is invalid");
  const root=path.dirname(configPath);
  return {config,identityPath:path.join(root,"var","terminal-identity.json"),
    setupPath:path.join(root,"enrolment.json"),managedPath:path.join(root,"var","managed-terminal-setup.json")};
}
async function missing(file){
  try{await fs.access(file);return false;}catch(error){if(error.code==="ENOENT")return true;throw error;}
}
export function managedSetupPoller({device,managedPath,clock=Date.now}){
  const backoffs=[30000,60000,120000,300000];
  let nextCheck=0,retries=0,jobId=null,working=null;
  return async function poll(){
    if(working)return working;
    let pending;
    try{pending=await readManagedSetup(managedPath);}
    catch(error){device.managedSetupPending=false;throw error;}
    device.managedSetupPending=pending?.state==="pending"&&!device.identity;
    if(!pending||pending.state==="closed")return;
    if(device.identity&&(!device.identity.paired||device.identity.terminalId!==pending.jobId||
        device.identity.publicKeySpki!==pending.publicKeySpki))return;
    if(working)return working;
    if(pending.jobId!==jobId){jobId=pending.jobId;nextCheck=0;retries=0;}
    if(clock()<nextCheck)return;
    working=(async()=>{
      try{
        if(await device.activateManagedSetup(pending)){
          await fs.rm(managedPath,{force:true});
          device.managedSetupPending=false;
          nextCheck=0;retries=0;
        }else{
          retries=0;nextCheck=clock()+backoffs[0];
        }
      }catch(error){
        if(error.status===410&&error.code==="MANAGED_SETUP_CLOSED"){
          // Keep the protected metadata and Windows key. Only an explicit
          // server closure permits later setup of a different unpaired job.
          await device.saveProtectedJson(managedPath,{...pending,state:"closed"});
          device.managedSetupPending=false;
        }else nextCheck=clock()+backoffs[Math.min(retries++,backoffs.length-1)];
        throw error;
      }
    })();
    try{return await working;}finally{working=null;}
  };
}
const managedSetupCodes=new Set([
  "MANAGED_SETUP_CLOSED","TABLET_LOCAL_REPLACEMENT_REQUIRED","TABLET_MANAGED_KEY_CHANGED",
  "TABLET_MANAGED_SETUP_CONFLICT","TABLET_MANAGED_SETUP_INVALID","TABLET_SIGNATURE_INVALID",
]);
function managedEvidenceDiagnostic(error,stage){
  const code=error?.code;
  const keyError=/^TABLET_KEY_[A-Z_]{3,40}$/.test(code||"");
  const knownCode=keyError||managedSetupCodes.has(code);
  const status=keyError&&/^[0-9A-F]{8}$/.test(error.windowsStatus||"")?error.windowsStatus:"00000000";
  return `CAL_EATS_MANAGED_SETUP_ERROR_V1:${knownCode?code:stage}:${status}`;
}
async function manageInstalledSetup(configPath,jobId,revisionArgument){
  let stage="TABLET_MANAGED_REQUEST";
  const deliveryRevision=revisionArgument===undefined?1:Number(revisionArgument);
  try{
    if(!configPath||!managedJobId(jobId)||!validManagedDeliveryRevision(deliveryRevision)||
      (revisionArgument!==undefined&&(deliveryRevision<2||String(deliveryRevision)!==revisionArgument)))throw Error();
    stage="TABLET_MANAGED_CONFIG";
    const {config,identityPath,setupPath,managedPath}=await installedConfig(path.resolve(configPath));
    stage="TABLET_MANAGED_LEGACY_SETUP";
    if(!await missing(setupPath))throw Error();
    stage="TABLET_MANAGED_IDENTITY_LOAD";
    const device=await new TerminalDevice({identityPath,managedPath,apiBaseUrl:config.apiBaseUrl}).load();
    stage="TABLET_MANAGED_EVIDENCE_PREPARE";
    const evidence=await device.prepareManagedSetup(jobId,managedPath,deliveryRevision);
    stage="TABLET_MANAGED_EVIDENCE_ENCODE";
    process.stdout.write(encodeManagedEvidence(evidence)+"\n");
  }catch(error){
    process.stderr.write(managedEvidenceDiagnostic(error,stage)+"\n");
    process.exitCode=1;
  }
}
export async function startInstalledBroker({configPath,signal,logger=record=>process.stdout.write(JSON.stringify(record)+"\n")}){
  const {config,identityPath,setupPath,managedPath}=await installedConfig(configPath);
  const device=await new TerminalDevice({identityPath,managedPath,apiBaseUrl:config.apiBaseUrl}).load();
  if(!device.identity){
    try{device.managedSetupPending=(await readManagedSetup(managedPath))?.state==="pending";}
    catch(error){if(error.code!=="TABLET_MANAGED_SETUP_INVALID")throw error;}
  }
  const broker=await startBroker({device,origin:API_ORIGIN,port:BROKER_PORT,signal});
  const pollManaged=managedSetupPoller({device,managedPath});
  const logError=error=>logger({at:new Date().toISOString(),event:"tablet_connection_waiting",code:/^[A-Z][A-Z0-9_]{2,80}$/.test(error.code||"")?error.code:"TABLET_SETUP_REQUIRED"});
  let active=false;
  const tick=async()=>{
    if(active||signal?.aborted)return;active=true;
    try{
      let setup=null;try{setup=JSON.parse(await fs.readFile(setupPath,"utf8"));}catch(error){if(error.code!=="ENOENT")throw error;}
      if(setup){await device.enrol({...setup,deviceName:config.deviceName});await fs.rm(setupPath);}
      else try{await pollManaged();}catch(error){logError(error);}
      if(device.identity?.paired)await device.heartbeat();
    }catch(error){logError(error);}
    finally{active=false;}
  };
  const timer=setInterval(()=>void tick(),15000);timer.unref();
  signal?.addEventListener("abort",()=>clearInterval(timer),{once:true});
  await tick();
  logger({at:new Date().toISOString(),event:"tablet_broker_started",paired:device.identity?.paired===true});
  return {...broker,device};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const index=process.argv.indexOf("--config"),configPath=index>=0&&process.argv[index+1];
  const managedIndex=process.argv.indexOf("--prepare-managed");
  if(managedIndex>=0)await manageInstalledSetup(configPath,process.argv[managedIndex+1],process.argv[managedIndex+2]);
  else if(!configPath){process.stderr.write("A protected tablet configuration is required.\n");process.exitCode=1;}
  else{
    const controller=new AbortController();
    process.once("SIGTERM",()=>controller.abort());process.once("SIGINT",()=>controller.abort());
    startInstalledBroker({configPath:path.resolve(configPath),signal:controller.signal})
      .catch(()=>{process.stderr.write("The protected restaurant tablet service could not start.\n");process.exitCode=1;});
  }
}
