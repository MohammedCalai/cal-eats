import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Linking, Platform, ScrollView, StyleSheet, Text } from "react-native";
import { api, API_BASE_URL } from "../api";
import { requestKey } from "../model";
import { Button, Card, ErrorBanner, Field } from "../components";
import { colours } from "../theme";
import type { User } from "../types";

type Mode = "login" | "register" | "apply" | "forgot";
export function AuthScreen({ onAuthenticated, onContinueBrowsing }: { onAuthenticated: (token: string, user: User) => Promise<void>; onContinueBrowsing?: () => void }) {
  const [mode, setMode] = useState<Mode>("login");
  const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [restaurantName, setRestaurantName] = useState(""); const [address, setAddress] = useState(""); const [mobile, setMobile] = useState("");
  const [applicationReceived, setApplicationReceived] = useState(false); const applicationKey = useRef<string | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const mounted = useRef(false), request = useRef(0), inFlight = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current += 1; }; }, []);

  async function openLink(url: string) {
    if (!mounted.current || inFlight.current) return;
    const id = ++request.current; inFlight.current = true; setBusy(true); setError("");
    try { await Linking.openURL(url); }
    catch { if (mounted.current && request.current === id) setError("This link could not be opened. Please try again."); }
    finally { if (request.current === id) { inFlight.current = false; if (mounted.current) setBusy(false); } }
  }

  async function submit() {
    if (!mounted.current || inFlight.current || mode === "forgot") return;
    const id = ++request.current; inFlight.current = true;
    const current = () => mounted.current && request.current === id;
    setBusy(true); setError("");
    try {
      if (mode === "apply") {
        applicationKey.current ??= requestKey("business-application");
        await api("/api/native/business/auth/apply", { method: "POST", idempotencyKey: applicationKey.current, body: JSON.stringify({ name, email, password, restaurantName, address, mobile }) });
        if (current()) { setApplicationReceived(true); setPassword(""); } return;
      }
      const body = mode === "register" ? { name, email, password } : { email, password };
      const result = await api<{ user: User; token: string; expiresAt: string }>(`/api/native/auth/${mode}`, { method: "POST", body: JSON.stringify(body) });
      if (current()) await onAuthenticated(result.token, result.user);
    } catch (caught) { if (current()) setError((caught as Error).message); }
    finally { if (request.current === id) { inFlight.current = false; if (mounted.current) setBusy(false); } }
  }

  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      {applicationReceived ? <Card><Text style={styles.cardTitle}>Application received</Text><Text style={styles.sub}>Thank you for applying, {restaurantName}. The Calai team will contact you within 72 hours.</Text><Text style={styles.sub}>Your restaurant stays private while we review your application. An acknowledgement has been queued for {email}.</Text><Button busy={busy} onPress={() => void openLink(`${API_BASE_URL}/business/login`)}>View your pending application</Button><Button disabled={busy} tone="quiet" onPress={() => { setApplicationReceived(false); setMode("login"); setError(""); }}>Back to customer sign in</Button></Card> : mode === "forgot" ? <Card><Text style={styles.cardTitle}>Help signing in</Text><Text style={styles.sub}>Password recovery needs help from Cal-Eats support during this preview. Email support@calai.info with your customer account email. Never include your password.</Text><ErrorBanner message={error}/><Button busy={busy} onPress={() => void openLink("mailto:support@calai.info?subject=Cal-Eats%20customer%20account%20help")}>Contact support</Button><Button disabled={busy} tone="quiet" onPress={() => { setMode("login"); setError(""); }}>Back to sign in</Button></Card> : <Card><Text style={styles.cardTitle}>{mode === "apply" ? "List your restaurant" : mode === "register" ? "Create your customer account" : "Customer sign in"}</Text>
        {mode === "login" ? <Text style={styles.sub}>Sign in to order, save your favourites and follow your deliveries. Your customer account is separate from a business or administrator login.</Text> : null}
        {mode === "register" || mode === "apply" ? <Field label={mode === "apply" ? "Your name" : "Name"} value={name} onChangeText={setName} autoComplete="name" maxLength={100}/> : null}
        {mode === "apply" ? <><Field label="Your business name" value={restaurantName} onChangeText={setRestaurantName} maxLength={150}/><Field label="Full business address" value={address} onChangeText={setAddress} multiline maxLength={500} autoComplete="street-address" hint="Include the street address, town or city and postcode."/><Field label="Your mobile number" value={mobile} onChangeText={setMobile} keyboardType="phone-pad" autoComplete="tel" maxLength={30}/></> : null}
        <Field label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="email" maxLength={254}/>
        <Field label={mode === "apply" ? "Set new password" : "Password"} value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" autoCorrect={false} textContentType={mode === "login" ? "password" : "newPassword"} autoComplete={mode === "login" ? "current-password" : "new-password"} maxLength={128} hint={mode === "apply" || mode === "register" ? "Use at least 12 characters." : undefined}/>
        <ErrorBanner message={error}/>
        <Button busy={busy} onPress={submit}>{mode === "apply" ? "Submit application" : mode === "register" ? "Create account" : "Sign in"}</Button>
        {mode === "apply" ? <Text style={styles.sub}>The Calai team will contact you within 72 hours. Your restaurant stays private until reviewed and approved.</Text> : null}
        {mode === "login" ? <><Button disabled={busy} tone="quiet" onPress={() => { setMode("register"); setError(""); }}>New here? Create an account</Button><Button disabled={busy} tone="quiet" onPress={() => { setMode("forgot"); setError(""); }}>Forgot password</Button><Button disabled={busy} tone="quiet" onPress={() => { applicationKey.current = null; setMode("apply"); setError(""); }}>List your restaurant</Button></> : <Button disabled={busy} tone="quiet" onPress={() => { setMode("login"); setError(""); }}>Back to sign in</Button>}
      </Card>}
      {onContinueBrowsing ? <Button disabled={busy} tone="quiet" onPress={onContinueBrowsing}>Continue browsing</Button> : null}
    </ScrollView>
  </KeyboardAvoidingView>;
}

const styles = StyleSheet.create({ page: { flexGrow: 1, width: "100%", maxWidth: 560, alignSelf: "center", padding: 18, paddingBottom: 32, backgroundColor: colours.cream, gap: 14 }, sub: { color: colours.muted, fontSize: 14, lineHeight: 21 }, cardTitle: { color: colours.ink, fontSize: 25, fontWeight: "800", marginBottom: 4 } });
