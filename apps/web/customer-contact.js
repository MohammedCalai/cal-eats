const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const when = value => new Date(value).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const label = value => ({ open: "Open", resolved: "Resolved", awaiting_restaurant: "Waiting for restaurant", awaiting_customer: "Waiting for you", team: "Waiting for a reply", customer: "Waiting for you", none: "Resolved" })[value] || value;

export function supportCardsHtml(cases = []) {
  return cases.length ? `<div class="support-cards">${cases.map(item => `<article class="card support-card"><div class="section-head"><span class="badge">${escape(label(item.status === "resolved" ? "resolved" : item.waitingFor || "team"))}</span><small>#${escape(item.reference || item.id.slice(0, 8).toUpperCase())}</small></div><h3>${escape(item.subject)}</h3><p class="meta">To ${escape(item.recipient || "Cal-Eats support")} · ${when(item.updatedAt)}</p><button class="secondary" data-action="support-ticket" data-id="${escape(item.id)}">View request & reply</button></article>`).join("")}</div>` : `<div class="empty"><strong>Your help requests will appear here.</strong><p>Each request has a reference, a responsible team and a reply thread.</p></div>`;
}

export async function mountCustomerThread({ api, container, id, support = false, title = "Restaurant messages", onClose = () => {} }) {
  let closed = false, sending = false, requestKey = null, requestText = "", data, messages = [], lastRead = null, timer, olderCursor = null, loadedOlder = false, initialVisible = false;
  const path = support ? `/api/support/${encodeURIComponent(id)}` : `/api/customer/conversations/${encodeURIComponent(id)}/messages`;
  const readPath = support ? `${path}/read` : `/api/customer/conversations/${encodeURIComponent(id)}/read`;
  container.innerHTML = `<section class="contact-thread"><header class="section-head"><div><h2>${escape(title)}</h2><p class="meta" data-contact-subtitle>Loading conversation…</p></div><button class="quiet" data-contact-close aria-label="Close conversation">×</button></header><p class="form-error error" role="alert" data-contact-error></p><button class="quiet" data-contact-older hidden>Load earlier replies</button><div class="contact-messages" aria-live="polite" aria-relevant="additions" data-contact-messages></div><form class="stack" data-contact-form><label>Your message<textarea name="message" rows="3" maxlength="${support ? 2000 : 300}" required placeholder="Write your message"></textarea></label><div class="section-head"><small>Messages do not change an order or authorise a refund.</small><button class="primary">Send message</button></div></form><button class="quiet" data-contact-resolve ${support ? "" : "hidden"}>Mark request resolved</button></section>`;
  const field = container.querySelector("textarea"), errorBox = container.querySelector("[data-contact-error]"), list = container.querySelector("[data-contact-messages]"), older = container.querySelector("[data-contact-older]"), subtitle = container.querySelector("[data-contact-subtitle]"), resolveButton = container.querySelector("[data-contact-resolve]");
  const close = () => { if (closed) return; closed = true; clearInterval(timer); document.removeEventListener("visibilitychange", visible); onClose(); };
  function render() {
    const scrollTop = list.scrollTop, followLatest = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    const initial = support && initialVisible ? `<article class="contact-bubble mine"><strong>Your request</strong><p>${escape(data.message)}</p><small>${when(data.createdAt)}</small></article>` : "";
    list.innerHTML = initial + messages.map(item => `<article class="contact-bubble ${item.senderRole === "customer" ? "mine" : "theirs"}"><strong>${item.senderRole === "customer" ? "You" : item.senderRole === "admin" ? "Cal-Eats support" : escape(data.recipient || title)}</strong><p>${escape(item.message)}</p><small>${when(item.createdAt)}</small></article>`).join("");
    subtitle.textContent = support ? `#${data.reference} · ${data.recipient} · ${label(data.status === "resolved" ? "resolved" : data.waitingFor)}` : label(data.thread?.status || "open");
    older.hidden = !olderCursor;
    resolveButton.textContent = data.status === "resolved" ? "Reopen request" : "Mark request resolved";
    list.scrollTop = followLatest && !loadedOlder ? list.scrollHeight : scrollTop;
  }
  async function refresh({ previous = false } = {}) {
    if (closed) return;
    try {
      const cursor = previous && olderCursor ? `?${new URLSearchParams(olderCursor)}` : "";
      const result = await api(path + cursor); if (closed) return;
      const incoming = support ? result.messages : result.items;
      if (previous) loadedOlder = true;
      if (previous || !loadedOlder) olderCursor = result.nextCursor;
      if (support && !result.nextCursor) initialVisible = true;
      messages = loadedOlder ? [...messages, ...(incoming || [])].filter((item, index, all) => all.findIndex(other => other.id === item.id) === index).filter(item => support || !item.expiresAt || Date.parse(item.expiresAt) > Date.now()).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id)) : incoming || [];
      data = result; errorBox.textContent = ""; render();
      const latest = support ? messages.at(-1)?.id || "initial" : result.readThroughMessageId || messages.reduce((latest,item)=>(item.ingestSequence||0)>(latest?.ingestSequence||0)?item:latest,messages.at(-1))?.id || "initial";
      if (latest !== lastRead && (support || latest !== "initial")) {
        await api(readPath, { method: "POST", body: JSON.stringify(support ? {} : latest === "initial" ? {} : { lastMessageId: latest }) });
        lastRead = latest; window.dispatchEvent(new Event("cal-eats-notifications-read"));
      }
    } catch (error) { if (!closed) errorBox.textContent = error.message || "Messages could not be loaded. Your draft is still here."; }
  }
  const visible = () => { if (!document.hidden) void refresh(); };
  container.querySelector("[data-contact-close]").onclick = close;
  older.onclick = () => refresh({ previous: true });
  field.oninput = () => { if (field.value.trim() !== requestText) requestKey = null; };
  container.querySelector("form").onsubmit = async event => {
    event.preventDefault(); if (sending || closed || !field.value.trim()) return;
    const message = field.value.trim(); if (!requestKey || requestText !== message) { requestKey = `contact-${crypto.randomUUID()}`; requestText = message; }
    sending = true; const button = container.querySelector("form button"); button.disabled = true; button.textContent = "Sending…"; errorBox.textContent = "";
    try {
      await api(support ? `${path}/messages` : path, { method: "POST", headers: { "Idempotency-Key": requestKey }, body: JSON.stringify({ message }) });
      if (!closed) { field.value = ""; requestKey = null; requestText = ""; await refresh(); field.focus(); }
    } catch (error) { if (!closed) errorBox.textContent = `${error.message} Your message is kept here so you can retry.`; }
    finally { sending = false; if (!closed) { button.disabled = false; button.textContent = "Send message"; } }
  };
  resolveButton.onclick = async () => {
    resolveButton.disabled = true;
    try { await api(path, { method: "PATCH", body: JSON.stringify({ status: data.status === "resolved" ? "open" : "resolved" }) }); await refresh(); }
    catch (error) { errorBox.textContent = error.message; }
    finally { if (!closed) resolveButton.disabled = false; }
  };
  await refresh();
  if (closed || !container.isConnected) { closed = true; return { close, refresh }; }
  timer = setInterval(() => { if (!document.hidden && container.isConnected) void refresh(); }, 15000);
  document.addEventListener("visibilitychange", visible);
  return { close, refresh };
}

export async function mountCustomerInbox({ api, container, openThread }) {
  let page = 1, query = "", request = 0, closed = false, timer;
  container.innerHTML = `<section class="section"><div class="section-head"><div><span class="eyebrow">Your conversations</span><h1>Messages</h1><p class="meta">Stay in touch with the restaurants you order from.</p></div></div><label class="customer-search">Search restaurants<input type="search" placeholder="Restaurant name" aria-label="Search conversations"></label><div data-inbox-list></div><div class="section-head"><button class="secondary" data-inbox-previous>Previous</button><span class="meta" data-inbox-page></span><button class="secondary" data-inbox-next>Next</button></div></section>`;
  const list = container.querySelector("[data-inbox-list]"), previous = container.querySelector("[data-inbox-previous]"), next = container.querySelector("[data-inbox-next]"), position = container.querySelector("[data-inbox-page]");
  async function refresh() {
    const version = ++request;
    try {
      const result = await api(`/api/customer/conversations?${new URLSearchParams({ page, pageSize: 20, ...(query ? { q: query } : {}) })}`);
      if (closed || version !== request) return;
      list.innerHTML = result.items.length ? result.items.map(item => `<article class="card inbox-row"><div><h3>${escape(item.restaurantName)}</h3><p class="meta">${escape(label(item.status))} · ${when(item.lastMessageAt)}</p></div>${item.unreadMessageCount ? `<span class="unread-count">${item.unreadMessageCount} unread</span>` : ""}<button class="secondary" data-thread="${escape(item.id)}" data-title="${escape(item.restaurantName)}">Open conversation</button></article>`).join("") : `<div class="empty"><strong>No restaurant conversations yet.</strong><p>Restaurants you have ordered from can contact you here. For an active order, use the message button in Orders. For app or order problems, use Help in Account.</p></div>`;
      previous.disabled = page <= 1; next.disabled = !result.pagination.hasNext; position.textContent = `Page ${page} · ${result.pagination.total} conversations`;
    } catch (error) { if (!closed && version === request) list.innerHTML = `<div class="error" role="alert">${escape(error.message)}</div>`; }
  }
  container.querySelector("input").oninput = event => { query = event.target.value.trim(); page = 1; clearTimeout(timer); timer = setTimeout(refresh, 250); };
  list.onclick = event => { const button = event.target.closest("[data-thread]"); if (button) openThread(button.dataset.thread, button.dataset.title); };
  previous.onclick = () => { page = Math.max(1, page - 1); void refresh(); }; next.onclick = () => { page++; void refresh(); };
  await refresh();
  return { close() { closed = true; request++; clearTimeout(timer); }, refresh };
}
