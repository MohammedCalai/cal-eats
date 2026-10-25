import { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { api } from "../api";
import { Button, Card, ErrorBanner, Field, Pill, SectionTitle } from "../components";
import { canCheckout, cartTotals, entryUnitMinor, money, orderItems, requestKey } from "../model";
import { checkoutPayment, paymentChoices } from "../payments";
import { colours } from "../theme";
import type { Address, CartEntry, Fulfillment, Offer, Order, PaymentMethod, Restaurant } from "../types";

export function CheckoutScreen({ token, restaurant, cart, fulfillment, onBack, onOrdered }: { token: string; restaurant: Restaurant; cart: CartEntry[]; fulfillment: Fulfillment; onBack: () => void; onOrdered: (order: Order) => void }) {
  const [addresses, setAddresses] = useState<Address[]>([]); const [offers, setOffers] = useState<Offer[]>([]); const [selectedOffer, setSelectedOffer] = useState<string | undefined>();
  const [address, setAddress] = useState<Address>({ label: "Home", line1: "", line2: "", city: "", postcode: "" }); const [saveAddress, setSaveAddress] = useState(false);
  const [phone, setPhone] = useState(""); const [instructions, setInstructions] = useState(""); const [allergyNotes, setAllergyNotes] = useState(""); const [payment, setPayment] = useState<PaymentMethod>("mock_card");
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [key, setKey] = useState(() => requestKey("ios-order"));
  const totals = useMemo(() => cartTotals(cart, fulfillment, restaurant), [cart, fulfillment, restaurant]);
  const localCheck = canCheckout(cart, fulfillment, restaurant, address.postcode);

  useEffect(() => { void Promise.all([
    api<Address[]>("/api/account/addresses", { token }).then(setAddresses),
    api<Offer[]>(`/api/offers?restaurantId=${encodeURIComponent(restaurant.id)}`, { token }).then((rows) => setOffers(rows.filter((offer) => offer.status === "available")))
  ]).catch((caught) => setError((caught as Error).message)); }, [restaurant.id, token]);

  function chooseAddress(value: Address) { setAddress({ ...value }); }
  async function placeOrder() {
    if (!localCheck.ok) return setError(localCheck.reason);
    setBusy(true); setError("");
    try {
      const body = {
        restaurantId: restaurant.id,
        items: orderItems(cart),
        paymentMethod: checkoutPayment(payment),
        fulfillment,
        ...(fulfillment === "delivery" ? { deliveryAddress: { line1: address.line1, ...(address.line2 ? { line2: address.line2 } : {}), city: address.city, postcode: address.postcode } } : {}),
        ...(phone.trim() ? { customerPhone: phone.trim() } : {}),
        ...(fulfillment === "delivery" && instructions.trim() ? { deliveryInstructions: instructions.trim() } : {}),
        ...(allergyNotes.trim() ? { allergyNotes: allergyNotes.trim() } : {}),
        ...(selectedOffer ? { offerId: selectedOffer } : {})
      };
      const order = await api<Order>("/api/orders", { method: "POST", token, idempotencyKey: key, body: JSON.stringify(body) });
      if (saveAddress && fulfillment === "delivery" && !address.id) {
        try { await api<Address>("/api/account/addresses", { method: "POST", token, body: JSON.stringify(address) }); }
        catch { Alert.alert("Order placed", "The order was placed, but this address could not be saved. You can add it later under Account."); }
      }
      onOrdered(order);
    } catch (caught) {
      const message = (caught as Error).message; setError(`${message} You can retry safely; the same checkout key will be reused.`);
    } finally { setBusy(false); }
  }

  return <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
    <Button tone="quiet" onPress={onBack}>← Back to menu</Button><SectionTitle eyebrow="Checkout" title="Review your order"/>
    <Card>{cart.map((entry) => <View key={entry.item.id} style={styles.line}><View style={{ flex: 1 }}><Text style={styles.lineName}>{entry.quantity} × {entry.item.name}</Text><Text style={styles.meta}>{entry.item.modifierGroups.flatMap((group) => group.options.filter((option) => entry.selections[group.id]?.includes(option.id)).map((option) => option.name)).join(", ") || "No extras"}</Text></View><Text style={styles.price}>{money(entryUnitMinor(entry) * entry.quantity)}</Text></View>)}<View style={styles.rule}/><Price label="Food" value={totals.subtotalMinor}/><Price label="Delivery" value={totals.deliveryFeeMinor}/><Price label="Estimated total" value={totals.totalMinor} strong/><Text style={styles.meta}>The server revalidates availability, prices, delivery area, minimum and offer at order time.</Text></Card>
    {fulfillment === "delivery" ? <Card><Text style={styles.cardTitle}>Delivery address</Text>{addresses.length ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>{addresses.map((saved) => <Pressable key={saved.id} onPress={() => chooseAddress(saved)} style={[styles.addressChip, address.id === saved.id && styles.addressActive]}><Text style={styles.addressLabel}>{saved.label}</Text><Text style={styles.meta}>{saved.postcode}</Text></Pressable>)}</ScrollView> : null}
      <Field label="Label" value={address.label} onChangeText={(label) => setAddress({ ...address, label })} maxLength={50}/><Field label="Address line 1" value={address.line1} onChangeText={(line1) => setAddress({ ...address, line1 })} autoComplete="street-address" maxLength={150}/><Field label="Address line 2 (optional)" value={address.line2} onChangeText={(line2) => setAddress({ ...address, line2 })} maxLength={150}/><Field label="Town or city" value={address.city} onChangeText={(city) => setAddress({ ...address, city })} maxLength={100}/><Field label="Postcode" value={address.postcode} onChangeText={(postcode) => setAddress({ ...address, postcode })} autoCapitalize="characters" autoComplete="postal-code" maxLength={12}/>
      {!address.id ? <View style={styles.switchRow}><Text style={styles.switchLabel}>Save this address</Text><Switch value={saveAddress} onValueChange={setSaveAddress} trackColor={{ true: colours.blue }}/></View> : null}<Field label="Delivery instructions (optional)" value={instructions} onChangeText={setInstructions} multiline maxLength={500}/></Card> : <Card tone="info"><Text style={styles.cardTitle}>Collection</Text><Text style={styles.meta}>The order status will show when it is ready. Bring the order reference.</Text></Card>}
    <Card><Text style={styles.cardTitle}>Contact and allergy notes</Text><Field label="Phone (optional)" value={phone} onChangeText={setPhone} keyboardType="phone-pad" autoComplete="tel" maxLength={30}/><Field label="Allergy notes (optional)" value={allergyNotes} onChangeText={setAllergyNotes} multiline maxLength={500} hint="This does not replace speaking to the restaurant about severe allergies."/></Card>
    {offers.length ? <Card><Text style={styles.cardTitle}>Offers</Text><Pressable onPress={() => setSelectedOffer(undefined)} style={[styles.offer, !selectedOffer && styles.offerActive]}><Text style={styles.lineName}>No offer</Text></Pressable>{offers.map((offer) => <Pressable key={offer.id} onPress={() => setSelectedOffer(offer.id)} style={[styles.offer, selectedOffer === offer.id && styles.offerActive]}><View style={{ flex: 1 }}><Text style={styles.lineName}>{offer.title}</Text><Text style={styles.meta}>{offer.message}</Text><Text style={styles.meta}>Free {offer.itemName} with {money(offer.minSubtotalMinor)} food minimum · expires {new Date(offer.expiresAt).toLocaleDateString("en-GB")}</Text></View></Pressable>)}</Card> : null}
    <Card><Text style={styles.cardTitle}>Payment</Text>{paymentChoices(restaurant.profile.cashEnabled).map((choice) => <Pressable accessibilityRole="radio" accessibilityState={{ checked: payment === choice.id, disabled: !choice.available }} key={choice.id} disabled={!choice.available} onPress={() => choice.id !== "apple_pay" && setPayment(choice.id)} style={[styles.payment, payment === choice.id && styles.paymentActive, !choice.available && styles.disabled]}><View style={{ flex: 1 }}><Text style={styles.lineName}>{choice.label}</Text><Text style={styles.meta}>{choice.description}</Text></View>{payment === choice.id ? <Pill>Selected</Pill> : null}</Pressable>)}</Card>
    <ErrorBanner message={error || (!localCheck.ok ? localCheck.reason : "")}/><Button busy={busy} disabled={!localCheck.ok} onPress={() => void placeOrder()}>Place order · {money(totals.totalMinor)}</Button><Text style={styles.meta}>Mock card is deterministic local simulation. Cash is paid directly to the restaurant. No live payment provider is connected.</Text>
  </ScrollView>;
}
function Price({ label, value, strong }: { label: string; value: number; strong?: boolean }) { return <View style={styles.line}><Text style={[styles.meta, strong && styles.lineName]}>{label}</Text><Text style={[styles.price, strong && { fontSize: 19 }]}>{money(value)}</Text></View>; }
const styles = StyleSheet.create({ page: { padding: 18, paddingBottom: 44, gap: 14, backgroundColor: colours.cream }, line: { flexDirection: "row", gap: 12, justifyContent: "space-between" }, lineName: { color: colours.ink, fontWeight: "800" }, meta: { color: colours.muted, lineHeight: 19 }, price: { color: colours.ink, fontWeight: "800" }, rule: { height: 1, backgroundColor: colours.line, marginVertical: 2 }, cardTitle: { color: colours.ink, fontSize: 19, fontWeight: "800" }, addressChip: { minWidth: 110, borderWidth: 1, borderColor: colours.line, borderRadius: 12, padding: 11, backgroundColor: colours.white }, addressActive: { borderColor: colours.blue, backgroundColor: colours.sky }, addressLabel: { color: colours.ink, fontWeight: "800" }, switchRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" }, switchLabel: { color: colours.ink, fontWeight: "700" }, offer: { borderWidth: 1, borderColor: colours.line, padding: 12, borderRadius: 12, flexDirection: "row", gap: 10 }, offerActive: { borderColor: colours.blue, backgroundColor: colours.sky }, payment: { flexDirection: "row", gap: 10, padding: 12, borderWidth: 1, borderColor: colours.line, borderRadius: 12 }, paymentActive: { borderColor: colours.blue, backgroundColor: colours.sky }, disabled: { opacity: .5 } });
