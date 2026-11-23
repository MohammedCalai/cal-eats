import crypto from "node:crypto";
import {spawn} from "node:child_process";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {UUID} from "./protocol.js";
export function runWindowsKeyHelper(input,{spawnImpl=spawn,platform=process.platform,timeoutMs=10000}={}){
  if(platform!=="win32")throw Error("Windows terminal identity is required");
  const bytes=JSON.stringify(input);if(Buffer.byteLength(bytes)>32768)throw Error("Tablet key request is too large");
  return new Promise((resolve,reject)=>{
    const helper=fileURLToPath(new URL("../windows/terminal-key.ps1",import.meta.url));
    const exe=path.join(process.env.SystemRoot||"C:\\Windows","System32","WindowsPowerShell","v1.0","powershell.exe");
    const child=spawnImpl(exe,["-NoLogo","-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",helper],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
    let output="",size=0,done=false;
    const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(result);};
    const timer=setTimeout(()=>{child.kill();finish(Error("Tablet key operation timed out"));},timeoutMs);
    child.stdout.on("data",chunk=>{size+=chunk.length;if(size>32768){child.kill();finish(Error("Invalid tablet key response"));}else output+=chunk;});
    child.stderr.resume();child.stdin.on("error",()=>{});
    child.once("error",()=>finish(Error("Tablet key helper could not start")));
    child.once("close",code=>{if(code!==0)return finish(Error("Tablet identity could not be used"));try{finish(null,JSON.parse(output.replace(/^\uFEFF/,"")));}catch{finish(Error("Invalid tablet key response"));}});
    child.stdin.end(bytes);
  });
}
export class WindowsDeviceKey{
  constructor(terminalId,{helper=runWindowsKeyHelper}={}){if(!UUID.test(terminalId))throw Error("Invalid tablet identity");this.terminalId=terminalId;this.helper=helper;}
  validate(value){
    if(value?.machineKey!==true||value.nonExportable!==true||value.aclVerified!==true||value.provider!=="Microsoft Software Key Storage Provider")throw Error("Tablet key protection could not be verified");
    const key=crypto.createPublicKey({key:Buffer.from(value.publicKeySpki,"base64"),type:"spki",format:"der"});
    if(key.asymmetricKeyType!=="ec"||key.asymmetricKeyDetails?.namedCurve!=="prime256v1")throw Error("Invalid tablet public key");
    return value;
  }
  async publicKey({create=false}={}){return this.validate(await this.helper({action:create?"create":"public",terminalId:this.terminalId,provider:"software"}));}
  async sign(canonical){
    if(typeof canonical!=="string"||!(/^(?:CAL-EATS-(?:PAIR|TERMINAL)-V1|Cal-Eats managed terminal (?:evidence|activation) v1)\n/.test(canonical))||
      Buffer.byteLength(canonical)>16384)throw Error("Unsupported tablet signing context");
    const value=this.validate(await this.helper({action:"sign",terminalId:this.terminalId,provider:"software",messageBase64:Buffer.from(canonical).toString("base64")}));
    if(!/^[A-Za-z0-9_-]{86}$/.test(value.signature||"")||!crypto.verify("sha256",Buffer.from(canonical),{key:crypto.createPublicKey({key:Buffer.from(value.publicKeySpki,"base64"),format:"der",type:"spki"}),dsaEncoding:"ieee-p1363"},Buffer.from(value.signature,"base64url")))throw Error("Tablet signature verification failed");
    return value.signature;
  }
}
