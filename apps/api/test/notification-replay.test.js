import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { journeyFixture } from "./helpers.js";
import { notificationStreamHub } from "../src/notification-stream.js";

async function replayFixture() {
  const f = await journeyFixture();
  await f.login("customer@calai.local", "LocalCustomer!4310");
  const user = f.db.prepare("SELECT id FROM users WHERE email='customer@calai.local'").get();
  const other = f.db.prepare("SELECT id FROM users WHERE email='restaurant@calai.local'").get();
  const session = f.db.prepare("SELECT id FROM sessions WHERE user_id=?").get(user.id);
  const insert = f.db.prepare("INSERT INTO user_notifications(id,user_id,type,title,message,event_key,created_at) VALUES(?,?,'order_status','Notice','Fixture only',?,?)");
  const add = (id, recipient = user.id) => insert.run(id, recipient, `replay:${id}`, f.config.now().toISOString());
  const req = new EventEmitter(), res = new EventEmitter(), output = [];
  Object.assign(res, { writeHead() {}, flushHeaders() {}, write(chunk) { output.push(chunk); return true; }, end() { this.ended = true; } });
  return { f, user, other, session, req, res, add, ids: () => [...output.join("").matchAll(/^id: (.+)$/gm)].map(match => match[1]) };
}

for (const count of [150, 1000]) {
  test(`reconnect drains ${count} missed notifications in bounded pages without skipping concurrent writes`, async () => {
    const x = await replayFixture(); let hub;
    try {
      x.add("cursor");
      const expected = [];
      for (let i = 0; i < count; i++) { const id = `missed-${i}`; x.add(id); expected.push(id); x.add(`other-${i}`, x.other.id); }
      // The hub starts after the backlog already exists, reproducing BE-03.
      hub = notificationStreamHub(x.f.db, { pollMs: 60_000, heartbeatMs: 60_000, now: x.f.config.now });
      hub.subscribe({ req: x.req, res: x.res, userId: x.user.id, sessionId: x.session.id, lastEventId: "cursor" });
      assert.equal(x.ids().length, 100);
      for (let i = 0; i < 15; i++) {
        const id = `during-replay-${i}`; x.add(id); expected.push(id);
        hub.poll();
      }
      hub.poll();
      assert.deepEqual(x.ids(), expected);
      assert.equal(new Set(x.ids()).size, expected.length);
    } finally { hub?.close(); await x.f.close(); }
  });
}

test("deleted or foreign reconnect cursors replay only retained recipient events", async () => {
  const x = await replayFixture(); let hub;
  try {
    x.add("foreign-cursor", x.other.id);
    const expected = Array.from({ length: 150 }, (_, i) => `retained-${i}`);
    for (const id of expected) x.add(id);
    hub = notificationStreamHub(x.f.db, { pollMs: 60_000, heartbeatMs: 60_000, now: x.f.config.now });
    hub.subscribe({ req: x.req, res: x.res, userId: x.user.id, sessionId: x.session.id, lastEventId: "foreign-cursor" });
    hub.poll();
    assert.deepEqual(x.ids(), expected);
    x.req.emit("close");
    // The same unavailable-cursor branch also handles an event removed by retention.
    x.f.db.prepare("DELETE FROM user_notifications WHERE id=?").run("foreign-cursor");
    const next = new EventEmitter(), chunks = [];
    Object.assign(next, { writeHead() {}, flushHeaders() {}, write(chunk) { chunks.push(chunk); return true; }, end() {} });
    hub.subscribe({ req: new EventEmitter(), res: next, userId: x.user.id, sessionId: x.session.id, lastEventId: "foreign-cursor" });
    hub.poll();
    assert.deepEqual([...chunks.join("").matchAll(/^id: (.+)$/gm)].map(match => match[1]), expected);
  } finally { hub?.close(); await x.f.close(); }
});

test("revoked sessions stop a pending replay before the next page is sent", async () => {
  const x = await replayFixture(); let hub;
  try {
    x.add("cursor");
    for (let i = 0; i < 150; i++) x.add(`pending-${i}`);
    hub = notificationStreamHub(x.f.db, { pollMs: 60_000, heartbeatMs: 60_000, now: x.f.config.now });
    hub.subscribe({ req: x.req, res: x.res, userId: x.user.id, sessionId: x.session.id, lastEventId: "cursor" });
    x.f.db.prepare("UPDATE sessions SET revoked_at=? WHERE id=?").run(x.f.config.now().toISOString(), x.session.id);
    hub.poll();
    assert.equal(x.ids().length, 100);
    assert.equal(x.res.ended, true);
  } finally { hub?.close(); await x.f.close(); }
});
