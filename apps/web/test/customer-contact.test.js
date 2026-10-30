import assert from "node:assert/strict";
import test from "node:test";
import { customerInboxRowsHtml, customerMessagesHtml, mountCustomerThread } from "../customer-contact.js";

test("conversation rows safely render actual activity and unread counts without invented previews or presence", () => {
  const html = customerInboxRowsHtml([{ id: 'thread" onclick="bad', restaurantName: '<img src=x onerror=bad>', status: "awaiting_customer", lastMessageAt: "2026-10-30T09:35:00.000Z", unreadMessageCount: 104 }], Date.parse("2026-10-30T11:00:00.000Z"));
  assert.ok(html.includes("&lt;img src=x onerror=bad&gt;"));
  assert.ok(html.includes("thread&quot; onclick=&quot;bad"));
  assert.equal(html.includes("<img src=x"), false);
  assert.ok(html.includes("104 unread messages"));
  assert.ok(html.includes("99+"));
  assert.ok(html.includes("Waiting for your reply"));
  assert.ok(html.includes("09:35"));
  assert.equal(/online|last seen|read receipt|delivered|message preview/i.test(html), false);
  const noUnread = customerInboxRowsHtml([{ id: "t", restaurantName: "Café Blue", status: "resolved", lastMessageAt: "not-a-date", unreadMessageCount: -1 }]);
  assert.equal(noUnread.includes("customer-message-count"), false);
  assert.equal(noUnread.includes("<time"), false);
});

test("chat groups real timestamps and preserves escaped multiline text and sender direction", () => {
  const html = customerMessagesHtml([
    { senderRole: "restaurant", message: "Your meal is ready\n<script>unsafe</script>", createdAt: "2026-10-29T23:50:00.000Z" },
    { senderRole: "customer", message: "Thank you & see you soon", createdAt: "2026-10-30T00:05:00.000Z" },
    { senderRole: "admin", message: "We can help", createdAt: "2026-10-30T01:00:00.000Z" }
  ], { title: "Restaurant <unsafe>", now: Date.parse("2026-10-30T12:00:00.000Z") });
  assert.equal((html.match(/customer-chat-day/g) || []).length, 2);
  assert.ok(html.includes("Yesterday")); assert.ok(html.includes("Today"));
  assert.ok(html.includes("contact-bubble mine")); assert.ok(html.includes("contact-bubble theirs"));
  assert.ok(html.includes("Your meal is ready\n&lt;script&gt;unsafe&lt;/script&gt;"));
  assert.ok(html.includes("Cal-Eats support"));
  assert.equal(html.includes("<script>"), false);
});

function fakeThreadContainer() {
  const node = () => ({ value: "", textContent: "", innerHTML: "", disabled: false, hidden: false, scrollTop: 0, scrollHeight: 44, clientHeight: 300, style: {}, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, focus() { this.focused = true; } });
  const nodes = Object.fromEntries(["textarea", "form", "[data-contact-send]", "[data-contact-send-status]", "[data-contact-count]", "[data-contact-error]", "[data-contact-messages]", "[data-contact-older]", "[data-contact-subtitle]", "[data-contact-resolve]", "[data-contact-latest]", "[data-contact-close]", ".customer-chat-heading h2", ".customer-chat-header .customer-chat-avatar"].map(selector => [selector, node()]));
  return { nodes, container: { isConnected: true, innerHTML: "", querySelector(selector) { assert.ok(nodes[selector], `Unexpected selector: ${selector}`); return nodes[selector]; } } };
}

test("thread retries keep the operation key and preserve a new draft typed while sending; closing stops refresh", async () => {
  const previousDocument = globalThis.document, previousWindow = globalThis.window;
  globalThis.document = Object.assign(new EventTarget(), { hidden: false }); globalThis.window = new EventTarget();
  const { nodes, container } = fakeThreadContainer(), calls = [], posted = []; let sends = 0, releaseSend, closed = 0;
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (options.method === "POST" && !path.endsWith("/read")) {
      posted.push(options.headers["Idempotency-Key"]); sends++;
      if (sends === 1) throw new Error("Connection interrupted");
      if (sends === 3) await new Promise(resolve => { releaseSend = resolve; });
      return { id: `sent-${sends}` };
    }
    if (path.endsWith("/read")) return {};
    return { thread: { id: "thread-1", restaurantName: "Blue Kitchen", status: "open" }, items: [{ id: "m1", senderRole: "restaurant", message: "Hello", createdAt: "2026-10-30T09:00:00.000Z", ingestSequence: 1 }], readThroughMessageId: "m1", nextCursor: null };
  };
  let controller;
  try {
    controller = await mountCustomerThread({ api, container, id: "thread-1", onClose: () => { closed++; } });
    const field = nodes.textarea, submit = () => nodes.form.onsubmit({ preventDefault() {} });
    field.value = "Can you help?"; field.oninput(); await submit();
    assert.equal(field.value, "Can you help?"); assert.match(nodes["[data-contact-error]"].textContent, /kept here/);
    await submit(); assert.equal(posted[0], posted[1]); assert.equal(field.value, "");
    field.value = "One more question"; field.oninput(); const pending = submit();
    assert.equal(typeof releaseSend, "function");
    field.value = "My next draft"; field.oninput(); releaseSend(); await pending;
    assert.equal(field.value, "My next draft"); assert.equal(nodes["[data-contact-send]"].disabled, false);
    const beforeClose = calls.length; controller.close(); await controller.refresh(); controller.close();
    assert.equal(calls.length, beforeClose); assert.equal(closed, 1);
    assert.ok(calls.some(call => call.path === "/api/customer/conversations/thread-1/read" && JSON.parse(call.options.body).lastMessageId === "m1"));
  } finally { controller?.close(); globalThis.document = previousDocument; globalThis.window = previousWindow; }
});
