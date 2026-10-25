import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { api } from "../api";
import { Brand, Button, Card, ErrorBanner, Field } from "../components";
import { colours } from "../theme";
import type { User } from "../types";

type Mode = "login" | "register" | "forgot" | "reset";
export function AuthScreen({ onAuthenticated }: { onAuthenticated: (token: string, user: User) => Promise<void> }) {
  const [mode, setMode] = useState<Mode>("login");
  const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [resetToken, setResetToken] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");

  async function submit() {
    setBusy(true); setError(""); setNotice("");
    try {
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
      <Card><Text style={styles.cardTitle}>{mode === "register" ? "Create your account" : mode === "forgot" ? "Recover your account" : mode === "reset" ? "Set a new password" : "Welcome back"}</Text>
        {mode === "register" ? <Field label="Name" value={name} onChangeText={setName} autoComplete="name" maxLength={100}/> : null}
        {mode !== "reset" ? <Field label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="email" maxLength={254}/> : null}
        {mode === "reset" ? <Field label="Reset token" value={resetToken} onChangeText={setResetToken} autoCapitalize="none" autoCorrect={false} hint="Copy this from the local development mail sink."/> : null}
        {mode !== "forgot" ? <Field label={mode === "reset" ? "New password" : "Password"} value={password} onChangeText={setPassword} secureTextEntry autoComplete={mode === "login" ? "current-password" : "new-password"} maxLength={128}/> : null}
        <ErrorBanner message={error}/>{notice ? <Text style={styles.notice}>{notice}</Text> : null}
        <Button busy={busy} onPress={submit}>{mode === "register" ? "Create account" : mode === "forgot" ? "Request reset" : mode === "reset" ? "Reset password" : "Sign in"}</Button>
        {mode === "login" ? <><Button tone="quiet" onPress={() => setMode("register")}>New here? Create an account</Button><Button tone="quiet" onPress={() => setMode("forgot")}>Forgot password</Button></> : <Button tone="quiet" onPress={() => { setMode("login"); setError(""); setNotice(""); }}>Back to sign in</Button>}
      </Card>
      <Text style={styles.legal}>By continuing, you can review the development Terms and Privacy notice after signing in. Mock card payments do not charge money.</Text>
    </ScrollView>
  </KeyboardAvoidingView>;
}

const styles = StyleSheet.create({ page: { flexGrow: 1, padding: 22, paddingTop: 62, paddingBottom: 40, backgroundColor: colours.cream, gap: 28 }, hero: { gap: 10 }, kicker: { color: colours.blue, fontWeight: "800", textTransform: "uppercase", letterSpacing: 1.2 }, headline: { color: colours.ink, fontWeight: "900", fontSize: 36, lineHeight: 40, letterSpacing: -1.2 }, sub: { color: colours.muted, fontSize: 16, lineHeight: 24 }, cardTitle: { color: colours.ink, fontSize: 22, fontWeight: "800", marginBottom: 4 }, notice: { color: colours.success, lineHeight: 20 }, legal: { color: colours.muted, textAlign: "center", fontSize: 12, lineHeight: 18 } });
