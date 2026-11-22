import assert from "node:assert/strict";
import crypto from "node:crypto";
import {pairingCanonical, requestCanonical} from "../../terminal-auth/src/protocol.js";

/** Explicit software-key tablet adapter. Ordinary owner/phone requests remain
 * ordinary requests: callers must deliberately choose tablet.json/request for
 * each operational action. No physical Windows CNG or printing is simulated as
 * a verified physical result. Pairing/authentication use the real app routes. */
export async function enrolRegisteredTablet(f, {ownerCookie, businessId, replace = false, deviceName = "Synthetic signed test Surface"} = {}) {
  assert.ok(ownerCookie, "Explicit owner/admin setup authority is required");
  if (!businessId) {
    const context = await f.json("/api/business/context", {cookie: ownerCookie});
    assert.equal(context.status, 200, context.text);
    businessId = context.body.data.id;
  }
  const setup = await f.json(`/api/business/accounts/${businessId}/terminals/setup`, {method: "POST", cookie: ownerCookie, body: {deviceName, ...(replace ? {replace: true} : {})}});
  assert.equal(setup.status, 201, setup.text);
  const pairing = setup.body.data, terminalId = pairing.terminalId;
  const keys = crypto.generateKeyPairSync("ec", {namedCurve: "prime256v1"});
  const publicKeySpki = keys.publicKey.export({type: "spki", format: "der"}).toString("base64");
  const sign = canonical => crypto.sign("sha256", Buffer.from(canonical), {key: keys.privateKey, dsaEncoding: "ieee-p1363"}).toString("base64url");
  const paired = await f.json("/api/terminal-devices/pair", {method: "POST", body: {terminalId, code: pairing.code, deviceName, publicKeySpki, challengeSignature: sign(pairingCanonical({...pairing, publicKeySpki}))}});
  assert.equal(paired.status, 201, paired.text);
  let grant = null;
  function options(target, {method = "GET", body, headers = {}, signal} = {}) {
    const timestamp = String(f.config.now().getTime()), nonce = crypto.randomBytes(24).toString("base64url");
    return {method, ...(body === undefined ? {} : {body}), ...(signal ? {signal} : {}), headers: {
      ...headers,
      "X-Cal-Eats-Terminal-Id": terminalId,
      "X-Cal-Eats-Terminal-Timestamp": timestamp,
      "X-Cal-Eats-Terminal-Nonce": nonce,
      "X-Cal-Eats-Terminal-Signature": sign(requestCanonical({terminalId, timestamp, nonce, method, target, body: body === undefined ? "" : JSON.stringify(body)})),
      ...(grant ? {"X-Cal-Eats-Terminal-Session": grant.token} : {})
    }};
  }
  const request = (target, init) => f.request(target, options(target, init));
  const json = (target, init) => f.json(target, options(target, init));
  async function session() {
    const response = await json(`/api/terminal-devices/${terminalId}/operator-session`, {method: "POST", body: {}});
    assert.equal(response.status, 201, response.text); grant = response.body.data; return grant;
  }
  await session();
  return {json, request, session, options, terminalId, businessId, restaurantId: grant.restaurantId, get expiresAt() {return grant.expiresAt;}};
}

const fixtures = new WeakMap();
/** Deliberately selected on-tablet operation. This never intercepts f.json or
 * changes human authority; callers still use ordinary f.json for phone/browser
 * denial, owner financial reads and owner/admin management workflows. */
export async function tabletJson(f, ownerCookie, target, init) {
  let cache=fixtures.get(f.db);if(!cache){cache={owners:new Map(),businesses:new Map()};fixtures.set(f.db,cache);}
  let entry=cache.owners.get(ownerCookie);
  if(!entry){
    const response=await f.json("/api/business/context",{cookie:ownerCookie});
    assert.equal(response.status,200,response.text);
    const context=response.body.data;
    assert.equal(context.products?.["cal-eats"]?.capabilities?.manageTerminal,true,"A new fixture owner cookie must prove current native tablet-management authority");
    entry=cache.businesses.get(context.id);
    if(!entry){entry={ready:enrolRegisteredTablet(f,{ownerCookie,businessId:context.id}),renewing:null};cache.businesses.set(context.id,entry);const initial=entry;entry.ready.catch(()=>{if(cache.businesses.get(context.id)===initial)cache.businesses.delete(context.id);for(const [cookie,saved]of cache.owners)if(saved===initial)cache.owners.delete(cookie);});}
    cache.owners.set(ownerCookie,entry);
  }
  const tablet=await entry.ready;
  if(Date.parse(tablet.expiresAt)<=f.config.now().getTime()+60_000){
    if(!entry.renewing)entry.renewing=tablet.session().finally(()=>{entry.renewing=null;});
    await entry.renewing;
  }
  return tablet.json(target,init);
}
