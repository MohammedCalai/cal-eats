const LOCAL_ORIGIN = "http://127.0.0.1:17863";
const ID = "[A-Za-z0-9_-]{8,100}";
const orderAction = new RegExp(`^/api/restaurant/orders/${ID}/(?:status|preparation)$`);
const receiptAction = new RegExp(`^/api/restaurant/restaurants/${ID}/printers/${ID}/(?:test-receipt|reprints)$`);
const receiptCheck = new RegExp(`^/api/restaurant/restaurants/${ID}/printers/${ID}/jobs/${ID}/check$`);
let installed = null;

export function isTerminalDiagnostic(path,method,restaurantId){
  if(typeof path!=="string"||/[\\\r\n?#%]/.test(path))return false;
  return method==="GET"&&path===`/api/restaurant/restaurants/${encodeURIComponent(restaurantId)}/operations-health`||method==="PATCH"&&new RegExp(`^/api/restaurant/incidents/${ID}/read$`).test(path);
}

export function isTerminalOperation(path, method = "GET") {
  if (typeof path !== "string" || /[\\\r\n?#%]/.test(path)) return false;
  method = method.toUpperCase();
  return method === "PATCH" && (orderAction.test(path) || new RegExp(`^/api/print-jobs/${ID}$`).test(path)) || method === "POST" && (receiptAction.test(path) || receiptCheck.test(path) || new RegExp(`^/api/orders/${ID}/print-jobs$`).test(path));
}

function failure(message, code = "PAIRED_TERMINAL_REQUIRED", status = 403) {
  return Object.assign(new Error(message), {code, status});
}

// Only a live, scoped provider can install a transport. Its connection token and
// private device key stay inside the local Windows service, never in this page.
export function installOrderingTerminalClient(client) {
  installed = client;
  return () => { if (installed === client) installed = null; };
}
export function terminalOperation(path, options = {}) {
  if (!installed) throw failure("Use the registered restaurant tablet to manage orders or print receipts.");
  return installed.forward(path, options);
}

export function createOrderingTerminalClient({restaurantId, request, screenId, canProcess = false, fetchImpl = globalThis.fetch, clock = Date.now, visible = () => typeof document === "undefined" || !document.hidden, onChange = () => {}}) {
  const root = `/api/restaurant/restaurants/${encodeURIComponent(restaurantId)}/terminal`;
  const lifetime = new AbortController();
  let disposed = false, connecting = null, pulsePending = null, pairing = null, pairingIntent = null, csrfToken = null, userProof = null, verifiedAt = 0, sessionValidUntil = 0, reconnectRequired = false;
  let snapshot = {ready:false, sessionVerified:false, localAvailable:false, terminalId:null, paired:false, status:null, error:"", connecting:false};
  const publish = update => { if (!disposed) { snapshot = {...snapshot, ...update}; onChange(snapshot); } };
  const assertCurrent = () => { if (disposed) throw failure("This restaurant screen has closed.", "TERMINAL_SCOPE_ENDED"); };
  const clearSession = expected => {
    if (userProof !== expected) return;
    userProof = null; sessionValidUntil = 0; verifiedAt = 0; reconnectRequired = true;
    publish({ready:false, sessionVerified:false});
  };
  const canOperate = id => !disposed && canProcess && id === restaurantId && visible() && snapshot.ready && clock() - verifiedAt < 40_000;
  // A previously authenticated local USER session can still inspect an outage.
  // This grants diagnostic reads only, never order actions on a stale screen.
  const canReadHealth = id => !disposed&&canProcess&&id===restaurantId&&snapshot.sessionVerified&&snapshot.paired&&sessionValidUntil>clock();
  async function browserRequest(path, options = {}) {
    assertCurrent();
    const binding=userProof;
    const controller=new AbortController(),cancel=()=>controller.abort();
    lifetime.signal.addEventListener("abort",cancel,{once:true});
    const timer=setTimeout(cancel,10_000);
    try { const value=await request(path,{...options,signal:controller.signal});assertCurrent();return value; }
    catch(error){if([401,403].includes(error.status))clearSession(binding);throw error;}
    finally {clearTimeout(timer);lifetime.signal.removeEventListener("abort",cancel);}
  }
  async function local(path, body, proof = userProof) {
    assertCurrent();
    const protectedRequest = ["/v1/request", "/v1/screen-heartbeat", "/v1/disconnect"].includes(path);
    if (protectedRequest && (typeof proof !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(proof) || proof !== userProof)) throw failure("Reconnect this browser’s signed-in restaurant tablet screen.", "LOCAL_USER_PROOF_REQUIRED");
    const timeout = new AbortController(), cancel = () => timeout.abort();
    lifetime.signal.addEventListener("abort", cancel, {once:true});
    const timer = setTimeout(cancel, path==="/v1/pair"?30_000:15_000);
    try {
      const response = await fetchImpl(`${LOCAL_ORIGIN}${path}`, {method:body === undefined ? "GET" : "POST", mode:"cors", credentials:"omit", cache:"no-store", redirect:"error", signal:timeout.signal, headers:body === undefined ? {Accept:"application/json"} : {Accept:"application/json", "Content-Type":"application/json", "X-Cal-Eats-CSRF":csrfToken, ...(protectedRequest ? {"X-Cal-Eats-User-Proof":proof} : {})}, ...(body === undefined ? {} : {body:JSON.stringify(body)})});
      const value = await response.json(); assertCurrent();
      if (!response.ok) throw failure(value?.error?.message || "The restaurant tablet connection is unavailable.", value?.error?.code || "TERMINAL_LOCAL_REJECTED", response.status);
      return value?.data ?? value;
    } catch (error) {
      if (protectedRequest && [401,403].includes(error.status)) clearSession(proof);
      if (error.code) throw error;
      throw failure("The restaurant tablet connection is unavailable. Check that the Windows setup is running on this device.", "TERMINAL_LOCAL_UNAVAILABLE");
    } finally { clearTimeout(timer); lifetime.signal.removeEventListener("abort", cancel); }
  }
  async function bootstrap() {
    const value = await local("/v1/bootstrap");
    if (value.product !== "cal-eats-terminal" || typeof value.csrfToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.csrfToken)) throw failure("Update the restaurant tablet connection setup.", "TERMINAL_LOCAL_INVALID");
    csrfToken = value.csrfToken;
    publish({localAvailable:true, terminalId:value.terminalId, paired:value.paired === true});
    return value;
  }
  async function screenProof() {
    if (!visible()) { publish({ready:false}); return snapshot; }
    const binding = userProof;
    const proof = await browserRequest(`${root}/screen-challenge`, {method:"POST", body:JSON.stringify({screenId})});
    assertCurrent();
    if (proof.terminalId !== snapshot.terminalId) throw failure("This device is not the restaurant’s registered tablet.", "TERMINAL_ID_MISMATCH");
    const status = await local("/v1/screen-heartbeat", {screenId, challenge:proof.challenge}, binding);
    assertCurrent();
    verifiedAt = clock();
    publish({status, ready:visible() && status.deviceId === snapshot.terminalId && status.isReady === true, error:""});
    return snapshot;
  }
  async function connect() {
    assertCurrent();
    if (connecting) return connecting;
    if (pulsePending) return pulsePending;
    if (!canProcess || !visible()) { publish({ready:false}); return snapshot; }
    publish({connecting:true, ready:false, error:""});
    connecting = (async () => {
      try {
        const [localState, status] = await Promise.all([bootstrap(), browserRequest(root)]);
        assertCurrent(); publish({status});
        if (!localState.paired || !localState.terminalId || status.deviceId !== localState.terminalId) return snapshot;
        let session;
        const previous = userProof;
        for (let attempt=0; attempt<2; attempt++) {
          const handoff = await browserRequest(`${root}/session-handoff`, {method:"POST", body:JSON.stringify({screenId})});
          assertCurrent();
          if (handoff.terminalId !== localState.terminalId) throw failure("The registered restaurant tablet changed. Refresh its connection.", "TERMINAL_ID_MISMATCH");
          try { session=await local("/v1/session", {terminalId:handoff.terminalId, handoffToken:handoff.handoffToken}); break; }
          catch(error) {
            // A newer successful USER handoff invalidates earlier one-use handoffs.
            // Retry that definite rejection once using this browser's own cookie.
            if(error.code==="TERMINAL_HANDOFF_INVALID"&&attempt===0)continue;
            if (!(error.status>=400&&error.status<500) || /^(?:TERMINAL_(?:HANDOFF_UNCERTAIN|NETWORK_ERROR|LOCAL_UNAVAILABLE)|LOCAL_USER_SESSION_CHANGED)$/.test(error.code||"")) clearSession(previous);
            throw error;
          }
        }
        if(session?.connected!==true||typeof session.userProof!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(session.userProof)||!Number.isFinite(Date.parse(session.expiresAt))||Date.parse(session.expiresAt)<=clock()) { clearSession(previous);throw failure("Reconnect the signed-in restaurant tablet screen.","TERMINAL_SESSION_INVALID"); }
        userProof=session.userProof;reconnectRequired=false;sessionValidUntil=Date.parse(session.expiresAt);publish({sessionVerified:true});
        return await screenProof();
      } catch (error) { publish({ready:false, error:error.message}); throw error; }
      finally { connecting = null; publish({connecting:false}); }
    })();
    return connecting;
  }
  async function pulse() {
    assertCurrent();
    if (!visible()) { publish({ready:false}); return snapshot; }
    if (pulsePending) return pulsePending;
    if (reconnectRequired) return snapshot;
    if (!canReadHealth(restaurantId)) return connect();
    pulsePending = screenProof().catch(error => { publish({ready:false, error:error.message}); throw error; }).finally(() => { pulsePending = null; });
    return pulsePending;
  }
  async function pair({replace = false, deviceName}) {
    assertCurrent();
    if (pairing) return pairing;
    pairing = (async () => {
      publish({ready:false, error:""});
      try {
        if (connecting) await connecting.catch(()=>{});
        if (pulsePending) await pulsePending.catch(()=>{});
        await bootstrap();
        if (!pairingIntent || pairingIntent.replace !== replace || Date.parse(pairingIntent.expiresAt) <= clock()) {
          const value = await browserRequest(`${root}/pairing-code`, {method:"POST", body:JSON.stringify({replace})});
          assertCurrent(); pairingIntent = {...value, replace};
        }
        await local("/v1/pair", {terminalId:pairingIntent.terminalId, code:pairingIntent.code, challenge:pairingIntent.challenge, deviceName});
        pairingIntent = null;
        return await connect();
      } catch (error) { publish({ready:false, error:error.message}); throw error; }
      finally { pairing = null; }
    })();
    return pairing;
  }
  async function forward(path, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    const diagnostic=isTerminalDiagnostic(path,method,restaurantId);
    if (!(diagnostic?canReadHealth(restaurantId):isTerminalOperation(path, method)&&canOperate(restaurantId))) throw failure("Use the registered restaurant tablet to manage orders or print receipts.");
    if(method==="GET"&&options.body!==undefined)throw failure("Health reads cannot contain a request body.","TERMINAL_BODY_INVALID",400);
    let body;
    try { body = options.body ? JSON.parse(options.body) : {}; } catch { throw failure("The tablet request must contain valid JSON.", "TERMINAL_BODY_INVALID", 400); }
    const headers = new Headers(options.headers || {});
    try { return await local("/v1/request", {method, path, ...(method==="GET"?{}:{body}), ...(headers.has("Idempotency-Key") ? {idempotencyKey:headers.get("Idempotency-Key")} : {})}); }
    catch (error) { if ([401,403].includes(error.status) || /^(?:TERMINAL_|LOCAL_)/.test(error.code||"")) publish({ready:false, error:error.message}); throw error; }
  }
  return {getSnapshot:() => snapshot, canOperate, canReadHealth, connect, pulse, pair, forward, dispose() {
    if(disposed)return;
    const proof=userProof,csrf=csrfToken;
    disposed = true; verifiedAt = 0; sessionValidUntil = 0; userProof = null; csrfToken = null; pairingIntent = null; lifetime.abort();
    // Cleanup is scoped to this browser's captured USER proof. A stale page can
    // never disconnect a newer operator, even if both use the same local service.
    if(proof&&csrf)void fetchImpl(`${LOCAL_ORIGIN}/v1/disconnect`,{method:"POST",mode:"cors",credentials:"omit",cache:"no-store",redirect:"error",signal:AbortSignal.timeout(3000),headers:{Accept:"application/json","Content-Type":"application/json","X-Cal-Eats-CSRF":csrf,"X-Cal-Eats-User-Proof":proof},body:"{}"}).catch(()=>{});
  }};
}
