import "./BusinessCommunication.css";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { api, json, newKey } from "./api.js";

const time = (value) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));

export function useLiveNotifications({ onNotification, soundPreferenceKey = "calai-message-sound" } = {}) {
  const seen = useRef(new Set()); const audio = useRef(null); const callback = useRef(onNotification); callback.current = onNotification; const [connected, setConnected] = useState(false); const [soundEnabled, setSoundEnabled] = useState(() => localStorage.getItem(soundPreferenceKey) === "on");
  const enableSound = useCallback(async () => {
    const Context = window.AudioContext || window.webkitAudioContext; if (!Context) return false;
    audio.current ??= new Context(); await audio.current.resume(); localStorage.setItem(soundPreferenceKey, "on"); setSoundEnabled(true); return true;
  }, [soundPreferenceKey]);
  useEffect(() => {
    const source = new EventSource("/api/notifications/stream");
    const receive = (event) => {
      let item; try { item = JSON.parse(event.data); } catch { return; }
      if (seen.current.has(item.id)) return; seen.current.add(item.id); callback.current?.(item);
      if (soundEnabled && item.type === "order_message" && audio.current) {
        const ctx = audio.current, oscillator = ctx.createOscillator(), gain = ctx.createGain(); oscillator.frequency.value = 660; gain.gain.setValueAtTime(0.05, ctx.currentTime); gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18); oscillator.connect(gain).connect(ctx.destination); oscillator.start(); oscillator.stop(ctx.currentTime + 0.18);
      }
    };
    source.onopen = () => setConnected(true); source.onerror = () => setConnected(false); source.addEventListener("notification", receive); return () => { setConnected(false); source.close(); };
  }, [soundEnabled]);
  return { connected, soundEnabled, enableSound, disableSound() { localStorage.setItem(soundPreferenceKey, "off"); setSoundEnabled(false); } };
}

export function OrderConversation({ orderId, onClose }) {
  const [conversation, setConversation] = useState(null), [message, setMessage] = useState(""), [reportReason, setReportReason] = useState(""), [error, setError] = useState(""), [sending, setSending] = useState(false); const pendingKey = useRef(null);
  const load = useCallback(async () => { try { const data = await api(`/api/orders/${encodeURIComponent(orderId)}/messages`); setConversation(data); setError(""); const last = data.items.at(-1); if (last) { await api(`/api/orders/${encodeURIComponent(orderId)}/messages/read`, json("POST", { lastMessageId: last.id })); window.dispatchEvent(new CustomEvent("cal-eats-notifications-read", { detail: { orderId } })); } } catch (e) { if (e.status === 410 || e.code === "MESSAGING_CLOSED") setConversation({ items: [], isOpen: false, closedAt: null }); setError(e.message); } }, [orderId]);
  useEffect(() => { load(); }, [load]);
  const live = useLiveNotifications({ onNotification: useCallback((item) => { if (item.orderId === orderId && ["order_message", "order_status"].includes(item.type)) load(); }, [load, orderId]) });
  useEffect(() => { if (live.connected) return; const poll = () => { if (document.visibilityState === "visible") load(); }; const timer = setInterval(poll, 30_000); document.addEventListener("visibilitychange", poll); return () => { clearInterval(timer); document.removeEventListener("visibilitychange", poll); }; }, [live.connected, load]);
  useEffect(() => { if (!conversation?.isOpen || !conversation.closedAt) return; const delay = Date.parse(conversation.closedAt) - Date.now(); if (delay <= 0) { setConversation({ items: [], isOpen: false, closedAt: conversation.closedAt }); return; } const timer = setTimeout(() => { setConversation({ items: [], isOpen: false, closedAt: conversation.closedAt }); }, Math.min(delay, 2_147_483_647)); return () => clearTimeout(timer); }, [conversation?.isOpen, conversation?.closedAt]);
  async function sendText(text) { const value = text.trim(); if (!value || sending) return; if (pendingKey.current?.message !== value) pendingKey.current = { message: value, key: newKey("message") }; setSending(true); setError(""); try { await api(`/api/orders/${encodeURIComponent(orderId)}/messages`, json("POST", { message: value }, pendingKey.current.key)); pendingKey.current = null; setMessage(""); await load(); } catch (e) { if (e.status === 410 || e.code === "MESSAGING_CLOSED") setConversation({ items: [], isOpen: false, closedAt: null }); setError(e.message); } finally { setSending(false); } }
  async function send(event) { event.preventDefault(); await sendText(message); }
  async function report(event) { event.preventDefault(); try { await api(`/api/orders/${encodeURIComponent(orderId)}/message-incidents`, json("POST", { reason: reportReason })); setReportReason(""); setError(""); } catch (e) { setError(e.message); } }
  return <section className="order-conversation" aria-label="Order messages">
    <header><h2>Order messages</h2>{onClose && <button type="button" onClick={onClose} aria-label="Close messages">×</button>}</header>
    {error && <p role="alert">{error} <button type="button" onClick={()=>void load()}>Try again</button></p>}
    <div className="message-list" aria-live="polite">{conversation?.items?.map((item) => <article key={item.id} className={`message ${item.senderRole}`} aria-label={`${item.senderRole === "customer" ? "Customer" : "Restaurant"} message`}><strong>{item.senderRole === "customer" ? "Customer" : "Restaurant"}</strong><p>{item.message}</p><small>{time(item.createdAt)}</small></article>)}</div>
    {conversation?.restaurantPhone && <a href={`tel:${conversation.restaurantPhone}`}>Call restaurant</a>}
    {conversation?.isOpen ? <form onSubmit={send}><p>Messages cannot change paid items, prices, or payment terms.</p><label>Message<textarea maxLength={300} value={message} onChange={(e) => { setMessage(e.target.value); if (pendingKey.current?.message !== e.target.value.trim()) pendingKey.current = null; }} /></label><small>{message.length}/300</small><div>{conversation.quickResponses?.map((text) => <button disabled={sending} key={text} type="button" onClick={() => sendText(text)}>{text}</button>)}</div><button disabled={sending || !message.trim()}>{sending ? "Sending…" : "Send"}</button></form> : conversation ? <p>This conversation is closed.</p> : <p role="status">{error?"Messages could not be loaded.":"Loading messages…"}</p>}
    <details><summary>Report a message concern</summary><form onSubmit={report}><label>What happened?<textarea required maxLength={300} value={reportReason} onChange={(e) => setReportReason(e.target.value)} /></label><button>Send report</button></form></details>
  </section>;
}

export function AdminMessageReview({ orderId, onClose }) {
  const [reason, setReason] = useState(""), [items, setItems] = useState(null), [error, setError] = useState("");
  async function review(event) { event.preventDefault(); try { const result = await api(`/api/orders/${encodeURIComponent(orderId)}/messages?reason=${encodeURIComponent(reason)}`); setItems(result.items); setError(""); } catch (e) { setError(e.message); } }
  return <section aria-label="Admin message incident review"><header><h2>Message incident review</h2>{onClose && <button type="button" onClick={onClose}>Close</button>}</header><p>Access is audited. Enter a specific operational reason.</p><form onSubmit={review}><label>Access reason<input minLength={10} maxLength={300} required value={reason} onChange={(e) => setReason(e.target.value)} /></label><button>Review messages</button></form>{error && <p role="alert">{error}</p>}{items && <div>{items.map((item) => <article key={item.id}><strong>{item.senderRole}</strong><p>{item.message}</p><small>{time(item.createdAt)}</small></article>)}</div>}</section>;
}

export function AdminMessageIncidents() {
  const [items, setItems] = useState([]), [selected, setSelected] = useState(null), [note, setNote] = useState(""), [error, setError] = useState("");
  const load = useCallback(() => api("/api/admin/message-incidents").then(setItems).catch((e) => setError(e.message)), []); useEffect(() => { load(); }, [load]);
  async function update(status) { try { await api(`/api/admin/message-incidents/${encodeURIComponent(selected.id)}`, json("PATCH", { status, note })); setSelected(null); setNote(""); await load(); } catch (e) { setError(e.message); } }
  return <section><h2>Message incidents</h2>{error && <p role="alert">{error}</p>}<div>{items.map((item) => <article key={item.id}><strong>{item.status.replace("_", " ")}</strong><p>{item.reason}</p><small>Order {item.orderId}</small><button type="button" onClick={() => setSelected(item)}>Review</button></article>)}</div>{selected && <div><h3>Review incident</h3><label>Admin note<textarea required maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></label><button disabled={!note.trim()} onClick={() => update("under_review")}>Mark under review</button><button disabled={!note.trim()} onClick={() => update("resolved")}>Resolve</button><AdminMessageReview orderId={selected.orderId} onClose={() => setSelected(null)} /></div>}</section>;
}

export function MessagingSettings({ restaurantId }) {
  const [value, setValue] = useState(null), [error, setError] = useState(""), [saved, setSaved] = useState(false);
  useEffect(() => { api(`/api/restaurant/restaurants/${encodeURIComponent(restaurantId)}/message-settings`).then(setValue).catch((e) => setError(e.message)); }, [restaurantId]);
  async function save(event) { event.preventDefault(); setSaved(false); try { setValue(await api(`/api/restaurant/restaurants/${encodeURIComponent(restaurantId)}/message-settings`, json("PATCH", value))); setSaved(true); } catch (e) { setError(e.message); } }
  if (!value) return <p role={error ? "alert" : "status"}>{error || "Loading message settings…"}</p>;
  return <form onSubmit={save}><h2>Order message settings</h2>{error && <p role="alert">{error}</p>}<label>Support after an order ends (minutes)<input type="number" min="0" max="1440" value={value.supportWindowMinutes} onChange={(e) => setValue({ ...value, supportWindowMinutes: Number(e.target.value) })} /></label>{value.quickResponses.map((text, index) => <label key={index}>Quick response {index + 1}<input maxLength={120} value={text} onChange={(e) => { const next = [...value.quickResponses]; next[index] = e.target.value; setValue({ ...value, quickResponses: next }); }} /></label>)}<button>Save message settings</button>{saved && <span role="status">Saved</span>}</form>;
}
