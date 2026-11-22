import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {TerminalDevice} from "./device.js";
import {startBroker} from "./broker.js";
import {API_ORIGIN,BROKER_PORT,exactObject} from "./protocol.js";

export async function startInstalledBroker({configPath,signal,logger=record=>process.stdout.write(JSON.stringify(record)+"\n")}){
  const config=JSON.parse(await fs.readFile(configPath,"utf8"));
  exactObject(config,["schemaVersion","product","apiBaseUrl","port","deviceName"]);
  if(config.schemaVersion!==1||config.product!=="calai-business-terminal"||config.apiBaseUrl!==API_ORIGIN||config.port!==BROKER_PORT||typeof config.deviceName!=="string"||config.deviceName.length<2||config.deviceName.length>80)throw Error("Installed tablet configuration is invalid");
  const root=path.dirname(configPath),identityPath=path.join(root,"var","terminal-identity.json"),setupPath=path.join(root,"enrolment.json");
  const device=await new TerminalDevice({identityPath,apiBaseUrl:config.apiBaseUrl}).load();
  const broker=await startBroker({device,origin:API_ORIGIN,port:BROKER_PORT,signal});
  let active=false;
  const tick=async()=>{
    if(active||signal?.aborted)return;active=true;
    try{
      let setup=null;try{setup=JSON.parse(await fs.readFile(setupPath,"utf8"));}catch(error){if(error.code!=="ENOENT")throw error;}
      if(setup){await device.enrol({...setup,deviceName:config.deviceName});await fs.rm(setupPath);}
      if(device.identity?.paired)await device.heartbeat();
    }catch(error){logger({at:new Date().toISOString(),event:"tablet_connection_waiting",code:/^[A-Z][A-Z0-9_]{2,80}$/.test(error.code||"")?error.code:"TABLET_SETUP_REQUIRED"});}
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
  if(!configPath){process.stderr.write("A protected tablet configuration is required.\n");process.exitCode=1;}
  else{
    const controller=new AbortController();
    process.once("SIGTERM",()=>controller.abort());process.once("SIGINT",()=>controller.abort());
    startInstalledBroker({configPath:path.resolve(configPath),signal:controller.signal}).catch(()=>{process.stderr.write("The protected restaurant tablet service could not start.\n");process.exitCode=1;});
  }
}
