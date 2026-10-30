const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
async function request(path, options) { const response = await fetch(path, { credentials: "same-origin", ...options, headers: { ...(options?.body ? { "Content-Type": "application/json" } : {}), ...options?.headers } }); const body = await response.json(); if (!response.ok) { const error = new Error(body.error?.message || "Request failed"); error.status = response.status; error.code = body.error?.code; throw error; } return body.data; }

export async function openOrderMessaging({ api = request, orderId, onClose, container } = {}) {
  const root = typeof container === "string" ? document.querySelector(container) : container;
  if (!root) throw new Error("Message panel container is missing");
  const path = `/api/orders/${encodeURIComponent(orderId)}/messages`, retryKeys = new Map();
  let data, error = "", closed = false, connected = false, sending = false, reporting = false, inFlight, stream, timer, expiryTimer, rendered = "", loaded = false, lastRead;
  root.innerHTML = `<section class="order-messages"><header><div><h2>Restaurant chat</h2><p>Order #${escapeHtml(orderId.slice(0, 8).toUpperCase())}</p></div><button type="button" data-close aria-label="Close restaurant chat">×</button></header><p class="order-chat-error" role="alert" data-error hidden></p><div class="order-chat-history"><div class="order-message-list" role="log" aria-label="Messages for this order" aria-live="polite" aria-relevant="additions" data-history><p class="order-chat-empty" role="status">Loading your conversation…</p></div><button type="button" class="order-chat-latest" data-latest hidden>Latest messages ↓</button></div><div class="order-chat-contact"><span>For questions about this order</span><a data-call hidden>Call restaurant</a></div><form class="order-chat-composer" data-send hidden><label class="sr-only" for="order-message-${escapeHtml(orderId)}">Message restaurant</label><div class="order-chat-compose-row"><textarea id="order-message-${escapeHtml(orderId)}" rows="1" maxlength="300" required placeholder="Write a message…"></textarea><button type="submit" aria-label="Send message" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m4 12 16-8-5 16-3-6-8-2zM12 14l8-10"/></svg></button></div><div class="order-chat-compose-meta"><span role="status" data-send-status></span><span data-count>0/300</span></div><p class="order-chat-note">Messages cannot change paid items, prices or payment terms.</p></form><p class="order-chat-closed" data-closed hidden>This order conversation is closed. You can still get help from your order page.</p><details class="order-chat-report"><summary>Report a message concern</summary><form data-report><label>What happened?<textarea maxlength="300" required placeholder="Tell us about the message that concerns you."></textarea></label><button type="submit">Send report</button><span role="status" data-report-status></span></form></details></section>`;
  const list = root.querySelector("[data-history]"), form = root.querySelector("[data-send]"), field = form.querySelector("textarea"), send = form.querySelector("button"), errorBox = root.querySelector("[data-error]"), sendStatus = root.querySelector("[data-send-status]"), latest = root.querySelector("[data-latest]"), report = root.querySelector("[data-report]");
  const nearLatest = () => list.scrollHeight - list.scrollTop - list.clientHeight < 70;
  const close = () => { if (closed) return; closed = true; stream?.close(); clearInterval(timer); clearTimeout(expiryTimer); document.removeEventListener("visibilitychange", visibleRefresh); root.replaceChildren(); onClose?.(); };
  function updateComposer() { send.disabled = sending || !data?.isOpen || !field.value.trim(); send.setAttribute("aria-busy", String(sending)); field.readOnly = sending; form.querySelector("[data-count]").textContent = `${field.value.length}/300`; field.style.height = "auto"; field.style.height = `${Math.min(120, Math.max(44, field.scrollHeight))}px`; }
  function render() {
    if (closed) return;
    const follow = !loaded || nearLatest(), scroll = list.scrollTop;
    const html = (data?.items || []).map(item => {
      const date = new Date(item.createdAt), valid = Number.isFinite(date.getTime()), mine = item.senderRole === "customer";
      return `<article class="order-message ${mine ? "customer" : "restaurant"}" aria-label="${mine ? "Your" : "Restaurant"} message"><strong>${mine ? "You" : "Restaurant"}</strong><p>${escapeHtml(item.message)}</p>${valid ? `<time datetime="${date.toISOString()}" title="${escapeHtml(date.toLocaleString("en-GB", { timeZone: "Europe/London" }))}">${escapeHtml(date.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }))}</time>` : ""}</article>`;
    }).join("") || `<div class="order-chat-empty"><strong>${data ? data.isOpen ? "A direct line to your restaurant" : "Conversation closed" : "Loading your conversation…"}</strong>${data?.isOpen ? "<p>Ask about your delivery, collection or this order. Replies will appear here.</p>" : ""}</div>`;
    if (html !== rendered) { list.innerHTML = html; rendered = html; }
    list.scrollTop = follow ? list.scrollHeight : scroll; latest.hidden = nearLatest(); loaded = true;
    errorBox.textContent = error; errorBox.hidden = !error;
    const call = root.querySelector("[data-call]"), phone = String(data?.restaurantPhone || "").replace(/[^+0-9]/g, ""); call.hidden = !phone; if (phone) call.href = `tel:${phone}`;
    form.hidden = !data?.isOpen; root.querySelector("[data-closed]").hidden = !data || data.isOpen; updateComposer();
  }
  const markRead = async () => { const last = data?.items.at(-1); if (!closed && last && last.id !== lastRead) { await api(`${path}/read`, { method: "POST", body: JSON.stringify({ lastMessageId: last.id }) }); if (!closed) { lastRead = last.id; window.dispatchEvent(new CustomEvent("cal-eats-notifications-read", { detail: { orderId } })); } } };
  const scheduleClosure = () => { clearTimeout(expiryTimer); if (!data?.isOpen || !data.closedAt) return; const delay = Date.parse(data.closedAt) - Date.now(); if (!Number.isFinite(delay)) return; if (delay <= 0) { data = { ...data, items: [], isOpen: false }; render(); return; } expiryTimer = setTimeout(() => { data = { ...data, items: [], isOpen: false }; render(); }, Math.min(delay, 2_147_483_647)); };
  const refresh = async ({ force = false } = {}) => {
    if (closed) return;
    if (inFlight) { if (!force) return inFlight; await inFlight; if (closed) return; }
    const work = (async () => { try { const next = await api(path); if (closed) return; data = next; error = ""; render(); scheduleClosure(); await markRead(); } catch (cause) { if (closed) return; if (cause.status === 410 || cause.code === "MESSAGING_CLOSED") data = { items: [], isOpen: false, closedAt: null }; error = cause.message || "Messages could not be refreshed. Your draft is kept here."; render(); } })();
    inFlight = work; try { await work; } finally { if (inFlight === work) inFlight = null; }
  };
  root.querySelector("[data-close]").onclick = close;
  field.oninput = updateComposer;
  list.onscroll = () => { latest.hidden = nearLatest(); };
  latest.onclick = () => { list.scrollTop = list.scrollHeight; latest.hidden = true; };
  form.onsubmit = async event => {
    event.preventDefault(); const message = field.value.trim(); if (closed || sending || !data?.isOpen || !message) return;
    const key = retryKeys.get(message) || `web-message-${crypto.randomUUID()}`; retryKeys.set(message, key); sending = true; error = ""; sendStatus.textContent = "Sending…"; updateComposer(); render();
    try { await api(path, { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify({ message }) }); if (closed) return; retryKeys.delete(message); if (field.value.trim() === message) field.value = ""; sendStatus.textContent = "Message sent"; await refresh({ force: true }); list.scrollTop = list.scrollHeight; latest.hidden = true; }
    catch (cause) { if (closed) return; if (cause.status === 410 || cause.code === "MESSAGING_CLOSED") data = { items: [], isOpen: false, closedAt: null }; error = `${cause.message || "Message could not be sent."} Your draft is kept here.`; sendStatus.textContent = "Not sent · try again"; render(); }
    finally { sending = false; if (!closed) { updateComposer(); if (data?.isOpen) field.focus(); } }
  };
  report.onsubmit = async event => {
    event.preventDefault(); const reason = report.querySelector("textarea").value.trim(), button = report.querySelector("button"), status = report.querySelector("[data-report-status]"); if (closed || reporting || !reason) return;
    reporting = true; button.disabled = true; status.textContent = "Sending report…";
    try { await api(`/api/orders/${encodeURIComponent(orderId)}/message-incidents`, { method: "POST", body: JSON.stringify({ reason }) }); if (!closed) { status.textContent = "Report sent"; report.querySelector("textarea").value = ""; error = ""; render(); } }
    catch (cause) { if (!closed) status.textContent = `${cause.message || "Report could not be sent."} Your report is kept here.`; }
    finally { reporting = false; if (!closed) button.disabled = false; }
  };
  const visibleRefresh = () => { if (!connected && document.visibilityState === "visible") void refresh(); };
  await refresh(); if (closed) return { close, refresh };
  stream = new EventSource("/api/notifications/stream"); stream.onopen = () => { connected = true; }; stream.onerror = () => { connected = false; };
  stream.addEventListener("notification", event => { try { const item = JSON.parse(event.data); if (["order_message", "order_status"].includes(item.type) && item.orderId === orderId) void refresh(); } catch { error = "A live message update was invalid."; render(); } });
  timer = setInterval(() => { if (!connected && document.visibilityState === "visible") void refresh(); }, 30_000); document.addEventListener("visibilitychange", visibleRefresh);
  return { close, refresh };
}

export function bindOrderMessaging(container = document) {
  container.addEventListener("click", event => { const button = event.target.closest("[data-order-messages]"); if (!button) return; void openOrderMessaging({ orderId: button.dataset.orderMessages, container: button.dataset.messageMount || "#order-messaging" }); });
}
