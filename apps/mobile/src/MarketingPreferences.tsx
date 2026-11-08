import { useEffect, useRef, useState } from "react";
import { StyleSheet, Switch, Text, View } from "react-native";
import { api } from "./api";
import { Card, ErrorBanner } from "./components";
import { colours } from "./theme";

type Preferences = { inAppPromotions: boolean; pushPromotions: boolean };
export function MarketingPreferences({ token }: { token: string }) {
  const [value, setValue] = useState<Preferences | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const scope = useRef({ token }), mounted = useRef(false), revision = useRef(0), inFlight = useRef(false);
  if (scope.current.token !== token) scope.current = { token };
  const renderedScope = scope.current, [stateScope, setStateScope] = useState(renderedScope);
  const currentValue = stateScope === renderedScope ? value : null;
  const currentError = stateScope === renderedScope ? error : "";
  const currentBusy = stateScope === renderedScope && busy;
  useEffect(() => {
    mounted.current = true;
    const requestedScope = renderedScope, request = ++revision.current;
    const current = () => mounted.current && revision.current === request && scope.current === requestedScope;
    inFlight.current = false;
    setStateScope(requestedScope); setValue(null); setError(""); setBusy(false);
    if (token) void api<Preferences>("/api/account/marketing-preferences", { token })
      .then(next => { if (current()) setValue(next); })
      .catch(cause => { if (current()) setError((cause as Error).message); });
    return () => { mounted.current = false; revision.current++; };
  }, [token]);
  async function change(key: keyof Preferences, enabled: boolean) {
    if (!token || !currentValue || !mounted.current || scope.current !== renderedScope || inFlight.current) return;
    const requestedScope = renderedScope, request = ++revision.current;
    const current = () => mounted.current && revision.current === request && scope.current === requestedScope;
    inFlight.current = true;
    setBusy(true); setError("");
    try {
      const next = await api<Preferences>("/api/account/marketing-preferences", { method: "PATCH", token, body: JSON.stringify({ inAppPromotions:currentValue.inAppPromotions, pushPromotions:currentValue.pushPromotions, [key]: enabled, source: "native-account" }) });
      if (current()) setValue(next);
    } catch (cause) { if (current()) setError((cause as Error).message); }
    finally { if (current()) { inFlight.current = false; setBusy(false); } }
  }
  return <Card><Text style={styles.title}>Restaurant offers</Text><Text style={styles.meta}>Choose whether restaurants you have ordered from can send you promotions. You can turn either option off at any time. Order updates are separate.</Text><ErrorBanner message={currentError}/>{currentValue ? <><View style={styles.row}><Text style={styles.label}>Offers in the app</Text><Switch accessibilityLabel="Offers in the app" disabled={currentBusy} value={currentValue.inAppPromotions} onValueChange={v => void change("inAppPromotions", v)}/></View><View style={styles.row}><Text style={styles.label}>Promotional push notifications</Text><Switch accessibilityLabel="Promotional push notifications" disabled={currentBusy} value={currentValue.pushPromotions} onValueChange={v => void change("pushPromotions", v)}/></View><Text style={styles.meta}>Promotional phone alerts require this preference and phone notification permission. Your phone notification connection status is shown above.</Text></> : <Text style={styles.meta}>{token ? "Loading preferences…" : "Sign in to manage your preferences."}</Text>}</Card>;
}
const styles = StyleSheet.create({ title: { fontSize: 18, fontWeight: "700", color: colours.ink }, meta: { color: colours.muted, lineHeight: 20 }, label: { color: colours.ink, flex: 1 }, row: { flexDirection: "row", alignItems: "center", gap: 12 } });
