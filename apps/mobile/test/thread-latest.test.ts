import assert from "node:assert/strict";
import test from "node:test";
import { completeThreadSend, createThreadRefresh, createThreadWindow } from "../src/thread-refresh.ts";
import { createThreadScroll } from "../src/thread-scroll.ts";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function scrolling() {
  const frames = new Map<number, () => void>(), changes: boolean[] = [];
  let next = 0, scrolls = 0, active = true;
  const controller = createThreadScroll({
    requestFrame: callback => { frames.set(++next, callback); return next; },
    cancelFrame: id => { frames.delete(id); },
    scrollToLatest: () => { scrolls++; }, onFollowingChange: value => changes.push(value),
    isCurrent: () => active
  });
  const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); };
  return { controller, flush, changes, count: () => scrolls, leave: () => { active = false; } };
}
const position = (y: number, viewport = 400, content = 1200) => ({ contentSize: { height: content }, layoutMeasurement: { height: viewport }, contentOffset: { y } });
const row = (number: number) => ({ id: String(number).padStart(4, "0"), createdAt: new Date(Date.UTC(2026, 10, 6, 0, number)).toISOString(), message: `Message ${number}` });

test("a successful delayed send preserves text typed for the next message", async () => {
  const response = deferred<string>();
  let draft = "The message being sent", sent = "";
  const pending = completeThreadSend({ send: () => response.promise, text: draft, isCurrent: () => true, updateDraft: update => { draft = update(draft); }, onSent: value => { sent = value; } });
  draft = "A new draft typed during the request";
  response.resolve("canonical sent bubble");
  await pending;
  assert.equal(draft, "A new draft typed during the request");
  assert.equal(sent, "canonical sent bubble");
});

test("a delayed send cannot clear or append to a newer thread or signed-in session", async () => {
  const response = deferred<string>();
  let scope = "previous session and thread", draft = "Previous draft";
  const sent: string[] = [];
  const pending = completeThreadSend({ send: () => response.promise, text: draft, isCurrent: () => scope === "previous session and thread", updateDraft: update => { draft = update(draft); }, onSent: value => { sent.push(value); } });
  scope = "current session and thread"; draft = "Current draft";
  response.resolve("Previous thread message");
  await pending;
  assert.equal(draft, "Current draft");
  assert.deepEqual(sent, []);
  // React may apply the functional state update after the user navigates away.
  let delayedUpdate: ((value: string) => string) | undefined;
  await completeThreadSend({ send: async () => "Current message", text: draft, isCurrent: () => scope === "current session and thread", updateDraft: update => { delayedUpdate = update; }, onSent: () => {} });
  scope = "signed out";
  assert.equal(delayedUpdate!("Current draft"), "Current draft");
});

test("send shows its canonical result while a stale poll finishes, then waits for a fresh read", async () => {
  const oldPoll = deferred<string[]>(), afterSend = deferred<string[]>();
  let loads = 0, visible = ["original"], refreshed = false;
  const errors: string[] = [];
  const controller = createThreadRefresh({
    load: () => (++loads === 1 ? oldPoll.promise : afterSend.promise),
    apply: value => { visible = value; }, onError: error => errors.push((error as Error).message), isCurrent: () => true
  });
  const poll = controller.refresh("latest", true);
  // This is the successful POST response, before the earlier GET returns.
  controller.invalidate(); visible = ["original", "just sent"];
  const fresh = controller.refresh().then(() => { refreshed = true; });
  oldPoll.resolve(["original"]);
  await poll;
  assert.equal(loads, 2);
  assert.deepEqual(visible, ["original", "just sent"]);
  assert.equal(refreshed, false);
  afterSend.resolve(["original", "just sent", "restaurant reply"]);
  await fresh;
  assert.deepEqual(visible, ["original", "just sent", "restaurant reply"]);
  assert.deepEqual(errors, []);
});

test("leaving a thread prevents late reads, errors and loading callbacks affecting the next thread", async () => {
  const response = deferred<string[]>(), values: string[][] = [], loading: boolean[] = [], errors: unknown[] = [];
  let activeScope = "old";
  const old = createThreadRefresh({ load: () => response.promise, apply: value => { values.push(value); }, onError: error => errors.push(error), onLoading: value => loading.push(value), isCurrent: () => activeScope === "old" });
  const first = old.refresh(), queued = old.refresh();
  activeScope = "new"; old.dispose();
  const current = createThreadRefresh({ load: async () => ["current thread"], apply: value => { values.push(value); }, onError: error => errors.push(error), isCurrent: () => activeScope === "new" });
  await current.refresh();
  response.reject(new Error("Previous thread failed"));
  await Promise.all([first, queued]);
  assert.deepEqual(values, [["current thread"]]);
  assert.deepEqual(errors, []);
  assert.deepEqual(loading, [true]);
  assert.equal(old.isActive(), false);
});

test("older-page taps coalesce and a latest read still follows a pending older request", async () => {
  const earlier = deferred<string>(), pages: string[] = [], applied: string[] = [];
  const controller = createThreadRefresh({ load: page => { pages.push(page); return page === "earlier" ? earlier.promise : Promise.resolve("newest"); }, apply: value => { applied.push(value); }, onError: () => {}, isCurrent: () => true });
  const first = controller.refresh("earlier"), repeated = controller.refresh("earlier"), latest = controller.refresh();
  assert.equal(first, repeated);
  assert.deepEqual(pages, ["earlier"]);
  earlier.resolve("older history");
  await Promise.all([first, repeated, latest]);
  assert.deepEqual(pages, ["earlier", "latest"]);
  assert.deepEqual(applied, ["older history", "newest"]);
});

test("open and own-send follow survives geometry scroll events and keyboard resizing without new content", () => {
  const view = scrolling();
  view.controller.requestLatest(); view.flush();
  assert.equal(view.count(), 1);
  // Keyboard shrinks the viewport with exactly the same content height. This
  // onScroll is produced by layout rather than the reader scrolling upward.
  view.controller.scroll(position(800, 240));
  view.controller.geometryChanged(); view.flush();
  assert.equal(view.count(), 2);
  assert.equal(view.controller.isFollowing(), true);
  view.controller.beginInteraction(); view.controller.scroll(position(100)); view.controller.endInteraction();
  view.controller.requestLatest();
  view.controller.scroll(position(100, 240));
  view.controller.geometryChanged(); view.flush();
  view.controller.geometryChanged(); view.flush(); // multiline composer settles
  assert.equal(view.count(), 4);
  assert.equal(view.controller.isFollowing(), true);
});

test("incoming messages and earlier-page layout preserve reading history until the reader returns", () => {
  const view = scrolling();
  view.controller.requestLatest(); view.flush();
  view.controller.beginInteraction(); view.controller.scroll(position(200)); view.controller.endInteraction();
  view.controller.geometryChanged(); view.flush();
  assert.equal(view.count(), 1);
  view.controller.preserveHistory(); view.controller.geometryChanged(); view.flush();
  assert.equal(view.count(), 1);
  assert.equal(view.controller.isFollowing(), false);
  view.controller.beginInteraction(); view.controller.scroll(position(800)); view.controller.endInteraction(); view.flush();
  view.controller.geometryChanged(); view.flush();
  assert.equal(view.count(), 3);
  assert.equal(view.controller.isFollowing(), true);
});

test("a pending follow frame cannot scroll another thread after navigation or unmount", () => {
  const old = scrolling(); old.controller.requestLatest(); old.leave(); old.flush();
  assert.equal(old.count(), 0);
  const unmounted = scrolling(); unmounted.controller.requestLatest(); unmounted.controller.dispose(); unmounted.flush();
  assert.equal(unmounted.count(), 0);
});

test("a sliding latest page retains the currently read row and deduplicates prepended history", () => {
  const window = createThreadWindow<ReturnType<typeof row>>(4);
  window.receive([row(3), row(4), row(5)], { before: row(3).createdAt, beforeId: row(3).id }, "latest", false);
  const incoming = window.receive([row(4), row(5), row(6)], { before: row(4).createdAt, beforeId: row(4).id }, "latest", true);
  assert.deepEqual(incoming.items.map(item => item.id), [3, 4, 5, 6].map(number => row(number).id));
  const older = window.receive([row(1), row(2), row(3)], null, "earlier", true);
  assert.deepEqual(older.items.map(item => item.id), [1, 2, 3, 4, 5, 6].map(number => row(number).id));
  assert.equal(older.nextCursor, null);
  const more = window.receive([row(5), row(6), row(7)], null, "latest", true);
  assert.equal(more.items[0]!.id, row(1).id);
  // Return to the bottom: cap automatic history, retaining a valid earlier cursor.
  const following = window.receive([row(5), row(6), row(7)], null, "latest", false);
  assert.deepEqual(following.items.map(item => item.id), [4, 5, 6, 7].map(number => row(number).id));
  assert.deepEqual(following.nextCursor, { before: row(4).createdAt, beforeId: row(4).id });
  assert.deepEqual(window.append(row(7)).items.map(item => item.id), [4, 5, 6, 7].map(number => row(number).id));
});
