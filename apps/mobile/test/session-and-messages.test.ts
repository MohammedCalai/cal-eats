import assert from "node:assert/strict";
import test from "node:test";
import { bindCustomerProfileUpdate } from "../src/session-identity.ts";
import { createConversationRefresh } from "../src/conversation-refresh.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test("a pending account response cannot restore a customer after sign-out", async () => {
  let activeToken: string | null = "customer-a-session";
  let visibleUser: { id: string; name: string } | null = null;
  const response = deferred<{ id: string; name: string }>();
  const pending = response.promise.then(bindCustomerProfileUpdate<{ id: string; name: string }>(activeToken, "customer-a", () => activeToken, user => { visibleUser = user; }));
  activeToken = null;
  response.resolve({ id: "customer-a", name: "Previous customer" });
  await pending;
  assert.equal(visibleUser, null);
});

test("a previous customer's delayed profile cannot overwrite a newer sign-in", async () => {
  let activeToken = "customer-a-session";
  let visibleUser = { id: "customer-b", name: "Current customer" };
  const response = deferred<{ id: string; name: string }>();
  const pending = response.promise.then(bindCustomerProfileUpdate<{ id: string; name: string }>(activeToken, "customer-a", () => activeToken, user => { visibleUser = user; }));
  activeToken = "customer-b-session";
  response.resolve({ id: "customer-a", name: "Previous customer" });
  await pending;
  assert.equal(visibleUser.id, "customer-b");
});

test("active customer profile edits apply, while a mismatched identity is rejected", () => {
  let visibleUser = { id: "customer-a", name: "Original" };
  const update = bindCustomerProfileUpdate<{ id: string; name: string }>("active-session", "customer-a", () => "active-session", user => { visibleUser = user; });
  update({ id: "customer-a", name: "Updated name" });
  assert.equal(visibleUser.name, "Updated name");
  update({ id: "customer-b", name: "Wrong identity" });
  assert.deepEqual(visibleUser, { id: "customer-a", name: "Updated name" });
});

test("foreground conversation refresh delivers new unread rows without blanking the list", async () => {
  type Row = { id: string; unread: number };
  let rows: Row[] = [{ id: "restaurant-chat", unread: 0 }];
  const loading: boolean[] = [], response = deferred<Row[]>();
  const refresh = createConversationRefresh({ load: () => response.promise, apply: value => { rows = value; }, onError: () => {}, onLoading: value => loading.push(value) });
  const pending = refresh.refresh(true);
  assert.deepEqual(rows, [{ id: "restaurant-chat", unread: 0 }]);
  response.resolve([{ id: "restaurant-chat", unread: 1 }, { id: "new-chat", unread: 1 }]);
  await pending;
  assert.deepEqual(rows, [{ id: "restaurant-chat", unread: 1 }, { id: "new-chat", unread: 1 }]);
  assert.deepEqual(loading, []);
});

test("overlapping message polls are skipped and a network failure keeps the last rows", async () => {
  const rows = [{ id: "existing-chat" }], response = deferred<typeof rows>();
  let calls = 0, applied = rows;
  const refresh = createConversationRefresh({ load: () => { calls++; return response.promise; }, apply: value => { applied = value; }, onError: () => {}, onLoading: () => {} });
  const first = refresh.refresh(true);
  await refresh.refresh(true);
  assert.equal(calls, 1);
  response.reject(new Error("Offline"));
  await first;
  assert.equal(applied, rows);
  await refresh.refresh(true);
  assert.equal(calls, 2);
});

test("an old account or search response cannot replace the current conversations", async () => {
  const oldResponse = deferred<string[]>();
  let rows: string[] = [], error = "";
  const oldSearch = createConversationRefresh({ load: () => oldResponse.promise, apply: value => { rows = value; }, onError: value => { error = value; }, onLoading: () => {} });
  const pending = oldSearch.refresh();
  oldSearch.dispose();
  const newSearch = createConversationRefresh({ load: async () => ["current-result"], apply: value => { rows = value; }, onError: value => { error = value; }, onLoading: () => {} });
  await newSearch.refresh();
  oldResponse.resolve(["previous-account-result"]);
  await pending;
  assert.deepEqual(rows, ["current-result"]);
  assert.equal(error, "");
});
