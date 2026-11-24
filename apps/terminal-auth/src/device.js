import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {API_ORIGIN,UUID,exactObject,failure,pairingCanonical,requestCanonical,requestAllowed,managedJobId,managedPublicKey,managedEvidenceCanonical,managedActivationCanonical,validManagedDeliveryRevision} from "./protocol.js";
import {WindowsDeviceKey} from "./windows-key.js";
export class TerminalDevice{
  constructor({identityPath,managedPath=null,apiBaseUrl=API_ORIGIN,fetchImpl=globalThis.fetch,keyFactory=id=>new WindowsDeviceKey(id),clock=Date.now,randomBytes=crypto.randomBytes,timeoutMs=10000}){
    const url=new URL(apiBaseUrl);
    if(url.origin!==API_ORIGIN&&!(url.protocol==="http:"&&url.hostname==="127.0.0.1"))throw Error("Tablet API origin is not approved");
    if(url.origin!==apiBaseUrl)throw Error("Tablet API must be an origin");
    this.apiBaseUrl=apiBaseUrl;this.identityPath=identityPath;this.managedPath=managedPath;this.fetch=fetchImpl;this.keyFactory=keyFactory;this.clock=clock;this.randomBytes=randomBytes;this.timeoutMs=timeoutMs;this.identity=null;this.grant=null;this.windows=new Map();this.pairing=false;this.connecting=null;this.generation=0;this.closed=false;this.managedSetupPending=false;
  }
  async load(){
    try{
      const value=JSON.parse(await fs.readFile(this.identityPath,"utf8"));
      if(value.product!=="calai-business-terminal"||value.schemaVersion!==1||!UUID.test(value.terminalId)||typeof value.paired!=="boolean"||(value.paired&&!UUID.test(value.businessId)))throw Error("Saved tablet identity is invalid");
      const key=await this.keyFactory(value.terminalId).publicKey();
      if(key.publicKeySpki!==value.publicKeySpki)throw Error("Saved tablet identity does not match its Windows key");
      this.identity=value;
    }catch(error){if(error.code!=="ENOENT")throw error;}
    return this;
  }
  async saveProtectedJson(destination,value){
    await fs.mkdir(path.dirname(destination),{recursive:true,mode:0o700});
    const tmp=destination+"."+process.pid+"."+this.randomBytes(8).toString("hex")+".tmp";
    const file=await fs.open(tmp,"wx",0o600);
    try{
      try{await file.writeFile(JSON.stringify(value)+"\n");}finally{await file.close();}
      await fs.rename(tmp,destination);
    }finally{await fs.rm(tmp,{force:true});}
  }
  async saveIdentity(value){
    await this.saveProtectedJson(this.identityPath,value);
    this.identity=value;
  }
  bootstrap(){return {paired:this.identity?.paired===true,terminalId:this.identity?.terminalId||null,businessId:this.identity?.businessId||null,revoked:this.revoked===true,...(!this.identity&&this.managedSetupPending?{managedSetupPending:true}:{})};}
  clearGrant(expected=this.grant){if(this.grant!==expected)return;this.grant=null;this.windows.clear();this.generation++;this.connecting=null;}
  assertCurrent(identity,generation,{grant=null,windowProof=null,windowBinding=null}={}){
    if(this.closed||this.identity!==identity||this.generation!==generation||(grant&&this.grant!==grant))throw failure("TABLET_SESSION_CHANGED",409);
    if(windowBinding&&(this.windows.get(windowProof)!==windowBinding||windowBinding.expiresAt<=this.clock()))throw failure("TABLET_WINDOW_PROOF_REQUIRED",403);
  }
  async _fetch(method,target,rawBody,headers={},includeStatus=false){
    let response;
    try{response=await this.fetch(new URL(target,this.apiBaseUrl),{method,headers:{accept:"application/json","content-type":"application/json",...headers},...(method==="GET"?{}:{body:rawBody}),redirect:"error",signal:AbortSignal.timeout(this.timeoutMs)});}
    catch{throw failure("TABLET_NETWORK_UNAVAILABLE",503);}
    const chunks=[];let size=0;
    for await(const chunk of response.body||[]){size+=chunk.length;if(size>1048576)throw failure("TABLET_RESPONSE_TOO_LARGE",503);chunks.push(chunk);}
    let value;try{value=JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{throw failure("TABLET_RESPONSE_INVALID",503);}
    if(!response.ok){const code=/^[A-Z][A-Z0-9_]{2,80}$/.test(value.error?.code||"")?value.error.code:"TABLET_REQUEST_REJECTED";throw failure(code,response.status);}
    const data=Object.hasOwn(value,"data")?value.data:value;
    return includeStatus?{status:response.status,data}:data;
  }
  async prepareManagedSetup(jobId,setupPath,deliveryRevision=1){
    if(!managedJobId(jobId)||!validManagedDeliveryRevision(deliveryRevision))throw failure("TABLET_MANAGED_SETUP_INVALID");
    if(this.identity&&(!this.identity.paired||this.identity.terminalId!==jobId))throw failure("TABLET_LOCAL_REPLACEMENT_REQUIRED",409);
    const pending=await readManagedSetup(setupPath);
    if(pending&&pending.jobId!==jobId&&pending.state!=="closed")throw failure("TABLET_MANAGED_SETUP_CONFLICT",409);
    if(pending?.jobId===jobId&&pending.state==="closed")throw failure("MANAGED_SETUP_CLOSED",410);
    const key=this.keyFactory(jobId);
    const {publicKeySpki}=await key.publicKey({create:!this.identity&&pending?.jobId!==jobId,managedSetup:true});
    if(!managedPublicKey(publicKeySpki)||(this.identity&&this.identity.publicKeySpki!==publicKeySpki)||
        (pending?.jobId===jobId&&pending.publicKeySpki!==publicKeySpki))throw failure("TABLET_MANAGED_KEY_CHANGED",409);
    const signature=await key.sign(managedEvidenceCanonical({jobId,publicKeySpki,deliveryRevision}));
    if(!/^[A-Za-z0-9_-]{86}$/.test(signature))throw failure("TABLET_SIGNATURE_INVALID",503);
    if(!this.identity?.paired&&pending?.jobId!==jobId){
      await this.saveProtectedJson(setupPath,{schemaVersion:1,jobId,publicKeySpki,state:"pending"});
    }
    return {jobId,...(deliveryRevision>1?{deliveryRevision}:{}),publicKeySpki,signature};
  }
  async activateManagedSetup({jobId,publicKeySpki}){
    if(!managedJobId(jobId)||!managedPublicKey(publicKeySpki))throw failure("TABLET_MANAGED_SETUP_INVALID");
    if(this.identity){
      if(this.identity.terminalId===jobId&&this.identity.publicKeySpki===publicKeySpki&&this.identity.paired)return true;
      throw failure("TABLET_LOCAL_REPLACEMENT_REQUIRED",409);
    }
    if(this.pairing)throw failure("TABLET_ENROLMENT_BUSY",409);
    if(this.closed)throw failure("TABLET_SERVICE_STOPPED",503);
    this.pairing=true;
    const generation=this.generation;
    try{
      const key=this.keyFactory(jobId),publicKey=await key.publicKey();
      if(publicKey.publicKeySpki!==publicKeySpki)throw failure("TABLET_MANAGED_KEY_CHANGED",409);
      const target="/api/terminal-devices/managed-enrolment";
      const intent={jobId,publicKeySpki};
      this.assertCurrent(null,generation);
      const {status,data}=await this._fetch("POST",target,JSON.stringify(intent),{},true);
      this.assertCurrent(null,generation);
      if(status===202)return false;
      if(status!==200)throw failure("TABLET_MANAGED_RESPONSE_INVALID",503);
      const challenge=data?.challenge;
      if(typeof challenge!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(challenge))throw failure("TABLET_MANAGED_RESPONSE_INVALID",503);
      const signature=await key.sign(managedActivationCanonical({...intent,challenge}));
      if(!/^[A-Za-z0-9_-]{86}$/.test(signature))throw failure("TABLET_SIGNATURE_INVALID",503);
      this.assertCurrent(null,generation);
      const result=await this._fetch("POST",target,JSON.stringify({...intent,challenge,signature}),{},true);
      this.assertCurrent(null,generation);
      const saved=result.data;
      if(result.status!==201||saved?.paired!==true||saved.terminalId!==jobId||!managedJobId(saved.businessId)||
        typeof saved.registeredAt!=="string"||!Number.isFinite(Date.parse(saved.registeredAt)))throw failure("TABLET_MANAGED_RESPONSE_INVALID",503);
      await this.saveIdentity({schemaVersion:1,product:"calai-business-terminal",terminalId:jobId,publicKeySpki,
        paired:true,businessId:saved.businessId,pairedAt:saved.registeredAt});
      this.clearGrant();this.revoked=false;
      return true;
    }finally{this.pairing=false;}
  }
  async enrol(body){
    exactObject(body,["terminalId","code","challenge","deviceName","businessId","apiBaseUrl","expiresAt"]);
    if(!UUID.test(body.terminalId)||typeof body.code!=="string"||!/^[A-Za-z0-9_-]{8,200}$/.test(body.code)||typeof body.deviceName!=="string"||body.deviceName.trim().length<2||body.deviceName.length>80||(body.businessId!==undefined&&!UUID.test(body.businessId))||(body.apiBaseUrl!==undefined&&body.apiBaseUrl!==this.apiBaseUrl))throw failure("TABLET_ENROLMENT_INVALID");
    if(this.managedPath&&(await readManagedSetup(this.managedPath))?.state==="pending")throw failure("TABLET_MANAGED_SETUP_CONFLICT",409);
    if(this.pairing)throw failure("TABLET_ENROLMENT_BUSY",409);
    if(this.closed)throw failure("TABLET_SERVICE_STOPPED",503);
    if(this.identity&&this.identity.terminalId!==body.terminalId)throw failure("TABLET_LOCAL_REPLACEMENT_REQUIRED",409);
    this.pairing=true;this.clearGrant();const generation=this.generation;
    try{
      const key=this.keyFactory(body.terminalId),pub=await key.publicKey({create:true});
      const challengeSignature=await key.sign(pairingCanonical({terminalId:body.terminalId,challenge:body.challenge,publicKeySpki:pub.publicKeySpki}));
      if(!this.identity)await this.saveIdentity({schemaVersion:1,product:"calai-business-terminal",terminalId:body.terminalId,publicKeySpki:pub.publicKeySpki,paired:false});
      const result=await this._fetch("POST","/api/terminal-devices/pair",JSON.stringify({terminalId:body.terminalId,code:body.code,deviceName:body.deviceName.trim(),publicKeySpki:pub.publicKeySpki,challengeSignature}));
      if(this.closed||this.generation!==generation)throw failure("TABLET_SESSION_CHANGED",409);
      if(result.terminalId!==body.terminalId||!UUID.test(result.businessId)||(body.businessId&&result.businessId!==body.businessId))throw failure("TABLET_ENROLMENT_RESPONSE_INVALID",503);
      await this.saveIdentity({...this.identity,paired:true,businessId:result.businessId,pairedAt:new Date(this.clock()).toISOString()});
      this.clearGrant();this.revoked=false;
      return this.bootstrap();
    }finally{this.pairing=false;}
  }
  async signed(method,target,body={},grant=null,headers={},window={}){
    if(!this.identity?.paired)throw failure("TABLET_NOT_ENROLLED",403);
    const identity=this.identity,generation=this.generation,binding={grant,...window};
    this.assertCurrent(identity,generation,binding);
    const rawBody=method==="GET"?"":JSON.stringify(body),timestamp=String(this.clock()),nonce=this.randomBytes(24).toString("base64url"),terminalId=this.identity.terminalId;
    const signature=await this.keyFactory(terminalId).sign(requestCanonical({terminalId,timestamp,nonce,method,target,body:rawBody}));
    this.assertCurrent(identity,generation,binding);
    try{const result=await this._fetch(method,target,rawBody,{"X-Cal-Eats-Terminal-Id":terminalId,"X-Cal-Eats-Terminal-Timestamp":timestamp,"X-Cal-Eats-Terminal-Nonce":nonce,"X-Cal-Eats-Terminal-Signature":signature,...(grant?{"X-Cal-Eats-Terminal-Session":grant.token}:{}),...headers});this.assertCurrent(identity,generation,binding);return result;}
    catch(error){
      this.assertCurrent(identity,generation,binding);
      if(["TERMINAL_REVOKED","TABLET_REVOKED"].includes(error.code)){this.revoked=true;this.clearGrant();}
      else if(grant&&(error.status===401||["TERMINAL_BUSINESS_UNAVAILABLE","TERMINAL_BUSINESS_CHANGED","TERMINAL_SESSION_REQUIRED","TERMINAL_SESSION_EXPIRED"].includes(error.code)))this.clearGrant(grant);
      throw error;
    }
  }
  async ensureGrant(){
    if(this.closed)throw failure("TABLET_SERVICE_STOPPED",503);
    if(this.grant&&Date.parse(this.grant.expiresAt)>this.clock()+60000)return this.grant;
    if(this.connecting)return this.connecting;
    const expected=this.grant,identity=this.identity,generation=this.generation;
    const intent=(async()=>{
      const result=await this.signed("POST","/api/terminal-devices/"+this.identity?.terminalId+"/operator-session",{});
      this.assertCurrent(identity,generation);
      if(result.terminalId!==this.identity.terminalId||result.businessId!==this.identity.businessId||result.principalKind!=="terminal"||result.user?.role!=="restaurant"||!UUID.test(result.user?.id||"")||typeof result.token!=="string"||!/^[A-Za-z0-9_-]{32,500}$/.test(result.token)||!Number.isFinite(Date.parse(result.expiresAt))||Date.parse(result.expiresAt)<=this.clock()||Date.parse(result.expiresAt)>this.clock()+3600000||(result.restaurantId!==null&&!UUID.test(result.restaurantId||""))||typeof result.products?.calai?.active!=="boolean"||typeof result.products?.["cal-eats"]?.active!=="boolean")throw failure("TABLET_SESSION_RESPONSE_INVALID",503);
      if(this.grant!==expected)throw failure("TABLET_SESSION_CHANGED",409);
      this.grant=result;this.revoked=false;
      return result;
    })();
    this.connecting=intent;
    try{return await intent;}finally{if(this.connecting===intent)this.connecting=null;}
  }
  async automaticSession(body){
    exactObject(body,["screenId"]);if(!UUID.test(body.screenId||""))throw failure("TABLET_SCREEN_INVALID");
    const grant=await this.ensureGrant();
    for(const [proof,window]of this.windows)if(window.expiresAt<=this.clock())this.windows.delete(proof);
    for(const [proof,window]of this.windows)if(window.screenId===body.screenId)this.windows.delete(proof);
    if(this.windows.size>=16)throw failure("TABLET_WINDOW_LIMIT",429);
    const windowProof=this.randomBytes(32).toString("base64url");
    this.windows.set(windowProof,{terminalId:this.identity.terminalId,businessId:this.identity.businessId,screenId:body.screenId,expiresAt:Date.parse(grant.expiresAt)});
    const user={id:grant.user.id,role:"restaurant",...(typeof grant.user.name==="string"?{name:grant.user.name.slice(0,100)}:{})};
    const products={};
    for(const name of ["calai","cal-eats"]){const source=grant.products?.[name];if(typeof source?.active!=="boolean")throw failure("TABLET_SESSION_RESPONSE_INVALID",503);products[name]={active:source.active,...(typeof source.linked==="boolean"?{linked:source.linked}:{}),...(["active","inactive","unlinked"].includes(source.status)?{status:source.status}:{}),...(typeof source.sourceAccountId==="string"&&source.sourceAccountId.length<=100?{sourceAccountId:source.sourceAccountId}:source.sourceAccountId===null?{sourceAccountId:null}:{})};}
    return {terminalId:grant.terminalId,businessId:grant.businessId,restaurantId:grant.restaurantId??null,principalKind:"terminal",user,products,screenId:body.screenId,expiresAt:grant.expiresAt,windowProof};
  }
  captureWindow(proof){
    const window=typeof proof==="string"&&this.windows.get(proof);
    if(!window||window.expiresAt<=this.clock()||window.terminalId!==this.identity?.terminalId||window.businessId!==this.identity?.businessId)throw failure("TABLET_WINDOW_PROOF_REQUIRED",403);
    return window;
  }
  async forward(body,{windowProof}={}){
    exactObject(body,["method","path","body","headers"]);const windowBinding=this.captureWindow(windowProof);
    const grant=await this.ensureGrant();
    if(this.captureWindow(windowProof)!==windowBinding)throw failure("TABLET_WINDOW_PROOF_REQUIRED",403);
    const method=typeof body.method==="string"?body.method.toUpperCase():"";
    if(!requestAllowed(method,body.path,grant.restaurantId,grant.businessId))throw failure("TABLET_OPERATION_DENIED",403);
    if(method==="GET"&&Object.hasOwn(body,"body")&&body.body!==null)throw failure("TABLET_GET_BODY_INVALID");
    const headers={};
    if(body.headers!==undefined){
      exactObject(body.headers,["Idempotency-Key"]);
      const key=body.headers["Idempotency-Key"];
      if(key!==undefined){if(typeof key!=="string"||!/^[A-Za-z0-9_.:-]{8,200}$/.test(key))throw failure("TABLET_IDEMPOTENCY_INVALID");headers["Idempotency-Key"]=key;}
    }
    const signingOut=method==='POST'&&body.path===`/api/business/accounts/${grant.businessId}/surface/heartbeat`&&body.body?.state==='signed_out';
    try{return await this.signed(method,body.path,body.body??{},grant,headers,{windowProof,windowBinding});}
    finally{if(signingOut)this.clearGrant(grant);}
  }
  heartbeat(){return this.signed("POST","/api/terminal-devices/"+this.identity?.terminalId+"/heartbeat",{});}
  close(){this.closed=true;this.clearGrant();}
}
export async function readManagedSetup(setupPath){
  try{
    const stat=await fs.stat(setupPath);
    if(stat.size<1||stat.size>4096)throw failure("TABLET_MANAGED_SETUP_INVALID");
    const value=JSON.parse(await fs.readFile(setupPath,"utf8"));
    exactObject(value,["schemaVersion","jobId","publicKeySpki","state"]);
    if(value.schemaVersion!==1||!managedJobId(value.jobId)||!managedPublicKey(value.publicKeySpki)||
        !["pending","closed"].includes(value.state))throw failure("TABLET_MANAGED_SETUP_INVALID");
    return value;
  }catch(error){
    if(error.code==="ENOENT")return null;
    if(error instanceof SyntaxError||error.code==="TABLET_BODY_INVALID")throw failure("TABLET_MANAGED_SETUP_INVALID");
    throw error;
  }
}
