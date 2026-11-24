import assert from "node:assert/strict";
import test from "node:test";
import { validateBase } from "../src/api.ts";

test("permits explicit IPv4 and IPv6 loopback HTTP", () => {
  assert.equal(validateBase("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
  assert.equal(validateBase("http://[::1]:3000"), "http://[::1]:3000");
});
test("rejects cleartext remote APIs", () => assert.throws(() => validateBase("http://example.test"), /HTTPS/));
test("rejects original host regardless of case or trailing dot", () => {
  assert.throws(() => validateBase("https://CALAI.INFO./"), /original Calai host/);
  assert.throws(() => validateBase("https://api.CalAi.Info./"), /original Calai host/);
});
test("rejects URL credentials", () => assert.throws(() => validateBase("https://user:secret@example.test"), /credentials/));

test("guest mutations carry the configured API origin without a session or cookies", async () => {
  const previousBase = process.env.EXPO_PUBLIC_API_BASE_URL, originalFetch = globalThis.fetch;
  process.env.EXPO_PUBLIC_API_BASE_URL = "https://eats.calai.info";
  try {
    const client = await import(new URL("../src/api.ts?guest-origin-check", import.meta.url).href);
    let options: RequestInit | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      options = init;
      return new Response(JSON.stringify({ data: { postcode: "LU1 2AB", city: "Luton" } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const result = await client.api("/api/location/postcode", { method: "POST", body: JSON.stringify({ latitude: 51.88, longitude: -.42, consent: true }) });
    const headers = new Headers(options?.headers);
    assert.equal(headers.get("Origin"), "https://eats.calai.info");
    assert.equal(headers.has("Authorization"), false);
    assert.equal(options?.credentials, "omit");
    assert.equal(result.postcode, "LU1 2AB");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL; else process.env.EXPO_PUBLIC_API_BASE_URL = previousBase;
  }
});

test("tablet intake errors keep their code without exposing tablet wording to customers", async () => {
  const previousBase = process.env.EXPO_PUBLIC_API_BASE_URL, originalFetch = globalThis.fetch;
  process.env.EXPO_PUBLIC_API_BASE_URL = "https://eats.calai.info";
  try {
    const client = await import(new URL("../src/api.ts?tablet-intake-copy", import.meta.url).href);
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: {
      code: "TABLET_PRODUCT_INACTIVE",
      message: "The restaurant tablet is not currently receiving Cal-Eats orders."
    } }), { status: 409, headers: { "content-type": "application/json" } })) as typeof fetch;
    await assert.rejects(client.api("/api/restaurants?fulfillment=collection"), (error: unknown) => {
      assert.ok(error instanceof client.ApiError);
      assert.equal(error.code, "TABLET_PRODUCT_INACTIVE");
      assert.match(error.message, /restaurant/i);
      assert.doesNotMatch(error.message, /tablet/i);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL; else process.env.EXPO_PUBLIC_API_BASE_URL = previousBase;
  }
});
