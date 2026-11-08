import { SafeAreaView } from "react-native-safe-area-context";
import { CustomerModal as Modal } from "./CustomerModal";
import { useEffect, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { api } from "./api";
import { Button, ErrorBanner, Field } from "./components";
import { CustomerIcon } from "./CustomerBrandBanner";
import { colours } from "./theme";

const choices = [
  ["inappropriate_message", "Inappropriate message"], ["harassment", "Harassment or unwanted contact"],
  ["misleading_menu", "Misleading menu or photo"], ["unsafe_content", "Unsafe or offensive content"], ["other", "Something else"]
] as const;
type Props = { token: string; restaurantId?: string; orderId?: string; conversationId?: string; messageId?: string; menu?: boolean; reportOnly?: boolean; onBlockedChange?: (blocked: boolean) => void; onSignIn?: () => void };

export function RestaurantSafetyControls({ token, restaurantId, orderId, conversationId, messageId, menu, reportOnly, onBlockedChange, onSignIn }: Props) {
  const [blocked, setBlocked] = useState(false), [open, setOpen] = useState(false), [reason, setReason] = useState<string>(menu ? "misleading_menu" : "inappropriate_message"), [details, setDetails] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState(""), [reference, setReference] = useState("");
  const scope = useRef({ token, restaurantId, orderId, conversationId, messageId, menu, reportOnly }), request = useRef<{ body: string; key: string } | null>(null);
  if (scope.current.token !== token || scope.current.restaurantId !== restaurantId || scope.current.orderId !== orderId || scope.current.conversationId !== conversationId || scope.current.messageId !== messageId || scope.current.menu !== menu || scope.current.reportOnly !== reportOnly) scope.current = { token, restaurantId, orderId, conversationId, messageId, menu, reportOnly };
  const renderedScope = scope.current, activeScope = useRef<typeof renderedScope | null>(null), [stateScope, setStateScope] = useState(renderedScope);
  const current = () => activeScope.current === renderedScope && scope.current === renderedScope;
  useEffect(() => {
    activeScope.current = renderedScope;
    setStateScope(renderedScope); setBlocked(false); setOpen(false); setError(""); setDetails(""); setReference(""); setBusy(false); setReason(menu ? "misleading_menu" : "inappropriate_message"); request.current = null;
    onBlockedChange?.(false);
    if (token && restaurantId && !reportOnly) void api<{ blocked: boolean }>(`/api/customer-safety/restaurants/${encodeURIComponent(restaurantId)}`, { token }).then(value => {
      if (current()) { setBlocked(value.blocked); onBlockedChange?.(value.blocked); }
    }).catch(cause => { if (current()) setError((cause as Error).message); });
    return () => { if (activeScope.current === renderedScope) activeScope.current = null; };
  }, [token, restaurantId, orderId, conversationId, messageId, menu, reportOnly]);
  if (!restaurantId) return null;
  if (!token) return <View style={styles.container}>{onSignIn ? <Button tone="quiet" onPress={onSignIn}>{reportOnly ? "Sign in to report this message" : "Sign in to report or block"}</Button> : <Text style={styles.notice}>Sign in to use reporting and blocking.</Text>}</View>;
  if (stateScope !== renderedScope) return null;
  async function toggle() {
    if (!token || busy || !current()) return;
    setBusy(true); setError("");
    try {
      const value = await api<{ blocked: boolean }>(`/api/customer-safety/restaurants/${encodeURIComponent(restaurantId!)}`, { token, method: "PUT", body: JSON.stringify({ blocked: !blocked }) });
      if (current()) { setBlocked(value.blocked); onBlockedChange?.(value.blocked); }
    } catch (cause) { if (current()) setError((cause as Error).message); }
    finally { if (current()) setBusy(false); }
  }
  function confirmBlock() {
    if (!token || busy || !current()) return;
    Alert.alert(blocked ? "Unblock this restaurant?" : "Block this restaurant?", blocked ? "You can exchange messages and receive eligible offers again. Your marketing preferences still apply." : "Restaurant messages and personalised offers will stop. Your order status updates and Cal-Eats support remain available. Existing conversation history is kept.", [
      { text: "Cancel", style: "cancel" }, { text: blocked ? "Unblock" : "Block restaurant", style: blocked ? "default" : "destructive", onPress: () => void toggle() }
    ]);
  }
  async function sendReport() {
    if (!token || busy || !current()) return;
    const body = JSON.stringify({ restaurantId, ...(orderId ? { orderId } : {}), ...(conversationId ? { conversationId } : {}), ...(messageId ? { messageId } : {}), reason, details: details.trim() });
    if (request.current?.body !== body) request.current = { body, key: `safety-${Date.now()}-${Math.random().toString(36).slice(2)}` };
    setBusy(true); setError("");
    try {
      const result = await api<{ reference: string }>("/api/customer-safety/reports", { token, method: "POST", headers: { "Idempotency-Key": request.current.key }, body });
      if (current()) { setReference(result.reference); request.current = null; }
    } catch (cause) { if (current()) setError((cause as Error).message); }
    finally { if (current()) setBusy(false); }
  }
  return <View style={styles.container}><View style={styles.actions}><Button tone="quiet" disabled={busy} onPress={() => { setOpen(true); setError(""); setReference(""); }}>{reportOnly ? "Report message" : menu ? "Report restaurant or menu" : "Report conversation"}</Button>{!reportOnly?<Button tone="quiet" disabled={busy} onPress={confirmBlock}>{blocked ? "Unblock restaurant" : "Block restaurant"}</Button>:null}</View>{blocked ? <Text style={styles.notice}>Restaurant contact is blocked. Order updates and Cal-Eats support remain available.</Text> : null}{!open ? <ErrorBanner message={error}/> : null}
    <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}><SafeAreaView style={styles.backdrop}><View accessibilityViewIsModal style={styles.sheet}><View style={styles.heading}><Text accessibilityRole="header" style={styles.title}>Report to Cal-Eats</Text><Pressable accessibilityRole="button" accessibilityLabel="Close report" onPress={() => setOpen(false)} style={styles.close}><CustomerIcon name="close" size={22}/></Pressable></View><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}><ErrorBanner message={error}/>{reference ? <><Text style={styles.title}>Your report was received</Text><Text style={styles.copy}>Cal-Eats support will review your report. The restaurant does not receive it. You can follow replies in Account → Help requests.</Text><Text style={styles.notice}>Reference {reference}</Text><Button onPress={() => { setOpen(false); setDetails(""); }}>Done</Button></> : <><Text style={styles.copy}>This goes privately to Cal-Eats support, rather than the restaurant.</Text><Text style={styles.label}>What would you like us to review?</Text>{choices.map(([value, label]) => <Pressable key={value} accessibilityRole="radio" accessibilityState={{ checked: reason === value }} onPress={() => setReason(value)} style={[styles.choice, reason === value && styles.selected]}><Text style={styles.copy}>{reason === value ? "● " : "○ "}{label}</Text></Pressable>)}<Field label="Details" value={details} onChangeText={setDetails} multiline maxLength={1200}/><Text style={styles.notice}>Please include only information relevant to the report.</Text><Button busy={busy} onPress={() => void sendReport()}>Send report to Cal-Eats</Button></>}</ScrollView></View></SafeAreaView></Modal>
  </View>;
}
const styles = StyleSheet.create({ container: { gap: 6 }, actions: { flexDirection: "row", flexWrap: "wrap", gap: 6 }, notice: { color: colours.muted, fontSize: 12, lineHeight: 19 }, backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "#10283C80" }, sheet: { maxHeight: "90%", borderTopLeftRadius: 22, borderTopRightRadius: 22, backgroundColor: colours.panel, paddingBottom: 24 }, heading: { flexDirection: "row", alignItems: "center", paddingHorizontal: 18, paddingTop: 14, borderBottomWidth: 1, borderColor: colours.line }, title: { flex: 1, fontSize: 19, fontWeight: "800", color: colours.ink, lineHeight: 27 }, close: { minHeight: 48, minWidth: 48, alignItems: "center", justifyContent: "center" }, content: { padding: 18, gap: 13 }, copy: { color: colours.ink, fontSize: 14, lineHeight: 22 }, label: { color: colours.ink, fontSize: 15, fontWeight: "700", lineHeight: 22 }, choice: { minHeight: 48, padding: 12, borderWidth: 1, borderColor: colours.line, borderRadius: 12 }, selected: { borderColor: colours.blue, backgroundColor: colours.sky } });
