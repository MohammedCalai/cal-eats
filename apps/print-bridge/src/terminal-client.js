import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ApiError } from "./api-client.js";
import { WindowsTerminalKey, UUID, pairingCanonical, requestCanonical } from "./terminal-signing.js";

const ID = "[A-Za-z0-9_-]{8,100}";
const ORDER_COMMAND = new RegExp(`^/api/restaurant/orders/${ID}/(status|preparation)$`);
const PRINT_COMMAND = new RegExp(`^/api/restaurant/restaurants/(${ID})/printers/${ID}/(?:test-receipt|reprints)$`);
const SERVICE_COMMAND = new RegExp(`^/api/devices/(?:pair|heartbeat|jobs/claim|jobs/${ID}/(?:ack|submitting))$`);

export function merchantRequestAllowed(method, target, restaurantId) {
  if (typeof target !== "string" || !target.startsWith("/api/") || /[\\\r\n#%]/.test(target) || target.includes("..") || target.includes("//")) return false;
  const url = new URL(target, "https://eats.calai.info");
  if (method === "PATCH" && ORDER_COMMAND.test(url.pathname)) return !url.search;
  const printer = PRINT_COMMAND.exec(url.pathname);
  if (printer && printer[1] === restaurantId && method === "POST") return !url.search;
  const check = new RegExp(`^/api/restaurant/restaurants/(${ID})/printers/${ID}/jobs/${ID}/check$`).exec(url.pathname);
  if (method === "POST" && check && check[1] === restaurantId) return !url.search;
  if (method === "POST" && new RegExp(`^/api/orders/${ID}/print-jobs$`).test(url.pathname)) return !url.search;
  if (method === "PATCH" && new RegExp(`^/api/print-jobs/${ID}$`).test(url.pathname)) return !url.search;
  if (method === "PATCH" && new RegExp(`^/api/restaurant/incidents/${ID}/read$`).test(url.pathname)) return !url.search;
  // Only the current restaurant's diagnostic read; no admin/customer/auth, arbitrary GET,
  // legal acceptance, pairing/revocation, uploads or raw bytes signing proxy.
  if (method === "GET") return url.pathname===`/api/restaurant/restaurants/${restaurantId}/operations-health`&&!url.search;
  return false;
}

export class TerminalClient {
  constructor({ baseUrl, identityPath, timeoutMs = 10_000, fetchImpl = globalThis.fetch, keyFactory = id => new WindowsTerminalKey(id), clock = Date.now, randomBytes = crypto.randomBytes }) {
    const origin = new URL(baseUrl);
    if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" || (origin.origin !== "https://eats.calai.info" && !(origin.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(origin.hostname)))) throw new Error("Terminal API must be Cal-Eats or an explicit loopback test origin");
    this.baseUrl = origin.origin; this.identityPath = identityPath; this.timeoutMs = timeoutMs; this.fetchImpl = fetchImpl; this.keyFactory = keyFactory; this.clock = clock; this.randomBytes = randomBytes;
    this.identity = null; this.session = null; this.pairing = false; this.sessionGeneration = 0; this.handoffSequence = 0;
  }
  async load() {
    try {
      const value = JSON.parse(await fs.readFile(this.identityPath, "utf8"));
      if (value.product !== "cal-eats-terminal" || value.schemaVersion !== 1 || !UUID.test(value.terminalId) || typeof value.paired !== "boolean" || (value.paired && !UUID.test(value.restaurantId))) throw new Error("Invalid saved terminal identity");
      const key = await this.keyFactory(value.terminalId).publicKey();
      if (key.publicKeySpki !== value.publicKeySpki) throw new Error("Saved terminal identity does not match the Windows device key");
      this.identity = value;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    return this;
  }
  async saveIdentity(value) {
    await fs.mkdir(path.dirname(this.identityPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.identityPath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, this.identityPath);
    this.identity = value;
  }
  get paired() { return this.identity?.paired === true; }
  clearUserSession(expected=this.session) {
    if(this.session!==expected)return false;
    this.session=null;this.sessionGeneration++;this.handoffSequence++;return true;
  }
  captureUserSession(userProof) {
    const session=this.session;
    if(!session||typeof userProof!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(userProof)||typeof session.userProof!=="string"||Buffer.byteLength(userProof)!==Buffer.byteLength(session.userProof)||!crypto.timingSafeEqual(Buffer.from(userProof),Buffer.from(session.userProof)))throw new ApiError("Reconnect this browser’s signed-in restaurant tablet screen",{code:"LOCAL_USER_PROOF_REQUIRED",status:403});
    if(Date.parse(session.expiresAt)<=this.clock()){this.clearUserSession(session);throw new ApiError("Reconnect this browser’s signed-in restaurant tablet screen",{code:"TERMINAL_SESSION_REQUIRED",status:401});}
    return session;
  }
  assertUserSession(session,generation) {
    if(!session||this.session!==session||this.sessionGeneration!==generation||Date.parse(session.expiresAt)<=this.clock())throw new ApiError("This browser’s tablet sign-in has changed. Reconnect it before continuing.",{code:"LOCAL_USER_SESSION_CHANGED",status:403});
  }
  async _fetch(method, target, rawBody, headers = {}, {userBinding=null,generation,sessionAtStart=null,beforeDispatch}={}) {
    const url = new URL(target, this.baseUrl);
    if (url.origin !== this.baseUrl || `${url.pathname}${url.search}` !== target) throw new Error("Invalid terminal API target");
    if(userBinding)this.assertUserSession(userBinding,generation);
    beforeDispatch?.();
    let response;
    try { response = await this.fetchImpl(url, { method, headers: { accept: "application/json", "content-type": "application/json", ...headers }, ...(method === "GET" ? {} : { body: rawBody }), redirect: "error", signal: AbortSignal.timeout(this.timeoutMs) }); }
    catch { throw new ApiError("The Cal-Eats terminal connection is unavailable", { code: "TERMINAL_NETWORK_ERROR", retryable: true }); }
    if (Number(response.headers.get("content-length") || 0) > 1_048_576) throw new Error("Terminal API response is too large");
    const chunks = []; let size = 0;
    for await (const chunk of response.body || []) { size += chunk.length; if (size > 1_048_576) throw new Error("Terminal API response is too large"); chunks.push(chunk); }
    const text = Buffer.concat(chunks).toString("utf8");
    let result;
    try { result = text ? JSON.parse(text) : {}; } catch { throw new ApiError("Terminal API returned invalid JSON", { status: response.status }); }
    if (!response.ok) {
      if ([401, 403].includes(response.status) && userBinding) this.clearUserSession(userBinding);
      else if(result.error?.code==="TERMINAL_REVOKED"&&sessionAtStart)this.clearUserSession(sessionAtStart);
      throw new ApiError("The terminal request was not accepted. Check the business sign-in and tablet connection.", { status: response.status, code: result.error?.code || "TERMINAL_REJECTED", retryable: response.status >= 500 || response.status === 429 });
    }
    return Object.hasOwn(result, "data") ? result.data : result;
  }
  async pair({ terminalId, code, challenge, deviceName }) {
    if (this.pairing) throw new Error("Terminal pairing is already in progress");
    if (!UUID.test(terminalId) || typeof code !== "string" || code.length < 6 || code.length > 200 || typeof deviceName !== "string" || deviceName.trim().length < 2 || deviceName.length > 80) throw new Error("Invalid terminal pairing details");
    if (this.identity && this.identity.terminalId !== terminalId) throw new Error("This Windows installation already has a terminal identity. Use the documented replacement procedure.");
    this.pairing = true;
    try {
      const key = this.keyFactory(terminalId), publicKey = await key.publicKey({ create: true });
      const challengeSignature = await key.sign(pairingCanonical({ terminalId, challenge, publicKeySpki: publicKey.publicKeySpki }));
      // Persist only public metadata before sending: an interrupted response
      // reuses the same Windows key/proof, never creates a replacement key.
      if (!this.identity) await this.saveIdentity({ schemaVersion: 1, product: "cal-eats-terminal", terminalId, publicKeySpki: publicKey.publicKeySpki, paired: false });
      const result = await this._fetch("POST", "/api/terminal-devices/pair", JSON.stringify({ terminalId, code, deviceName: deviceName.trim(), publicKeySpki: publicKey.publicKeySpki, challengeSignature }));
      if (result.terminalId !== terminalId || !UUID.test(result.restaurantId)) throw new Error("Terminal pairing response did not match this installation");
      await this.saveIdentity({ ...this.identity, paired: true, restaurantId: result.restaurantId, pairedAt: new Date(this.clock()).toISOString() });
      this.clearUserSession();
      return { paired: true, terminalId, restaurantId: result.restaurantId };
    } finally { this.pairing = false; }
  }
  async signed(method, target, body = {}, { session = false, userBinding = null, printerToken = null, idempotencyKey = null, beforeDispatch } = {}) {
    if (!this.paired) throw new ApiError("Pair this business tablet first", { code: "TERMINAL_NOT_PAIRED", status: 403 });
    const terminalId=this.identity.terminalId,binding=session?(userBinding||this.session):null,generation=this.sessionGeneration,sessionAtStart=this.session;
    if(session)this.assertUserSession(binding,generation);
    const rawBody = method === "GET" ? "" : JSON.stringify(body);
    const timestamp = String(this.clock()), nonce = this.randomBytes(24).toString("base64url");
    const signature = await this.keyFactory(terminalId).sign(requestCanonical({ terminalId, timestamp, nonce, method, target, body: rawBody }));
    if(this.identity?.terminalId!==terminalId)throw new ApiError("The restaurant tablet identity changed",{code:"TERMINAL_IDENTITY_CHANGED",status:403});
    if(session)this.assertUserSession(binding,generation);
    const headers = { "X-Cal-Eats-Terminal-Id": terminalId, "X-Cal-Eats-Terminal-Timestamp": timestamp, "X-Cal-Eats-Terminal-Nonce": nonce, "X-Cal-Eats-Terminal-Signature": signature };
    if (session) {
      headers["X-Cal-Eats-Terminal-Session"] = binding.token;
    }
    if (printerToken) headers.authorization = `Bearer ${printerToken}`;
    if (idempotencyKey !== null) {
      if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9_.:-]{8,200}$/.test(idempotencyKey)) throw new Error("Invalid request idempotency key");
      headers["Idempotency-Key"] = idempotencyKey;
    }
    return this._fetch(method, target, rawBody, headers,{userBinding:binding,generation,sessionAtStart,beforeDispatch});
  }
  async connectSession({ terminalId, handoffToken }) {
    if (terminalId !== this.identity?.terminalId || typeof handoffToken !== "string" || !/^[A-Za-z0-9_-]{32,300}$/.test(handoffToken)) throw new Error("Invalid business-session handoff");
    const intent=++this.handoffSequence,previous=this.session,generation=this.sessionGeneration;let dispatched=false;
    const current=()=>{if(intent!==this.handoffSequence||this.session!==previous||this.sessionGeneration!==generation)throw new ApiError("A newer tablet sign-in replaced this request",{code:"LOCAL_USER_SESSION_CHANGED",status:403});};
    try{
      const result = await this.signed("POST", `/api/terminal-devices/${terminalId}/session`, { handoffToken },{beforeDispatch:()=>{current();dispatched=true;}});
      current();
      if (typeof result.sessionToken !== "string" || !/^[A-Za-z0-9_-]{32,500}$/.test(result.sessionToken) || !Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) <= this.clock()) throw new Error("Invalid business-session response");
      const userProof=this.randomBytes(32).toString("base64url");
      this.session = { token: result.sessionToken, expiresAt: result.expiresAt,userProof };this.sessionGeneration++;
      return { connected: true, expiresAt: result.expiresAt, user: result.user,userProof };
    }catch(error){
      // A delayed rejection belongs to its original attempt. Never expose it
      // as retryable handoff expiry after a newer operator has connected.
      current();
      // Definite rejected handoffs do not affect another signed-in operator.
      // A lost/invalid success response may have consumed the one-use handoff.
      if(dispatched&&!(error.status>=400&&error.status<500)){
        this.clearUserSession(previous);
        throw new ApiError("The tablet sign-in response could not be confirmed. Reconnect this browser before continuing.",{code:"TERMINAL_HANDOFF_UNCERTAIN",status:409});
      }
      throw error;
    }
  }
  screenHeartbeat({ screenId, challenge },{userProof}={}) {
    const userBinding=this.captureUserSession(userProof);
    if (typeof screenId !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(screenId) || typeof challenge !== "string" || !/^[A-Za-z0-9_-]{20,300}$/.test(challenge)) throw new Error("Invalid business-screen proof");
    return this.signed("POST", `/api/terminal-devices/${this.identity?.terminalId}/screen-heartbeat`, { screenId, challenge }, { session: true,userBinding });
  }
  heartbeat() { return this.signed("POST", `/api/terminal-devices/${this.identity?.terminalId}/heartbeat`, {}); }
  health(body) { return this.signed("POST", "/api/terminal-devices/health", body); }
  forward({ method, path: target, body = {}, idempotencyKey = null },{userProof}={}) {
    const userBinding=this.captureUserSession(userProof);
    if (!merchantRequestAllowed(method, target, this.identity?.restaurantId)) throw new Error("This operation is not allowed through the tablet companion");
    return this.signed(method, target, body, { session: true,userBinding, idempotencyKey });
  }
  disconnect({userProof}={}){const binding=this.captureUserSession(userProof);this.clearUserSession(binding);return {disconnected:true};}
  service(target, body, token = null) {
    if (!SERVICE_COMMAND.test(target)) throw new Error("Unsupported printer-service request");
    return this.signed("POST", target, body, { printerToken: token });
  }
}
