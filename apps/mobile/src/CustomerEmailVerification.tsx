import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Linking, StyleSheet, Text, View } from "react-native";
import { ApiError, api } from "./api";
import { Button, Card, ErrorBanner, Pill } from "./components";
import { CustomerIcon } from "./CustomerBrandBanner";
import { colours } from "./theme";
import { parseCustomerEmailVerification, verificationCooldownSeconds, type CustomerEmailVerificationStatus } from "./customer-email-verification";

export function useCustomerEmailVerification(token: string | null) {
  const [record, setRecord] = useState<{ token: string; status: CustomerEmailVerificationStatus } | null>(null);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false), [resending, setResending] = useState(false), [clock, setClock] = useState(Date.now());
  const identity = useRef(token); identity.current = token;
  const revision = useRef(0), mounted = useRef(false), resendInFlight = useRef(false);
  const refresh = useCallback(async () => {
    if (!token || identity.current !== token) return null;
    const own = ++revision.current, current = () => mounted.current && identity.current === token && revision.current === own;
    setLoading(true); setError("");
    try {
      const status = parseCustomerEmailVerification(await api("/api/native/auth/email-verification/status", { token }));
      if (!current()) return null;
      setRecord({ token, status }); setClock(Date.now());
      if (status.emailVerified) setNotice("Your email is verified. You’re ready to order.");
      return status;
    } catch (caught) {
      if (current()) setError((caught as Error).message);
      return null;
    } finally { if (current()) setLoading(false); }
  }, [token]);
  useEffect(() => {
    mounted.current = true; setRecord(null); setError(""); setNotice(""); setResending(false); resendInFlight.current = false;
    if (token) void refresh(); else setLoading(false);
    const subscription = AppState.addEventListener("change", state => { if (state === "active" && identity.current === token && token && !resendInFlight.current) void refresh(); });
    return () => { mounted.current = false; revision.current++; subscription.remove(); };
  }, [token, refresh]);
  const status = record?.token === token ? record.status : null;
  useEffect(() => {
    if (!status?.resendAvailableAt || status.emailVerified) return;
    const deadline=Date.parse(status.resendAvailableAt),start=Date.now();setClock(start);
    if(deadline<=start)return;
    const timer = setInterval(() => {const current=Date.now();setClock(current);if(current>=deadline)clearInterval(timer);}, 1000);
    return () => clearInterval(timer);
  }, [status?.resendAvailableAt, status?.emailVerified]);
  async function resend() {
    if (!token || !status || status.emailVerified || resendInFlight.current || verificationCooldownSeconds(status) > 0) return;
    const ownToken = token, own = ++revision.current, current = () => mounted.current && identity.current === ownToken && revision.current === own;
    resendInFlight.current = true; setResending(true); setLoading(false); setError(""); setNotice("");
    try {
      const response = await api<Partial<CustomerEmailVerificationStatus> & { accepted: boolean; resent: boolean }>("/api/native/auth/email-verification/send", { method: "POST", token, body: "{}" });
      const next = parseCustomerEmailVerification({ ...status, ...response });
      if (!current()) return;
      setRecord({ token: ownToken, status: next }); setClock(Date.now());
      setNotice(next.emailVerified ? "Your email is verified. You’re ready to order." : next.delivery === "unavailable" ? "Verification email is unavailable. Please contact Cal-Eats support." : !response.resent ? "A verification email was requested recently. Please use the newest email or wait before requesting another." : next.delivery === "email" ? "A new verification email is on its way. Use its link within 24 hours; earlier links have been replaced." : "Verification is recorded locally in this development environment; no email was sent.");
    } catch (caught) { if (current()) setError((caught as Error).message); }
    finally { if (identity.current === ownToken) { resendInFlight.current = false; if (mounted.current) setResending(false); } }
  }
  async function requireForNewOrder() {
    const next = await refresh();
    if (!next) throw Error("Your email-verification status could not be checked. Refresh it before placing your order.");
    if (!next.canOrder) throw new ApiError("Verify your email using the newest welcome email before placing your first order. You can continue browsing and contact support meanwhile.", 428, "EMAIL_VERIFICATION_REQUIRED");
  }
  return { status, error, notice, loading, resending, refresh, resend, requireForNewOrder, canOrder: status?.canOrder === true, cooldownSeconds: verificationCooldownSeconds(status, clock) };
}

export type CustomerEmailVerificationReview = ReturnType<typeof useCustomerEmailVerification>;
export function CustomerEmailVerification({ review, context = "account" }: { review: CustomerEmailVerificationReview; context?: "account" | "checkout" | "welcome" }) {
  const { status } = review;
  if (context === "checkout" && status?.canOrder) return null;
  if (status?.emailVerified) return context === "checkout" ? null : <Card tone="info"><View style={styles.heading}><CustomerIcon name="shield" size={23}/><Text style={styles.title}>Email verified</Text><Pill tone="green">Confirmed</Pill></View><Text style={styles.copy}>{status.email}</Text></Card>;
  return <Card tone="info"><View style={styles.heading}><CustomerIcon name="shield" size={25}/><Text accessibilityRole="header" style={styles.title}>{context === "welcome" ? "Welcome to Cal-Eats" : "Verify your email"}</Text></View>
    {status ? <><Text style={styles.email}>{status.email}</Text><Text style={styles.copy}>{status.verificationRequired ? "Open the welcome email and confirm your email address before placing your first order. Your account is ready to browse, save addresses and contact support." : "Your existing account can continue ordering. You can also verify your email to help keep your account secure."}</Text><Text style={styles.copy}>{status.delivery === "email" ? "Check your inbox and spam folder. The newest link expires after 24 hours and can be used once. Return here after confirming; we’ll update your status automatically." : status.delivery === "local_simulation" ? "This development environment records verification locally and does not send an email." : "Email delivery is currently unavailable. You can still use support and manage your account."}</Text></> : <Text style={styles.copy}>Checking your email-verification status…</Text>}
    <ErrorBanner message={review.error}/>{review.notice ? <Text accessibilityLiveRegion="polite" style={styles.copy}>{review.notice}</Text> : null}
    <Button tone="secondary" busy={review.loading} disabled={review.resending} onPress={() => void review.refresh()}>I’ve verified my email · Refresh</Button>
    {status && status.delivery !== "unavailable" ? <Button tone="quiet" busy={review.resending} disabled={review.loading || review.cooldownSeconds > 0} onPress={() => void review.resend()}>{review.cooldownSeconds ? `Resend available in ${review.cooldownSeconds}s` : "Resend verification email"}</Button> : null}
    {status?.delivery === "unavailable" ? <Button tone="quiet" onPress={() => void Linking.openURL("mailto:support@calai.info?subject=Cal-Eats%20email%20verification%20help").catch(() => undefined)}>Contact support</Button> : null}
  </Card>;
}
const styles = StyleSheet.create({ heading: { flexDirection: "row", alignItems: "center", gap: 10 }, title: { flex: 1, color: colours.ink, fontSize: 18, lineHeight: 25, fontWeight: "800" }, email: { color: colours.blueDark, fontWeight: "700", fontSize: 15, lineHeight: 22 }, copy: { color: colours.muted, fontSize: 13, lineHeight: 20 } });
