import { createStripeAdapter } from "./stripe-test.js";

const accountIdPattern=/^acct_[A-Za-z0-9]+$/;
const restaurantIdPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const signingSecretPattern=/^whsec_[A-Za-z0-9_]{8,}$/;
const onboardingMethods=["retrievePlatformAccount","createConnectedAccount","refreshConnectedAccount","configureWeeklyPayouts","retrievePayoutSchedule","createAccountLink","createAccountLoginLink","listExternalBankAccounts","listPayouts"];

// Preparing a real restaurant's bank account does not activate customer charges,
// transfers, payment webhooks or the global payment workers.
export function loadLiveOnboardingConfig(overrides,hosting){
  const input=overrides.liveOnboardingRestaurantIds??process.env.CALAI_LIVE_ONBOARDING_RESTAURANT_IDS??"";
  const ids=Array.isArray(input)?input:typeof input==="string"?(input.trim()?input.split(",").map(value=>value.trim()):[]):null;
  if(!ids||ids.length>100||ids.some(id=>typeof id!=="string"||!restaurantIdPattern.test(id)))throw new Error("CALAI_LIVE_ONBOARDING_RESTAURANT_IDS must be a bounded list of restaurant IDs");
  const restaurantIds=Object.freeze([...new Set(ids.map(id=>id.toLowerCase()))]);
  if(!restaurantIds.length)return null;
  if(hosting.runMode!=="hosted-preview"||hosting.nodeEnv!=="production"||new URL(hosting.origin).protocol!=="https:")throw new Error("Live bank onboarding requires production hosting and HTTPS");
  const accountId=overrides.liveOnboardingStripePlatformAccountId??process.env.CALAI_STRIPE_LIVE_ACCOUNT_ID;
  const secretKey=overrides.liveOnboardingStripeSecretKey??process.env.CALAI_STRIPE_LIVE_SECRET_KEY;
  const platformSecret=overrides.liveOnboardingWebhookSecret??process.env.CALAI_STRIPE_LIVE_WEBHOOK_SECRET;
  const connectSecret=overrides.liveOnboardingConnectWebhookSecret??process.env.CALAI_STRIPE_LIVE_CONNECT_WEBHOOK_SECRET;
  if(!accountIdPattern.test(accountId??""))throw new Error("Live bank onboarding requires the separately confirmed live platform account ID");
  if(![platformSecret,connectSecret].every(value=>typeof value==="string"&&signingSecretPattern.test(value))||platformSecret===connectSecret)throw new Error("Live bank onboarding requires distinct live platform and Connect signing secrets");
  if(!/^(rk|sk)_live_/.test(secretKey??""))throw new Error("Live bank onboarding requires a live connection key");
  const adapter=overrides.liveOnboardingPaymentProvider??createStripeAdapter({secretKey,mode:"live",liveEnabled:true});
  if(adapter?.mode!=="stripe_live")throw new Error("Live bank onboarding provider must use live mode");
  const provider=Object.freeze({mode:"stripe_live",...Object.fromEntries(onboardingMethods.filter(name=>typeof adapter[name]==="function").map(name=>[name,adapter[name].bind(adapter)]))});
  if(typeof provider.retrievePlatformAccount!=="function")throw new Error("Live bank onboarding requires platform account verification");
  return Object.freeze({restaurantIds,connection:Object.freeze({paymentProviderMode:"stripe_live",paymentProvider:provider,stripeProvider:provider,stripePlatformAccountId:accountId,paymentProviderWebhookSecret:platformSecret,paymentProviderConnectWebhookSecret:connectSecret,livePaymentsEnabled:false,onboardingOnly:true})});
}

export function restaurantBankingConfig(config,restaurantId){
  if(config.paymentProviderMode==="stripe_live"||!config.liveOnboarding?.restaurantIds.includes(restaurantId))return config;
  return {...config,...config.liveOnboarding.connection};
}

export function bankingPaymentScope(config){
  return {onboardingOnly:config.onboardingOnly===true,customerPaymentsLive:config.onboardingOnly!==true&&config.paymentProviderMode==="stripe_live"&&config.livePaymentsEnabled===true};
}
