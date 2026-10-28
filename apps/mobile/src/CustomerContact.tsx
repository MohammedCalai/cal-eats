import { useEffect, useRef, useState } from "react";
import { AppState, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { api } from "./api";
import { Button, Card, Empty, ErrorBanner, Field, Pill, SectionTitle } from "./components";
import { colours } from "./theme";

type Cursor = { before: string; beforeId: string };
type Message = { id: string; senderRole: string; message: string; createdAt: string; ingestSequence?: number };
type Contact = { id: string; restaurantName: string; status: string; lastMessageAt: string; unreadMessageCount: number };
type List = { items: Contact[]; pagination: { page: number; total: number; hasNext: boolean; hasPrevious: boolean } };
type Thread = { reference?: string; subject?: string; recipient?: string; message?: string; createdAt?: string; status?: string; waitingFor?: string; thread?: { status: string }; items?: Message[]; messages?: Message[]; nextCursor?: Cursor | null; readThroughMessageId?: string | null };
const labels: Record<string, string> = { awaiting_restaurant: "Waiting for restaurant", awaiting_customer: "Waiting for you", team: "Waiting for a reply", customer: "Waiting for you", resolved: "Resolved", open: "Open" };
const label = (value = "") => labels[value] || value.replaceAll("_", " ");
const key = () => `customer-contact-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function CustomerConversationList({ token, onOpen }: { token: string; onOpen: (id: string, title: string) => void }) {
  const [data, setData] = useState<List | null>(null), [page, setPage] = useState(1), [query, setQuery] = useState(""), [search, setSearch] = useState(""), [error, setError] = useState("");
  useEffect(() => { const timer = setTimeout(() => { setSearch(query.trim()); setPage(1); }, 250); return () => clearTimeout(timer); }, [query]);
  useEffect(() => {
    let active = true;
    void api<List>(`/api/customer/conversations?${new URLSearchParams({ page: String(page), pageSize: "20", ...(search ? { q: search } : {}) })}`, { token })
      .then(value => { if (active) { setData(value); setError(""); } }).catch(cause => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [token, page, search]);
  return <View style={styles.stack}><Field label="Find a restaurant conversation" value={query} onChangeText={setQuery} placeholder="Restaurant name"/><ErrorBanner message={error}/>{data?.items.length ? data.items.map(item => <Card key={item.id}><SectionTitle title={item.restaurantName}/><Pill>{label(item.status)}</Pill><Text style={styles.meta}>{item.unreadMessageCount ? `${item.unreadMessageCount} unread · ` : ""}{new Date(item.lastMessageAt).toLocaleString("en-GB")}</Text><Button tone="secondary" onPress={() => onOpen(item.id, item.restaurantName)}>Open conversation</Button></Card>) : <Empty>{data ? "Restaurants you have ordered from can contact you here. Active-order chat is also available from Orders." : "Loading conversations…"}</Empty>}<View style={styles.row}><Button tone="quiet" disabled={!data?.pagination.hasPrevious} onPress={() => setPage(value => Math.max(1, value - 1))}>Previous</Button><Text style={styles.meta}>Page {page} · {data?.pagination.total || 0} conversations</Text><Button tone="quiet" disabled={!data?.pagination.hasNext} onPress={() => setPage(value => value + 1)}>Next</Button></View></View>;
}

export function CustomerContactThread({ token, id, title, support = false, onClose }: { token: string; id: string; title: string; support?: boolean; onClose: () => void }) {
  const [data, setData] = useState<Thread | null>(null), [older, setOlder] = useState<Message[]>([]), [cursor, setCursor] = useState<Cursor | null | undefined>(), [message, setMessage] = useState(""), [error, setError] = useState(""), [loading, setLoading] = useState(false), [sending, setSending] = useState(false);
  const generation = useRef(0), read = useRef<string | null>(null), pending = useRef<{ message: string; key: string } | null>(null), oldest = useRef<Cursor | null | undefined>(undefined), inFlight = useRef(false);
  const path = support ? `/api/support/${encodeURIComponent(id)}` : `/api/customer/conversations/${encodeURIComponent(id)}/messages`;
  const readPath = support ? `${path}/read` : `/api/customer/conversations/${encodeURIComponent(id)}/read`;
  async function load(previous = false) {
    if (inFlight.current) return;
    inFlight.current = true;
    const current = generation.current; setLoading(true);
    try {
      const value = await api<Thread>(path + (previous && oldest.current ? `?${new URLSearchParams(oldest.current)}` : ""), { token });
      if (current !== generation.current) return;
      const items = support ? value.messages || [] : value.items || [];
      if (previous) { setOlder(old => [...items, ...old]); oldest.current = value.nextCursor || null; setCursor(oldest.current); }
      else { setData(value); if (oldest.current === undefined) { oldest.current = value.nextCursor || null; setCursor(oldest.current); } }
      setError("");
      const last = support ? items.at(-1)?.id || "initial" : value.readThroughMessageId || items.at(-1)?.id;
      if (last && last !== read.current) {
        await api(readPath, { token, method: "POST", body: JSON.stringify(support ? {} : { lastMessageId: last }) });
        if (current === generation.current) read.current = last;
      }
    } catch (cause) { if (current === generation.current) setError((cause as Error).message); }
    finally { inFlight.current = false; if (current === generation.current) setLoading(false); }
  }
  useEffect(() => {
    generation.current++; read.current = null; oldest.current = undefined; setOlder([]); setCursor(undefined); setMessage(""); pending.current = null; void load();
    const timer = setInterval(() => { if (AppState.currentState === "active") void load(); }, 15000);
    return () => { generation.current++; clearInterval(timer); };
  }, [token, path]);
  async function send() {
    const content = message.trim(); if (!content || sending) return;
    if (pending.current?.message !== content) pending.current = { message: content, key: key() };
    const current = generation.current; setSending(true); setError("");
    try {
      await api(support ? `${path}/messages` : path, { token, method: "POST", headers: { "Idempotency-Key": pending.current.key }, body: JSON.stringify({ message: content }) });
      if (current === generation.current) { pending.current = null; setMessage(""); await load(); }
    } catch (cause) { if (current === generation.current) setError(`${(cause as Error).message} Your draft is still here.`); }
    finally { if (current === generation.current) setSending(false); }
  }
  async function toggleResolved() {
    try { await api(path, { token, method: "PATCH", body: JSON.stringify({ status: data?.status === "resolved" ? "open" : "resolved" }) }); await load(); }
    catch (cause) { setError((cause as Error).message); }
  }
  const items = [...new Map([...older, ...(support ? data?.messages || [] : data?.items || [])].map(item => [item.id, item])).values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return <ScrollView contentContainerStyle={styles.page} refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()}/>}><Button tone="quiet" onPress={onClose}>← Back</Button><SectionTitle eyebrow={support ? `Help request ${data?.reference || ""}` : "Restaurant conversation"} title={data?.subject || title}/><Text style={styles.meta}>{support ? `${data?.recipient || "Cal-Eats support"} · ${label(data?.status === "resolved" ? "resolved" : data?.waitingFor || "team")}` : label(data?.thread?.status)}</Text><ErrorBanner message={error}/>{cursor && <Button tone="quiet" busy={loading} onPress={() => void load(true)}>Load earlier messages</Button>}{support && data?.message ? <Card tone="info"><Text style={styles.body}>{data.message}</Text><Text style={styles.meta}>Your original request</Text></Card> : null}{items.map(item => <Card key={item.id} tone={item.senderRole === "customer" ? "info" : "plain"}><Text style={styles.author}>{item.senderRole === "customer" ? "You" : item.senderRole === "admin" ? "Cal-Eats support" : title}</Text><Text style={styles.body}>{item.message}</Text><Text style={styles.meta}>{new Date(item.createdAt).toLocaleString("en-GB")}</Text></Card>)}<Card><Field label="Your message" value={message} onChangeText={setMessage} multiline maxLength={2000}/><Text style={styles.meta}>Messages do not change a paid order or authorise a refund.</Text><Button busy={sending} disabled={!message.trim()} onPress={() => void send()}>Send message</Button></Card>{support && <Button tone="secondary" onPress={() => void toggleResolved()}>{data?.status === "resolved" ? "Reopen request" : "Mark request resolved"}</Button>}</ScrollView>;
}
const styles = StyleSheet.create({ page: { padding: 18, paddingBottom: 90, gap: 14, backgroundColor: colours.cream }, stack: { gap: 14 }, row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }, meta: { color: colours.muted, lineHeight: 20 }, body: { color: colours.ink, lineHeight: 23 }, author: { color: colours.ink, fontWeight: "800" } });
