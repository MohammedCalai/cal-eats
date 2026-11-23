import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {gzipSync} from "node:zlib";
import {createHash} from "node:crypto";
import {API_ORIGIN,UUID,managedJobId} from "../src/protocol.js";
const root=path.resolve(fileURLToPath(new URL("../",import.meta.url)));
const names=["package.json","src/protocol.js","src/windows-key.js","src/device.js","src/broker.js","src/index.js","windows/terminal-key.ps1"];
const enrolmentKeys=['schemaVersion','product','apiBaseUrl','businessId','terminalId','code','challenge','expiresAt'];
function validatedEnrolment(value){
 if(!value||typeof value!=="object"||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)throw new TypeError("Invalid embedded tablet enrolment.");
 const properties=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(properties);
 if(keys.length!==enrolmentKeys.length||keys.some(key=>!enrolmentKeys.includes(key)||!Object.hasOwn(properties[key],'value')))throw new TypeError("Invalid embedded tablet enrolment.");
 const setup=Object.fromEntries(enrolmentKeys.map(key=>[key,properties[key]?.value]));
 const expires=typeof setup.expiresAt==='string'?Date.parse(setup.expiresAt):NaN,now=Date.now();
 if(setup.schemaVersion!==1||setup.product!=='calai-business-terminal'||setup.apiBaseUrl!==API_ORIGIN||
  ![setup.businessId,setup.terminalId].every(id=>typeof id==='string'&&UUID.test(id)&&id!=='00000000-0000-0000-0000-000000000000')||
  typeof setup.code!=='string'||!/^[A-Za-z0-9_-]{32}$/.test(setup.code)||typeof setup.challenge!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(setup.challenge)||
  !Number.isFinite(expires)||expires<=now||expires>now+11*60_000||new Date(expires).toISOString()!==setup.expiresAt)throw new TypeError("Invalid embedded tablet enrolment.");
 return setup;
}
function renderInstaller({targetSerial='',enrolment=null,deviceName,managed=null}){
 if(typeof targetSerial!=="string"||(targetSerial!==""&&!/^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,119}$/.test(targetSerial)))throw new TypeError("Invalid target tablet serial.");
 if(enrolment!==null&&(!targetSerial||targetSerial!==targetSerial.trim()))throw new TypeError("Embedded tablet enrolment requires an exact target serial.");
 const setup=enrolment===null?null:validatedEnrolment(enrolment);
 if(deviceName!==undefined&&(typeof deviceName!=='string'||deviceName.trim().length<2||deviceName.length>80||/[\r\n\0]/.test(deviceName)))throw new TypeError("Invalid tablet device name.");
 const setupBase64=setup===null?'':Buffer.from(JSON.stringify(setup),'utf8').toString('base64');
 const nameBase64=deviceName===undefined?'':Buffer.from(JSON.stringify(deviceName),'utf8').toString('base64');
 const managedBase64=managed===null?'':Buffer.from(JSON.stringify(managed),'utf8').toString('base64');
 const files=names.map(name=>{const bytes=fs.readFileSync(path.join(root,name));return{name,bytes:bytes.toString("base64"),sha256:createHash("sha256").update(bytes).digest("hex")};});
 const payload=gzipSync(Buffer.from(JSON.stringify({schemaVersion:1,files})));
 const template=fs.readFileSync(new URL("./install-template.ps1",import.meta.url),"utf8");
 return template.replace("__PAYLOAD_BASE64__",payload.toString("base64")).replace("__PAYLOAD_SHA256__",createHash("sha256").update(payload).digest("hex")).replace("__TARGET_SERIAL__",targetSerial).replace("__ENROLMENT_BASE64__",setupBase64).replace("__DEVICE_NAME_BASE64__",nameBase64).replace("__MANAGED_SETUP_BASE64__",managedBase64).replace(/\r?\n/g,"\r\n");
}
export function buildTerminalInstaller({targetSerial='',enrolment=null,deviceName}={}){
 return renderInstaller({targetSerial,enrolment,deviceName});
}
export function buildManagedTerminalInstaller(options){
 if(!options||Object.getPrototypeOf(options)!==Object.prototype)throw new TypeError("Invalid managed tablet setup.");
 const keys=["targetSerial","entraDeviceId","jobId"],properties=Object.getOwnPropertyDescriptors(options);
 if(Reflect.ownKeys(properties).length!==keys.length||!keys.every(key=>Object.hasOwn(properties[key]??{},"value"))){
  throw new TypeError("Invalid managed tablet setup.");
 }
 const {targetSerial,entraDeviceId,jobId}=options;
 if(typeof targetSerial!=="string"||!targetSerial||targetSerial!==targetSerial.trim()||
    !managedJobId(entraDeviceId)||!managedJobId(jobId))throw new TypeError("Invalid managed tablet setup.");
 return renderInstaller({targetSerial,managed:{jobId,entraDeviceId}});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const destination=process.argv[2];if(!destination)throw Error("An output path is required.");
 const output=buildTerminalInstaller();fs.writeFileSync(destination,output,{mode:0o600});
 console.log(JSON.stringify({bytes:Buffer.byteLength(output),assets:names.length,output:destination}));
}
