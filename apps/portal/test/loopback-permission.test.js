import assert from "node:assert/strict";
import test from "node:test";
import { loopbackPermissionState, queryLoopbackPermission } from "../src/loopback-permission.js";

test("permission lookup uses only the granular loopback name and unsupported browsers remain unknown", async () => {
  const requests = [], status = { state: "granted" };
  assert.equal(await queryLoopbackPermission({ query: async request => { requests.push(request); return status; } }), status);
  assert.deepEqual(requests, [{ name: "loopback-network" }]);
  assert.equal(loopbackPermissionState(await queryLoopbackPermission({ query: async () => { throw new TypeError("Unsupported permission"); } })), "unknown");
  assert.equal(loopbackPermissionState(await queryLoopbackPermission(null)), "unknown");
  for (const state of ["granted", "prompt", "denied"]) assert.equal(loopbackPermissionState({ state }), state);
  assert.equal(loopbackPermissionState({ state: "installed" }), "unknown");
});
