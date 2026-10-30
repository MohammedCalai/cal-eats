import { customerRestaurantVisual } from "./customer-ui.js";
const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const validDate = value => { const date = new Date(value); return value && Number.isFinite(date.getTime()) ? date : null; };
const when = value => { const date = validDate(value); return date ? date.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }) : "Date unavailable"; };
const label = value => ({ open: "Open", resolved: "Resolved", awaiting_restaurant: "Waiting for restaurant", awaiting_customer: "Waiting for you", team: "Waiting for a reply", customer: "Waiting for you", none: "Resolved" })[value] || value;
const conversationLabel = value => ({ open: "Restaurant conversation", resolved: "Conversation resolved", awaiting_restaurant: "Waiting for restaurant reply", awaiting_customer: "Waiting for your reply" })[value] || "Restaurant conversation";
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${({ back: '<path d="m15 5-7 7 7 7"/>', search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>', send: '<path d="m4 12 16-8-5 16-3-6-8-2zM12 14l8-10"/>', chat: '<path d="M21 11a8 8 0 0 1-8 8H8l-5 3V9a7 7 0 0 1 7-7h3a8 8 0 0 1 8 9zM7 8h10M7 12h7"/>' })[name] || ""}</svg>`;
const avatar = restaurant => `<span class="customer-chat-avatar" aria-hidden="true">${customerRestaurantVisual(typeof restaurant === "object" ? restaurant : {})}</span>`;
const dateKey = value => validDate(value)?.toLocaleDateString("en-CA", { timeZone: "Europe/London" }) ?? "";
function dayLabel(value, now = Date.now()) { const date = validDate(value); if (!date) return ""; const key = dateKey(value); return key === dateKey(now) ? "Today" : key === dateKey(now - 86400000) ? "Yesterday" : date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" }); }
function inboxTime(value, now = Date.now()) { const date = validDate(value); if (!date) return ""; return dateKey(value) === dateKey(now) ? date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }) : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" }); }

export function supportCardsHtml(cases = []) {
  return cases.length ? `<div class="support-cards">${cases.map(item => `<article class="card support-card"><div class="section-head"><span class="badge">${escape(label(item.status === "resolved" ? "resolved" : item.waitingFor || "team"))}</span><small>#${escape(item.reference || item.id.slice(0, 8).toUpperCase())}</small></div><h3>${escape(item.subject)}</h3><p class="meta">To ${escape(item.recipient || "Cal-Eats support")} · ${when(item.updatedAt)}</p><button class="secondary" data-action="support-ticket" data-id="${escape(item.id)}">View request & reply</button></article>`).join("")}</div>` : `<div class="empty"><strong>Your help requests will appear here.</strong><p>Each request has a reference, a responsible team and a reply thread.</p></div>`;
}
export function customerInboxRowsHtml(items = [], now = Date.now()) {
  return items.map(item => { const name = item.restaurantName || "Restaurant", unread = Number.isSafeInteger(item.unreadMessageCount) && item.unreadMessageCount > 0 ? item.unreadMessageCount : 0;
    return `<article class="customer-inbox-item${unread ? " has-unread" : ""}"><button type="button" class="customer-conversation-row" data-thread="${escape(item.id)}" data-title="${escape(name)}" aria-label="Open conversation with ${escape(name)}${unread ? `, ${unread} unread message${unread === 1 ? "" : "s"}` : ""}">${avatar(item)}<span class="customer-conversation-copy"><span class="customer-conversation-title"><strong>${escape(name)}</strong>${validDate(item.lastMessageAt) ? `<time datetime="${escape(item.lastMessageAt)}" title="${escape(when(item.lastMessageAt))}">${escape(inboxTime(item.lastMessageAt, now))}</time>` : ""}</span><span class="customer-conversation-preview"><span>${escape(conversationLabel(item.status))}</span>${unread ? `<b class="customer-message-count" aria-hidden="true">${unread > 99 ? "99+" : unread}</b>` : '<span class="customer-conversation-chevron" aria-hidden="true">›</span>'}</span></span></button></article>`;
  }).join("");
}
export function customerMessagesHtml(messages = [], { title = "Restaurant", initialRequest = null, now = Date.now() } = {}) {
  const rows = initialRequest ? [{ ...initialRequest, originalRequest: true, senderRole: "customer" }, ...messages] : messages;
  let lastDay = "";
  return rows.map(item => { const key = dateKey(item.createdAt), date = validDate(item.createdAt), separator = key && key !== lastDay ? `<div class="customer-chat-day"><span>${escape(dayLabel(item.createdAt, now))}</span></div>` : ""; if (key) lastDay = key;
    const mine = item.senderRole === "customer", sender = mine ? "You" : item.senderRole === "admin" ? "Cal-Eats support" : title;
    return `${separator}<article class="contact-bubble ${mine ? "mine" : "theirs"}" aria-label="${escape(sender)} message">${item.originalRequest ? '<strong class="customer-chat-request-label">Your original request</strong>' : !mine ? `<strong class="customer-chat-sender">${escape(sender)}</strong>` : ""}<p>${escape(item.message)}</p>${date ? `<time datetime="${escape(item.createdAt)}" title="${escape(when(item.createdAt))}">${date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" })}</time>` : ""}</article>`;
  }).join("");
}

export async function mountCustomerThread({ api, container, id, support = false, title = "Restaurant messages", onClose = () => {} }) {
  let closed = false, sending = false, data, messages = [], lastRead = null, timer, olderCursor = null, loadedOlder = false, initialVisible = false, inFlight = null, loaded = false, renderedMessagesHtml = "";
  const retryKeys = new Map(), path = support ? `/api/support/${encodeURIComponent(id)}` : `/api/customer/conversations/${encodeURIComponent(id)}/messages`;
  const readPath = support ? `${path}/read` : `/api/customer/conversations/${encodeURIComponent(id)}/read`;
  container.innerHTML = `<section class="contact-thread customer-chat"><header class="customer-chat-header"><button type="button" class="customer-chat-back" data-contact-close aria-label="Close conversation">${icon("back")}</button>${avatar(title)}<div class="customer-chat-heading"><h2>${escape(title)}</h2><p data-contact-subtitle>Loading conversation…</p></div></header><p class="form-error error customer-chat-error" role="alert" data-contact-error></p><div class="customer-chat-history"><button type="button" class="customer-chat-older" data-contact-older hidden>Load earlier messages</button><div class="contact-messages" role="log" aria-label="Conversation messages" aria-live="polite" aria-relevant="additions" data-contact-messages><p class="customer-chat-loading" role="status">Loading messages…</p></div><button type="button" class="customer-chat-latest" data-contact-latest hidden>Latest messages ↓</button></div><form class="customer-chat-composer" data-contact-form><label class="sr-only" for="contact-message-${escape(id)}">Your message</label><div class="customer-chat-compose-row"><textarea id="contact-message-${escape(id)}" name="message" rows="1" maxlength="${support ? 2000 : 300}" required placeholder="Write a message…"></textarea><button type="submit" class="customer-chat-send" data-contact-send aria-label="Send message" disabled>${icon("send")}<span class="sr-only">Send message</span></button></div><div class="customer-chat-compose-meta"><span data-contact-send-status role="status"></span><span data-contact-count>0/${support ? 2000 : 300}</span></div></form><details class="customer-chat-details"><summary>Conversation information</summary><p>Messages do not change an order or authorise a refund.</p><button type="button" class="quiet" data-contact-resolve ${support ? "" : "hidden"}>Mark request resolved</button></details></section>`;
  const field = container.querySelector("textarea"), form = container.querySelector("form"), send = container.querySelector("[data-contact-send]"), sendStatus = container.querySelector("[data-contact-send-status]"), counter = container.querySelector("[data-contact-count]"), errorBox = container.querySelector("[data-contact-error]"), list = container.querySelector("[data-contact-messages]"), older = container.querySelector("[data-contact-older]"), subtitle = container.querySelector("[data-contact-subtitle]"), resolveButton = container.querySelector("[data-contact-resolve]"), latestButton = container.querySelector("[data-contact-latest]");
  const nearLatest = () => list.scrollHeight - list.scrollTop - list.clientHeight < 70;
  function updateComposer() { send.disabled = sending || !data || data.canReply === false || !field.value.trim(); send.setAttribute("aria-busy", String(sending)); field.disabled = data?.canReply === false; counter.textContent = `${field.value.length}/${support ? 2000 : 300}`; field.style.height = "auto"; field.style.height = `${Math.min(120, Math.max(44, field.scrollHeight))}px`; }
  const close = () => { if (closed) return; closed = true; clearInterval(timer); document.removeEventListener("visibilitychange", visible); onClose(); };
  function render({ previous = false } = {}) {
    const scrollTop = list.scrollTop, scrollHeight = list.scrollHeight, followLatest = !loaded || nearLatest(), name = support ? data.recipient || title : data.thread?.restaurantName || title;
    const initialRequest = support && initialVisible ? { id: `initial-${id}`, message: data.message, createdAt: data.createdAt } : null;
    const messageHtml = customerMessagesHtml(messages, { title: name, initialRequest }) || `<div class="customer-chat-empty">${icon("chat")}<strong>No messages yet</strong><p>Send your first message to start the conversation.</p></div>`;
    if (messageHtml !== renderedMessagesHtml) { list.innerHTML = messageHtml; renderedMessagesHtml = messageHtml; }
    const heading = container.querySelector(".customer-chat-heading h2"); if (heading.textContent !== name) heading.textContent = name;
    container.querySelector(".customer-chat-header .customer-chat-avatar").innerHTML = customerRestaurantVisual(data.thread || {});
    subtitle.textContent = support ? `#${data.reference} · ${label(data.status === "resolved" ? "resolved" : data.waitingFor)}` : conversationLabel(data.thread?.status);
    older.hidden = !olderCursor; resolveButton.textContent = data.status === "resolved" ? "Reopen request" : "Mark request resolved";
    if (previous) list.scrollTop = scrollTop + list.scrollHeight - scrollHeight;
    else if (followLatest) list.scrollTop = list.scrollHeight;
    else list.scrollTop = scrollTop;
    latestButton.hidden = nearLatest(); loaded = true; updateComposer();
    if (data.canReply === false) errorBox.textContent = data.replyUnavailableReason || "Replies are temporarily unavailable. Your draft is kept here.";
  }
  async function refresh({ previous = false, force = false } = {}) {
    if (closed) return;
    if (inFlight) { if (!previous && !force) return inFlight; await inFlight; if (closed) return; }
    const work = (async () => { older.disabled = true;
      try {
        const cursor = previous && olderCursor ? `?${new URLSearchParams(olderCursor)}` : "";
        const result = await api(path + cursor); if (closed || !container.isConnected) return;
        const incoming = support ? result.messages : result.items;
        if (previous) loadedOlder = true;
        if (previous || !loadedOlder) olderCursor = result.nextCursor;
        if (support && !result.nextCursor) initialVisible = true;
        messages = loadedOlder ? [...messages, ...(incoming || [])].filter((item, index, all) => all.findIndex(other => other.id === item.id) === index).filter(item => support || !item.expiresAt || Date.parse(item.expiresAt) > Date.now()).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id)) : incoming || [];
        data = result; errorBox.textContent = ""; render({ previous });
        const latest = support ? messages.at(-1)?.id || "initial" : result.readThroughMessageId || messages.reduce((latest,item)=>(item.ingestSequence||0)>(latest?.ingestSequence||0)?item:latest,messages.at(-1))?.id || "initial";
        if (!document.hidden && latest !== lastRead && (support || latest !== "initial")) {
          await api(readPath, { method: "POST", body: JSON.stringify(support ? {} : { lastMessageId: latest }) });
          if (closed) return; lastRead = latest; window.dispatchEvent(new Event("cal-eats-notifications-read"));
        }
      } catch (error) { if (!closed) errorBox.textContent = error.message || "Messages could not be loaded. Your draft is still here."; }
      finally { if (!closed) older.disabled = false; }
    })();
    inFlight = work; try { await work; } finally { if (inFlight === work) inFlight = null; }
  }
  const visible = () => { if (!document.hidden) void refresh(); };
  container.querySelector("[data-contact-close]").onclick = close;
  older.onclick = () => refresh({ previous: true });
  list.onscroll = () => { latestButton.hidden = nearLatest(); };
  latestButton.onclick = () => { list.scrollTop = list.scrollHeight; latestButton.hidden = true; };
  field.oninput = updateComposer;
  form.onsubmit = async event => {
    event.preventDefault(); if (sending || closed || !data || data.canReply === false || !field.value.trim()) return;
    const message = field.value.trim(), key = retryKeys.get(message) || `contact-${crypto.randomUUID()}`; retryKeys.set(message, key);
    sending = true; updateComposer(); sendStatus.textContent = "Sending…"; errorBox.textContent = "";
    try {
      await api(support ? `${path}/messages` : path, { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify({ message }) });
      if (!closed) { retryKeys.delete(message); if (field.value.trim() === message) field.value = ""; sendStatus.textContent = "Message sent"; await refresh({ force: true }); list.scrollTop = list.scrollHeight; field.focus(); }
    } catch (error) { if (!closed) { errorBox.textContent = `${error.message} Your message is kept here so you can retry.`; sendStatus.textContent = "Not sent · try again"; } }
    finally { sending = false; if (!closed) updateComposer(); }
  };
  resolveButton.onclick = async () => {
    if (!data || closed) return; resolveButton.disabled = true;
    try { await api(path, { method: "PATCH", body: JSON.stringify({ status: data.status === "resolved" ? "open" : "resolved" }) }); if (!closed) await refresh({ force: true }); }
    catch (error) { if (!closed) errorBox.textContent = error.message; }
    finally { if (!closed) resolveButton.disabled = false; }
  };
  await refresh();
  if (closed || !container.isConnected) { closed = true; return { close, refresh }; }
  timer = setInterval(() => { if (!document.hidden && container.isConnected) void refresh(); }, 15000);
  document.addEventListener("visibilitychange", visible);
  return { close, refresh };
}

export async function mountCustomerInbox({ api, container, openThread }) {
  let page = 1, query = "", unreadOnly = false, request = 0, closed = false, debounce, poll, loading = false;
  container.innerHTML = `<section class="section customer-messages-page"><header class="customer-inbox-heading"><span class="eyebrow">Your conversations</span><h1>Messages</h1><p>Good food. A direct line to your restaurant.</p></header><div class="customer-inbox-panel"><label class="customer-inbox-search">${icon("search")}<span class="sr-only">Search conversations</span><input type="search" placeholder="Search restaurants" aria-label="Search conversations"></label><div class="customer-inbox-filters" role="group" aria-label="Conversation filter"><button type="button" data-inbox-filter="all" aria-pressed="true">All messages</button><button type="button" data-inbox-filter="unread" aria-pressed="false">Unread</button></div><div class="customer-inbox-list" data-inbox-list aria-live="polite"><p class="customer-inbox-loading" role="status">Loading your conversations…</p></div><nav class="customer-inbox-pagination" aria-label="Conversation pages"><button type="button" class="quiet" data-inbox-previous disabled>Previous</button><span data-inbox-page></span><button type="button" class="quiet" data-inbox-next disabled>Next</button></nav></div></section>`;
  const list = container.querySelector("[data-inbox-list]"), previous = container.querySelector("[data-inbox-previous]"), next = container.querySelector("[data-inbox-next]"), position = container.querySelector("[data-inbox-page]"), search = container.querySelector("input");
  async function refresh() {
    if (closed) return; const version = ++request; loading = true; list.setAttribute("aria-busy", "true"); previous.disabled = true; next.disabled = true;
    try {
      const result = await api(`/api/customer/conversations?${new URLSearchParams({ page, pageSize: 20, ...(query ? { q: query } : {}), ...(unreadOnly ? { unread: "true" } : {}) })}`);
      if (closed || version !== request) return;
      if (page > 1 && !result.items.length && result.pagination.total > 0) { page--; return refresh(); }
      list.innerHTML = result.items.length ? customerInboxRowsHtml(result.items) : `<div class="customer-inbox-empty">${icon("chat")}<strong>${query ? "No matching conversations" : unreadOnly ? "You’re all caught up" : "Your conversations start here"}</strong><p>${query ? "Try another restaurant name." : unreadOnly ? "New restaurant replies will appear here." : "Messages from restaurants you’ve ordered from will appear here. For a current order, you can also message your restaurant from Orders."}</p>${query || unreadOnly ? '<button type="button" class="secondary" data-inbox-reset>Show all conversations</button>' : '<button type="button" class="secondary" data-view="orders">Go to your orders</button>'}</div>`;
      previous.disabled = page <= 1; next.disabled = !result.pagination.hasNext; position.textContent = `${result.pagination.total} conversation${result.pagination.total === 1 ? "" : "s"} · Page ${page}`;
    } catch (error) { if (!closed && version === request) { list.innerHTML = `<div class="customer-inbox-empty"><strong>We couldn’t load your messages</strong><p>${escape(error.message)}</p><button type="button" class="secondary" data-inbox-retry>Try again</button></div>`; position.textContent = ""; } }
    finally { if (!closed && version === request) { loading = false; list.setAttribute("aria-busy", "false"); } }
  }
  function selectFilter(value) { unreadOnly = value === "unread"; page = 1; container.querySelectorAll("[data-inbox-filter]").forEach(button => button.setAttribute("aria-pressed", String((button.dataset.inboxFilter === "unread") === unreadOnly))); void refresh(); }
  search.oninput = event => { query = event.target.value.trim(); page = 1; request++; clearTimeout(debounce); debounce = setTimeout(refresh, 250); };
  container.querySelectorAll("[data-inbox-filter]").forEach(button => { button.onclick = () => selectFilter(button.dataset.inboxFilter); });
  list.onclick = event => { const button = event.target.closest("[data-thread]"); if (button) openThread(button.dataset.thread, button.dataset.title); else if (event.target.closest("[data-inbox-retry]")) void refresh(); else if (event.target.closest("[data-inbox-reset]")) { query = ""; search.value = ""; selectFilter("all"); } };
  previous.onclick = () => { if (loading || closed) return; page = Math.max(1, page - 1); void refresh(); }; next.onclick = () => { if (loading || closed) return; page++; void refresh(); };
  const visible = () => { if (!document.hidden && !loading) void refresh(); };
  await refresh();
  if (!closed) { poll = setInterval(visible, 15000); document.addEventListener("visibilitychange", visible); }
  return { close() { closed = true; request++; clearTimeout(debounce); clearInterval(poll); document.removeEventListener("visibilitychange", visible); }, refresh };
}
