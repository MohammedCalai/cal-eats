import { createHmac, timingSafeEqual } from "node:crypto";

export const STRIPE_API_VERSION = "2025-06-30.basil";
const DEFAULT_BASE_URL = "https://api.stripe.com";
const REFERENCE = /^(acct|pi|ch|tr|re|trr|po|seti|cus|pm|mandate|cs)_[A-Za-z0-9_]+$/;

export class StripeTestConfigurationError extends Error { constructor(message) { super(message); this.name = "StripeTestConfigurationError"; } }

export function createStripeTestAdapter(config = {}) {
  if(config.mode&&config.mode!=="test")throw new StripeTestConfigurationError("Stripe test adapter refuses non-test mode");
  return createStripeAdapter({...config,mode:"test",liveEnabled:false});
}

export function createStripeAdapter(config = {}) {
  const mode=config.mode??"test";if(!["test","live"].includes(mode))throw new StripeTestConfigurationError("Stripe mode is invalid");if(mode==="live"&&config.liveEnabled!==true)throw new StripeTestConfigurationError("Stripe live mode requires an explicit liveEnabled gate");
  const secretKey = String(config.secretKey || "");
  const expectedPrefixes=mode==="live"?["rk_live_","sk_live_"]:["rk_test_","sk_test_"];if(!expectedPrefixes.some((prefix)=>secretKey.startsWith(prefix)))throw new StripeTestConfigurationError(`Stripe ${mode} adapter requires a matching restricted or secret key`);
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
    const modes = Array.isArray(body?.data) ? body.data.map((item)=>item?.livemode) : [body?.livemode],expectedLive=mode==="live";
    const modeOmissionAllowed=options.allowModeOmissionForObject&&body?.object===options.allowModeOmissionForObject&&body?.livemode===undefined;
    if(response.ok&&options.requireTestObject&&!modeOmissionAllowed&&modes.some((objectMode)=>objectMode!==expectedLive))throw new StripeTestConfigurationError("Stripe returned an unverified or live-mode object whose mode does not match the configured adapter");
    if (!response.ok) return { ok: false, status: retryable(response.status, body) ? "unknown" : "failed", providerReference: options.providerReference, errorCode: safeError(body, response.status) };
    return { ok: true, body };
  }

  return Object.freeze({
    mode: mode==="live"?"stripe_live":"stripe_test", apiVersion: STRIPE_API_VERSION,
    async retrievePlatformAccount(){const result=await request("GET","/v1/account",null);if(!result.ok)return result;const accountId=ref(result.body.id,"acct");return{ok:true,status:"confirmed",providerReference:accountId,accountId,country:typeof result.body.country==="string"?result.body.country.slice(0,2):undefined,chargesEnabled:Boolean(result.body.charges_enabled),payoutsEnabled:Boolean(result.body.payouts_enabled),mode:mode==="live"?"stripe_live":"stripe_test"};},
    async createConnectedAccount(input) {
      const result = await request("POST", "/v1/accounts", { type: "express", country: input.country || "GB", email: email(input.email), "capabilities[card_payments][requested]": true, "capabilities[transfers][requested]": true, "metadata[restaurant_id]": bounded(input.restaurantId, 1, 100, "restaurantId") }, { idempotencyKey: input.idempotencyKey, requireTestObject:true,allowModeOmissionForObject:"account" });
      return accountResult(result);
    },
    async refreshConnectedAccount(input) { return accountResult(await request("GET", `/v1/accounts/${ref(input.accountId, "acct")}`, null, {requireTestObject:true,allowModeOmissionForObject:"account"})); },
    async listExternalBankAccounts(input) {
      const accountId=ref(input.accountId,"acct"),result=await request("GET",`/v1/accounts/${accountId}/external_accounts`,{object:"bank_account",limit:100});
      return result.ok?{ok:true,status:"confirmed",providerReference:accountId,items:(result.body.data||[]).filter(item=>item.object==="bank_account").map(bankAccountResult),hasMore:Boolean(result.body.has_more)}:result;
    },
    async createAccountLink(input) {
      const result = await request("POST", "/v1/account_links", { account: ref(input.accountId, "acct"), refresh_url: httpsUrl(input.refreshUrl), return_url: httpsUrl(input.returnUrl), type: "account_onboarding" }, { idempotencyKey: input.idempotencyKey });
      return result.ok ? normalized(result.body, { status: "pending", providerReference: input.accountId, actionUrl: httpsUrl(result.body.url), expiresAt: isoSeconds(result.body.expires_at) }) : result;
    },
    async createAccountLoginLink(input){const accountId=ref(input.accountId,"acct"),result=await request("POST",`/v1/accounts/${accountId}/login_links`,{},{idempotencyKey:input.idempotencyKey});return result.ok?normalized(result.body,{status:"confirmed",providerReference:accountId,actionUrl:httpsUrl(result.body.url)}):result;},
    async configureWeeklyPayouts(input) {
      const accountId=ref(input.accountId,"acct");
      const result = await request("POST", "/v1/balance_settings", { "payouts[schedule][interval]": "weekly", "payouts[schedule][weekly_payout_days][]": weekday(input.weeklyAnchor || "monday") }, { idempotencyKey: input.idempotencyKey, stripeAccount: accountId });
      return result.ok ? normalized(result.body, { status: "confirmed", providerReference: accountId }) : result;
    },
    async authorizePayment(input) {
      const result = await request("POST", "/v1/payment_intents", { amount: money(input.amountMinor), currency: "gbp", payment_method: ref(input.paymentMethodId,"pm"), confirm: true, capture_method: "manual", "payment_method_types[]": "card", "expand[]":"latest_charge.balance_transaction", transfer_group: bounded(input.transferGroup,1,100,"transferGroup"), "metadata[order_id]": bounded(input.orderId,1,100,"orderId") }, { idempotencyKey: input.idempotencyKey, requireTestObject:true });
      return paymentResult(result);
    },
    async createCheckoutSession(input){
      const fields={mode:"payment",success_url:httpsUrl(input.successUrl),cancel_url:httpsUrl(input.cancelUrl),"line_items[0][quantity]":1,"line_items[0][price_data][currency]":"gbp","line_items[0][price_data][unit_amount]":money(input.amountMinor),"line_items[0][price_data][product_data][name]":"Cal-Eats order","payment_intent_data[capture_method]":"manual","payment_intent_data[transfer_group]":bounded(input.transferGroup,1,100,"transferGroup"),"payment_intent_data[metadata][order_id]":bounded(input.orderId,1,100,"orderId"),"payment_intent_data[metadata][restaurant_id]":bounded(input.restaurantId,1,100,"restaurantId"),"metadata[order_id]":bounded(input.orderId,1,100,"orderId"),"metadata[restaurant_id]":bounded(input.restaurantId,1,100,"restaurantId"),...(input.expiresAt?{expires_at:expirySeconds(input.expiresAt)}:{})};
      return checkoutResult(await request("POST","/v1/checkout/sessions",fields,{idempotencyKey:input.idempotencyKey,requireTestObject:true}));
    },
    async retrieveCheckoutSession(input){return checkoutResult(await request("GET",`/v1/checkout/sessions/${ref(input.sessionId,"cs")}`,{"expand[]":"payment_intent.latest_charge.balance_transaction"},{requireTestObject:true}));},
    async expireCheckoutSession(input){const sessionId=ref(input.sessionId,"cs");return checkoutResult(await request("POST",`/v1/checkout/sessions/${sessionId}/expire`,{}, {idempotencyKey:input.idempotencyKey,providerReference:sessionId,requireTestObject:true}));},
    async capturePayment(input) { return paymentResult(await request("POST", `/v1/payment_intents/${ref(input.paymentIntentId,"pi")}/capture`, { ...(input.amountMinor == null ? {} : { amount_to_capture: money(input.amountMinor) }), "expand[]":"latest_charge.balance_transaction" }, { idempotencyKey: input.idempotencyKey, providerReference: input.paymentIntentId, requireTestObject:true })); },
    async cancelPayment(input) { return paymentResult(await request("POST", `/v1/payment_intents/${ref(input.paymentIntentId,"pi")}/cancel`, {}, { idempotencyKey: input.idempotencyKey, providerReference: input.paymentIntentId, requireTestObject:true })); },
    async retrievePayment(input) { return paymentResult(await request("GET", `/v1/payment_intents/${ref(input.paymentIntentId,"pi")}`, {"expand[]":"latest_charge.balance_transaction"}, {requireTestObject:true})); },
    async refundPayment(input) {
      const result = await request("POST", "/v1/refunds", { payment_intent: ref(input.paymentIntentId,"pi"), ...(input.amountMinor == null ? {} : { amount: money(input.amountMinor) }), "metadata[operation_key]": bounded(input.operationKey,1,100,"operationKey"),...(input.orderId?{"metadata[order_id]":bounded(input.orderId,1,100,"orderId")}:{ }),...(input.restaurantId?{"metadata[restaurant_id]":bounded(input.restaurantId,1,100,"restaurantId")}:{ }) }, { idempotencyKey: input.idempotencyKey, providerReference: input.paymentIntentId, requireTestObject:true });
      return result.ok ? normalized(result.body, { status: mapRefund(result.body.status), providerReference: result.body.id,paymentIntentId:typeof result.body.payment_intent==="string"?result.body.payment_intent:result.body.payment_intent?.id,amountMinor:safeAmount(result.body.amount),currency:safeCurrency(result.body.currency),orderId:metadataValue(result.body.metadata,"order_id"),restaurantId:metadataValue(result.body.metadata,"restaurant_id") }) : result;
    },
    async retrieveRefund(input){const result=await request("GET",`/v1/refunds/${ref(input.refundId,"re")}`,null,{requireTestObject:true});return result.ok?normalized(result.body,{status:mapRefund(result.body.status),providerReference:result.body.id,paymentIntentId:typeof result.body.payment_intent==="string"?result.body.payment_intent:result.body.payment_intent?.id,amountMinor:safeAmount(result.body.amount),currency:safeCurrency(result.body.currency),orderId:metadataValue(result.body.metadata,"order_id"),restaurantId:metadataValue(result.body.metadata,"restaurant_id")}):result;},
    async createTransfer(input) {
      const sourceTransactionId=ref(input.sourceTransactionId,"ch");
      const result = await request("POST", "/v1/transfers", { amount: money(input.amountMinor), currency: "gbp", destination: ref(input.destinationAccountId,"acct"), source_transaction:sourceTransactionId, transfer_group: bounded(input.transferGroup,1,100,"transferGroup"), "metadata[operation_key]": bounded(input.operationKey,1,100,"operationKey") }, { idempotencyKey: input.idempotencyKey, requireTestObject:true });
      return result.ok ? transferResult(result,sourceTransactionId) : result;
    },
    async retrieveTransfer(input) { const result = await request("GET", `/v1/transfers/${ref(input.transferId,"tr")}`, null, {requireTestObject:true}); return result.ok ? transferResult(result):result; },
    async reverseTransfer(input) {
      const transferId = ref(input.transferId,"tr"); const result = await request("POST", `/v1/transfers/${transferId}/reversals`, input.amountMinor == null ? {} : { amount: money(input.amountMinor) }, { idempotencyKey: input.idempotencyKey, providerReference: transferId, requireTestObject:true });
      return result.ok ? reversalResult(result,transferId) : result;
    },
    async retrieveTransferReversal(input){const transferId=ref(input.transferId,"tr"),reversalId=ref(input.reversalId,"trr"),result=await request("GET",`/v1/transfers/${transferId}/reversals/${reversalId}`,null,{requireTestObject:true});return result.ok?reversalResult(result,transferId):result;},
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
  const expectedLive=(input.mode??"test")==="live";if(event.livemode!==expectedLive)throw new StripeTestConfigurationError("Stripe webhook mode does not match the configured endpoint");
  if (!event.id||!event.type||!event.data?.object) throw new Error("Malformed Stripe webhook event");
  return event;
}

function encodeFields(value,prefix){const out=[];for(const[key,item]of Object.entries(value||{})){if(item===undefined||item===null)continue;const name=prefix?`${prefix}[${key}]`:key;if(Array.isArray(item))item.forEach(v=>out.push([name.endsWith("[]")?name:`${name}[]`,String(v)]));else if(typeof item==="object")out.push(...encodeFields(item,name));else out.push([name,String(item)])}return out}
function normalized(body,extra){return{ok:true,providerCostMinor:cost(body),...extra}}
function bankAccountResult(bank){return{id:typeof bank.id==="string"&&/^ba_[A-Za-z0-9_]+$/.test(bank.id)?bank.id:null,bankName:typeof bank.bank_name==="string"?bank.bank_name.slice(0,150):"Bank account",last4:typeof bank.last4==="string"&&/^\d{4}$/.test(bank.last4)?bank.last4:null,country:typeof bank.country==="string"&&/^[A-Z]{2}$/.test(bank.country)?bank.country:null,currency:typeof bank.currency==="string"&&/^[a-zA-Z]{3}$/.test(bank.currency)?bank.currency.toUpperCase():null,status:typeof bank.status==="string"?bank.status.slice(0,60):"unknown",defaultForCurrency:Boolean(bank.default_for_currency)};}
function accountResult(r){if(!r.ok)return r;const a=r.body,status=a.charges_enabled&&a.payouts_enabled?"confirmed":a.requirements?.disabled_reason?"failed":"pending";return normalized(a,{status,providerReference:a.id,chargesEnabled:Boolean(a.charges_enabled),payoutsEnabled:Boolean(a.payouts_enabled),capabilities:Object.entries(a.capabilities||{}).filter(([,v])=>v==="active").map(([k])=>k),requirements:[...(a.requirements?.currently_due||[]),...(a.requirements?.past_due||[])],bankDetailsAvailable:Array.isArray(a.external_accounts?.data),bankAccounts:(a.external_accounts?.data||[]).filter(bank=>bank.object==="bank_account").map(bankAccountResult)})}
function paymentResult(r){if(!r.ok)return r;const state=paymentState(r.body.status),charge=typeof r.body.latest_charge==="object"?r.body.latest_charge:null,transaction=typeof charge?.balance_transaction==="object"?charge.balance_transaction:null,amount=safeAmount(r.body.amount),currency=safeCurrency(r.body.currency),orderId=metadataValue(r.body.metadata,"order_id"),restaurantId=metadataValue(r.body.metadata,"restaurant_id"),captureMethod=typeof r.body.capture_method==="string"?r.body.capture_method:undefined;return normalized(r.body,{status:state.operationStatus,paymentState:state.paymentState,providerReference:r.body.id,...(r.body.id?{paymentIntentId:r.body.id}:{}),...(amount!==undefined?{amountMinor:amount}:{}),...(currency?{currency}:{}),...(orderId?{orderId}:{}),...(restaurantId?{restaurantId}:{}),...(captureMethod?{captureMethod}:{}),latestChargeId:typeof r.body.latest_charge==="string"?r.body.latest_charge:charge?.id,providerCostMinor:Number.isSafeInteger(transaction?.fee)?transaction.fee:undefined,availableOn:Number.isFinite(transaction?.available_on)?isoSeconds(transaction.available_on):undefined,errorCode:r.body.last_payment_error?.code})}
function checkoutResult(r){if(!r.ok)return r;const session=r.body,pi=typeof session.payment_intent==="object"?session.payment_intent:null,state=pi?paymentState(pi.status):session.status==="expired"?{operationStatus:"confirmed",paymentState:"expired"}:{operationStatus:"pending",paymentState:"pending"},charge=typeof pi?.latest_charge==="object"?pi.latest_charge:null,transaction=typeof charge?.balance_transaction==="object"?charge.balance_transaction:null,metadata=pi?.metadata??session.metadata;return normalized(session,{status:state.operationStatus,paymentState:state.paymentState,providerReference:session.id,checkoutUrl:session.url?httpsUrl(session.url):undefined,url:session.url?httpsUrl(session.url):undefined,paymentIntentId:typeof session.payment_intent==="string"?session.payment_intent:pi?.id,amountMinor:safeAmount(session.amount_total??pi?.amount),currency:safeCurrency(session.currency??pi?.currency),orderId:metadataValue(metadata,"order_id"),restaurantId:metadataValue(metadata,"restaurant_id"),captureMethod:typeof pi?.capture_method==="string"?pi.capture_method:undefined,latestChargeId:typeof pi?.latest_charge==="string"?pi.latest_charge:charge?.id,providerCostMinor:Number.isSafeInteger(transaction?.fee)?transaction.fee:undefined,availableOn:Number.isFinite(transaction?.available_on)?isoSeconds(transaction.available_on):undefined,expiresAt:isoSeconds(session.expires_at)})}
function paymentState(s){if(s==="requires_capture")return{operationStatus:"confirmed",paymentState:"authorized"};if(s==="succeeded")return{operationStatus:"confirmed",paymentState:"captured"};if(s==="canceled")return{operationStatus:"confirmed",paymentState:"cancelled"};if(s==="requires_action")return{operationStatus:"pending",paymentState:"action_required"};if(s==="processing")return{operationStatus:"pending",paymentState:"processing"};if(s==="requires_confirmation")return{operationStatus:"pending",paymentState:"requires_confirmation"};if(s==="requires_payment_method")return{operationStatus:"failed",paymentState:"requires_payment_method"};return{operationStatus:"unknown",paymentState:"unknown"}}
function mapRefund(s){return s==="succeeded"?"confirmed":s==="failed"||s==="canceled"?"failed":s==="pending"?"pending":"unknown"}
function mapSetup(s){return s==="succeeded"?"confirmed":s==="canceled"||s==="requires_payment_method"?"failed":["processing","requires_action","requires_confirmation"].includes(s)?"pending":"unknown"}
function safeError(body,status){const code=body?.error?.code||body?.error?.type;return typeof code==="string"&&/^[a-z0-9_]{1,80}$/i.test(code)?code:`STRIPE_HTTP_${status}`}
function retryable(status,body){return status===409||status===429||status>=500||body?.error?.type==="api_error"}
function payoutResult(r){if(!r.ok)return r;const p=r.body,status=p.status==="paid"?"confirmed":p.status==="failed"||p.status==="canceled"?"failed":["pending","in_transit"].includes(p.status)?"pending":"unknown";return normalized(p,{status,paymentState:p.status,providerReference:p.id,amountMinor:p.amount,currency:typeof p.currency==="string"?p.currency.toUpperCase():null,createdAt:isoSeconds(p.created),arrivalAt:isoSeconds(p.arrival_date),errorCode:p.failure_code})}
function transferResult(r,fallbackSource){const t=r.body;return normalized(t,{status:t.reversed?"failed":"confirmed",providerReference:t.id,transferId:t.id,amountMinor:safeAmount(t.amount),currency:safeCurrency(t.currency),destinationAccountId:typeof t.destination==="string"?t.destination:t.destination?.id,sourceTransactionId:typeof t.source_transaction==="string"?t.source_transaction:t.source_transaction?.id??fallbackSource,transferGroup:typeof t.transfer_group==="string"?t.transfer_group:undefined})}
function reversalResult(r,transferId){const reversal=r.body,resolvedTransfer=typeof reversal.transfer==="string"?reversal.transfer:reversal.transfer?.id??transferId;return normalized(reversal,{status:"confirmed",providerReference:reversal.id,reversalId:reversal.id,transferId:resolvedTransfer,amountMinor:safeAmount(reversal.amount),currency:safeCurrency(reversal.currency)})}
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
function expirySeconds(v){const date=v instanceof Date?v:new Date(v);if(!Number.isFinite(date.getTime()))throw new TypeError("expiresAt is invalid");return Math.floor(date.getTime()/1000)}
function safeAmount(v){return Number.isSafeInteger(v)&&v>=0?v:undefined}
function safeCurrency(v){return typeof v==="string"&&/^[a-z]{3}$/i.test(v)?v.toUpperCase():undefined}
function metadataValue(metadata,key){const value=metadata?.[key];return typeof value==="string"&&value.length>=1&&value.length<=100&&!/[\r\n\0]/.test(value)?value:undefined}
