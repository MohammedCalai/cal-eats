import { useCallback, useEffect, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as SecureStore from "expo-secure-store";
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { ConfirmOrder, OrderInformation } from "./OrdersScreen";
import { orderSoundAllowed, pendingOrderQueue, type BusinessOrder, type PendingOrders } from "./orders-model";
import { Button, Chip, Chips, colour, ErrorText, styles } from "./ui";
import { useLiveOrders } from "./useLiveOrders";

const SOUND_KEY = "cal_eats_admin_order_sound_v1";
export function useOrderSoundPreference() {
  const [enabled, setEnabled] = useState(true), [ready, setReady] = useState(false), [error, setError] = useState("");
  const changed = useRef(false);
  useEffect(() => { let live = true; void SecureStore.getItemAsync(SOUND_KEY).then(value => { if (live && !changed.current) setEnabled(value !== "off"); }).catch(() => { if (live && !changed.current) { setEnabled(false); setError("The saved sound preference could not be read. Enable sound here if you want order alerts."); } }).finally(() => { if (live) setReady(true); }); return () => { live = false; }; }, []);
  const change = useCallback((value: boolean) => { changed.current = true; setEnabled(value); setError(""); void SecureStore.setItemAsync(SOUND_KEY, value ? "on" : "off").catch(() => setError("The sound preference applies now but could not be saved on this device.")); }, []);
  return { enabled, ready, error, change };
}

function ForegroundOrderSound({ ring, urgent, onError }: { ring: boolean; urgent: boolean; onError: (message: string) => void }) {
  const normal = useAudioPlayer(require("../assets/sounds/notification.wav"), { updateInterval: 1000 }), unconfirmed = useAudioPlayer(require("../assets/sounds/unconfirmed-notification.wav"), { updateInterval: 1000 });
  const normalStatus = useAudioPlayerStatus(normal), urgentStatus = useAudioPlayerStatus(unconfirmed);
  const loaded = urgent ? urgentStatus.isLoaded : normalStatus.isLoaded;
  useEffect(() => {
    let cancelled = false;
    const stop = () => { for (const player of [normal, unconfirmed]) { try { player.pause(); void player.seekTo(0).catch(() => undefined); } catch { /* The managed hook may already have released this player. */ } } };
    stop();
    if (ring && loaded) void (async () => { try { await setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: false, allowsRecording: false, allowsBackgroundRecording: false, shouldRouteThroughEarpiece: false, interruptionMode: "duckOthers" }); if (cancelled) return; const player = urgent ? unconfirmed : normal; player.loop = true; player.volume = 1; await player.seekTo(0); if (!cancelled) { player.play(); onError(""); } } catch { if (!cancelled) onError("Order sound could not play. The visual order queue is still available."); } })();
    return () => { cancelled = true; stop(); };
  }, [ring, urgent, loaded, normal, unconfirmed, onError]);
  useEffect(() => { if (!ring || loaded) return; const timer = setTimeout(() => onError("Order sound is not ready. Check the visual queue and your device audio settings."), 5000); return () => clearTimeout(timer); }, [ring, loaded, onError]);
  return null;
}

export function IncomingOrderAlerts({ token, sound, refreshVersion, onOpenOrder, onSessionExpired }: { token: string; sound: ReturnType<typeof useOrderSoundPreference>; refreshVersion: number; onOpenOrder: (order: BusinessOrder) => Promise<void>; onSessionExpired: () => Promise<void> }) {
  const pending = useLiveOrders<PendingOrders>("/api/restaurant/orders/pending-confirmation", token, 5000), [selectedId, setSelectedId] = useState(""), [ignored, setIgnored] = useState(""), [audioError, setAudioError] = useState(""), [navigationError, setNavigationError] = useState(""), [opening, setOpening] = useState(false);
  const insets = useSafeAreaInsets(), dimensions = useWindowDimensions(); const previousVersion = useRef(refreshVersion);
  const queue = pendingOrderQueue(pending.value?.items || []), selected = queue.find(order => order.id === selectedId) || queue[0];
  const signature = queue.map(order => `${order.id}:${Boolean(order.confirmationOverdue)}`).join("|"), total = pending.value?.total || queue.length, overdue = queue.some(order => order.confirmationOverdue);
  const visible = pending.foreground && pending.verified && Boolean(selected) && signature !== ignored;
  const ring = orderSoundAllowed({ signedIn: Boolean(token), foreground: pending.foreground, enabled: sound.enabled && sound.ready, verified: pending.verified, pendingCount: queue.length });
  useEffect(() => { if (!signature) setIgnored(""); }, [signature]);
  useEffect(() => { if (previousVersion.current !== refreshVersion) { previousVersion.current = refreshVersion; void pending.refresh(true); } }, [refreshVersion, pending.refresh]);
  useEffect(() => { if (pending.unauthorised) void onSessionExpired(); }, [pending.unauthorised, onSessionExpired]);
  const audioFailure = useCallback((message: string) => setAudioError(message), []);
  async function openOrder(order: BusinessOrder) { setOpening(true); setNavigationError(""); try { await onOpenOrder(order); setIgnored(signature); } catch { setNavigationError("This restaurant's order could not be opened. Refresh the queue and try again."); } finally { setOpening(false); } }
  async function changed(order: BusinessOrder) { await pending.refresh(true); await onOpenOrder(order); }
  return <><ForegroundOrderSound ring={ring} urgent={overdue} onError={audioFailure}/>{pending.foreground && !visible && queue.length > 0 && <View style={[alertStyles.banner, { borderColor: overdue ? "#f59e0b" : colour.blue }]}><View style={{ flex: 1 }}><Text style={styles.heading}>{total} order{total === 1 ? "" : "s"} waiting</Text><Text style={styles.hint}>Confirmation is still required.</Text></View><Button quiet onPress={() => setIgnored("")}>Review</Button><Button quiet onPress={() => sound.change(!sound.enabled)}>{sound.enabled ? "Mute" : "Sound on"}</Button></View>}{pending.foreground && pending.error && !queue.length && <View style={alertStyles.banner}><Text style={[styles.muted, { flex: 1 }]}>Order updates unavailable. Check your connection.</Text><Button quiet onPress={() => void pending.refresh(true)}>Retry</Button></View>}
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => setIgnored(signature)}><View style={[alertStyles.overlay, { paddingTop: insets.top + 14, paddingBottom: insets.bottom + 14 }]}>{selected && <View style={[alertStyles.popup, { maxHeight: dimensions.height - insets.top - insets.bottom - 28, borderColor: selected.confirmationOverdue ? "#f59e0b" : "#3b82f6", shadowColor: selected.confirmationOverdue ? "#f59e0b" : "#2563eb" }]}><View style={[alertStyles.header, { backgroundColor: selected.confirmationOverdue ? "#b45309" : "#2563eb" }]}><Text style={alertStyles.bell}>{selected.confirmationOverdue ? "⚠" : "🔔"}</Text><View style={{ flex: 1, gap: 4 }}><Text style={alertStyles.title}>{selected.confirmationOverdue ? "Order needs confirmation" : "New order received"}</Text><Text style={alertStyles.subtitle}>{selected.restaurantName} · #{selected.id.slice(0, 8).toUpperCase()}</Text></View><Pressable accessibilityRole="button" accessibilityLabel="Keep pending and close popup" style={alertStyles.close} onPress={() => setIgnored(signature)}><Text style={{ color: "white", fontSize: 24 }}>×</Text></Pressable></View><ScrollView keyboardShouldPersistTaps="handled" style={{ flexShrink: 1 }} contentContainerStyle={{ padding: 16, gap: 14 }}><Text style={styles.muted}>{total} awaiting confirmation{total > queue.length ? ` · showing the first ${queue.length}` : ""}. Viewing or muting does not confirm an order.</Text>{queue.length > 1 && <Chips>{queue.map(order => <Chip key={order.id} selected={selected.id === order.id} onPress={() => setSelectedId(order.id)}>#{order.id.slice(0, 6).toUpperCase()}{order.confirmationOverdue ? " ⚠" : ""}</Chip>)}</Chips>}<ErrorText message={pending.error || navigationError || audioError || sound.error}/>{selected.confirmationOverdue && <View style={alertStyles.overdue}><Text style={{ color: "#fbbf24", fontWeight: "800" }}>Action required</Text><Text style={{ color: "#fde68a", lineHeight: 20 }}>The customer is waiting for the restaurant to confirm this order.</Text></View>}<OrderInformation order={selected}/><ConfirmOrder key={selected.id} token={token} order={selected} onChanged={changed}/><View style={styles.row}><Button quiet busy={opening} onPress={() => void openOrder(selected)}>View order queue</Button><Button quiet onPress={() => sound.change(!sound.enabled)}>{sound.enabled ? "Mute order sound" : "Enable order sound"}</Button></View><Text style={styles.hint}>Order sound is {sound.enabled ? "on" : "muted"} on this device. Alerts run while Cal-Eats Admin is open; background phone notifications are not connected.</Text></ScrollView></View>}</View></Modal>
  </>;
}
const alertStyles = StyleSheet.create({ overlay: { flex: 1, backgroundColor: "rgba(0,0,0,.72)", justifyContent: "center", alignItems: "center", paddingHorizontal: 14 }, popup: { width: "100%", maxWidth: 500, borderWidth: 2, borderRadius: 20, overflow: "hidden", backgroundColor: colour.background, shadowOpacity: .3, shadowRadius: 22, elevation: 10 }, header: { flexDirection: "row", alignItems: "center", gap: 10, padding: 16 }, bell: { fontSize: 24, color: "white" }, title: { color: "white", fontWeight: "800", fontSize: 20 }, subtitle: { color: "#e0e7ff", fontSize: 12, lineHeight: 18 }, close: { width: 44, height: 44, justifyContent: "center", alignItems: "center" }, overdue: { backgroundColor: "#261706", borderColor: "#92400e", borderWidth: 1, borderRadius: 12, padding: 14, gap: 6 }, banner: { position: "absolute", bottom: 76, left: 10, right: 10, flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, padding: 12, borderWidth: 1, borderColor: colour.border, borderRadius: 14, backgroundColor: colour.panel, elevation: 8, zIndex: 20 } });
