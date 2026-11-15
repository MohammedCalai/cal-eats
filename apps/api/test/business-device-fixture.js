import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes,sign} from 'node:crypto';
import {journeyFixture} from './helpers.js';
import {terminalCanonicalRequest,terminalPairingProof} from '../src/ordering-terminals.js';

// Test-only Windows-key adapter; this does not assert real CNG/hardware support.
// Each extra location and operator must be enrolled/connected explicitly.
export async function enrollRestaurantDevice(f,{restaurantId,cookie,deviceName='Health test adapter'}){
  const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),screenId=randomBytes(18).toString('base64url'),base=`/api/restaurant/restaurants/${restaurantId}/terminal`;
  const origin={Origin:f.config.origin};
  const issued=await f.json(`${base}/pairing-code`,{method:'POST',cookie,headers:origin,body:{}});assert.equal(issued.status,201,issued.text);
  const terminalId=issued.body.data.terminalId,publicKeySpki=keys.publicKey.export({type:'spki',format:'der'}).toString('base64');
  const paired=await f.json('/api/terminal-devices/pair',{method:'POST',body:{terminalId,code:issued.body.data.code,deviceName,publicKeySpki,challengeSignature:sign('sha256',Buffer.from(terminalPairingProof({...issued.body.data,publicKeySpki})),{key:keys.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url')}});assert.equal(paired.status,201,paired.text);
  let token,screenCookie=cookie;
  const signed=async(path,body={},extra={})=>{
    const {sessionToken=true,deviceOnly=false,...options}=extra,timestamp=String(f.config.now().getTime()),nonce=randomBytes(18).toString('base64url'),method=options.method??'POST';
    return f.json(path,{...options,method,body,headers:{...(options.headers??{}),'X-Cal-Eats-Terminal-Id':terminalId,'X-Cal-Eats-Terminal-Timestamp':timestamp,'X-Cal-Eats-Terminal-Nonce':nonce,'X-Cal-Eats-Terminal-Signature':sign('sha256',Buffer.from(terminalCanonicalRequest({terminalId,timestamp,nonce,method,path,body:Buffer.from(JSON.stringify(body))})),{key:keys.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url'),...(token&&sessionToken&&!deviceOnly?{'X-Cal-Eats-Terminal-Session':token}:{})}});
  };
  async function connectUser(nextCookie=screenCookie){
    const handoff=await f.json(`${base}/session-handoff`,{method:'POST',cookie:nextCookie,headers:origin,body:{screenId}});assert.equal(handoff.status,201,handoff.text);
    const grant=await signed(`/api/terminal-devices/${terminalId}/session`,{handoffToken:handoff.body.data.handoffToken},{sessionToken:false});assert.equal(grant.status,201,grant.text);
    token=grant.body.data.sessionToken;screenCookie=nextCookie;return pulse(false);
  }
  async function pulse(renew=true){
    const challenge=await f.json(`${base}/screen-challenge`,{method:'POST',cookie:screenCookie,headers:origin,body:{screenId}});assert.equal(challenge.status,201,challenge.text);
    const result=await signed(`/api/terminal-devices/${terminalId}/screen-heartbeat`,{screenId,challenge:challenge.body.data.challenge});
    if(renew&&result.status===401&&result.body?.error?.code==='TERMINAL_USER_SESSION_EXPIRED')return connectUser(screenCookie);
    assert.equal(result.status,200,result.text);return result;
  }
  await connectUser(cookie);
  return {terminalId,keys,screenId,signed,pulse,connectUser,headless:(path,body={},options={})=>signed(path,body,{...options,sessionToken:false})};
}
export async function businessDeviceFixture(overrides={}){
  const {withPrinter=true,...configOverrides}=overrides,baseTime=Date.parse('2026-01-01T01:00:00.000Z');let timeOffset=0;
  const clock=()=>new Date((configOverrides.now?configOverrides.now().getTime():baseTime)+timeOffset);
  const f=await journeyFixture({...configOverrides,now:clock,rateLimit:{attempts:500,windowMs:60000,...configOverrides.rateLimit}});
  const login=await f.json('/api/auth/login',{method:'POST',headers:{Origin:f.config.origin},body:{email:'restaurant@calai.local',password:'LocalRestaurant!4310'}});assert.equal(login.status,200,login.text);
  const owner=login.headers.get('set-cookie').split(';',1)[0];
  const restaurant=f.db.prepare("SELECT r.* FROM restaurants r JOIN restaurant_memberships m ON m.restaurant_id=r.id JOIN users u ON u.id=m.user_id WHERE u.email='restaurant@calai.local'").get();
  const device=await enrollRestaurantDevice(f,{restaurantId:restaurant.id,cookie:owner});
  const printerId=withPrinter?randomBytes(12).toString('hex'):null,stamp=f.config.now().toISOString();
  if(withPrinter)f.db.prepare('INSERT INTO restaurant_printers(id,restaurant_id,name,enabled,created_at,updated_at) VALUES(?,?,?,1,?,?)').run(printerId,restaurant.id,'Observed printer',stamp,stamp);
  const report=async(state='ready',source='tcp_connect',faults=[],extra={})=>device.headless('/api/terminal-devices/health',{bridgeVersion:'test-adapter',printer:{id:printerId,state,source,faults,physicalReadinessKnown:false,observedAt:f.config.now().toISOString(),...extra}});
  const nativeLogin=async()=>{const r=await f.json('/api/native/business/auth/login',{method:'POST',headers:{Origin:f.config.origin},body:{email:'restaurant@calai.local',password:'LocalRestaurant!4310'}});assert.equal(r.status,200,r.text);return {Authorization:`Bearer ${r.body.data.token}`};};
  return {...f,...device,owner,restaurant,printerId,report,nativeLogin,enrollRestaurant:options=>enrollRestaurantDevice(f,options),advance:ms=>{timeOffset+=ms;}};
}
