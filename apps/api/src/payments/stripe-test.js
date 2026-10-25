import { createHmac, timingSafeEqual } from "node:crypto";

export const STRIPE_API_VERSION = "2025-06-30.basil";
const DEFAULT_BASE_URL = "https://api.stripe.com";
const REFERENCE = /^(acct|pi|ch|tr|re|trr|po|seti|cus|pm|mandate)_[A-Za-z0-9_]+$/;

export class StripeTestConfigurationError extends Error { constructor(message) { super(message); this.name = "StripeTestConfigurationError"; } }

export function createStripeTestAdapter(config = {}) {
  const secretKey = String(config.secretKey || "");
  if (!secretKey.startsWith("sk_test_") || secretKey.startsWith("sk_live_")) throw new StripeTestConfigurationError("Stripe test adapter requires an sk_test_ key");
  if (config.mode && config.mode !== "test") throw new StripeTestConfigurationError("Stripe test adapter refuses non-test mode");
  const baseUrl = new URL(config.baseUrl || DEFAULT_BASE_URL);
  if (baseUrl.origin !== DEFAULT_BASE_URL && !(config.allowTestTransport && typeof config.fetchImpl === "function")) throw new StripeTestConfigurationError("Custom Stripe transport requires an explicitly injected test fetch");
  const fetchImpl = config.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new StripeTestConfigurationError("A fetch implementation is required");
  const timeoutMs = integer(config.timeoutMs ?? 10_000, 100, 60_000, "timeoutMs");

  async function request(method, path, fields, options = {}) {
    if (method !== "GET" && !validKey(options.idempotencyKey)) throw new TypeError("A bounded idempotencyKey is required for Stripe mutations");
    const url = new URL(path, baseUrl);
    if (url.origin !== baseUrl.origin || !url.pathname.startsWith("/v1/")) throw new TypeError("Invalid Stripe API path");
    if (method === "GET" && fields) for (const [key, value] of encodeFields(fields)) url.searchParams.append(key, value);
    const headers = { Authorization: `Bearer ${secretKey}`, "Stripe-Version": STRIPE_API_VERSION, Accept: "application/json" };
    if (options.stripeAccount) headers["Stripe-Account"] = ref(options.stripeAccount, "acct");
    if (options.stripeAccount) headers["Stripe-Account"] = ref(options.stripeAccount, "acct");
    const init = { method, headers, redirect: "error", signal: AbortSignal.timeout(timeoutMs) };
    if (method !== "GET") { headers["Content-Type"] = "application/x-www-form-urlencoded"; headers["Idempotency-Key"] = options.idempotencyKey; init.body = new URLSearchParams(encodeFields(fields)); }
    let response;
    try { response = await fetchImpl(url, init); }
    catch (error) { return { ok: false, status: "unknown", providerReference: options.providerReference, errorCode: error?.name === "TimeoutError" ? "STRIPE_TIMEOUT" : "STRIPE_NETWORK_AMBIGUOUS" }; }
    let body;
    try { body = await response.json(); } catch { return { ok: false, status: response.ok ? "unknown" : "failed", errorCode: "STRIPE_INVALID_RESPONSE" }; }
    const modes = Array.isArray(body?.data) ? body.data.map((item)=>item?.livemode) : [body?.livemode];
    if (modes.includes(true) || (response.ok && options.requireTestObject && modes.some((mode)=>mode !== false))) throw new StripeTestConfigurationError("Stripe returned an unverified or live-mode object to the test-only adapter");
    if (!response.ok) return { ok: false, status: retryable(response.status, body) ? "unknown" : "failed", providerReference: options.providerReference, errorCode: safeError(body, response.status) };
    return { ok: true, body };
  }

  return Object.freeze({
    mode: "stripe_test", apiVersion: STRIPE_API_VERSION,
    async createConnectedAccount(input) {
      const result = await request("POST", "/v1/accounts", { type: "express", country: input.country || "GB", email: email(input.email), "capabilities[card_payments][requested]": true, "capabilities[transfers][requested]": true, "metadata[restaurant_id]": bounded(input.restaurantId, 1, 100, "restaurantId") }, { idempotencyKey: input.idempotencyKey, requireTestObject:true });
      return accountResult(result);
    },
    async refreshConnectedAccount(input) { return accountResult(await request("GET", `/v1/accounts/${ref(input.accountId, "acct")}`, null, {requireTestObject:true})); },
    async createAccountLink(input) {
      const result = await request("POST", "/v1/account_links", { account: ref(input.accountId, "acct"), refresh_url: httpsUrl(input.refreshUrl), return_url: httpsUrl(input.returnUrl), type: "account_onboarding" }, { idempotencyKey: input.idempotencyKey });
      return result.ok ? normalized(result.body, { status: "pending", providerReference: input.accountId, actionUrl: httpsUrl(result.body.url), expiresAt: isoSeconds(result.body.expires_at) }) : result;
    },
    async configureWeeklyPayouts(input) {
      const accountId=ref(input.accountId,"acct");
      const result = await request("POST", "/v1/balance_settings", { "payments[payouts][schedule][interval]": "weekly", "payments[payouts][schedule][weekly_payout_days][]": weekday(input.weeklyAnchor || "monday") }, { idempotencyKey: input.idempotencyKey, stripeAccount: accountId });
      return result.ok ? normalized(result.body, { status: "confirmed", providerReference: accountId }) : result;
    },
    async authorizePayment(input) {
      const result = await request("POST", "/v1/payment_intents", { amount: money(input.amountMinor), currency: "gbp", payment_method: ref(input.paymentMethodId,"pm"), confirm: true, capture_method: "manual", "payment_method_types[]": "card", "expand[]":"latest_charge.balance_transaction", transfer_group: bounded(input.transferGroup,1,100,"transferGroup"), "metadata[order_id]": bounded(input.orderId,1,100,"orderId") }, { idempotencyKey: input.idempotencyKey, requireTestObject:true });
      return paymentResult(result);
    },
    async capturePayment(input) { return paymentResult(await request("POST", `/v1/payment_intents/${ref(input.paymentIntentId,"pi")}/capture`, { ...(input.amountMinor == null ? {} : { amount_to_capture: money(input.amountMinor) }), "expand[]":"latest_charge.balance_transaction" }, { idempotencyKey: input.idempotencyKey, providerReference: input.paymentIntentId, requireTestObject:true })); },
    async cancelPayment(input) { return paymentResult(await request("POST", `/v1/payment_intents/${ref(input.paymentIntentId,"pi")}/cancel`, {}, { idempotencyKey: input.idempotencyKey, providerReference: input.paymentIntentId, requireTestObject:true })); },
    async retrievePayment(input) { return paymentResult(await request("GET", `/v1/payment_intents/${ref(input.paymentIntentId,"pi")}`, {"expand[]":"latest_charge.balance_transaction"}, {requireTestObject:true})); },
    async refundPayment(input) {
      const result = await request("POST", "/v1/refunds", { payment_intent: ref(input.paymentIntentId,"pi"), ...(input.amountMinor == null ? {} : { amount: money(input.amountMinor) }), "metadata[operation_key]": bounded(input.operationKey,1,100,"operationKey") }, { idempotencyKey: input.idempotencyKey, providerReference: input.paymentIntentId, requireTestObject:true });
      return result.ok ? normalized(result.body, { status: mapRefund(result.body.status), providerReference: result.body.id }) : result;
    },
    async createTransfer(input) {
      const sourceTransactionId=ref(input.sourceTransactionId,"ch");
      const result = await request("POST", "/v1/transfers", { amount: money(input.amountMinor), currency: "gbp", destination: ref(input.destinationAccountId,"acct"), source_transaction:sourceTransactionId, transfer_group: bounded(input.transferGroup,1,100,"transferGroup"), "metadata[operation_key]": bounded(input.operationKey,1,100,"operationKey") }, { idempotencyKey: input.idempotencyKey, requireTestObject:true });
      return result.ok ? normalized(result.body, { status: "confirmed", providerReference: result.body.id, sourceTransactionId:result.body.source_transaction||sourceTransactionId }) : result;
    },
    async retrieveTransfer(input) { const result = await request("GET", `/v1/transfers/${ref(input.transferId,"tr")}`, null, {requireTestObject:true}); return result.ok ? normalized(result.body,{status:result.body.reversed?"failed":"confirmed",providerReference:result.body.id,sourceTransactionId:result.body.source_transaction}):result; },
    async reverseTransfer(input) {
      const transferId = ref(input.transferId,"tr"); const result = await request("POST", `/v1/transfers/${transferId}/reversals`, input.amountMinor == null ? {} : { amount: money(input.amountMinor) }, { idempotencyKey: input.idempotencyKey, providerReference: transferId, requireTestObject:true });
      return result.ok ? normalized(result.body, { status: "confirmed", providerReference: result.body.id }) : result;
    },
    async createCashMandateSetup(input) {
      const result = await request("POST", "/v1/setup_intents", { customer: ref(input.customerId,"cus"), "payment_method_types[]": "bacs_debit", usage: "off_session", "metadata[restaurant_id]": bounded(input.restaurantId,1,100,"restaurantId") }, { idempotencyKey: input.idempotencyKey, requireTestObject:true });
      return result.ok ? normalized(result.body, { status: mapSetup(result.body.status), providerReference: result.body.id, clientSecret: result.body.client_secret }) : result;
    },
    async collectCashCommission(input) {
      const result = await request("POST", "/v1/payment_intents", { amount: money(input.amountMinor), currency: "gbp", customer: ref(input.customerId,"cus"), payment_method: ref(input.paymentMethodId,"pm"), mandate: ref(input.mandateId,"mandate"), "payment_method_types[]": "bacs_debit", confirm: true, off_session: true, "expand[]":"latest_charge.balance_transaction", "metadata[operation_key]": bounded(input.operationKey,1,100,"operationKey") }, { idempotencyKey: input.idempotencyKey, requireTestObject:true });
      return paymentResult(result);
    },
    async retrieveCashCollection(input) { return paymentResult(await request("GET", `/v1/payment_intents/${ref(input.paymentIntentId,"pi")}`, {"expand[]":"latest_charge.balance_transaction"}, {requireTestObject:true})); },
    async createCustomer(input) { const result=await request("POST","/v1/customers",{email:email(input.email),name:bounded(input.name,1,120,"name"),"metadata[restaurant_id]":bounded(input.restaurantId,1,100,"restaurantId")},{idempotencyKey:input.idempotencyKey,requireTestObject:true});return result.ok?normalized(result.body,{status:"confirmed",providerReference:result.body.id}):result; },
    async retrieveCustomer(input) { const result=await request("GET",`/v1/customers/${ref(input.customerId,"cus")}`,null,{requireTestObject:true});return result.ok?normalized(result.body,{status:result.body.deleted?"failed":"confirmed",providerReference:result.body.id}):result; },
    async retrieveSetupIntent(input) { const result=await request("GET",`/v1/setup_intents/${ref(input.setupIntentId,"seti")}`,null,{requireTestObject:true});return result.ok?normalized(result.body,{status:mapSetup(result.body.status),providerReference:result.body.id,paymentState:result.body.status,mandateId:typeof result.body.mandate==="string"?result.body.mandate:result.body.mandate?.id,paymentMethodId:typeof result.body.payment_method==="string"?result.body.payment_method:result.body.payment_method?.id}):result; },
    async retrieveMandate(input) { const result=await request("GET",`/v1/mandates/${ref(input.mandateId,"mandate")}`,null,{requireTestObject:true});return result.ok?normalized(result.body,{status:result.body.status==="active"?"confirmed":result.body.status==="inactive"?"failed":"pending",providerReference:result.body.id,paymentState:result.body.status}):result; },
    async retrievePayout(input) { const result=await request("GET",`/v1/payouts/${ref(input.payoutId,"po")}`,null,{stripeAccount:input.accountId,requireTestObject:true});return payoutResult(result); },
    async listPayouts(input) { const result=await request("GET","/v1/payouts",{limit:integer(input.limit??25,1,100,"limit"),...(input.startingAfter?{starting_after:ref(input.startingAfter,"po")}:{})},{stripeAccount:input.accountId,requireTestObject:true});return result.ok?{ok:true,status:"confirmed",items:result.body.data.map(p=>payoutResult({ok:true,body:p})),hasMore:Boolean(result.body.has_more)}:result; }
  });
}

export function verifyStripeWebhook({ rawBody, signatureHeader, secret, nowSeconds = Math.floor(Date.now()/1000), toleranceSeconds = 300 }) {
  if (!Buffer.isBuffer(rawBody)) throw new TypeError("rawBody must be a Buffer captured before JSON parsing");
  if (!String(secret).startsWith("whsec_")) throw new StripeTestConfigurationError("A webhook signing secret is required");
  if (!Number.isSafeInteger(nowSeconds) || !Number.isSafeInteger(toleranceSeconds) || toleranceSeconds < 1 || toleranceSeconds > 900) throw new TypeError("Webhook time and tolerance are invalid");
  const parts = String(signatureHeader||"").split(",").map(v=>v.split("=")).filter(v=>v.length===2);
  const timestamp = Number(parts.find(([k])=>k==="t")?.[1]); const signatures=parts.filter(([k])=>k==="v1").map(([,v])=>v);
  if (!Number.isSafeInteger(timestamp)||Math.abs(nowSeconds-timestamp)>toleranceSeconds||!signatures.length) return false;
  const expected=createHmac("sha256",secret).update(Buffer.concat([Buffer.from(`${timestamp}.`),rawBody])).digest();
  return signatures.some(value=>{if(!/^[a-f0-9]{64}$/i.test(value))return false;const actual=Buffer.from(value,"hex");return actual.length===expected.length&&timingSafeEqual(actual,expected)});
}

export function parseStripeWebhook(input) {
  if (!verifyStripeWebhook(input)) throw new Error("Invalid Stripe webhook signature");
  const event=JSON.parse(input.rawBody.toString("utf8"));
  if (event.livemode !== false) throw new StripeTestConfigurationError("Live Stripe webhook events are rejected");
  if (!event.id||!event.type||!event.data?.object) throw new Error("Malformed Stripe webhook event");
  return event;
}

function encodeFields(value,prefix){const out=[];for(const[key,item]of Object.entries(value||{})){if(item===undefined||item===null)continue;const name=prefix?`${prefix}[${key}]`:key;if(Array.isArray(item))item.forEach(v=>out.push([name.endsWith("[]")?name:`${name}[]`,String(v)]));else if(typeof item==="object")out.push(...encodeFields(item,name));else out.push([name,String(item)])}return out}
function normalized(body,extra){if(body?.livemode===true)throw new StripeTestConfigurationError("Live Stripe object rejected");return{ok:true,providerCostMinor:cost(body),...extra}}
function accountResult(r){if(!r.ok)return r;const a=r.body,status=a.charges_enabled&&a.payouts_enabled?"confirmed":a.requirements?.disabled_reason?"failed":"pending";return normalized(a,{status,providerReference:a.id,capabilities:Object.entries(a.capabilities||{}).filter(([,v])=>v==="active").map(([k])=>k),requirements:[...(a.requirements?.currently_due||[]),...(a.requirements?.past_due||[])]})}
function paymentResult(r){if(!r.ok)return r;const state=paymentState(r.body.status),charge=typeof r.body.latest_charge==="object"?r.body.latest_charge:null,transaction=typeof charge?.balance_transaction==="object"?charge.balance_transaction:null;return normalized(r.body,{status:state.operationStatus,paymentState:state.paymentState,providerReference:r.body.id,latestChargeId:typeof r.body.latest_charge==="string"?r.body.latest_charge:charge?.id,providerCostMinor:Number.isSafeInteger(transaction?.fee)?transaction.fee:undefined,availableOn:Number.isFinite(transaction?.available_on)?isoSeconds(transaction.available_on):undefined,errorCode:r.body.last_payment_error?.code})}
function paymentState(s){if(s==="requires_capture")return{operationStatus:"confirmed",paymentState:"authorized"};if(s==="succeeded")return{operationStatus:"confirmed",paymentState:"captured"};if(s==="canceled")return{operationStatus:"confirmed",paymentState:"cancelled"};if(s==="requires_action")return{operationStatus:"pending",paymentState:"action_required"};if(s==="processing")return{operationStatus:"pending",paymentState:"processing"};if(s==="requires_confirmation")return{operationStatus:"pending",paymentState:"requires_confirmation"};if(s==="requires_payment_method")return{operationStatus:"failed",paymentState:"requires_payment_method"};return{operationStatus:"unknown",paymentState:"unknown"}}
function mapRefund(s){return s==="succeeded"?"confirmed":s==="failed"||s==="canceled"?"failed":s==="pending"?"pending":"unknown"}
function mapSetup(s){return s==="succeeded"?"confirmed":s==="canceled"||s==="requires_payment_method"?"failed":["processing","requires_action","requires_confirmation"].includes(s)?"pending":"unknown"}
function safeError(body,status){const code=body?.error?.code||body?.error?.type;return typeof code==="string"&&/^[a-z0-9_]{1,80}$/i.test(code)?code:`STRIPE_HTTP_${status}`}
function retryable(status,body){return status===409||status===429||status>=500||body?.error?.type==="api_error"}
function payoutResult(r){if(!r.ok)return r;const p=r.body,status=p.status==="paid"?"confirmed":p.status==="failed"||p.status==="canceled"?"failed":["pending","in_transit"].includes(p.status)?"pending":"unknown";return normalized(p,{status,paymentState:p.status,providerReference:p.id,amountMinor:p.amount,arrivalAt:isoSeconds(p.arrival_date),errorCode:p.failure_code})}
function cost(body){const transaction=typeof body?.latest_charge?.balance_transaction==="object"?body.latest_charge.balance_transaction:body?.balance_transaction;const fee=transaction?.fee;return Number.isSafeInteger(fee)&&fee>=0?fee:undefined}
function ref(value,prefix){value=String(value||"");if(!value.startsWith(`${prefix}_`)||!REFERENCE.test(value))throw new TypeError(`Invalid ${prefix} reference`);return value}
function money(v){return integer(v,1,100_000_000,"amountMinor")}
function integer(v,min,max,name){if(!Number.isSafeInteger(v)||v<min||v>max)throw new TypeError(`${name} is invalid`);return v}
function bounded(v,min,max,name){v=String(v||"");if(v.length<min||v.length>max||/[\r\n\0]/.test(v))throw new TypeError(`${name} is invalid`);return v}
function email(v){v=bounded(v,3,254,"email");if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))throw new TypeError("email is invalid");return v}
function validKey(v){return typeof v==="string"&&v.length>=8&&v.length<=255&&!/[\r\n\0]/.test(v)}
function httpsUrl(v){const u=new URL(v);if(u.protocol!=="https:"||u.username||u.password||u.hash)throw new TypeError("URL must be HTTPS without credentials or fragment");return u.href}
function weekday(v){if(!["monday","tuesday","wednesday","thursday","friday"].includes(v))throw new TypeError("weeklyAnchor must be a weekday");return v}
function isoSeconds(v){return Number.isFinite(v)?new Date(v*1000).toISOString():undefined}
