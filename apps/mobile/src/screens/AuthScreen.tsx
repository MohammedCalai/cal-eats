import { useRef, useState } from "react";
import { KeyboardAvoidingView, Linking, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { api, API_BASE_URL } from "../api";
import { requestKey } from "../model";
import { Brand, Button, Card, ErrorBanner, Field } from "../components";
import { colours } from "../theme";
import type { User } from "../types";

type Mode = "login" | "register" | "apply" | "forgot" | "reset";
export function AuthScreen({ onAuthenticated }: { onAuthenticated: (token: string, user: User) => Promise<void> }) {
  const [mode, setMode] = useState<Mode>("login");
  const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [resetToken, setResetToken] = useState("");
  const [restaurantName, setRestaurantName] = useState(""); const [address, setAddress] = useState(""); const [mobile, setMobile] = useState("");
  const [applicationReceived, setApplicationReceived] = useState(false); const applicationKey = useRef<string | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");

  async function submit() {
    setBusy(true); setError(""); setNotice("");
    try {
      if (mode === "apply") {
        applicationKey.current ??= requestKey("business-application");
        await api("/api/native/business/auth/apply", { method: "POST", idempotencyKey: applicationKey.current, body: JSON.stringify({ name, email, password, restaurantName, address, mobile }) });
        setApplicationReceived(true); setPassword(""); return;
      }
      if (mode === "forgot") {
        await api<{ accepted: true; delivery: string }>("/api/native/auth/forgot-password", { method: "POST", body: JSON.stringify({ email }) });
        setNotice("If the account exists, a reset token was written to the local development mail sink. No email delivery is claimed."); setMode("reset"); return;
      }
      if (mode === "reset") {
        await api("/api/native/auth/reset-password", { method: "POST", body: JSON.stringify({ token: resetToken, password }) });
        setNotice("Password reset. All existing sessions were revoked; sign in again."); setPassword(""); setMode("login"); return;
      }
      const body = mode === "register" ? { name, email, password } : { email, password };
      const result = await api<{ user: User; token: string; expiresAt: string }>(`/api/native/auth/${mode}`, { method: "POST", body: JSON.stringify(body) });
      await onAuthenticated(result.token, result.user);
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }

  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <Brand/><View style={styles.hero}><Text style={styles.kicker}>Local food, made easy</Text><Text style={styles.headline}>Order from independent restaurants near you.</Text><Text style={styles.sub}>This development app talks only to the Cal-Eats API address configured on your device.</Text></View>
      {applicationReceived ? <Card><Text style={styles.cardTitle}>Application received</Text><Text style={styles.sub}>Thank you for applying, {restaurantName}. The Calai team will contact you within 72 hours.</Text><Text style={styles.sub}>Your restaurant stays private while we review your application. An acknowledgement has been queued for {email}.</Text><Button onPress={() => void Linking.openURL(`${API_BASE_URL}/business/login`)}>View your pending application</Button><Button tone="quiet" onPress={() => { setApplicationReceived(false); setMode("login"); setError(""); }}>Back to customer sign in</Button></Card> : <Card><Text style={styles.cardTitle}>{mode === "apply" ? "List your restaurant" : mode === "register" ? "Create your account" : mode === "forgot" ? "Recover your account" : mode === "reset" ? "Set a new password" : "Welcome back"}</Text>
        {mode === "register" || mode === "apply" ? <Field label={mode === "apply" ? "Your name" : "Name"} value={name} onChangeText={setName} autoComplete="name" maxLength={100}/> : null}
        {mode === "apply" ? <><Field label="Your business name" value={restaurantName} onChangeText={setRestaurantName} maxLength={150}/><Field label="Full business address" value={address} onChangeText={setAddress} multiline maxLength={500} autoComplete="street-address" hint="Include the street address, town or city and postcode."/><Field label="Your mobile number" value={mobile} onChangeText={setMobile} keyboardType="phone-pad" autoComplete="tel" maxLength={30}/></> : null}
        {mode !== "reset" ? <Field label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="email" maxLength={254}/> : null}
        {mode === "reset" ? <Field label="Reset token" value={resetToken} onChangeText={setResetToken} autoCapitalize="none" autoCorrect={false} hint="Copy this from the local development mail sink."/> : null}
        {mode !== "forgot" ? <Field label={mode === "apply" ? "Set new password" : mode === "reset" ? "New password" : "Password"} value={password} onChangeText={setPassword} secureTextEntry autoComplete={mode === "login" ? "current-password" : "new-password"} maxLength={128} hint={mode === "apply" ? "Use at least 12 characters." : undefined}/> : null}
        <ErrorBanner message={error}/>{notice ? <Text style={styles.notice}>{notice}</Text> : null}
        <Button busy={busy} onPress={submit}>{mode === "apply" ? "Submit application" : mode === "register" ? "Create account" : mode === "forgot" ? "Request reset" : mode === "reset" ? "Reset password" : "Sign in"}</Button>
        {mode === "apply" ? <Text style={styles.sub}>The Calai team will contact you within 72 hours. Your restaurant stays private until reviewed and approved.</Text> : null}
        {mode === "login" ? <><Button tone="quiet" onPress={() => setMode("register")}>New here? Create an account</Button><Button tone="quiet" onPress={() => setMode("forgot")}>Forgot password</Button><Button tone="quiet" onPress={() => { applicationKey.current = null; setMode("apply"); setError(""); setNotice(""); }}>List your restaurant</Button></> : <Button tone="quiet" onPress={() => { setMode("login"); setError(""); setNotice(""); }}>Back to sign in</Button>}
      </Card>}
      <Text style={styles.legal}>By continuing, you can review the development Terms and Privacy notice after signing in. Mock card payments do not charge money.</Text>
    </ScrollView>
  </KeyboardAvoidingView>;
}

const styles = StyleSheet.create({ page: { flexGrow: 1, padding: 22, paddingTop: 62, paddingBottom: 40, backgroundColor: colours.cream, gap: 28 }, hero: { gap: 10 }, kicker: { color: colours.blue, fontWeight: "800", textTransform: "uppercase", letterSpacing: 1.2 }, headline: { color: colours.ink, fontWeight: "900", fontSize: 36, lineHeight: 40, letterSpacing: -1.2 }, sub: { color: colours.muted, fontSize: 16, lineHeight: 24 }, cardTitle: { color: colours.ink, fontSize: 22, fontWeight: "800", marginBottom: 4 }, notice: { color: colours.success, lineHeight: 20 }, legal: { color: colours.muted, textAlign: "center", fontSize: 12, lineHeight: 18 } });
