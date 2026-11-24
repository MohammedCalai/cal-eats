import crypto from "node:crypto";
import {spawn} from "node:child_process";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {UUID} from "./protocol.js";

function keyError(code, windowsStatus="00000000"){
  return Object.assign(new Error("Tablet identity could not be used"),{code,windowsStatus});
}

export function runWindowsKeyHelper(input,{spawnImpl=spawn,platform=process.platform,timeoutMs=10000}={}){
  if(platform!=="win32")throw Error("Windows terminal identity is required");
  const bytes=JSON.stringify(input);if(Buffer.byteLength(bytes)>32768)throw Error("Tablet key request is too large");
  return new Promise((resolve,reject)=>{
    const helper=fileURLToPath(new URL("../windows/terminal-key.ps1",import.meta.url));
    const exe=path.join(process.env.SystemRoot||"C:\\Windows","System32","WindowsPowerShell","v1.0","powershell.exe");
    const child=spawnImpl(exe,["-NoLogo","-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",helper],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
    let output="",size=0,done=false;
    const errorChunks=[];
    let errorSize=0;
    const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(result);};
    const timer=setTimeout(()=>{child.kill();finish(keyError("TABLET_KEY_HELPER_TIMEOUT"));},timeoutMs);
    child.stdout.on("data",chunk=>{
      size+=chunk.length;
      if(size>32768){child.kill();finish(keyError("TABLET_KEY_RESPONSE_INVALID"));}
      else output+=chunk;
    });
    child.stderr.on("data",chunk=>{
      errorSize+=chunk.length;
      if(errorSize<=4096)errorChunks.push(chunk);
    });
    child.stdin.on("error",()=>{});
    child.once("error",()=>finish(keyError("TABLET_KEY_HELPER_START")));
    child.once("close",code=>{
      if(code!==0){
        // Consume only a single typed result, never propagate native stderr.
        const diagnostic=errorSize<=4096&&
          /^CAL_EATS_TERMINAL_KEY_V1:(TABLET_KEY_[A-Z_]{3,40}):([0-9A-F]{8})(?:\r?\n)?(?![\s\S])/.exec(Buffer.concat(errorChunks).toString("utf8"));
        return finish(diagnostic?keyError(diagnostic[1],diagnostic[2]):keyError("TABLET_KEY_HELPER_EXIT"));
      }
      try{finish(null,JSON.parse(output.replace(/^\uFEFF/,"")));}
      catch{finish(keyError("TABLET_KEY_RESPONSE_INVALID"));}
    });
    child.stdin.end(bytes);
  });
}
export class WindowsDeviceKey{
  constructor(terminalId,{helper=runWindowsKeyHelper}={}){if(!UUID.test(terminalId))throw Error("Invalid tablet identity");this.terminalId=terminalId;this.helper=helper;}
  validate(value){
    if(value?.machineKey!==true||value.nonExportable!==true||value.aclVerified!==true||value.provider!=="Microsoft Software Key Storage Provider")throw keyError("TABLET_KEY_PROTECTION_INVALID");
    let key;
    try{key=crypto.createPublicKey({key:Buffer.from(value.publicKeySpki,"base64"),type:"spki",format:"der"});}
    catch{throw keyError("TABLET_KEY_PUBLIC_INVALID");}
    if(key.asymmetricKeyType!=="ec"||key.asymmetricKeyDetails?.namedCurve!=="prime256v1")throw keyError("TABLET_KEY_PUBLIC_INVALID");
    return value;
  }
  async publicKey({create=false}={}){return this.validate(await this.helper({action:create?"create":"public",terminalId:this.terminalId,provider:"software"}));}
  async sign(canonical){
    if(typeof canonical!=="string"||!/^(?:CAL-EATS-(?:PAIR|TERMINAL)-V1|Cal-Eats managed terminal (?:evidence v[12]|activation v1))\n/.test(canonical)||
      Buffer.byteLength(canonical)>16384)throw Error("Unsupported tablet signing context");
    const value=this.validate(await this.helper({action:"sign",terminalId:this.terminalId,provider:"software",messageBase64:Buffer.from(canonical).toString("base64")}));
    if(!/^[A-Za-z0-9_-]{86}$/.test(value.signature||"")||!crypto.verify("sha256",Buffer.from(canonical),{key:crypto.createPublicKey({key:Buffer.from(value.publicKeySpki,"base64"),format:"der",type:"spki"}),dsaEncoding:"ieee-p1363"},Buffer.from(value.signature,"base64url")))throw keyError("TABLET_KEY_SIGNATURE_INVALID");
    return value.signature;
  }
}
