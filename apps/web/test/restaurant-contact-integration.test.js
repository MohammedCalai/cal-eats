import assert from "node:assert/strict";
import test from "node:test";
import { mountCustomerThread } from "../customer-contact.js";
import { openOrderMessaging } from "../order-messaging.js";

function panel() {
  const node = () => ({ isConnected: true, value: "", textContent: "", innerHTML: "", disabled: false, hidden: false, readOnly: false, scrollTop: 0, scrollHeight: 44, clientHeight: 300, style: {}, setAttribute() {}, focus() {}, querySelector(selector) { return this.children[selector]; } });
  const selectors = ["textarea", "form", "[data-contact-send]", "[data-contact-send-status]", "[data-contact-count]", "[data-contact-error]", "[data-contact-messages]", "[data-contact-older]", "[data-contact-subtitle]", "[data-contact-resolve]", "[data-contact-latest]", "[data-contact-close]", ".customer-chat-heading h2", ".customer-chat-header .customer-chat-avatar", "[data-history]", "[data-send]", "[data-error]", "[data-send-status]", "[data-latest]", "[data-report]", "[data-close]", "[data-call]", "[data-closed]", "[data-restaurant-contact-controls]"];
  const nodes = Object.fromEntries(selectors.map(selector => [selector, node()]));
  const field = nodes.textarea, form = nodes["[data-send]"];
  form.children = { textarea: field, button: node(), "[data-count]": node() };
  const preferenceNodes = Object.fromEntries(["[data-contact-toggle]", "[data-contact-retry]", "[data-contact-preference-status]", "[data-contact-preference-error]"].map(selector => [selector, node()]));
  nodes["[data-restaurant-contact-controls]"].children = preferenceNodes;
  const root = node(); root.children = nodes; root.replaceChildren = () => { root.isConnected = false; };
  return { root, nodes, field, orderForm: form, preferenceNodes };
}

test("general and order chat both stop and resume contact without losing the draft or opening a restaurant ban", async () => {
  const saved = { document: globalThis.document, window: globalThis.window, EventSource: globalThis.EventSource };
  globalThis.document = Object.assign(new EventTarget(), { hidden: true, visibilityState: "hidden" });
  globalThis.window = Object.assign(new EventTarget(), { confirm: () => true });
  globalThis.EventSource = class { addEventListener() {} close() {} };
  try {
    for (const mode of ["conversation", "order"]) {
      const { root, nodes, field, orderForm, preferenceNodes } = panel();
      let blocked = false, current = true; const writes = [];
      const api = async (path, options = {}) => {
        if (path === "/api/customer-safety/restaurants/shop") {
          if (options.method) { writes.push({ path, options }); blocked = JSON.parse(options.body).blocked; }
          return { restaurantId: "shop", blocked };
        }
        if (options.method) { writes.push({ path, options }); return {}; }
        return mode === "order" ? { restaurantId: "shop", items: [], isOpen: true, closedAt: null } : { thread: { restaurantId: "shop", restaurantName: "Kitchen", status: "open" }, items: [], canReply: true, nextCursor: null };
      };
      const control = mode === "order" ? await openOrderMessaging({ api, orderId: "order", container: root, isCurrent: () => current }) : await mountCustomerThread({ api, id: "conversation", container: root, isCurrent: () => current });
      try {
        for (let i = 0; i < 8; i++) await Promise.resolve();
        assert.equal(preferenceNodes["[data-contact-toggle]"].textContent, "Stop restaurant messages");
        field.value = "My unsent draft"; field.oninput();
        await preferenceNodes["[data-contact-toggle]"].onclick();
        assert.equal(preferenceNodes["[data-contact-toggle]"].textContent, "Resume messages");
        assert.equal(field.value, "My unsent draft"); assert.match(field.placeholder, /Resume messages/);
        const sendForm = mode === "order" ? orderForm : nodes.form;
        await sendForm.onsubmit({ preventDefault() {} });
        assert.equal(writes.filter(call => call.path.includes("/messages")).length, 0);
        await preferenceNodes["[data-contact-toggle]"].onclick();
        assert.equal(field.disabled, false); assert.equal(field.readOnly, false);
        assert.equal(preferenceNodes["[data-contact-toggle]"].textContent, "Stop restaurant messages");
        assert.deepEqual(writes.map(call => JSON.parse(call.options.body)), [{ blocked: true }, { blocked: false }]);
        current = false; const count = writes.length; await preferenceNodes["[data-contact-toggle]"].onclick(); assert.equal(writes.length, count);
        assert.doesNotMatch(root.innerHTML, /Block restaurant|Unblock restaurant/);
      } finally { control.close(); }
    }
  } finally { Object.assign(globalThis, saved); }
});
