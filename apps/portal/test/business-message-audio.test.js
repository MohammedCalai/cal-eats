import test from "node:test";
import assert from "node:assert/strict";
import {createBusinessMessageAudio,BUSINESS_MESSAGE_REPEAT_MS} from "../src/business-message-audio.js";

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

test("message reminders play once and preserve a ten-second cadence across five-second polls", async () => {
  const { player, audio, timers, advance, storage } = setup();
  update(audio, { pending: 0, revision: 0 }); audio.interact(); await advance(60000);
  assert.equal(player.plays, 0); assert.equal(timers.size, 0); assert.equal(storage.size, 0);
  update(audio); await settled(); assert.equal(player.plays, 1); assert.equal(timers.size, 1);
  const snapshot = audio.getSnapshot();
  for (let index = 0; index < 10; index++) update(audio);
  assert.equal(audio.getSnapshot(), snapshot); assert.equal(player.plays, 1); assert.equal(timers.size, 1);
  assert.equal(BUSINESS_MESSAGE_REPEAT_MS,10000);
  await advance(5000);update(audio);assert.equal(player.plays,1);
  await advance(4999); assert.equal(player.plays, 1);
  await advance(1); assert.equal(player.plays, 2); assert.equal(player.maxActive, 1);
  update(audio, { pending: false }); await advance(60000); assert.equal(player.plays, 2); assert.equal(timers.size, 0);
});

test("reading one conversation acknowledges attention without clearing other unread messages and a new arrival re-arms", async () => {
  const { player, audio, advance, timers } = setup();
  update(audio,{pending:1000,revision:10});await settled();assert.equal(player.plays,1);
  assert.equal(audio.acknowledge({scope:"owner-a:restaurant-a",revision:10,unreadCount:0}),true);
  update(audio,{pending:999,revision:10});await advance(60000);assert.equal(player.plays,1);assert.equal(timers.size,0);
  assert.equal(audio.getSnapshot().pending,true);assert.equal(audio.getSnapshot().acknowledgedRevision,10);
  audio.stop();update(audio,{pending:999,revision:10});audio.interact();await advance(10000);assert.equal(player.plays,1);
  update(audio,{pending:1000,revision:11});await settled();assert.equal(player.plays,2);
  update(audio,{pending:0,revision:11});audio.stop();
});

test("attention acknowledgement stays scoped to each restaurant and user through dashboard returns", async () => {
  const {player,audio,advance}=setup();
  update(audio);await settled();audio.acknowledge({scope:"owner-a:restaurant-a",revision:10,unreadCount:0});
  update(audio,{scope:"owner-a:restaurant-b",revision:10});await settled();assert.equal(player.plays,2);
  audio.acknowledge({scope:"owner-a:restaurant-b",revision:10,unreadCount:0});
  update(audio);await advance(20000);assert.equal(player.plays,2);
  update(audio,{scope:"owner-b:restaurant-a",revision:10});await settled();assert.equal(player.plays,3);
  audio.stop();update(audio,{pending:1000,revision:10});await advance(20000);assert.equal(player.plays,3);
  update(audio,{revision:11});await settled();assert.equal(player.plays,4);audio.stop();
});

test("restaurant/account changes cancel the old scope; legacy browser acknowledgements cannot suppress unread messages", async () => {
  let legacyReads=0;
  const { player, audio, advance } = setup({autoFinish:false,readAcknowledged(){legacyReads++;return 999;}});
  update(audio);assert.equal(player.active,1);assert.equal(legacyReads,0);
  update(audio,{scope:"owner-a:restaurant-b",pending:0,revision:0});assert.equal(player.active,0);
  await advance(30000);assert.equal(player.plays,1);
  update(audio,{scope:"owner-b:restaurant-a",pending:1,revision:1});assert.equal(player.plays,2);
  update(audio,{scope:"owner-b:restaurant-a",pending:0,revision:1});assert.equal(player.active,0);audio.stop();
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

test("slow melody never overlaps and successful conversation reads cancel its outstanding completion", async () => {
  const { player, audio, advance, timers } = setup({ autoFinish: false, readAcknowledged() { throw new Error("Storage denied"); }, writeAcknowledged() { throw new Error("Storage denied"); } });
  const snapshots = [], unsubscribe = audio.subscribe(snapshot => snapshots.push(snapshot));
  update(audio); await advance(10000); assert.equal(player.plays, 1); assert.equal(player.active, 1);
  player.finish(); await settled(); assert.equal(player.plays, 2); assert.equal(player.maxActive, 1);
  assert.equal(audio.acknowledge({scope:"owner-a:restaurant-a",revision:10,unreadCount:0}),true);await settled();assert.equal(player.active,0);
  update(audio,{pending:1}); await advance(60000); assert.equal(player.plays, 2); assert.equal(timers.size, 0);
  unsubscribe(); const count = snapshots.length; audio.stop(); assert.equal(snapshots.length, count);
});

test("an unrelated read or a stale read barrier cannot silence pending messages", async () => {
  const {player,audio,advance}=setup();
  update(audio,{pending:2,revision:120});await settled();
  for(const detail of [
    {scope:"owner-b:restaurant-a",revision:120,unreadCount:0},
    {scope:"owner-a:restaurant-b",revision:120,unreadCount:0},
    {scope:"owner-a:restaurant-a",revision:120},
    {scope:"owner-a:restaurant-a",revision:120,unreadCount:1},
    {scope:"owner-a:restaurant-a",revision:119,unreadCount:0},
    {scope:"owner-a:restaurant-a",revision:"120",unreadCount:0}
  ])assert.equal(audio.acknowledge(detail),false);
  update(audio,{pending:1,revision:120});await advance(10000);assert.equal(player.plays,2);
  update(audio,{pending:2,revision:121});
  assert.equal(audio.acknowledge({scope:"owner-a:restaurant-a",revision:120,unreadCount:0}),false);
  await advance(10000);assert.equal(player.plays,3);
  assert.equal(audio.acknowledge({scope:"owner-a:restaurant-a",revision:121,unreadCount:1}),false);
  await advance(10000);assert.equal(player.plays,4);
  assert.equal(audio.acknowledge({scope:"owner-a:restaurant-a",revision:121,unreadCount:0}),true);
  update(audio,{pending:1,revision:121});await advance(20000);assert.equal(player.plays,4);
  update(audio,{pending:2,revision:122});await settled();assert.equal(player.plays,5);audio.stop();
});

test("a server read ahead of the last poll covers only its exact revision and never a later arrival", async () => {
  const {player,audio,advance}=setup();
  update(audio,{revision:120});await settled();
  assert.equal(audio.acknowledge({scope:"owner-a:restaurant-a",revision:121,unreadCount:0}),true);
  update(audio,{revision:120});update(audio,{revision:121});await advance(20000);assert.equal(player.plays,1);
  update(audio,{revision:122});await settled();assert.equal(player.plays,2);audio.stop();
});
