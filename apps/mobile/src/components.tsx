import type { PropsWithChildren, ReactNode } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";
import { colours, radii } from "./theme";

export function Brand() {
  return <View style={styles.brand}><Image accessibilityIgnoresInvertColors accessible accessibilityLabel="Cal-Eats" source={require("../assets/cal-eats-logo.png")} style={styles.brandLogo} resizeMode="cover"/></View>;
}

export function Field({ label, hint, ...props }: TextInputProps & { label: string; hint?: string }) {
  return <View style={styles.fieldWrap}><Text style={styles.label}>{label}</Text><TextInput {...props} accessibilityLabel={props.accessibilityLabel ?? label} placeholderTextColor="#8492A4" style={[styles.input, props.multiline && styles.multiline, props.style]}/>{hint ? <Text style={styles.hint}>{hint}</Text> : null}</View>;
}

export function Button({ children, onPress, disabled, tone = "primary", busy, accessibilityLabel }: PropsWithChildren<{ onPress: () => void; disabled?: boolean; tone?: "primary" | "secondary" | "danger" | "quiet"; busy?: boolean; accessibilityLabel?: string }>) {
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} disabled={disabled || busy} onPress={onPress} style={({ pressed }) => [styles.button, styles[`button_${tone}`], (disabled || busy) && styles.disabled, pressed && !disabled && styles.pressed]}>{busy ? <ActivityIndicator color={tone === "primary" ? colours.white : colours.blue}/> : <Text style={[styles.buttonText, tone !== "primary" && styles.buttonTextAlt, tone === "danger" && { color: colours.danger }]}>{children}</Text>}</Pressable>;
}

export function Card({ children, tone = "plain" }: PropsWithChildren<{ tone?: "plain" | "info" | "warning" }>) {
  return <View style={[styles.card, tone === "info" && styles.cardInfo, tone === "warning" && styles.cardWarning]}>{children}</View>;
}

export function Pill({ children, tone = "blue" }: { children: ReactNode; tone?: "blue" | "green" | "amber" }) {
  return <View style={[styles.pill, tone === "green" && styles.pillGreen, tone === "amber" && styles.pillAmber]}><Text style={styles.pillText}>{children}</Text></View>;
}

export function Empty({ children }: PropsWithChildren) { return <View style={styles.empty}><Text style={styles.emptyText}>{children}</Text></View>; }
export function ErrorBanner({ message }: { message?: string | null }) { return message ? <View style={styles.error}><Text style={styles.errorText}>{message}</Text></View> : null; }
export function SectionTitle({ eyebrow, title, action }: { eyebrow?: string; title: string; action?: ReactNode }) { return <View style={styles.sectionHead}><View style={{ flex: 1 }}>{eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}<Text style={styles.title}>{title}</Text></View>{action}</View>; }

const styles = StyleSheet.create({
  brand: { alignSelf: "flex-start", width: 230, maxWidth: "92%", aspectRatio: 4.096, overflow: "hidden" },
  brandLogo: { width: "100%", height: "100%", transform: [{ scale: 1.45 }] },
  fieldWrap: { gap: 6 }, label: { color: colours.ink, fontWeight: "700", fontSize: 14 },
  input: { minHeight: 48, borderWidth: 1, borderColor: colours.line, borderRadius: radii.small, paddingHorizontal: 13, paddingVertical: 11, color: colours.ink, backgroundColor: colours.panel, fontSize: 16 },
  multiline: { minHeight: 96, textAlignVertical: "top" }, hint: { fontSize: 12, color: colours.muted },
  button: { minHeight: 46, borderRadius: 13, paddingHorizontal: 17, paddingVertical: 12, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colours.blue },
  button_primary: { backgroundColor: colours.blue }, button_secondary: { backgroundColor: colours.panel }, button_danger: { backgroundColor: "#3B2229", borderColor: "#71424F" }, button_quiet: { backgroundColor: "transparent", borderColor: "transparent", paddingHorizontal: 8 },
  buttonText: { color: colours.white, fontWeight: "800", fontSize: 15 }, buttonTextAlt: { color: colours.blue }, disabled: { opacity: 0.45 }, pressed: { opacity: 0.78 },
  card: { backgroundColor: colours.panel, borderColor: colours.line, borderWidth: 1, borderRadius: radii.medium, padding: 16, gap: 10 },
  cardInfo: { backgroundColor: colours.sky, borderColor: "#2E4874" }, cardWarning: { backgroundColor: "#382C19", borderColor: "#6F572E" },
  pill: { alignSelf: "flex-start", paddingHorizontal: 9, paddingVertical: 4, borderRadius: 99, backgroundColor: colours.sky }, pillGreen: { backgroundColor: "#19392E" }, pillAmber: { backgroundColor: "#40331D" }, pillText: { color: colours.ink, fontSize: 12, fontWeight: "700" },
  empty: { paddingVertical: 30, paddingHorizontal: 18, alignItems: "center" }, emptyText: { color: colours.muted, textAlign: "center", lineHeight: 21 },
  error: { padding: 12, borderRadius: radii.small, backgroundColor: "#3B2229", borderWidth: 1, borderColor: "#71424F" }, errorText: { color: colours.danger, lineHeight: 20 },
  sectionHead: { flexDirection: "row", gap: 10, alignItems: "center" }, eyebrow: { color: colours.blue, textTransform: "uppercase", fontWeight: "800", fontSize: 11, letterSpacing: 1.1 }, title: { color: colours.ink, fontSize: 26, fontWeight: "800", letterSpacing: -0.5 }
});
