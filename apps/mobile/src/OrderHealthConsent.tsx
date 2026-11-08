import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { api } from "./api";
import { colours } from "./theme";

type Notice = { version: string; sha256: string; text: string };
type Privacy = { enabled: boolean; healthDataEnabled: boolean; healthConsent: Notice | null };
export function useOrderHealthConsent(token: string, notes: string) {
  const [status, setStatus] = useState<Privacy | null>(null), [error, setError] = useState("");
  const [acceptedNotes, setAcceptedNotes] = useState<string | null>(null), [scope, setScope] = useState<string | null>(null);
  const accepted = acceptedNotes === notes;
  const setAccepted = (value: boolean) => setAcceptedNotes(value ? notes : null);
  const current = useRef(token); current.current = token;
  useEffect(() => {
    let active = true; setStatus(null); setScope(null); setError(""); setAccepted(false);
    void api<Privacy>("/api/customer/privacy", { token }).then(value => {
      if (active && current.current === token) {
        if (typeof value?.enabled !== "boolean" || typeof value.healthDataEnabled !== "boolean" || value.healthDataEnabled && (!value.enabled || !value.healthConsent?.version || !/^[a-f0-9]{64}$/.test(value.healthConsent.sha256) || !value.healthConsent.text)) throw Error("Allergy-note information could not be verified.");
        setStatus(value); setScope(token);
      }
    }).catch(caught => { if (active && current.current === token) setError((caught as Error).message); });
    return () => { active = false; };
  }, [token]);
  const activeStatus = scope === token ? status : null;
  const ready = !notes.trim() || Boolean(activeStatus?.healthDataEnabled && accepted);
  function payload() {
    if (!notes.trim()) return undefined;
    if (!activeStatus) throw Error("Allergy-note information is unavailable. Wait for it to load, or clear the optional notes before ordering.");
    if (!activeStatus.healthDataEnabled) throw Error("Allergy-note collection is unavailable. Contact the restaurant directly about allergies and clear the optional notes before ordering.");
    if (!accepted) throw Error("Please explicitly agree to sharing your allergy notes with the restaurant, or clear the optional notes before ordering.");
    return { accepted: true, version: activeStatus.healthConsent!.version, sha256: activeStatus.healthConsent!.sha256 };
  }
  return { status: activeStatus, collectionAvailable: activeStatus?.healthDataEnabled === true, error, accepted, setAccepted, ready, payload };
}
export function OrderHealthConsent({ review, notes, disabled }: { review: ReturnType<typeof useOrderHealthConsent>; notes: string; disabled: boolean }) {
  if (!notes.trim()) return null;
  if (review.status && !review.status.healthDataEnabled) return <Text style={styles.note}>Allergy-note collection is unavailable. Contact the restaurant directly about allergies, and clear these optional notes before ordering.</Text>;
  if (!review.status) return <Text accessibilityLiveRegion="polite" style={styles.note}>{review.error ? "Allergy-note information is unavailable. Clear the optional notes to order without them, or return to checkout when your connection is available." : "Checking allergy-note information…"}</Text>;
  return <View style={styles.box}><Pressable accessibilityRole="checkbox" accessibilityState={{ checked: review.accepted, disabled }} disabled={disabled} onPress={() => review.setAccepted(!review.accepted)} style={styles.row}><View style={[styles.check, review.accepted && styles.selected]}><Text style={styles.tick}>{review.accepted ? "✓" : ""}</Text></View><Text style={styles.note}>{review.status.healthConsent!.text}</Text></Pressable></View>;
}
const styles = StyleSheet.create({ box: { marginTop: 12 }, row: { flexDirection: "row", gap: 12, alignItems: "flex-start", minHeight: 48 }, check: { width: 25, height: 25, borderWidth: 1.5, borderColor: colours.blue, borderRadius: 6, alignItems: "center", justifyContent: "center" }, selected: { backgroundColor: colours.blue }, tick: { color: "#fff", fontWeight: "800" }, note: { color: colours.muted, fontSize: 13, lineHeight: 20, flex: 1 } });
