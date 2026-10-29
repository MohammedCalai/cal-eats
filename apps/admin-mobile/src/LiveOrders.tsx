import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, StyleSheet, Text, View } from "react-native";
import { Button, colour, styles } from "./ui";

type Operations = { liveOrders: number; pendingConfirmation: number; confirmedInKitchen: number; readyForHandover: number };
export function LiveOrders({ operations, onOpen }: { operations: Operations; onOpen: () => void }) {
  const [reducedMotion, setReducedMotion] = useState(true), flow = useRef(new Animated.Value(0)).current;
  const count = operations.liveOrders, live = count > 0;
  useEffect(() => { let active = true; void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (active) setReducedMotion(value); }); const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReducedMotion); return () => { active = false; sub.remove(); }; }, []);
  useEffect(() => { if (!live || reducedMotion) { flow.setValue(0); return; } const animation = Animated.loop(Animated.sequence([Animated.timing(flow, { toValue: 1, duration: 3000, useNativeDriver: true }), Animated.timing(flow, { toValue: 0, duration: 3000, useNativeDriver: true })])); animation.start(); return () => animation.stop(); }, [live, reducedMotion, flow]);
  return <View style={[card.panel, live && card.active]}>
    {live && <View pointerEvents="none" importantForAccessibility="no-hide-descendants" style={StyleSheet.absoluteFill}><Animated.View style={[card.energy, { opacity: flow.interpolate({ inputRange: [0, 1], outputRange: [.25, .65] }), transform: [{ rotate: "-16deg" }, { translateY: flow.interpolate({ inputRange: [0, 1], outputRange: [-16, 20] }) }] }]}/><Animated.View style={[card.energy, { top: 180, transform: [{ rotate: "12deg" }], opacity: .25 }]}/></View>}
    <View style={[card.orbit, live && card.activeOrbit]}><Text style={{ color: live ? colour.cyan : colour.muted, fontSize: 22 }}>◉</Text><Text accessibilityLiveRegion="polite" accessibilityLabel={`${count} live orders`} style={card.count}>{count}</Text><Text style={card.label}>LIVE ORDERS</Text></View>
    <Text style={[card.label, { color: live ? colour.cyan : colour.muted }]}>● LIVE ACTIVITY</Text><Text style={styles.heading}>{live ? `${count} live order${count === 1 ? "" : "s"}` : "No live orders"}</Text>
    <Text style={[styles.muted, { textAlign: "center" }]}>{live ? "Your kitchen is in motion. Keep each order up to date." : "Keep this page open. New orders appear automatically."}</Text>
    <View style={[styles.row, { justifyContent: "center" }]}><Text style={styles.muted}>{operations.pendingConfirmation} to confirm</Text><Text style={styles.muted}>{operations.confirmedInKitchen} preparing</Text><Text style={styles.muted}>{operations.readyForHandover} ready</Text></View>
    <Button quiet onPress={onOpen}>View orders ↗</Button><Text style={[styles.hint, { textAlign: "center" }]}>All dates · leaves live when out for delivery or collected{"\n"}Updates every 5 seconds</Text>
  </View>;
}
const card = StyleSheet.create({ panel: { position: "relative", overflow: "hidden", borderRadius: 22, backgroundColor: "#18191d", borderWidth: 1, borderColor: "#2b2d38", alignItems: "center", padding: 24, gap: 14 }, active: { backgroundColor: "#101e38", borderColor: "#3066b2" }, orbit: { width: 144, height: 144, borderRadius: 72, borderWidth: 2, borderColor: "#2b354c", alignItems: "center", justifyContent: "center", gap: 7, backgroundColor: "#18191ddd" }, activeOrbit: { borderColor: "#3085ed", backgroundColor: "#122344", shadowColor: "#1687ff", shadowOffset: { width: 0, height: 0 }, shadowOpacity: .5, shadowRadius: 24 }, count: { color: colour.text, fontSize: 46, fontWeight: "800", lineHeight: 50 }, label: { color: "#b7c2d5", fontSize: 10, letterSpacing: 2 }, energy: { position: "absolute", width: "150%", height: 190, left: "-25%", top: 70, borderWidth: 2, borderColor: "#2d98ff", borderRadius: 160, backgroundColor: "#167cff14" } });
