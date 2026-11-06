import test from "node:test";
import assert from "node:assert/strict";
import { createManualPortalReload, portalRecovery } from "../src/portal-recovery.js";

test("expired lazy modules and CSS recover across supported browser error formats", () => {
  const errors = [
    new TypeError("Failed to fetch dynamically imported module: https://eats.calai.info/business/assets/Admin-oldhash.js"),
    new TypeError("error loading dynamically imported module: https://eats.calai.info/business/assets/Admin-oldhash.js"),
    new TypeError("Importing a module script failed."),
    Object.assign(new Error("Loading chunk 42 failed."), { name: "ChunkLoadError" }),
    new Error("Loading CSS chunk admin failed."),
    new Error("Unable to preload CSS for /business/assets/Admin-oldhash.css")
  ];
  for (const error of errors) {
    const recovery = portalRecovery(error);
    assert.equal(recovery.kind, "module");
    assert.match(recovery.description, /connection.*reload/i);
    assert.doesNotMatch(JSON.stringify(recovery), /oldhash|https:|\/assets\//);
  }
});

test("other render failures receive a safe recovery message without internal details", () => {
  const recovery = portalRecovery(new Error("Customer secret@example.invalid password=private SQL SELECT * FROM users"));
  assert.equal(recovery.kind, "page");
  assert.doesNotMatch(JSON.stringify(recovery), /secret|private|SQL|users/);
  assert.equal(portalRecovery(new TypeError("Failed to fetch")).kind, "page");
  assert.equal(portalRecovery(null).kind, "page");
  assert.equal(portalRecovery({ get message() { throw new Error("unreadable"); } }).kind, "page");
});

test("a failed module never reloads automatically and repeat clicks cannot loop", () => {
  let reloads = 0;
  const requestReload = createManualPortalReload(() => { reloads++; });
  portalRecovery(new TypeError("Failed to fetch dynamically imported module"));
  assert.equal(reloads, 0);
  assert.equal(requestReload(), "requested");
  assert.equal(reloads, 1);
  assert.equal(requestReload(), "already_requested");
  assert.equal(reloads, 1);
});

test("a blocked browser reload can be retried only by another deliberate action", () => {
  let attempts = 0;
  const requestReload = createManualPortalReload(() => { attempts++; if (attempts === 1) throw new Error("Browser navigation unavailable"); });
  assert.equal(requestReload(), "failed");
  assert.equal(attempts, 1);
  assert.equal(requestReload(), "requested");
  assert.equal(attempts, 2);
});
