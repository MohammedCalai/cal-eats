import path from "node:path";
import { createStripeAdapter } from "./payments/stripe-test.js";
import { loadOrderAlertEmailConfig } from "./order-alert-email.js";

export function loadConfig(overrides = {}) {
  const runMode = overrides.runMode ?? process.env.CALAI_RUN_MODE ?? "local";
  if (!["local", "hosted-preview"].includes(runMode)) throw new Error("CALAI_RUN_MODE must be local or hosted-preview");
  const hostname = overrides.hostname ?? process.env.CALAI_HOST ?? "127.0.0.1";
  const port = Number(overrides.port ?? process.env.CALAI_PORT ?? (runMode === "hosted-preview" ? process.env.PORT : undefined) ?? 4310);
  const nodeEnv = overrides.nodeEnv ?? process.env.NODE_ENV ?? "development";
  if (nodeEnv === "production" && runMode !== "hosted-preview") throw new Error("NODE_ENV=production requires hosted-preview mode");
  if (runMode === "local" && hostname !== "127.0.0.1" && hostname !== "::1" && hostname !== "localhost") throw new Error("CALAI_HOST must be loopback in local mode");
  if (runMode === "hosted-preview" && !["0.0.0.0", "::", "127.0.0.1", "::1", "localhost"].includes(hostname)) throw new Error("CALAI_HOST is invalid for hosted preview");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("CALAI_PORT is invalid");
  const configuredOrigin = overrides.origin ?? process.env.CALAI_ORIGIN;
  if (runMode === "hosted-preview" && !configuredOrigin) throw new Error("CALAI_ORIGIN is required for hosted preview");
  const origin = configuredOrigin ?? `http://${hostname === "::1" ? "[::1]" : hostname}:${port}`;
  const parsed = new URL(origin);
  if (origin !== parsed.origin || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error("CALAI_ORIGIN must be a normalized origin without a path");
  if (runMode === "local" && (parsed.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(parsed.hostname))) throw new Error("CALAI_ORIGIN must be loopback HTTP in local mode");
  if (runMode === "hosted-preview" && parsed.protocol !== "https:") throw new Error("CALAI_ORIGIN must use HTTPS for hosted preview");
  const orderExpiryMinutes = overrides.orderExpiryMinutes ?? Number(process.env.CALAI_ORDER_EXPIRY_MINUTES ?? 15);
  if (!Number.isInteger(orderExpiryMinutes) || orderExpiryMinutes < 1 || orderExpiryMinutes > 1440) throw new Error("CALAI_ORDER_EXPIRY_MINUTES must be an integer from 1 to 1440");
  const healthcheckHost = overrides.healthcheckHost ?? process.env.CALAI_HEALTHCHECK_HOST ?? null;
  if (healthcheckHost && (runMode !== "hosted-preview" || healthcheckHost !== "healthcheck.railway.app")) throw new Error("CALAI_HEALTHCHECK_HOST is invalid");
  const paymentProviderMode = overrides.paymentProviderMode ?? process.env.CALAI_PAYMENT_PROVIDER ?? "local_simulator";
  if (!["local_simulator", "stripe_test", "stripe_live"].includes(paymentProviderMode)) throw new Error("CALAI_PAYMENT_PROVIDER must be local_simulator, stripe_test or stripe_live");
  const livePaymentsEnabled = overrides.livePaymentsEnabled ?? process.env.CALAI_LIVE_PAYMENTS_ENABLED === "true";
  if (typeof livePaymentsEnabled !== "boolean") throw new Error("livePaymentsEnabled must be a boolean");
  if (paymentProviderMode === "stripe_live" && (!livePaymentsEnabled || runMode !== "hosted-preview" || nodeEnv !== "production" || parsed.protocol !== "https:")) throw new Error("Live Stripe requires explicit CALAI_LIVE_PAYMENTS_ENABLED=true, production hosting and HTTPS");
  const stripePlatformAccountId = overrides.stripePlatformAccountId ?? process.env.CALAI_STRIPE_ACCOUNT_ID ?? null;
  if (stripePlatformAccountId !== null && !/^acct_[A-Za-z0-9]+$/.test(stripePlatformAccountId)) throw new Error("CALAI_STRIPE_ACCOUNT_ID must be a Stripe platform account ID");
  if (paymentProviderMode === "stripe_live" && !stripePlatformAccountId) throw new Error("Live Stripe requires a separately confirmed CALAI_STRIPE_ACCOUNT_ID");
  const stripeMode = paymentProviderMode === "stripe_live" ? "live" : "test";
  const stripeSecretKey = overrides.stripeSecretKey ?? (stripeMode === "live" ? process.env.CALAI_STRIPE_LIVE_SECRET_KEY : process.env.CALAI_STRIPE_TEST_SECRET_KEY);
  const paymentProvider = overrides.paymentProvider ?? overrides.stripeProvider ?? (paymentProviderMode.startsWith("stripe_") ? createStripeAdapter({ secretKey: stripeSecretKey, mode: stripeMode, liveEnabled: livePaymentsEnabled }) : null);
  if (paymentProvider?.mode && paymentProviderMode.startsWith("stripe_") && paymentProvider.mode !== paymentProviderMode) throw new Error("Stripe provider mode must match CALAI_PAYMENT_PROVIDER");
  const paymentProviderWebhookSecret = overrides.paymentProviderWebhookSecret ?? (stripeMode === "live" ? process.env.CALAI_STRIPE_LIVE_WEBHOOK_SECRET : process.env.CALAI_STRIPE_TEST_WEBHOOK_SECRET);
  const paymentProviderConnectWebhookSecret = overrides.paymentProviderConnectWebhookSecret ?? (stripeMode === "live" ? process.env.CALAI_STRIPE_LIVE_CONNECT_WEBHOOK_SECRET : process.env.CALAI_STRIPE_TEST_CONNECT_WEBHOOK_SECRET);
  if (paymentProviderMode === "stripe_live" && (![paymentProviderWebhookSecret, paymentProviderConnectWebhookSecret].every(value => typeof value === "string" && /^whsec_[A-Za-z0-9_]{8,}$/.test(value)))) throw new Error("Live Stripe requires separate platform and Connect webhook signing secrets");
  const messagingSupportHours = overrides.messagingSupportHours ?? Number(process.env.CALAI_MESSAGE_SUPPORT_HOURS ?? 2);
  if (!Number.isFinite(messagingSupportHours) || messagingSupportHours < 0 || messagingSupportHours > 24) throw new Error("CALAI_MESSAGE_SUPPORT_HOURS must be from 0 to 24");
  const dbPath = overrides.dbPath ?? process.env.CALAI_DB_PATH ?? path.resolve("data/calai-eats.sqlite");
  const orderAlertEmail = loadOrderAlertEmailConfig(overrides.orderAlertEmail, dbPath);
  return {
    hostname,
    runMode,
    port,
    origin: parsed.origin,
    expectedHost: parsed.host,
    secureCookies: runMode === "hosted-preview",
    demoShortcuts: runMode === "local",
    healthcheckHost,
    dbPath,
    orderAlertEmail,
    sessionHours: overrides.sessionHours ?? 24,
    bodyLimit: overrides.bodyLimit ?? 16 * 1024,
    orderExpiryMinutes,
    mockCapture: overrides.mockCapture,
    paymentProviderMode,
    paymentProvider,
    stripeProvider: paymentProvider,
    livePaymentsEnabled,
    stripePlatformAccountId,
    stripePayoutWeeklyAnchor: "monday",
    messagingSupportHours,
    messageEncryptionKey: overrides.messageEncryptionKey ?? process.env.CALAI_MESSAGE_ENCRYPTION_KEY,
    messageKeyFile: overrides.messageKeyFile ?? process.env.CALAI_MESSAGE_KEY_FILE,
    paymentProviderWebhookSecret,
    paymentProviderConnectWebhookSecret,
    providerWebhookBodyLimit: overrides.providerWebhookBodyLimit ?? 256 * 1024,
    now: overrides.now ?? (() => new Date()),
    rateLimit: overrides.rateLimit ?? { attempts: 8, windowMs: 60_000 }
  };
}
