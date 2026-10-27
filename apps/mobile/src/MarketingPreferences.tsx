import { useEffect, useState } from "react";
import { StyleSheet, Switch, Text, View } from "react-native";
import { api } from "./api";
import { Card, ErrorBanner } from "./components";
import { colours } from "./theme";

type Preferences = { inAppPromotions: boolean; pushPromotions: boolean };
export function MarketingPreferences({ token }: { token: string }) {
  const [value, setValue] = useState<Preferences | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { let active = true; api<Preferences>("/api/account/marketing-preferences", { token }).then(v => { if (active) setValue(v); }).catch(e => { if (active) setError(e.message); }); return () => { active = false; }; }, [token]);
  async function change(key: keyof Preferences, enabled: boolean) {
    if (!value || busy) return;
    setBusy(true); setError("");
    try { setValue(await api<Preferences>("/api/account/marketing-preferences", { method: "PATCH", token, body: JSON.stringify({ inAppPromotions:value.inAppPromotions, pushPromotions:value.pushPromotions, [key]: enabled, source: "native-account" }) })); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <Card><Text style={styles.title}>Restaurant offers</Text><Text style={styles.meta}>Choose whether restaurants you have ordered from can send you promotions. You can turn either option off at any time. Order updates are separate.</Text><ErrorBanner message={error}/>{value ? <><View style={styles.row}><Text style={styles.label}>Offers in the app</Text><Switch accessibilityLabel="Offers in the app" disabled={busy} value={value.inAppPromotions} onValueChange={v => void change("inAppPromotions", v)}/></View><View style={styles.row}><Text style={styles.label}>Promotional push notifications</Text><Switch accessibilityLabel="Promotional push notifications" disabled={busy} value={value.pushPromotions} onValueChange={v => void change("pushPromotions", v)}/></View><Text style={styles.meta}>Push delivery also needs device permission and a connected push service. Saving this preference does not enable that service.</Text></> : <Text style={styles.meta}>Loading preferences…</Text>}</Card>;
}
const styles = StyleSheet.create({ title: { fontSize: 18, fontWeight: "700", color: colours.ink }, meta: { color: colours.muted, lineHeight: 20 }, label: { color: colours.ink, flex: 1 }, row: { flexDirection: "row", alignItems: "center", gap: 12 } });
