import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { api } from "./api";
import { Button, Card, ErrorBanner, Pill } from "./components";
import { money } from "./model";
import { offerBenefit } from "./offerPresentation";
import { colours } from "./theme";
import type { Offer } from "./types";

type Promotion = Omit<Offer, "restaurantName" | "status">;
type Grant = { id: string; campaignId: string; restaurantId: string; status: string };
type Props = { token: string; restaurantId: string; restaurantName: string; onClaim: (offer: Offer) => void };

export function FirstOrderPromotions(props: Props) {
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [loadedKey, setLoadedKey] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [claimed, setClaimed] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const latest = useRef(props), mounted = useRef(false), pending = useRef<string | null>(null);
  latest.current = props;
  const key = JSON.stringify([props.token, props.restaurantId]);
  const scope = useRef({ key, revision: 0 });
  if (scope.current.key !== key) scope.current = { key, revision: scope.current.revision + 1 };

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    const revision = scope.current.revision;
    setPromotions([]); setLoadedKey(""); setClaimed([]); setErrors({}); setBusyId(null); pending.current = null;
    if (props.token) void api<Promotion[]>(`/api/promotions?restaurantId=${encodeURIComponent(props.restaurantId)}`, { token: props.token })
      .then(rows => { if (active && scope.current.revision === revision) { setPromotions(Array.isArray(rows) ? rows.filter(row => row.restaurantId === props.restaurantId) : []); setLoadedKey(key); } })
      .catch(() => { /* Menus remain usable when no promotion can be loaded. */ });
    return () => { active = false; };
  }, [key]);

  async function claim(promotion: Promotion) {
    if (!props.token || loadedKey !== key || promotion.restaurantId !== props.restaurantId || pending.current || claimed.includes(promotion.id)) return;
    const revision = scope.current.revision, token = props.token, restaurantId = props.restaurantId;
    const current = () => mounted.current && scope.current.revision === revision;
    pending.current = promotion.id; setBusyId(promotion.id);
    setErrors(previous => ({ ...previous, [promotion.id]: "" }));
    try {
      const grant = await api<Grant>(`/api/promotions/${encodeURIComponent(promotion.id)}/claim`, { method: "POST", token, body: "{}" });
      if (!current()) return;
      if (!grant.id || grant.campaignId !== promotion.id || grant.restaurantId !== restaurantId) throw new Error("We couldn’t add this offer. Please try again.");
      setClaimed(previous => [...previous, promotion.id]);
      latest.current.onClaim({ ...promotion, ...grant, restaurantName: latest.current.restaurantName });
    } catch (error) {
      if (current()) setErrors(previous => ({ ...previous, [promotion.id]: (error as Error).message }));
    } finally {
      if (current()) { pending.current = null; setBusyId(null); }
    }
  }

  if (!props.token || loadedKey !== key || !promotions.length) return null;
  return <View style={styles.section}><Card><Text accessibilityRole="header" style={styles.heading}>First-order offers</Text>{promotions.map((promotion, index) => {
    const added = claimed.includes(promotion.id), offer = { ...promotion, restaurantName: props.restaurantName, status: "available" };
    return <View key={promotion.id} style={[styles.promotion, index > 0 && styles.divider]}><Text style={styles.title}>{promotion.title}</Text><Text style={styles.message}>{promotion.message}</Text><View style={styles.conditions}><Pill>{offerBenefit(offer)}</Pill><Text style={styles.minimum}>{money(promotion.minSubtotalMinor)} minimum</Text></View><Button tone="secondary" busy={busyId === promotion.id} disabled={added || Boolean(busyId)} onPress={() => void claim(promotion)}>{added ? "Added to my offers" : "Add to my offers"}</Button>{added ? <Text accessibilityLiveRegion="polite" style={styles.minimum}>Offer added. Eligible offers apply automatically at checkout.</Text> : null}<ErrorBanner message={errors[promotion.id]}/></View>;
  })}</Card></View>;
}

const styles = StyleSheet.create({
  section: { paddingHorizontal: 16, paddingTop: 24 },
  heading: { color: colours.ink, fontSize: 22, lineHeight: 29, fontWeight: "800" },
  promotion: { gap: 10, paddingTop: 4 },
  divider: { marginTop: 6, paddingTop: 16, borderTopWidth: 1, borderTopColor: colours.line },
  title: { color: colours.ink, fontSize: 17, lineHeight: 24, fontWeight: "700" },
  message: { color: colours.muted, fontSize: 14, lineHeight: 22 },
  conditions: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
  minimum: { color: colours.muted, fontSize: 12, lineHeight: 18 }
});
