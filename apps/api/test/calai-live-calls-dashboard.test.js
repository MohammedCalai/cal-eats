import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HttpError } from "../src/http.js";
import { businessFixture, EATS_PASSWORD } from "./unified-business-test-fixture.js";
import { enrolRegisteredTablet } from "./registered-tablet-fixture.js";
import { requestAllowed } from "../../terminal-auth/src/protocol.js";

const dashboardPath = "/api/business/dashboard";
const activityPath = "/api/business/calai/orders?scope=activity";
const liveSummary = {
  activeCalls: 2,
  agentsInUse: 1,
  ringing: 3,
  queued: 4,
  forwarding: 5,
};

async function fixture(t) {
  const f = await businessFixture();
  t.after(() => f.close());
  assert.equal((await f.allow("calai")).status, 200);
  assert.equal((await f.link()).status, 200);

  const feed = {
    reads: 0,
    getSnapshot: now => ({
      complete: true,
      generatedAt: now.toISOString(),
      summary: { ...liveSummary, unrelatedNumber: 10 },
      calls: [{ id: "private-call-id", agentName: "private-agent-name" }],
      debug: { transcript: "private-transcript" },
    }),
  };
  const nativeRead = f.adapter.read;
  f.adapter.read = async (section, ...args) => {
    if (section !== "live") return nativeRead(section, ...args);
    feed.reads++;
    return feed.getSnapshot(f.config.now(), args[1]?.signal);
  };
  return { ...f, feed };
}

async function registeredBothTablet(f) {
  const ownerCookie = await f.login("restaurant@calai.local", EATS_PASSWORD);
  const adminCookie = await f.login("admin@calai.local", "LocalAdmin!4310");
  const tablet = await enrolRegisteredTablet(f, { ownerCookie: adminCookie, businessId: f.business.id });
  const mode = f.db.prepare("UPDATE admin_tablets SET application_products=?,revision=revision+1 WHERE terminal_id=?");
  const selectMode = value => assert.equal(mode.run(value, tablet.terminalId).changes, 1);
  selectMode("both");
  const approve = () => f.json("/api/business/accounts/" + f.business.id + "/terminals/calai-authorization", {
    method: "POST",
    cookie: ownerCookie,
    body: { expectedTerminalId: tablet.terminalId },
  });
  return { tablet, selectMode, approve };
}

test("Both uses the same limited Live Calls summary for a verified owner and an authorised signed tablet", async t => {
  const f = await fixture(t);
  const { tablet, selectMode, approve } = await registeredBothTablet(f);

  const beforeApproval = await tablet.json(dashboardPath);
  assert.equal(beforeApproval.status, 200, beforeApproval.text);
  assert.equal(beforeApproval.body.data.calaiLiveCalls, null);
  assert.equal(f.feed.reads, 0, "Pairing and app mode do not grant Calai access");

  const allowed = await approve();
  assert.equal(allowed.status, 200, allowed.text);
  const [owner, kitchen] = await Promise.all([f.call(dashboardPath), tablet.json(dashboardPath)]);
  for (const response of [owner, kitchen]) {
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(response.body.data.calaiLiveCalls, {
      ...liveSummary,
      generatedAt: f.config.now().toISOString(),
    });
    for (const privateValue of ["private-call-id", "private-agent-name", "private-transcript"]) {
      assert.equal(response.text.includes(privateValue), false);
    }
  }
  assert.equal(f.feed.reads, 1, "Concurrent viewers share the linked restaurant snapshot");

  const direct = await tablet.json("/api/business/calai/live");
  assert.equal(direct.status, 403, direct.text);
  for (const selection of ["cal-eats", "calai", null]) {
    selectMode(selection);
    const otherMode = await tablet.json(dashboardPath);
    assert.equal(otherMode.status, 200, otherMode.text);
    assert.equal(otherMode.body.data.calaiLiveCalls, null, "A cached snapshot still needs Both");
  }

  const unrelated = await f.call(dashboardPath, { session: f.otherSession });
  assert.equal(unrelated.status, 200, unrelated.text);
  assert.notEqual(unrelated.body.data.business.id, f.business.id);
  assert.equal(unrelated.body.data.calaiLiveCalls, null);
  assert.equal(f.feed.reads, 1, "Other modes and locations do not read the native call feed");
});

test("an unhealthy Calai call feed leaves both products' current orders available", async t => {
  const f = await fixture(t);
  const customer = f.db.prepare("SELECT id FROM users WHERE role='customer' LIMIT 1").get();
  const orderId = randomUUID(), at = f.config.now().toISOString();
  f.db.prepare("INSERT INTO orders(id,restaurant_id,restaurant_name,customer_id,status,currency,subtotal_minor," +
    "total_minor,commission_minor,payment_method,payment_status,fulfillment,idempotency_key,request_hash,created_at,updated_at) " +
    "VALUES(?,?,?,?,'completed','GBP',400,400,28,'mock_card','paid','collection',?,'SYNTHETIC_LIVE_CALLS',?,?)")
    .run(orderId, f.restaurant.id, f.restaurant.name, customer.id, orderId, at, at);

  const validSnapshot = f.feed.getSnapshot;
  let slowReadAborted = false;
  const failures = [
    ["incomplete", now => ({ ...validSnapshot(now), complete: false })],
    ["malformed", now => ({ ...validSnapshot(now), summary: { ...liveSummary, activeCalls: -1 } })],
    ["stale", now => validSnapshot(new Date(now.getTime() - 61_000))],
    ["future timestamp", now => validSnapshot(new Date(now.getTime() + 6_000))],
    ["upstream failure", () => { throw new HttpError(503, "CALAI_UNAVAILABLE", "Synthetic Live Calls outage"); }],
    ["slow feed", (_now, signal) => new Promise(resolve => {
      signal.addEventListener("abort", () => {
        slowReadAborted = true;
        resolve(null);
      }, { once: true });
    })],
  ];

  for (const [scenario, snapshot] of failures) {
    f.advance(6_000);
    f.feed.getSnapshot = snapshot;
    const response = await f.call(dashboardPath);
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.data.calaiLiveCalls, null, scenario);
    assert.equal(response.body.data.counts.calai.today, 1, scenario);
    assert.equal(response.body.data.counts["cal-eats"].today, 1, scenario);
    assert.ok(response.body.data.orders.some(order => order.sourceOrderId === orderId), scenario);
  }

  assert.equal(slowReadAborted, true, "A slow native call read gets cancelled");
  f.advance(6_000);
  const zero = { activeCalls: 0, agentsInUse: 0, ringing: 0, queued: 0, forwarding: 0 };
  f.feed.getSnapshot = now => ({ ...validSnapshot(now), summary: zero });
  const recovered = await f.call(dashboardPath);
  assert.equal(recovered.status, 200, recovered.text);
  assert.deepEqual(recovered.body.data.calaiLiveCalls, { ...zero, generatedAt: f.config.now().toISOString() });
});

test("a signed dashboard cannot publish Live Calls after the device scope or grant changes during refresh", async t => {
  const f = await fixture(t);
  const { tablet, selectMode, approve } = await registeredBothTablet(f);
  const approved = await approve();
  assert.equal(approved.status, 200, approved.text);

  const validSnapshot = f.feed.getSnapshot;
  async function refreshWhile(mutate) {
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    f.feed.getSnapshot = async now => {
      entered.resolve();
      await release.promise;
      return validSnapshot(now);
    };
    const response = tablet.json(dashboardPath);
    try {
      await Promise.race([
        entered.promise,
        response.then(result => assert.fail("Expected the native call read to start: " + result.text)),
      ]);
      mutate();
    } finally {
      release.resolve();
    }
    return response;
  }

  const switched = await refreshWhile(() => selectMode("cal-eats"));
  assert.equal(switched.status, 200, switched.text);
  assert.equal(switched.body.data.calaiLiveCalls, null);
  assert.equal(switched.body.data.counts["cal-eats"].available, true);

  selectMode("both");
  f.advance(6_000);
  const approvalRemoved = await refreshWhile(() => {
    const result = f.db.prepare("DELETE FROM business_terminal_calai_approvals WHERE terminal_id=?")
      .run(tablet.terminalId);
    assert.equal(result.changes, 1);
  });
  assert.equal(approvalRemoved.status, 200, approvalRemoved.text);
  assert.equal(approvalRemoved.body.data.calaiLiveCalls, null);
  assert.equal(approvalRemoved.body.data.counts.calai.available, false);

  assert.equal((await approve()).status, 200);
  f.advance(6_000);
  const revoked = await refreshWhile(() => {
    const result = f.db.prepare("UPDATE business_terminal_grants SET revoked_at=? WHERE terminal_id=? AND revoked_at IS NULL")
      .run(f.config.now().toISOString(), tablet.terminalId);
    assert.equal(result.changes, 1);
  });
  assert.equal(revoked.status, 401, revoked.text);
  assert.equal(revoked.body.data, undefined);
});

test("a failed native post-read identity check cannot publish an in-flight snapshot to another viewer", async t => {
  const f = await fixture(t);
  const nativeIdentity = f.adapter.identity, validSnapshot = f.feed.getSnapshot;
  const liveStarted = Promise.withResolvers(), bothOrdersStarted = Promise.withResolvers();
  const release = Promise.withResolvers();
  let ordersReads = 0, rejectNextIdentity = false;
  f.feed.getSnapshot = async now => {
    liveStarted.resolve();
    await release.promise;
    return validSnapshot(now);
  };
  f.state.readHook = section => {
    if (section === "orders" && ++ordersReads === 2) bothOrdersStarted.resolve();
  };
  f.adapter.identity = async (...args) => {
    const identity = await nativeIdentity(...args);
    if (!rejectNextIdentity) return identity;
    rejectNextIdentity = false;
    return { ...identity, business: { ...identity.business, businessId: randomUUID() } };
  };

  const initiator = f.call(dashboardPath);
  const waiter = (async () => {
    await liveStarted.promise;
    return f.call(dashboardPath);
  })();
  try {
    await Promise.race([
      bothOrdersStarted.promise,
      initiator.then(result => assert.fail("Expected the live source to still be waiting: " + result.text)),
      waiter.then(result => assert.fail("Expected the later viewer to join the live read: " + result.text)),
    ]);
    assert.equal(f.feed.reads, 1);
    rejectNextIdentity = true;
  } finally {
    release.resolve();
  }

  const [failed, waiting] = await Promise.all([initiator, waiter]);
  assert.equal(failed.status, 200, failed.text);
  assert.equal(failed.body.data.connections.calai.code, "CALAI_BUSINESS_CHANGED");
  assert.equal(failed.body.data.calaiLiveCalls, null);
  assert.equal(waiting.status, 200, waiting.text);
  assert.equal(waiting.body.data.counts.calai.today, 1, "The waiting viewer had its own valid native order read");
  assert.equal(waiting.body.data.calaiLiveCalls, null, "An unverified publisher can never populate another viewer's snapshot");

  f.feed.getSnapshot = validSnapshot;
  const fresh = await f.call(dashboardPath);
  assert.equal(fresh.status, 200, fresh.text);
  assert.deepEqual(fresh.body.data.calaiLiveCalls, { ...liveSummary, generatedAt: f.config.now().toISOString() });
  assert.equal(f.feed.reads, 2, "Recovery reads a new native snapshot");
});

test("Both activity uses the installed signed read, exact business proof, and a limited shared snapshot", async t => {
  const f = await fixture(t);
  const { tablet, selectMode, approve } = await registeredBothTablet(f);
  assert.equal(requestAllowed("GET", activityPath, f.restaurant.id, f.business.id), true);
  assert.equal((await tablet.json(activityPath)).status, 403);
  assert.equal((await f.call(activityPath, { session: f.otherSession })).status, 403);
  assert.equal(f.feed.reads, 0);
  assert.equal(f.state.reads.length, 0);

  assert.equal((await approve()).status, 200);
  const snapshot = f.feed.getSnapshot;
  let generatedAge = 0;
  f.feed.getSnapshot = now => ({ ...snapshot(new Date(now.getTime() - generatedAge)), calls: [
    { id: "private-current-call", status: "ringing", agentName: "private-agent-name", startedAt: new Date(now.getTime() - 2_000).toISOString() },
    { id: "private-ended-call", status: "ended", startedAt: now.toISOString() },
    { id: "invalid-call-time", status: "queued", startedAt: "unknown" },
  ] });

  const [owner, kitchen] = await Promise.all([f.call(activityPath), tablet.json(activityPath)]);
  for (const response of [owner, kitchen]) {
    assert.equal(response.status, 200, response.text);
    assert.equal(response.headers.get?.("cache-control") ?? response.headers["Cache-Control"], "private, no-store");
    assert.equal(response.body.data.businessId, f.business.id);
    for (const projection of [response.body.data.calls, response.body.data.phoneOrders]) {
      assert.deepEqual(Object.keys(projection).sort(), ["events", "generatedAt"]);
      assert.equal(projection.events.length, 1);
      assert.deepEqual(Object.keys(projection.events[0]).sort(), ["at", "key"]);
      assert.match(projection.events[0].key, /^[a-f0-9]{64}$/);
    }
    for (const privateValue of ["private-current-call", "private-agent-name", "Synthetic phone customer", "c3333333-3333-4333-8333-333333333333"]) {
      assert.equal(response.text.includes(privateValue), false);
    }
  }
  assert.deepEqual(owner.body.data, kitchen.body.data);
  assert.equal(f.feed.reads, 1);
  assert.deepEqual(f.state.reads, ["orders"]);

  f.advance(6_000);
  const next = await tablet.json(activityPath);
  assert.equal(next.status, 200, next.text);
  assert.equal(next.body.data.calls.events[0].key, owner.body.data.calls.events[0].key);
  assert.deepEqual(next.body.data.phoneOrders, owner.body.data.phoneOrders);
  assert.equal(f.feed.reads, 2);
  assert.deepEqual(f.state.reads, ["orders"], "Do not fetch the full native list at the call cadence");

  f.advance(25_000);
  generatedAge = 21_000;
  const stale = await tablet.json(activityPath);
  assert.equal(stale.status, 200, stale.text);
  assert.equal(stale.body.data.calls, null);
  assert.equal(stale.body.data.phoneOrders.events[0].key, owner.body.data.phoneOrders.events[0].key);
  assert.deepEqual(f.state.reads, ["orders", "orders"]);

  for (const selection of ["calai", "cal-eats", null]) {
    selectMode(selection);
    assert.equal((await tablet.json(activityPath)).status, 403, String(selection));
  }
  assert.equal(f.feed.reads, 3, "Other tablet modes cannot use a previously cached Both feed");

  selectMode("both");
  f.state.available = false;
  const unavailable = await tablet.json(activityPath);
  assert.equal(unavailable.status, 200, unavailable.text);
  assert.deepEqual(unavailable.body.data, { businessId: f.business.id, calls: null, phoneOrders: null });
  const current = await tablet.json("/api/business/context");
  assert.equal(current.status, 200, current.text);
  assert.equal(current.body.data.canViewEats, true);
});

test("an in-flight Both activity read cannot publish to a tablet switched to another mode", async t => {
  const f = await fixture(t);
  const { tablet, selectMode, approve } = await registeredBothTablet(f);
  assert.equal((await approve()).status, 200);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const snapshot = f.feed.getSnapshot;
  f.feed.getSnapshot = async now => {
    entered.resolve();
    await release.promise;
    return snapshot(now);
  };
  const pending = tablet.json(activityPath);
  try {
    await Promise.race([entered.promise, pending.then(result => assert.fail("Expected a pending native read: " + result.text))]);
    selectMode("cal-eats");
  } finally {
    release.resolve();
  }
  const switched = await pending;
  assert.equal(switched.status, 403, switched.text);
  assert.equal(switched.body.error.code, "CALAI_AUTHORITY_REQUIRED");
  assert.equal(switched.body.data, undefined);
});
