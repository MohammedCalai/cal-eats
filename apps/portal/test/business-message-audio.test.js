import test from "node:test";
import assert from "node:assert/strict";
import {createBusinessMessageAudio} from "../src/business-message-audio.js";

const settled = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function setup({ autoFinish = true, readAcknowledged, writeAcknowledged } = {}) {
  let now = 0, nextId = 0;
  const timers = new Map(), pending = [], storage = new Map();
  const player = {
    plays: 0, pauses: 0, active: 0, maxActive: 0, blocked: false,
    play() {
      this.plays++;
      if (this.blocked) return Promise.reject(Object.assign(new Error("Gesture required"), { name: "NotAllowedError" }));
      this.active++; this.maxActive = Math.max(this.maxActive, this.active);
      const run = { active: true, resolve: null };
      const work = new Promise(resolve => { run.resolve = resolve; });
      run.finish = () => { if (!run.active) return; run.active = false; this.active--; run.resolve(); };
      pending.push(run);
      if (autoFinish) run.finish();
      return work;
    },
    pause() { this.pauses++; for (const run of pending) run.finish(); },
    finish() { pending.find(run => run.active)?.finish(); }
  };
  const audio = createBusinessMessageAudio(player, {
    readAcknowledged: readAcknowledged ?? (scope => storage.get(scope)),
    writeAcknowledged: writeAcknowledged ?? ((scope, revision) => storage.set(scope, revision)),
    schedule(callback, delay) { const id = ++nextId; timers.set(id, { callback, at: now + delay }); return id; },
    cancel(id) { timers.delete(id); }
  });
  return { player, audio, storage, timers, async advance(ms) {
    const end = now + ms;
    while (true) {
      const next = [...timers.entries()].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].callback(); await settled();
    }
    now = end; await settled();
  } };
}
const update = (audio, changes = {}) => audio.update({ scope: "owner-a:restaurant-a", enabled: true, pending: 2, revision: 10, orderAlarmActive: false, ...changes });

test("message reminders are idle without unread arrivals and repeated polling preserves a single twenty-second cadence", async () => {
  const { player, audio, timers, advance, storage } = setup();
  update(audio, { pending: 0, revision: 0 }); audio.interact(); await advance(60000);
  assert.equal(player.plays, 0); assert.equal(timers.size, 0); assert.equal(storage.size, 0);
  update(audio); await settled(); assert.equal(player.plays, 1); assert.equal(timers.size, 1);
  const snapshot = audio.getSnapshot();
  for (let index = 0; index < 10; index++) update(audio);
  assert.equal(audio.getSnapshot(), snapshot); assert.equal(player.plays, 1); assert.equal(timers.size, 1);
  await advance(19999); assert.equal(player.plays, 1);
  await advance(1); assert.equal(player.plays, 2); assert.equal(player.maxActive, 1);
  update(audio, { pending: false }); await advance(60000); assert.equal(player.plays, 2); assert.equal(timers.size, 0);
});

test("opening a conversation hushes the whole current backlog persistently, while a newer arrival re-arms it", async () => {
  const { player, audio, storage, advance } = setup({ autoFinish: false });
  update(audio); assert.equal(player.active, 1); assert.equal(audio.acknowledge(), 10);
  assert.equal(player.active, 0); assert.equal(storage.get("owner-a:restaurant-a"), 10);
  update(audio, { pending: 7 }); audio.interact(); await advance(60000); assert.equal(player.plays, 1);
  update(audio, { pending: 6, revision: 9 }); assert.equal(player.plays, 1);
  update(audio, { revision: 11 }); assert.equal(player.plays, 2); assert.equal(player.active, 1);
  audio.acknowledge(); assert.equal(storage.get("owner-a:restaurant-a"), 11);
  audio.stop(); update(audio, { revision: 11 }); await advance(60000); assert.equal(player.plays, 2);
  const persisted = setup({ readAcknowledged: scope => storage.get(scope) });
  update(persisted.audio, { revision: 11 }); await persisted.advance(60000); assert.equal(persisted.player.plays, 0);
});

test("restaurant/account scopes isolate acknowledgement and route-style repeat updates do not reset it", async () => {
  const { player, audio, storage, advance } = setup();
  update(audio); await settled(); audio.acknowledge();
  update(audio, { scope: "owner-a:restaurant-b", revision: 4 }); await settled(); assert.equal(player.plays, 2);
  audio.acknowledge(); assert.equal(storage.get("owner-a:restaurant-b"), 4);
  update(audio, { scope: "owner-b:restaurant-a", revision: 10 }); await settled(); assert.equal(player.plays, 3);
  audio.acknowledge("owner-a:restaurant-a"); assert.equal(audio.getSnapshot().acknowledgedRevision, 0);
  update(audio); await advance(60000); assert.equal(player.plays, 3); assert.equal(storage.get("owner-a:restaurant-a"), 10);
  assert.equal(storage.has("owner-b:restaurant-a"), false);
});

test("order alarms take priority; mute, empty backlog and stop cancel active melody and stale completion", async () => {
  const { player, audio, timers, advance, storage } = setup({ autoFinish: false });
  update(audio, { orderAlarmActive: true }); assert.equal(player.plays, 0);
  update(audio); assert.equal(player.active, 1);
  update(audio, { orderAlarmActive: true }); assert.equal(player.active, 0); assert.equal(timers.size, 0);
  await advance(60000); assert.equal(player.plays, 1);
  update(audio); assert.equal(player.plays, 2);
  update(audio, { enabled: false }); assert.equal(player.active, 0); assert.equal(storage.size, 0);
  update(audio); assert.equal(player.plays, 3);
  update(audio, { pending: 0 }); assert.equal(player.active, 0);
  update(audio); assert.equal(player.plays, 4); audio.stop(); audio.interact();
  await advance(60000); assert.equal(player.active, 0); assert.equal(player.plays, 4); assert.equal(timers.size, 0);
  assert.equal(audio.getSnapshot().scope, ""); assert.equal(player.maxActive, 1);
});

test("blocked autoplay waits for a trusted interaction rather than retrying each poll", async () => {
  const { player, audio, timers, advance } = setup(); player.blocked = true;
  update(audio); await settled(); assert.equal(player.plays, 1); assert.equal(audio.getSnapshot().blocked, true);
  for (let index = 0; index < 10; index++) update(audio);
  await advance(60000); assert.equal(player.plays, 1); assert.equal(timers.size, 0);
  player.blocked = false; audio.interact(); await settled();
  assert.equal(player.plays, 2); assert.equal(audio.getSnapshot().blocked, false); assert.equal(audio.getSnapshot().error, "");
  audio.interact(); assert.equal(player.plays, 2);
});

test("slow melody never overlaps; storage denial cannot prevent acknowledgement and cleanup", async () => {
  const { player, audio, advance, timers } = setup({ autoFinish: false, readAcknowledged() { throw new Error("Storage denied"); }, writeAcknowledged() { throw new Error("Storage denied"); } });
  const snapshots = [], unsubscribe = audio.subscribe(snapshot => snapshots.push(snapshot));
  update(audio); await advance(20000); assert.equal(player.plays, 1); assert.equal(player.active, 1);
  player.finish(); await settled(); assert.equal(player.plays, 2); assert.equal(player.maxActive, 1);
  audio.acknowledge(); await settled(); assert.equal(player.active, 0); assert.equal(audio.getSnapshot().acknowledgedRevision, 10);
  update(audio); await advance(60000); assert.equal(player.plays, 2); assert.equal(timers.size, 0);
  unsubscribe(); const count = snapshots.length; audio.stop(); assert.equal(snapshots.length, count);
});

test("server read barriers cover arrivals missed by a stale poll without acknowledging a newer unread arrival", async () => {
  const scope="owner-a:restaurant-a",{player,audio,storage,advance}=setup({autoFinish:false});
  update(audio,{revision:100});assert.equal(player.plays,1);
  assert.equal(audio.acknowledge(scope,120),120);assert.equal(player.active,0);
  update(audio,{revision:120});await advance(60000);assert.equal(player.plays,1);
  update(audio,{revision:121});assert.equal(player.plays,2);assert.equal(player.active,1);
  assert.equal(audio.acknowledge(scope,120),120);assert.equal(storage.get(scope),120);
  assert.equal(player.active,1);assert.equal(audio.getSnapshot().acknowledgedRevision,120);
  update(audio,{revision:121});await advance(20000);assert.equal(player.plays,2);
  player.finish();await settled();assert.equal(player.plays,3);assert.equal(player.maxActive,1);
  audio.acknowledge(scope,121);assert.equal(player.active,0);assert.equal(storage.get(scope),121);
  assert.throws(()=>audio.acknowledge(scope,"122"),/safe integer/);assert.equal(storage.get(scope),121);
  audio.stop();
});
