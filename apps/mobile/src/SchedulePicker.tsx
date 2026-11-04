import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, AppState, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ApiError, api } from "./api";
import { ErrorBanner } from "./components";
import { colours } from "./theme";
import type { Fulfillment } from "./types";
import { reconcileScheduleChoice, type ScheduleMode } from "./schedule-choice";

export type { ScheduleChoice, ScheduleMode } from "./schedule-choice";
type Slot = { scheduledFor: string; label: string; dateKey: string; dateLabel: string };
type Slots = { items: Slot[]; minimumLeadMinutes: number; maxDays: number };
type Props = { token: string; restaurantId: string; fulfillment: Fulfillment; acceptingOrders: boolean; mode: ScheduleMode; value: string | null; onModeChange: (mode: ScheduleMode) => void; onChange: (value: string | null) => void; disabled?: boolean; asapMinutes?: number };

function checkedSlots(value: Slots): Slots {
  if (!value || !Array.isArray(value.items) || value.items.length > 700 || !Number.isInteger(value.minimumLeadMinutes) || value.minimumLeadMinutes < 30 || value.maxDays !== 7 || value.items.some(slot => !slot || typeof slot !== "object" || typeof slot.scheduledFor !== "string" || !Number.isFinite(Date.parse(slot.scheduledFor)) || new Date(slot.scheduledFor).toISOString() !== slot.scheduledFor || typeof slot.label !== "string" || typeof slot.dateKey !== "string" || typeof slot.dateLabel !== "string")) throw new ApiError("Available times could not be verified.", 0, "MALFORMED_RESPONSE");
  return value;
}

export function scheduledTimeLabel(value: string) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

export function SchedulePicker({ token, restaurantId, fulfillment, acceptingOrders, mode, value, onModeChange, onChange, disabled = false, asapMinutes }: Props) {
  const [result, setResult] = useState<Slots | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [day, setDay] = useState(""), [expanded, setExpanded] = useState(true), [revision, setRevision] = useState(0);
  const latest = useRef({ value, onChange, disabled }); latest.current = { value, onChange, disabled };
  const context = `${restaurantId}:${fulfillment}`;
  const [loadedContext, setLoadedContext] = useState("");
  const slots = loadedContext === context ? result : null;

  useEffect(() => {
    if (mode !== "scheduled" || disabled) return;
    let active = true, retries = 0, retry: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      if (!active || latest.current.disabled) return;
      setLoading(true); setError("");
      try {
        const response = checkedSlots(await api<Slots>(`/api/restaurants/${encodeURIComponent(restaurantId)}/schedule-slots?fulfillment=${fulfillment}`, { token }));
        if (!active || latest.current.disabled) return;
        setResult(response); setLoadedContext(context);
        const selected = response.items.find(slot => slot.scheduledFor === latest.current.value);
        const reconciled = reconcileScheduleChoice({ mode: "scheduled", scheduledFor: latest.current.value }, response.items.map(slot => slot.scheduledFor), latest.current.disabled);
        if (reconciled.scheduledFor !== latest.current.value) { latest.current.onChange(reconciled.scheduledFor); setExpanded(true); }
        setDay(old => selected?.dateKey ?? (response.items.some(slot => slot.dateKey === old) ? old : response.items[0]?.dateKey ?? ""));
      } catch (caught) {
        if (!active || latest.current.disabled) return;
        const transient = caught instanceof ApiError && caught.code !== "API_NOT_CONFIGURED" && (caught.status === 0 || caught.status === 408 || caught.status === 429 || caught.status >= 500);
        setError(transient ? "Available times could not be loaded. We’ll check again automatically." : (caught as Error).message);
        if (transient && retries < 3) retry = setTimeout(() => void load(), [1500, 4000, 10000][retries++]);
      } finally { if (active && !latest.current.disabled) setLoading(false); }
    }
    void load();
    const refresh = setInterval(() => { retries = 0; clearTimeout(retry); void load(); }, 60000);
    const focus = AppState.addEventListener("change", state => { if (state === "active") setRevision(old => old + 1); });
    return () => { active = false; clearTimeout(retry); clearInterval(refresh); focus.remove(); };
  }, [token, restaurantId, fulfillment, context, mode, disabled, revision]);

  const days = useMemo(() => [...new Map((slots?.items ?? []).map(slot => [slot.dateKey, { key: slot.dateKey, label: slot.dateLabel }])).values()], [slots]);
  const times = slots?.items.filter(slot => slot.dateKey === day) ?? [];
  function chooseMode(next: ScheduleMode) { if (disabled || next === "asap" && !acceptingOrders) return; if (mode === next) return; onChange(null); onModeChange(next); setExpanded(true); }
  function chooseDay(next: string) { if (disabled) return; setDay(next); if (!slots?.items.some(slot => slot.dateKey === next && slot.scheduledFor === value)) onChange(null); setExpanded(true); }
  const kind = fulfillment === "delivery" ? "delivery" : "collection";

  return <View style={styles.root}>
    <Text style={styles.title}>When would you like it?</Text>
    <View style={styles.modes} accessibilityRole="radiogroup">
      <Pressable accessibilityRole="radio" accessibilityLabel={`As soon as possible${!acceptingOrders ? ", unavailable while the restaurant is closed" : ""}`} accessibilityState={{ checked: mode === "asap", disabled: disabled || !acceptingOrders }} disabled={disabled || !acceptingOrders} onPress={() => chooseMode("asap")} style={[styles.mode, mode === "asap" && styles.selected, !acceptingOrders && styles.disabled]}><Text style={[styles.modeTitle, mode === "asap" && styles.selectedText]}>As soon as possible</Text><Text style={styles.caption}>{acceptingOrders ? asapMinutes ? `About ${asapMinutes} min` : "Next available" : "Restaurant closed now"}</Text></Pressable>
      <Pressable accessibilityRole="radio" accessibilityLabel={`Schedule ${kind}`} accessibilityState={{ checked: mode === "scheduled", disabled }} disabled={disabled} onPress={() => chooseMode("scheduled")} style={[styles.mode, mode === "scheduled" && styles.selected]}><Text style={[styles.modeTitle, mode === "scheduled" && styles.selectedText]}>Schedule for later</Text><Text style={styles.caption}>Choose a day and time</Text></Pressable>
    </View>
    {mode === "scheduled" ? <>
      <Text style={styles.caption}>{slots ? `Choose an available time at least ${slots.minimumLeadMinutes} minutes ahead, up to ${slots.maxDays} days from now.` : "Checking the restaurant’s available times…"} Times are shown for the UK.</Text>
      {loading && !slots ? <View accessibilityLiveRegion="polite" style={styles.loading}><ActivityIndicator color={colours.blue}/><Text style={styles.caption}>Finding available times…</Text></View> : null}
      <ErrorBanner message={error}/>
      {slots && !slots.items.length ? <Text accessibilityLiveRegion="polite" style={styles.empty}>No scheduled {kind} times are available in the next 7 days.</Text> : null}
      {days.length ? <>
        <Text style={styles.label}>Day</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.days}>{days.map(option => <Pressable key={option.key} accessibilityRole="radio" accessibilityLabel={option.label} accessibilityState={{ checked: day === option.key, disabled }} disabled={disabled} onPress={() => chooseDay(option.key)} style={[styles.day, day === option.key && styles.selected]}><Text style={[styles.dayText, day === option.key && styles.selectedText]}>{option.label}</Text></Pressable>)}</ScrollView>
        <Pressable accessibilityRole="button" accessibilityLabel={value ? `Change scheduled ${kind}, ${scheduledTimeLabel(value)}` : `Choose ${kind} time`} accessibilityState={{ expanded, disabled }} disabled={disabled} onPress={() => setExpanded(old => !old)} style={styles.timeControl}><View style={styles.controlText}><Text style={styles.label}>{value ? `Scheduled ${kind}` : "Choose a time"}</Text><Text style={[styles.timeValue, !value && styles.unselected]}>{value ? scheduledTimeLabel(value) : "Select from available times"}</Text></View><Text style={styles.chevron}>{expanded ? "⌃" : "⌄"}</Text></Pressable>
        {expanded ? <ScrollView nestedScrollEnabled style={styles.timeScroll} contentContainerStyle={styles.times}>{times.map(slot => <Pressable key={slot.scheduledFor} accessibilityRole="radio" accessibilityLabel={`${slot.dateLabel}, ${slot.label}`} accessibilityState={{ checked: value === slot.scheduledFor, disabled }} disabled={disabled} onPress={() => { onChange(slot.scheduledFor); setExpanded(false); }} style={[styles.time, value === slot.scheduledFor && styles.selected]}><Text style={[styles.timeText, value === slot.scheduledFor && styles.selectedText]}>{slot.label}</Text></Pressable>)}</ScrollView> : null}
      </> : null}
    </> : <Text style={styles.caption}>The restaurant will confirm your estimated {kind === "delivery" ? "arrival" : "collection"} time after you order.</Text>}
  </View>;
}

const styles = StyleSheet.create({
  root: { gap: 10 }, title: { color: colours.ink, fontWeight: "800", fontSize: 16, lineHeight: 23 },
  modes: { flexDirection: "row", gap: 9 }, mode: { flex: 1, minHeight: 82, padding: 12, borderWidth: 1, borderColor: colours.line, borderRadius: 12, justifyContent: "center", gap: 5 }, modeTitle: { fontSize: 14, fontWeight: "800", color: colours.ink, lineHeight: 20 },
  selected: { borderColor: colours.blue, backgroundColor: colours.sky }, selectedText: { color: colours.blueDark }, disabled: { opacity: .5 }, caption: { color: colours.muted, fontSize: 12, lineHeight: 19 }, loading: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 }, empty: { color: colours.ink, lineHeight: 21, backgroundColor: colours.cream, borderRadius: 10, padding: 12 },
  label: { color: colours.ink, fontSize: 13, fontWeight: "700", lineHeight: 20 }, days: { gap: 8, paddingBottom: 2 }, day: { minHeight: 46, minWidth: 104, borderWidth: 1, borderColor: colours.line, borderRadius: 10, paddingHorizontal: 12, justifyContent: "center", alignItems: "center" }, dayText: { color: colours.ink, fontWeight: "700", fontSize: 13, lineHeight: 20 },
  timeControl: { minHeight: 64, flexDirection: "row", gap: 12, alignItems: "center", borderWidth: 1, borderColor: colours.line, backgroundColor: colours.panel, borderRadius: 11, padding: 12 }, controlText: { flex: 1, gap: 2 }, timeValue: { color: colours.blueDark, fontWeight: "800", fontSize: 15, lineHeight: 22 }, unselected: { color: colours.muted, fontWeight: "400" }, chevron: { color: colours.blue, fontSize: 20 },
  timeScroll: { maxHeight: 224, borderWidth: 1, borderColor: colours.line, borderRadius: 12, backgroundColor: colours.cream }, times: { flexDirection: "row", flexWrap: "wrap", gap: 8, padding: 10 }, time: { minWidth: "22%", flexGrow: 1, minHeight: 46, paddingHorizontal: 10, borderWidth: 1, borderColor: colours.line, backgroundColor: colours.panel, borderRadius: 9, alignItems: "center", justifyContent: "center" }, timeText: { color: colours.ink, fontWeight: "700", fontSize: 14, lineHeight: 21 }
});
