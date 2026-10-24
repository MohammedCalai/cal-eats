export function authorizeMockPayment({ amountMinor, scenario = "success" }) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new TypeError("Invalid mock payment amount");
  if (scenario === "decline") return { ok: false, code: "MOCK_DECLINED", provider: "local_mock", external: false };
  if (scenario !== "success") throw new TypeError("Unknown mock payment scenario");
  return { ok: true, status: "mock_authorized", reference: `mock-${amountMinor}`, provider: "local_mock", external: false };
}

export function captureMockPayment({ amountMinor, scenario = "success" }) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new TypeError("Invalid mock capture amount");
  if (scenario === "fail") return { ok: false, code: "MOCK_CAPTURE_FAILED", provider: "local_mock", external: false };
  if (scenario !== "success") throw new TypeError("Unknown mock capture scenario");
  return { ok: true, status: "mock_captured", reference: `mock-capture-${amountMinor}`, provider: "local_mock", external: false };
}

export function createDisabledLiveAdapter(name) {
  return Object.freeze({ name, enabled: false, async authorize() { throw new Error(`${name} is disabled in the local demo`); } });
}

export const stripeAdapter = createDisabledLiveAdapter("stripe");
export const applePayAdapter = createDisabledLiveAdapter("apple_pay");
