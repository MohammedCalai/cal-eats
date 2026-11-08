import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as SecureStore from "expo-secure-store";
import { CustomerModal } from "./CustomerModal";
import { CustomerIcon } from "./CustomerBrandBanner";
import { Button, ErrorBanner } from "./components";
import { colours } from "./theme";
import type { CustomerPushState } from "./useCustomerPush";
import { notificationPermissionPrompt, showNotificationPermissionPrompt } from "./notification-permission-prompt";

const keyFor = (id: string) => `cal-eats-notification-permission-v2-${id}`;

export function CustomerNotificationPermissionPrompt({ userId, state, blocked, onAllow }: {
  userId: string | null; state: CustomerPushState; blocked: boolean; onAllow: () => Promise<void>;
}) {
  const currentUser = useRef(userId); currentUser.current = userId;
  const [choice, setChoice] = useState({ userId: null as string | null, seen: false });
  const [busy, setBusy] = useState(false), [requestedFor, setRequestedFor] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setBusy(false); setRequestedFor(null); setError("");
    if (!userId) { setChoice({ userId: null, seen: false }); return; }
    void SecureStore.getItemAsync(keyFor(userId)).catch(() => null).then(saved => {
      if (active) setChoice({ userId, seen: saved === "seen" });
    });
    return () => { active = false; };
  }, [userId]);

  function dismiss() {
    if (!userId) return;
    setChoice({ userId, seen: true });
    void SecureStore.setItemAsync(keyFor(userId), "seen").catch(() => undefined);
  }
  useEffect(() => {
    if (userId && requestedFor === userId && !busy && state.status === "enabled" && !state.needsBannerSetup) dismiss();
  }, [requestedFor, busy, state.status, state.needsBannerSetup, userId]);

  async function allow() {
    const requestedUser = userId;
    if (!requestedUser || busy) return;
    setBusy(true); setError(""); setRequestedFor(requestedUser);
    try { await onAllow(); }
    catch { if (currentUser.current === requestedUser) setError("Notification settings could not be opened. Please try again."); }
    finally { if (currentUser.current === requestedUser) setBusy(false); }
  }
  const presentation = notificationPermissionPrompt(state);
  const connecting = busy || Boolean(userId && requestedFor === userId && state.status === "checking");
  const visible = showNotificationPermissionPrompt({ userId, loadedFor: choice.userId, acknowledged: choice.seen, blocked, state, requesting: connecting });
  return <CustomerModal visible={visible} transparent animationType="fade" onRequestClose={() => { if (!connecting) dismiss(); }}>
    <SafeAreaView style={styles.backdrop}><View accessibilityViewIsModal style={styles.card}>
      <View style={styles.toolbar}><Text style={styles.eyebrow}>ORDER UPDATES</Text><Pressable accessibilityRole="button" accessibilityLabel="Close notification setup" disabled={connecting} onPress={dismiss} style={styles.close}><CustomerIcon name="close" size={22}/></Pressable></View>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.icon}><CustomerIcon name="bell" size={36} colour={colours.blue}/></View>
        <Text accessibilityRole="header" style={styles.title}>{presentation?.ready ? "Your notifications are ready" : "Allow notifications"}</Text>
        <Text style={styles.copy}>{presentation?.ready ? "Cal-Eats can send you order updates and messages while the app is closed." : "Keep up with your order and messages, even while Cal-Eats is closed. Allow notifications so you don’t miss an update."}</Text>
        <View style={styles.note}><CustomerIcon name="shield" size={22} colour={colours.blue}/><Text style={styles.noteText}>Your Cal-Eats alerts stay silent. Offer notifications follow your preferences.</Text></View>
        {state.needsBannerSetup || state.status === "blocked" || state.status === "error" ? <Text style={styles.hint}>{state.message}</Text> : null}
        <ErrorBanner message={error}/>
        <Button busy={connecting} onPress={() => { if (presentation?.action === "done") dismiss(); else void allow(); }}>{presentation?.label || "Allow notifications"}</Button>
        {presentation?.ready ? <Button tone="quiet" onPress={() => void allow()}>Review notification settings</Button> : <Button tone="quiet" disabled={connecting} onPress={dismiss}>Not now</Button>}
        <Text style={styles.footer}>You can review notifications any time in Account.</Text>
      </ScrollView>
    </View></SafeAreaView>
  </CustomerModal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "center", padding: 18, backgroundColor: "rgba(20,49,77,.44)" },
  card: { width: "100%", maxWidth: 480, maxHeight: "90%", alignSelf: "center", borderRadius: 24, borderWidth: 1, borderColor: colours.line, backgroundColor: colours.panel, overflow: "hidden" },
  toolbar: { minHeight: 54, paddingLeft: 22, paddingRight: 10, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  eyebrow: { fontSize: 11, letterSpacing: 1.6, fontWeight: "800", color: colours.blueDark },
  close: { minWidth: 44, minHeight: 44, justifyContent: "center", alignItems: "center" },
  content: { paddingHorizontal: 22, paddingBottom: 24, gap: 16 },
  icon: { width: 76, height: 76, borderRadius: 24, backgroundColor: colours.sky, alignItems: "center", justifyContent: "center" },
  title: { color: colours.ink, fontSize: 27, lineHeight: 34, fontWeight: "800" },
  copy: { color: colours.ink, fontSize: 15, lineHeight: 23 },
  note: { flexDirection: "row", alignItems: "center", gap: 10, borderRadius: 14, padding: 13, backgroundColor: colours.sky },
  noteText: { flex: 1, color: colours.blueDark, fontSize: 13, lineHeight: 20 },
  hint: { color: colours.muted, fontSize: 13, lineHeight: 20 },
  footer: { color: colours.muted, fontSize: 12, lineHeight: 18, textAlign: "center" }
});
