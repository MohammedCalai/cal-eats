import { useCallback, useEffect, useRef, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { api, API_BASE_URL } from "./api";
import { Button, ErrorBanner } from "./components";
import { colours } from "./theme";
import { customerLegalPayload, customerLegalReady, inactiveCustomerLegal, type CustomerLegalStatus } from "./customer-legal";

export function useCustomerLegal(token: string | null, active = true) {
  const [status, setStatus] = useState<CustomerLegalStatus | null>(null), [error, setError] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [resolvedScope, setResolvedScope] = useState<string | null>(null);
  const scopeKey = active ? token || "guest" : "inactive";
  const identity = useRef({ token, active }); identity.current = { token, active };
  const revision = useRef(0), mounted = useRef(false);
  const refresh = useCallback(async () => {
    const request = ++revision.current;
    setStatus(null); setError(""); setTermsAccepted(false);
    try {
      const next = active ? await api<CustomerLegalStatus>("/api/customer/legal", { token }) : inactiveCustomerLegal;
      if (mounted.current && request === revision.current && identity.current.token === token && identity.current.active === active) { setStatus(next); setResolvedScope(active ? token || "guest" : "inactive"); }
    } catch (caught) { if (mounted.current && request === revision.current && identity.current.token === token && identity.current.active === active) setError((caught as Error).message); }
  }, [token, active]);
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; revision.current++; }; }, [refresh]);
  const currentStatus = resolvedScope === scopeKey ? status : null;
  const choices = { termsAccepted };
  async function acceptForNewOrder() {
    const body = customerLegalPayload(currentStatus, choices);
    if (!body || !currentStatus?.termsAcceptanceRequired && !currentStatus?.privacyAcknowledgementRequired) return;
    const request = revision.current;
    const current = () => mounted.current && request === revision.current && identity.current.token === token && identity.current.active === active;
    try {
      const next = await api<CustomerLegalStatus>("/api/customer/legal/acceptances", { method: "POST", token, body: JSON.stringify(body) });
      if (!current()) throw Error("Your account changed. Return to the current checkout before continuing.");
      setStatus(next);
    } catch (caught) { if (current()) await refresh(); throw caught; }
  }
  async function open(url: string) {
    try {
      const target = new URL(url), base = new URL(API_BASE_URL);
      if (target.origin !== base.origin || target.username || target.password || target.search || target.hash || !target.pathname.startsWith("/legal/")) throw Error("Document link is unavailable.");
      await Linking.openURL(target.href);
    } catch { setError("This document could not be opened. Please try again before continuing."); }
  }
  return { status: currentStatus, error, termsAccepted, setTermsAccepted, refresh, open, acceptForNewOrder, ready: !active || customerLegalReady(currentStatus, choices), signupPayload: () => customerLegalPayload(currentStatus, choices) };
}

export function CustomerLegalReview({ review }: { review: ReturnType<typeof useCustomerLegal> }) {
  const { status } = review;
  if (status && !status.enabled) return null;
  if (!status) return <View style={styles.box}>{review.error ? <><ErrorBanner message={review.error}/><Button tone="quiet" onPress={() => void review.refresh()}>Reload account information</Button></> : <Text style={styles.note}>Checking account information…</Text>}</View>;
  if (!status.termsAcceptanceRequired && !status.privacyAcknowledgementRequired) return null;
  return <View style={styles.box}>
    <Text style={styles.title}>Before you continue</Text>
    {status.terms ? <Button tone="quiet" onPress={() => void review.open(status.terms!.url)}>Read Customer Terms</Button> : null}
    {status.privacy ? <Button tone="quiet" onPress={() => void review.open(status.privacy!.url)}>Read Privacy Notice</Button> : null}
    {status.termsAcceptanceRequired ? <LegalCheckbox checked={review.termsAccepted} onChange={review.setTermsAccepted} label="I accept the Customer Terms."/> : null}
    {status.privacyAcknowledgementRequired ? <Text style={styles.note}>The Privacy Notice explains how your information is used. Continuing records that this notice was provided; it is not general consent to processing.</Text> : null}
    <Text style={styles.note}>Offers and marketing preferences are a separate choice in your account.</Text>
    <ErrorBanner message={review.error}/>
  </View>;
}

// Read-only access never asks an existing user to accept terms to view their
// account, sign in, contact support or exercise privacy rights.
export function CustomerLegalDocuments({ review }: { review: ReturnType<typeof useCustomerLegal> }) {
  const { status } = review;
  if (!status) return <View style={styles.box}>{review.error ? <><ErrorBanner message={review.error}/><Button tone="quiet" onPress={() => void review.refresh()}>Reload legal documents</Button></> : <Text style={styles.note}>Loading legal documents…</Text>}</View>;
  if (!status.enabled) return null;
  if (!status.terms || !status.privacy) return <ErrorBanner message="The current legal documents could not be loaded. Please try again."/>;
  return <View style={styles.box}>
    <Text style={styles.title}>Customer documents</Text>
    <Button tone="quiet" onPress={() => void review.open(status.terms!.url)}>Read Customer Terms</Button>
    <Text style={styles.note}>Terms version: {status.terms.version}</Text>
    <Button tone="quiet" onPress={() => void review.open(status.privacy!.url)}>Read Privacy Notice</Button>
    <Text style={styles.note}>Privacy version: {status.privacy.version}</Text>
    <ErrorBanner message={review.error}/>
  </View>;
}

function LegalCheckbox({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return <Pressable accessibilityRole="checkbox" accessibilityState={{ checked }} accessibilityLabel={label} onPress={() => onChange(!checked)} style={styles.checkRow}><View style={[styles.check, checked && styles.selected]}><Text style={styles.tick}>{checked ? "✓" : ""}</Text></View><Text style={styles.label}>{label}</Text></Pressable>;
}
const styles = StyleSheet.create({ box: { gap: 10, marginVertical: 10 }, title: { fontWeight: "800", color: colours.ink, fontSize: 17 }, note: { color: colours.muted, lineHeight: 20, fontSize: 13 }, checkRow: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 48 }, check: { width: 25, height: 25, borderWidth: 1.5, borderColor: colours.blue, borderRadius: 6, justifyContent: "center", alignItems: "center" }, selected: { backgroundColor: colours.blue }, tick: { color: "#fff", fontWeight: "800" }, label: { color: colours.ink, fontSize: 14, lineHeight: 21, flex: 1 } });
