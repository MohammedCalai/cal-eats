import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatScroll } from '../chat-scroll.js';
import { serveStatic } from '../../api/src/static.js';
import { mountCustomerThread } from '../customer-contact.js';
import { openOrderMessaging } from '../order-messaging.js';

function fixture() {
  const frames = new Map(), list = new EventTarget(), latestButton = { hidden: true }, view = new EventTarget();
  let nextFrame = 0, top = 0, resize, disconnected = false, nodes = [];
  Object.assign(list, { scrollHeight: 1800, clientHeight: 400, ownerDocument: { defaultView: view },
    getBoundingClientRect: () => ({ top: 20 }), querySelectorAll: () => nodes });
  Object.defineProperty(list, 'scrollTop', { get: () => top, set: value => { top = Math.max(0, Math.min(list.scrollHeight - list.clientHeight, value)); } });
  view.ResizeObserver = class { constructor(callback) { resize = callback; } observe() {} disconnect() { disconnected = true; } };
  const scroll = createChatScroll({ list, latestButton, requestFrame: callback => { frames.set(++nextFrame, callback); return nextFrame; }, cancelFrame: id => frames.delete(id) });
  const flush = () => { for (let i = 0; frames.size && i < 5; i++) { const batch = [...frames.values()]; frames.clear(); for (const callback of batch) callback(); } assert.equal(frames.size, 0); };
  const userScroll = value => { list.dispatchEvent(new Event('wheel')); list.scrollTop = value; list.dispatchEvent(new Event('scroll')); };
  return { list, scroll, latestButton, view, flush, userScroll, resize: () => resize(),
    anchor(id, offset) { const node = { dataset: { chatMessageId: id }, offset, getBoundingClientRect() { return { top: 20 + this.offset - list.scrollTop, bottom: 100 + this.offset - list.scrollTop }; } }; nodes.push(node); return node; },
    disconnected: () => disconnected, pending: () => frames.size };
}

test('latest chat message follows delayed composer/keyboard layout, while incoming messages respect reading intent', () => {
  const f = fixture();
  try {
    f.scroll.restore(f.scroll.snapshot());
    f.list.clientHeight = 260; f.flush();
    assert.equal(f.list.scrollTop, 1540, 'Initial open follows after viewport layout');
    const before = f.scroll.snapshot(); f.list.scrollHeight += 200; f.scroll.restore(before); f.flush();
    assert.equal(f.list.scrollTop, 1740, 'Incoming message follows when already at the end');
    f.userScroll(240); const reading = f.scroll.snapshot(); f.list.scrollHeight += 200; f.scroll.restore(reading); f.flush();
    f.list.clientHeight = 200; f.resize(); f.flush();
    assert.equal(f.list.scrollTop, 240, 'Incoming updates and keyboard resize leave earlier history in place');
    assert.equal(f.latestButton.hidden, false);
    f.scroll.latest(); f.list.clientHeight = 140; f.flush();
    assert.equal(f.list.scrollTop, 2060, 'Own-send explicit follow settles after the composer and keyboard resize');
    f.list.clientHeight = 100; f.resize(); f.flush(); assert.equal(f.list.scrollTop, 2100);
    f.scroll.latest(); f.userScroll(120); f.flush(); assert.equal(f.list.scrollTop, 120, 'A real scroll cancels already scheduled auto-follow');
  } finally { f.scroll.close(); }
  assert.equal(f.disconnected(), true); assert.equal(f.pending(), 0);
});

test('loading earlier messages preserves the visible bubble through delayed layout and stops on close', () => {
  const f = fixture();
  try {
    f.scroll.restore(f.scroll.snapshot()); f.flush(); f.userScroll(400);
    const anchor = f.anchor('same-message', 420), before = f.scroll.snapshot();
    f.list.scrollHeight += 320; anchor.offset += 320; f.scroll.restore(before, { previous: true });
    assert.equal(anchor.getBoundingClientRect().top - 20, 20);
    f.list.scrollHeight += 44; anchor.offset += 44; f.flush();
    assert.equal(anchor.getBoundingClientRect().top - 20, 20, 'The same bubble remains at the same viewport offset');
    const refresh = f.scroll.snapshot(); f.list.scrollHeight += 30; anchor.offset += 30;
    f.scroll.restore(refresh); f.flush();
    assert.equal(anchor.getBoundingClientRect().top - 20, 20, 'An ordinary refresh also restores the visible bubble after layout shifts');
    f.scroll.latest(); f.scroll.close(); const top = f.list.scrollTop;
    f.list.clientHeight = 100; f.resize(); f.flush(); assert.equal(f.list.scrollTop, top);
  } finally { f.scroll.close(); }
});

test('the production static allowlist serves the chat helper as JavaScript', async () => {
  const headers = {}; let status, body;
  const res = { setHeader(key, value) { headers[key] = value; }, writeHead(code, values) { status = code; Object.assign(headers, values); }, end(value) { body = value; } };
  assert.equal(await serveStatic({ method: 'GET' }, res, '/chat-scroll.js'), true);
  assert.equal(status, 200); assert.equal(headers['Content-Type'], 'text/javascript; charset=utf-8');
  assert.match(body.toString(), /export function createChatScroll/);
});

test('mounted restaurant, support and order threads preserve history across sliding newest pages and follow own sends after keyboard layout', async () => {
  const previous = { document: globalThis.document, window: globalThis.window, EventSource: globalThis.EventSource };
  globalThis.document = Object.assign(new EventTarget(), { hidden: false, visibilityState: 'visible' });
  globalThis.EventSource = class { addEventListener() {} close() {} };
  try {
    for (const kind of ['restaurant', 'support', 'order']) {
      const frames = new Map(); let nextFrame = 0;
      globalThis.window = Object.assign(new EventTarget(), { requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; }, cancelAnimationFrame(id) { frames.delete(id); } });
      const flush = () => { for (let i = 0; frames.size && i < 5; i++) { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); } assert.equal(frames.size, 0); };
      const node = () => Object.assign(new EventTarget(), { value: '', textContent: '', hidden: false, disabled: false, style: {}, setAttribute() {}, focus(options) { this.focusOptions = options; }, scrollHeight: 44 });
      const field = node(), send = node(), counter = node(), sendStatus = node(), latestButton = node(), form = node(), report = node(), list = node();
      const children = { textarea: field, button: send, '[data-count]': counter };
      form.querySelector = selector => children[selector]; report.querySelector = () => node();
      let top = 0, html = '';
      Object.assign(list, { clientHeight: 300, scrollHeight: 44, getBoundingClientRect: () => ({ top: 20 }),
        querySelectorAll: () => Array.from(html.matchAll(/data-chat-message-id="([^"]*)"/g), (match, index) => ({
          dataset: { chatMessageId: match[1] }, getBoundingClientRect: () => ({ top: 20 + index * 80 - top, bottom: 100 + index * 80 - top })
        })) });
      Object.defineProperty(list, 'scrollTop', { get: () => top, set: value => { top = Math.max(0, Math.min(list.scrollHeight - list.clientHeight, value)); } });
      Object.defineProperty(list, 'innerHTML', { get: () => html, set: value => { html = value; list.scrollHeight = (value.match(/<article /g) || []).length * 80 + 40; } });
      const nodes = { textarea: field, form, '[data-contact-send]': send, '[data-contact-send-status]': sendStatus,
        '[data-contact-count]': counter, '[data-contact-error]': node(), '[data-contact-messages]': list,
        '[data-contact-older]': node(), '[data-contact-subtitle]': node(), '[data-contact-resolve]': node(),
        '[data-contact-latest]': latestButton, '[data-contact-close]': node(), '.customer-chat-heading h2': node(),
        '.customer-chat-header .customer-chat-avatar': node(), '[data-history]': list, '[data-send]': form,
        '[data-error]': node(), '[data-send-status]': sendStatus, '[data-latest]': latestButton, '[data-report]': report,
        '[data-close]': node(), '[data-call]': node(), '[data-closed]': node() };
      const container = { isConnected: true, innerHTML: '', querySelector(selector) { assert.ok(nodes[selector], selector); return nodes[selector]; }, replaceChildren() {} };
      const items = Array.from({ length: 24 }, (_, i) => ({ id: `m${i}`, senderRole: 'restaurant', message: `Earlier reply ${i}`, createdAt: new Date(Date.UTC(2026, 10, 6, 12, i)).toISOString(), ingestSequence: i + 1 })), requested = [];
      const api = async (path, options = {}) => {
        if (path.endsWith('/read')) return {};
        if (options.method === 'POST') { const item = { id: 'sent-now', senderRole: 'customer', message: JSON.parse(options.body).message, createdAt: '2026-11-06T13:00:00Z', ingestSequence: 25 }; items.push(item); return item; }
        requested.push(path);
        return { items: items.slice(-24), messages: items.slice(-24), thread: { id: 'thread', restaurantName: 'Local fixture', status: 'open' }, canReply: true, isOpen: true, reference: 'TEST', waitingFor: 'customer', nextCursor: { beforeId: items.slice(-24)[0].id } };
      };
      let controller;
      try {
        controller = kind === 'order' ? await openOrderMessaging({ api, container, orderId: 'order' }) : await mountCustomerThread({ api, container, id: 'thread', support: kind === 'support' });
        flush(); field.value = 'My multiline\nmessage to the restaurant'; field.oninput(); flush();
        list.dispatchEvent(new Event('wheel')); list.scrollTop = 100; list.dispatchEvent(new Event('scroll'));
        const firstVisible = () => list.querySelectorAll().find(node => node.getBoundingClientRect().bottom > 20);
        const anchor = { id: firstVisible().dataset.chatMessageId, offset: firstVisible().getBoundingClientRect().top - 20 };
        items.push({ id: 'incoming-latest', senderRole: 'restaurant', message: 'A new reply while you read older messages', createdAt: '2026-11-06T12:30:00Z', ingestSequence: 25 });
        await controller.refresh(); flush();
        assert.equal(firstVisible().dataset.chatMessageId, anchor.id, `${kind} keeps the same visible message when the server newest page shifts`);
        assert.equal(firstVisible().getBoundingClientRect().top - 20, anchor.offset);
        assert.ok(list.innerHTML.includes('data-chat-message-id="m0"'), `${kind} retains the previously loaded oldest message`);
        if (kind !== 'order') {
          await nodes['[data-contact-older]'].onclick(); flush();
          assert.equal(new URL(requested.at(-1), 'https://local.invalid').searchParams.get('beforeId'), 'm0', `${kind} retains its original older-page cursor`);
        }
        await form.onsubmit({ preventDefault() {} });
        list.clientHeight = 130; flush();
        assert.equal(list.scrollHeight - list.clientHeight - list.scrollTop, 0, `${kind} own-send keeps the latest bubble visible after layout`);
        assert.ok(list.innerHTML.includes('sent-now')); assert.equal(latestButton.hidden, true);
        assert.equal(field.value, ''); assert.equal(field.focusOptions.preventScroll, true);
      } finally { controller?.close(); flush(); }
    }
  } finally { globalThis.document = previous.document; globalThis.window = previous.window; globalThis.EventSource = previous.EventSource; }
});
