import { useEffect, useRef, useState } from "react";
import { AppState, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
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
  return <View style={styles.stack}><View style={styles.searchBox}><TextInput accessibilityLabel="Search your chats" value={query} onChangeText={setQuery} placeholder="Search your chats" placeholderTextColor={colours.muted} style={styles.searchInput}/></View><ErrorBanner message={error}/>{data?.items.length ? data.items.map(item => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`${item.restaurantName}, ${item.unreadMessageCount} unread messages`} onPress={()=>onOpen(item.id,item.restaurantName)} style={({pressed})=>[styles.chatRow,pressed&&{opacity:.7}]}><View style={styles.avatar}><Text style={styles.avatarText}>{item.restaurantName.trim().split(/\s+/).slice(0,2).map(word=>word[0]).join("").toUpperCase()}</Text></View><View style={styles.chatCopy}><View style={styles.chatTitleRow}><Text numberOfLines={1} style={styles.chatName}>{item.restaurantName}</Text><Text style={styles.chatTime}>{new Date(item.lastMessageAt).toLocaleDateString("en-GB",{day:"numeric",month:"short"})}</Text></View><View style={styles.chatTitleRow}><Text numberOfLines={1} style={styles.chatPreview}>{item.unreadMessageCount ? "New messages · tap to reply" : label(item.status)||"Tap to open conversation"}</Text>{item.unreadMessageCount?<View style={styles.unreadBadge}><Text style={styles.unreadText}>{item.unreadMessageCount>99?"99+":item.unreadMessageCount}</Text></View>:null}</View></View></Pressable>) : <Empty>{data ? "Restaurants you have ordered from can contact you here. Active-order chat is also available from Orders." : "Loading conversations…"}</Empty>}<View style={styles.row}><Button tone="quiet" disabled={!data?.pagination.hasPrevious} onPress={() => setPage(value => Math.max(1, value - 1))}>Previous</Button><Text style={styles.meta}>Page {page} · {data?.pagination.total || 0} conversations</Text><Button tone="quiet" disabled={!data?.pagination.hasNext} onPress={() => setPage(value => value + 1)}>Next</Button></View></View>;
}

export function CustomerContactThread({ token, id, title, support = false, onClose }: { token: string; id: string; title: string; support?: boolean; onClose: () => void }) {
  const [data, setData] = useState<Thread | null>(null), [older, setOlder] = useState<Message[]>([]), [cursor, setCursor] = useState<Cursor | null | undefined>(), [message, setMessage] = useState(""), [error, setError] = useState(""), [loading, setLoading] = useState(false), [sending, setSending] = useState(false);
  const scroll=useRef<ScrollView>(null),nearBottom=useRef(true);
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
      if (current === generation.current) { pending.current = null; nearBottom.current=true;setMessage(""); await load(); }
    } catch (cause) { if (current === generation.current) setError(`${(cause as Error).message} Your draft is still here.`); }
    finally { if (current === generation.current) setSending(false); }
  }
  async function toggleResolved() {
    try { await api(path, { token, method: "PATCH", body: JSON.stringify({ status: data?.status === "resolved" ? "open" : "resolved" }) }); await load(); }
    catch (cause) { setError((cause as Error).message); }
  }
  const items = [...new Map([...older, ...(support ? data?.messages || [] : data?.items || [])].map(item => [item.id, item])).values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return <View style={styles.threadShell}><View style={styles.chatHeader}><Button tone="quiet" accessibilityLabel="Back to messages" onPress={onClose}>‹</Button><View style={styles.smallAvatar}><Text style={styles.avatarText}>{(data?.subject||title).trim().slice(0,1).toUpperCase()}</Text></View><View style={{flex:1,gap:3}}><Text numberOfLines={1} style={styles.chatName}>{data?.subject||title}</Text><Text numberOfLines={1} style={styles.chatPreview}>{support?`${data?.recipient||"Cal-Eats support"} · ${label(data?.status==="resolved"?"resolved":data?.waitingFor||"team")}`:label(data?.thread?.status)||"Restaurant conversation"}</Text></View></View><ScrollView ref={scroll} contentContainerStyle={styles.messages} keyboardShouldPersistTaps="handled" scrollEventThrottle={100} onScroll={event=>{const n=event.nativeEvent;nearBottom.current=n.contentSize.height-n.layoutMeasurement.height-n.contentOffset.y<90;}} onContentSizeChange={()=>{if(nearBottom.current)scroll.current?.scrollToEnd({animated:true});}} maintainVisibleContentPosition={{minIndexForVisible:0}} refreshControl={<RefreshControl refreshing={loading} onRefresh={()=>void load()}/>}><ErrorBanner message={error}/>{cursor?<Button tone="quiet" busy={loading} onPress={()=>{nearBottom.current=false;void load(true);}}>Earlier messages</Button>:null}{support&&data?.message?<View style={[styles.bubble,styles.bubbleMine]}><Text style={styles.messageBody}>{data.message}</Text><Text style={styles.bubbleMeta}>Your original request</Text></View>:null}{items.map(item=><View key={item.id} style={[styles.bubble,item.senderRole==="customer"?styles.bubbleMine:styles.bubbleOther]}><Text style={styles.bubbleAuthor}>{item.senderRole==="customer"?"You":item.senderRole==="admin"?"Cal-Eats support":title}</Text><Text style={styles.messageBody}>{item.message}</Text><Text style={styles.bubbleMeta}>{new Date(item.createdAt).toLocaleString("en-GB",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})}</Text></View>)}{!items.length&&!data?.message&&!loading?<Text style={[styles.meta,{textAlign:"center",padding:24}]}>Your messages with {title} will appear here.</Text>:null}{support?<Button tone="quiet" onPress={()=>void toggleResolved()}>{data?.status==="resolved"?"Reopen request":"Mark request resolved"}</Button>:null}</ScrollView><View style={styles.composer}><View style={styles.composerRow}><TextInput accessibilityLabel="Message" placeholder="Message…" placeholderTextColor={colours.muted} value={message} onChangeText={setMessage} multiline maxLength={2000} style={styles.composerInput}/><Pressable accessibilityRole="button" accessibilityLabel={sending?"Sending message":"Send message"} accessibilityState={{disabled:sending||!message.trim(),busy:sending}} disabled={sending||!message.trim()} onPress={()=>void send()} style={[styles.sendButton,(sending||!message.trim())&&{opacity:.45}]}><Text style={styles.sendText}>{sending?"…":"↑"}</Text></Pressable></View><Text style={styles.composerHint}>Messages do not change paid items or authorise a refund.</Text></View></View>;
}const styles = StyleSheet.create({ threadShell:{flex:1,backgroundColor:"#EAF3FB"},chatHeader:{flexDirection:"row",alignItems:"center",gap:10,paddingHorizontal:10,paddingVertical:10,backgroundColor:colours.panel,borderBottomWidth:1,borderColor:colours.line},smallAvatar:{width:38,height:38,borderRadius:19,backgroundColor:colours.sky,alignItems:"center",justifyContent:"center"},searchBox:{borderRadius:24,backgroundColor:colours.panel,borderWidth:1,borderColor:colours.line,paddingHorizontal:17},searchInput:{minHeight:46,fontSize:16,color:colours.ink},chatRow:{flexDirection:"row",alignItems:"center",gap:12,paddingVertical:16,paddingHorizontal:2,borderBottomWidth:1,borderColor:colours.line},avatar:{width:52,height:52,borderRadius:26,backgroundColor:colours.sky,alignItems:"center",justifyContent:"center"},avatarText:{fontSize:16,fontWeight:"800",color:colours.blueDark},chatCopy:{flex:1,gap:7},chatTitleRow:{flexDirection:"row",alignItems:"center",justifyContent:"space-between",gap:10},chatName:{flex:1,fontSize:16,lineHeight:22,fontWeight:"800",color:colours.ink},chatTime:{fontSize:11,color:colours.muted},chatPreview:{flex:1,fontSize:13,lineHeight:18,color:colours.muted},unreadBadge:{backgroundColor:colours.blue,borderRadius:12,minWidth:22,height:22,paddingHorizontal:5,alignItems:"center",justifyContent:"center"},unreadText:{color:colours.white,fontWeight:"800",fontSize:11},messages:{padding:16,gap:10,paddingBottom:22,flexGrow:1},bubble:{maxWidth:"86%",paddingHorizontal:14,paddingVertical:10,gap:5,borderRadius:17},bubbleMine:{alignSelf:"flex-end",backgroundColor:"#D8EAFE",borderBottomRightRadius:4},bubbleOther:{alignSelf:"flex-start",backgroundColor:colours.panel,borderBottomLeftRadius:4,borderWidth:1,borderColor:"#DCE6EF"},bubbleAuthor:{fontSize:11,fontWeight:"700",color:colours.blueDark},messageBody:{color:colours.ink,fontSize:15,lineHeight:22},bubbleMeta:{color:colours.muted,fontSize:11,lineHeight:16,alignSelf:"flex-end"},composer:{backgroundColor:colours.panel,borderTopWidth:1,borderColor:colours.line,paddingHorizontal:12,paddingTop:10,paddingBottom:8,gap:5},composerRow:{flexDirection:"row",alignItems:"flex-end",gap:8},composerInput:{flex:1,minHeight:46,maxHeight:120,paddingHorizontal:15,paddingVertical:12,borderWidth:1,borderColor:colours.line,borderRadius:23,fontSize:15,color:colours.ink,backgroundColor:colours.cream},sendButton:{width:46,height:46,borderRadius:23,backgroundColor:colours.blue,alignItems:"center",justifyContent:"center"},sendText:{fontSize:26,color:colours.white,fontWeight:"700"},composerHint:{color:colours.muted,fontSize:11,lineHeight:16}, page: { padding: 18, paddingBottom: 90, gap: 14, backgroundColor: colours.cream }, stack: { gap: 14 }, row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }, meta: { color: colours.muted, lineHeight: 20 }, body: { color: colours.ink, lineHeight: 23 }, author: { color: colours.ink, fontWeight: "800" } });
