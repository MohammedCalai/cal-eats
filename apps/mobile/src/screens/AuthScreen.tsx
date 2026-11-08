import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Linking, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { api, API_BASE_URL } from "../api";
import { requestKey } from "../model";
import { Button, Card, ErrorBanner, Field } from "../components";
import { colours } from "../theme";
import { CustomerLegalDocuments, CustomerLegalReview, useCustomerLegal } from "../CustomerLegalReview";
import type { User } from "../types";

type Mode = "login" | "register" | "apply" | "forgot";
type RecoveryDelivery = "email" | "local_simulation" | "unavailable";
const recoveryMessages: Record<RecoveryDelivery, { title: string; detail: string }> = {
  email: { title: "Check your email", detail: "If an active account matches this email, a password reset link will arrive shortly. Check your inbox and spam folder. Open the link to choose a new password, then return here to sign in." },
  local_simulation: { title: "Development recovery", detail: "Reset instructions are recorded locally in this development environment. They are not sent by email. Contact Cal-Eats support if you need help signing in." },
  unavailable: { title: "Email recovery is unavailable", detail: "We cannot send password reset emails right now. Contact Cal-Eats support for help signing in. Never include your password." }
};
export function AuthScreen({ onAuthenticated, onContinueBrowsing }: { onAuthenticated: (token: string, user: User, context?: { created: boolean }) => Promise<void>; onContinueBrowsing?: () => void }) {
  const [mode, setMode] = useState<Mode>("login");
  const legal = useCustomerLegal(null, mode === "register" || mode === "login");
  const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [restaurantName, setRestaurantName] = useState(""); const [address, setAddress] = useState(""); const [mobile, setMobile] = useState("");
  const [applicationReceived, setApplicationReceived] = useState(false); const applicationKey = useRef<string | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [recoveryDelivery, setRecoveryDelivery] = useState<RecoveryDelivery | null>(null);
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
    if (!mounted.current || inFlight.current) return;
    const id = ++request.current; inFlight.current = true;
    const current = () => mounted.current && request.current === id;
    setBusy(true); setError("");
    try {
      if (mode === "forgot") {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError("Enter a valid email address."); return; }
        const result = await api<{ accepted: boolean; delivery: RecoveryDelivery }>("/api/native/auth/forgot-password", { method: "POST", body: JSON.stringify({ email: email.trim() }) });
        if (current()) setRecoveryDelivery(result.delivery === "email" || result.delivery === "local_simulation" ? result.delivery : "unavailable");
        return;
      }
      if (mode === "apply") {
        applicationKey.current ??= requestKey("business-application");
        await api("/api/native/business/auth/apply", { method: "POST", idempotencyKey: applicationKey.current, body: JSON.stringify({ name, email, password, restaurantName, address, mobile }) });
        if (current()) { setApplicationReceived(true); setPassword(""); } return;
      }
      const body = mode === "register" ? { name, email, password, legalAcceptance: legal.signupPayload() } : { email, password };
      const result = await api<{ user: User; token: string; expiresAt: string }>(`/api/native/auth/${mode}`, { method: "POST", body: JSON.stringify(body) });
      if (current()) await onAuthenticated(result.token, result.user, { created: mode === "register" });
    } catch (caught) { if (current()) setError((caught as Error).message); }
    finally { if (request.current === id) { inFlight.current = false; if (mounted.current) setBusy(false); } }
  }

  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      {!applicationReceived&&mode!=="forgot"?<View style={styles.heading}><Text style={styles.eyebrow}>Your account</Text><Text accessibilityRole="header" style={styles.title}>{mode==="login"?"Sign in to Cal-Eats":mode==="register"?"Create a customer account":"List your restaurant"}</Text></View>:null}
      {applicationReceived ? <Card><Text style={styles.cardTitle}>Application received</Text><Text style={styles.sub}>Thank you for applying, {restaurantName}. The Calai team will contact you within 72 hours.</Text><Text style={styles.sub}>Your restaurant stays private while we review your application. An acknowledgement has been queued for {email}.</Text><Button busy={busy} onPress={() => void openLink(`${API_BASE_URL}/business/login`)}>View your pending application</Button><Button disabled={busy} tone="quiet" onPress={() => { setApplicationReceived(false); setMode("login"); setError(""); }}>Back to customer sign in</Button></Card> : mode === "forgot" ? <Card><Text accessibilityRole="header" style={styles.cardTitle}>{recoveryDelivery ? recoveryMessages[recoveryDelivery].title : "Reset your password"}</Text>{recoveryDelivery ? <Text accessibilityLiveRegion="polite" style={styles.sub}>{recoveryMessages[recoveryDelivery].detail}</Text> : <><Text style={styles.sub}>Enter your account email to request a secure password reset link.</Text><Field editable={!busy} label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="email" maxLength={254}/></>}<ErrorBanner message={error}/>{!recoveryDelivery ? <Button busy={busy} onPress={submit}>Send reset link</Button> : recoveryDelivery !== "email" ? <Button busy={busy} onPress={() => void openLink("mailto:support@calai.info?subject=Cal-Eats%20customer%20account%20help")}>Contact support</Button> : null}<Button disabled={busy} tone="quiet" onPress={() => { setMode("login"); setRecoveryDelivery(null); setPassword(""); setError(""); }}>Back to customer sign in</Button></Card> : <Card><Text style={styles.cardTitle}>{mode === "apply" ? "List your restaurant" : mode === "register" ? "Create your customer account" : "Welcome back"}</Text>
        {mode === "login" ? <Text style={styles.sub}>Sign in to order, save your addresses and follow your orders. Your customer account is separate from a business or administrator login.</Text> : null}
        {mode === "register" || mode === "apply" ? <Field editable={!busy} label={mode === "apply" ? "Your name" : "Name"} value={name} onChangeText={setName} autoComplete="name" maxLength={100}/> : null}
        {mode === "apply" ? <><Field editable={!busy} label="Your business name" value={restaurantName} onChangeText={setRestaurantName} maxLength={150}/><Field editable={!busy} label="Full business address" value={address} onChangeText={setAddress} multiline maxLength={500} autoComplete="street-address" hint="Include the street address, town or city and postcode."/><Field editable={!busy} label="Your mobile number" value={mobile} onChangeText={setMobile} keyboardType="phone-pad" autoComplete="tel" maxLength={30}/></> : null}
        <Field editable={!busy} label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="email" maxLength={254}/>
        <Field editable={!busy} label={mode === "apply" ? "Set new password" : "Password"} value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" autoCorrect={false} textContentType={mode === "login" ? "password" : "newPassword"} autoComplete={mode === "login" ? "current-password" : "new-password"} maxLength={128} hint={mode === "apply" || mode === "register" ? "Use at least 12 characters." : undefined}/>
        <ErrorBanner message={error}/>
        {mode === "register" ? <CustomerLegalReview review={legal}/> : mode === "login" ? <CustomerLegalDocuments review={legal}/> : null}
        {mode === "register" ? <Text style={styles.sub}>We’ll send a welcome email with a secure link to verify your email address before your first order. You can keep browsing while you verify.</Text> : null}
        <Button busy={busy} disabled={mode === "register" && !legal.ready} onPress={submit}>{mode === "apply" ? "Submit application" : mode === "register" ? "Create account" : "Sign in"}</Button>
        {mode === "apply" ? <Text style={styles.sub}>The Calai team will contact you within 72 hours. Your restaurant stays private until reviewed and approved.</Text> : null}
        {mode === "login" ? <><Button disabled={busy} tone="quiet" onPress={() => { setMode("register"); setError(""); }}>New here? Create an account</Button><Button disabled={busy} tone="quiet" onPress={() => { setMode("forgot"); setRecoveryDelivery(null); setError(""); }}>Forgot password</Button><Button disabled={busy} tone="quiet" onPress={() => { applicationKey.current = null; setMode("apply"); setError(""); }}>List your restaurant</Button></> : <Button disabled={busy} tone="quiet" onPress={() => { setMode("login"); setError(""); }}>Back to sign in</Button>}
      </Card>}
      {onContinueBrowsing ? <Button disabled={busy} tone="quiet" onPress={onContinueBrowsing}>Continue browsing</Button> : null}
    </ScrollView>
  </KeyboardAvoidingView>;
}

const styles = StyleSheet.create({ heading: { gap: 6, paddingVertical: 8 }, eyebrow: { color: colours.blueDark, textTransform: "uppercase", fontSize: 11, fontWeight: "800", letterSpacing: 1.1 }, title: { color: colours.ink, fontSize: 28, lineHeight: 35, letterSpacing: -.7, fontWeight: "800" }, page: { flexGrow: 1, width: "100%", maxWidth: 560, alignSelf: "center", padding: 18, paddingBottom: 32, backgroundColor: colours.cream, gap: 14 }, sub: { color: colours.muted, fontSize: 14, lineHeight: 21 }, cardTitle: { color: colours.ink, fontSize: 21, lineHeight: 28, fontWeight: "800", marginBottom: 4 } });
