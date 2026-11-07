import assert from "node:assert/strict";
import test from "node:test";
import { createCustomerUnreadPrompt, customerUnreadPromptVisible } from "../src/customer-unread-prompt.ts";

test("dismissal and opening the bell acknowledge attention without polling the same unread IDs again", () => {
  const prompt = createCustomerUnreadPrompt();
  prompt.observe([]); assert.equal(prompt.pending(), false);
  prompt.observe(["order-update", "offer"]); assert.equal(prompt.pending(), true);
  const saved = prompt.acknowledge(); assert.equal(prompt.pending(), false);
  for (const ids of [["offer", "order-update"], ["offer"], [], ["order-update", "offer", "offer"]]) {
    prompt.observe(ids); assert.equal(prompt.pending(), false);
  }
  // Restoring this customer's saved attention state does not re-prompt old unread updates.
  const restored = createCustomerUnreadPrompt(saved);
  restored.observe(["order-update", "offer"]); assert.equal(restored.pending(), false);
  restored.observe(["order-update", "offer", "new-message"]); assert.equal(restored.pending(), true);
  restored.acknowledge(); assert.equal(restored.pending(), false);
  // A different customer has an independent attention history.
  const anotherCustomer = createCustomerUnreadPrompt();
  anotherCustomer.observe(["new-message"]); assert.equal(anotherCustomer.pending(), true);
});

test("typing, checkout, conversations and background defer a pending popup without consuming it", () => {
  const prompt = createCustomerUnreadPrompt(); prompt.observe(["customer-update"]);
  assert.equal(customerUnreadPromptVisible(prompt.pending(), true, true), false);
  assert.equal(customerUnreadPromptVisible(prompt.pending(), false, false), false);
  assert.equal(prompt.pending(), true);
  assert.equal(customerUnreadPromptVisible(prompt.pending(), true, false), true);
  prompt.observe(["customer-update", "another-update"]);
  assert.equal(customerUnreadPromptVisible(prompt.pending(), true, false), true);
  prompt.acknowledge();
  assert.equal(customerUnreadPromptVisible(prompt.pending(), true, false), false);
});
