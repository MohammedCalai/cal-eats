import { useEffect, useMemo, useRef, useState } from "react";
import { Image, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { absoluteMediaUrl, api } from "../api";
import { Button, Card, Empty, ErrorBanner, Field, Pill, SectionTitle } from "../components";
import { cartTotals, money, refreshCart, toggleSelection, validateSelections } from "../model";
import { colours } from "../theme";
import type { CartEntry, Fulfillment, MenuItem, Restaurant, Selections } from "../types";

interface Props {
  token: string; fulfillment: Fulfillment; onFulfillment: (value: Fulfillment) => void;
  restaurant: Restaurant | null; cart: CartEntry[]; onRestaurant: (restaurant: Restaurant | null) => void;
  onCart: (entries: CartEntry[]) => void; onCheckout: () => void; focusRestaurantId?: string | null; onRestaurantFocused?: () => void;
}
export function DiscoverScreen(props: Props) {
  const [postcode, setPostcode] = useState(""); const [query, setQuery] = useState(""); const [restaurants, setRestaurants] = useState<Restaurant[]>([]); const [menu, setMenu] = useState<MenuItem[]>([]);
  const [discoveryLoading, setDiscoveryLoading] = useState(false), [menuLoading, setMenuLoading] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const mounted = useRef(false), discoveryRequest = useRef(0), menuRequest = useRef(0), latest = useRef(props), latestCart = useRef(props.cart);
  latest.current = props; latestCart.current = props.cart;
  const loading = discoveryLoading || menuLoading;
  const totals = useMemo(() => cartTotals(props.cart, props.fulfillment, props.restaurant), [props.cart, props.fulfillment, props.restaurant]);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; discoveryRequest.current++; menuRequest.current++; }; }, []);
  function updateCart(entries: CartEntry[]) { latestCart.current = entries; latest.current.onCart(entries); }

  async function loadRestaurants() {
    const request = ++discoveryRequest.current, fulfillment = props.fulfillment, token = props.token;
    const current = () => mounted.current && discoveryRequest.current === request && latest.current.fulfillment === fulfillment && latest.current.token === token;
    setDiscoveryLoading(true); setError("");
    try { const params = new URLSearchParams({ fulfillment }); if (postcode.trim()) params.set("postcode", postcode.trim()); if (query.trim()) params.set("q", query.trim()); const result = await api<Restaurant[]>(`/api/restaurants?${params}`, { token }); if (current()) setRestaurants(result); }
    catch (caught) { if (current() && !latest.current.restaurant) setError((caught as Error).message); } finally { if (current()) setDiscoveryLoading(false); }
  }
  useEffect(() => { void loadRestaurants(); }, [props.fulfillment]);

  useEffect(() => { const focused = props.focusRestaurantId; if (focused) void chooseRestaurant({ id: focused }, props.restaurant?.id === focused).then(() => { if (mounted.current && latest.current.focusRestaurantId === focused) latest.current.onRestaurantFocused?.(); }); }, [props.focusRestaurantId]);

  useEffect(() => { if (!props.focusRestaurantId && props.restaurant && !menu.length) void chooseRestaurant(props.restaurant, true); }, [props.restaurant?.id, props.focusRestaurantId]);

  async function chooseRestaurant(restaurant: Pick<Restaurant, "id">, refresh = false) {
    const request = ++menuRequest.current, token = props.token;
    const current = () => mounted.current && menuRequest.current === request && latest.current.token === token && (!latest.current.focusRestaurantId || latest.current.focusRestaurantId === restaurant.id);
    setMenuLoading(true); setError("");
    try {
      const result = await api<{ restaurant: Restaurant; items: MenuItem[] }>(`/api/restaurants/${encodeURIComponent(restaurant.id)}/menu`, { token });
      if (!current()) return;
      latest.current.onRestaurant(result.restaurant); updateCart(refresh ? refreshCart(latestCart.current, result.items) : []); setMenu(result.items); setNotice(refresh ? "Menu refreshed. Your basket is kept using current prices and available choices." : "");
    }
    catch (caught) { if (current()) setError((caught as Error).message); } finally { if (current()) setMenuLoading(false); }
  }

  function changeQuantity(item: MenuItem, delta: number) {
    const cart = latestCart.current, current = cart.find((entry) => entry.item.id === item.id);
    const next = Math.max(0, Math.min(20, (current?.quantity ?? 0) + delta));
    const selections = current?.selections ?? {};
    updateCart(next ? [...cart.filter((entry) => entry.item.id !== item.id), { item, quantity: next, selections }] : cart.filter((entry) => entry.item.id !== item.id));
  }
  function toggleOption(item: MenuItem, groupId: string, optionId: string, max: number) {
    const cart = latestCart.current, current = cart.find((entry) => entry.item.id === item.id) ?? { item, quantity: 1, selections: {} as Selections };
    const selected = current.selections[groupId] ?? [];
    const nextIds = toggleSelection(selected, optionId, max);
    const updated = { ...current, selections: { ...current.selections, [groupId]: nextIds } };
    updateCart([...cart.filter((entry) => entry.item.id !== item.id), updated]);
  }

  if (props.restaurant) return <View style={{ flex: 1 }}><ScrollView contentContainerStyle={styles.page} refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void chooseRestaurant(props.restaurant!, true)}/> }>
    <Button tone="quiet" onPress={() => { menuRequest.current++; setMenuLoading(false); props.onRestaurant(null); updateCart([]); setMenu([]); setError(""); setNotice(""); }}>← Restaurants</Button>
    <SectionTitle eyebrow={props.restaurant.profile.cuisine || "Local menu"} title={props.restaurant.name}/>
    <Text style={styles.meta}>{props.fulfillment === "delivery" ? `${props.restaurant.profile.estimatedDeliveryMinutes ?? "—"} min · ${money(props.restaurant.delivery.deliveryFeeMinor)} delivery` : `${props.restaurant.profile.estimatedCollectionMinutes ?? "—"} min collection`}</Text>
    <Card tone="warning"><Text style={styles.allergyStrong}>Allergy safety</Text><Text style={styles.meta}>Allergen details are supplied by restaurants. Add an allergy note at checkout and contact the restaurant if you need confirmation.</Text></Card>
    <ErrorBanner message={error}/>{notice ? <Card tone="info"><Text style={styles.meta}>{notice}</Text></Card> : null}
    {menu.length ? menu.map((item) => { const entry = props.cart.find((line) => line.item.id === item.id); const validity = validateSelections(item, entry?.selections ?? {}); return <Card key={item.id}>
      <View style={styles.row}>{item.photoUrl ? <Image style={styles.foodImage} source={{ uri: absoluteMediaUrl(item.photoUrl) }}/> : <View style={styles.foodFallback}><Text style={{ fontSize: 28 }}>🍽️</Text></View>}<View style={{ flex: 1, gap: 5 }}><Pill>{item.category || "Menu"}</Pill><Text style={styles.itemTitle}>{item.name}</Text><Text style={styles.meta}>{item.description}</Text><Text style={styles.price}>{money(item.priceMinor)}</Text></View></View>
      {item.dietaryTags.length ? <Text style={styles.meta}>{item.dietaryTags.join(" · ")}</Text> : null}
      <Text style={item.allergens.length ? styles.allergy : styles.meta}>{item.allergens.length ? `Allergens: ${item.allergens.join(", ")} · restaurant supplied` : "No allergens listed — ask the restaurant."}</Text>
      {item.modifierGroups.map((group) => <View key={group.id} style={styles.options}><Text style={styles.optionTitle}>{group.name} · choose {group.minSelections}{group.maxSelections !== group.minSelections ? `–${group.maxSelections}` : ""}</Text><View style={styles.wrap}>{group.options.map((option) => { const active = entry?.selections[group.id]?.includes(option.id); return <Pressable key={option.id} disabled={!item.available || !option.available} onPress={() => toggleOption(item, group.id, option.id, group.maxSelections)} style={[styles.choice, active && styles.choiceActive, (!item.available || !option.available) && { opacity: .4 }]}><Text style={[styles.choiceText, active && { color: colours.white }]}>{option.name}{option.priceMinor ? ` +${money(option.priceMinor)}` : ""}</Text></Pressable>; })}</View></View>)}
      {entry && !validity.ok ? <Text style={styles.errorText}>{validity.reason}</Text> : null}
      <View style={styles.qty}><Button tone="secondary" disabled={!entry} onPress={() => changeQuantity(item, -1)}>−</Button><Text style={styles.quantity}>{entry?.quantity ?? 0}</Text><Button tone="secondary" disabled={!item.available} onPress={() => changeQuantity(item, 1)}>+</Button></View>
    </Card>; }) : <Empty>No menu items are available right now.</Empty>}
  </ScrollView>{props.cart.length ? <View style={styles.basketBar}><View><Text style={styles.basketTitle}>{props.cart.reduce((sum, entry) => sum + entry.quantity, 0)} item(s)</Text><Text style={styles.meta}>{money(totals.totalMinor)}</Text></View><Button onPress={props.onCheckout}>Review basket</Button></View> : null}</View>;

  return <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled" refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void loadRestaurants()}/> }>
    <SectionTitle eyebrow="Discover" title="What are you craving?"/>
    <View style={styles.segment}><Pressable onPress={() => props.onFulfillment("delivery")} style={[styles.segmentButton, props.fulfillment === "delivery" && styles.segmentActive]}><Text style={[styles.segmentText, props.fulfillment === "delivery" && styles.segmentTextActive]}>Delivery</Text></Pressable><Pressable onPress={() => props.onFulfillment("collection")} style={[styles.segmentButton, props.fulfillment === "collection" && styles.segmentActive]}><Text style={[styles.segmentText, props.fulfillment === "collection" && styles.segmentTextActive]}>Collection</Text></Pressable></View>
    <Field label="Postcode" value={postcode} onChangeText={setPostcode} autoCapitalize="characters" placeholder="e.g. E1 6AN"/>
    <Field label="Search" value={query} onChangeText={setQuery} placeholder="Restaurant or cuisine" returnKeyType="search" onSubmitEditing={() => void loadRestaurants()}/>
    <Button busy={loading} onPress={() => void loadRestaurants()}>Find restaurants</Button><ErrorBanner message={error}/>
    {restaurants.length ? restaurants.map((restaurant) => <Pressable accessibilityRole="button" key={restaurant.id} onPress={() => void chooseRestaurant(restaurant)}><Card><View style={styles.row}>{restaurant.coverImageUrl ? <Image style={styles.restaurantImage} source={{ uri: absoluteMediaUrl(restaurant.coverImageUrl) }}/> : <View style={styles.restaurantImage}><Text style={{ fontSize: 30 }}>🥘</Text></View>}<View style={{ flex: 1, gap: 5 }}><Text style={styles.itemTitle}>{restaurant.name}</Text><Text style={styles.meta}>{restaurant.profile.cuisine || "Independent restaurant"}</Text><Text style={styles.meta}>{restaurant.profile.description}</Text><Pill tone={restaurant.acceptingOrders ? "green" : "amber"}>{restaurant.acceptingOrders ? "Taking orders" : restaurant.closedReason || "Closed"}</Pill></View></View></Card></Pressable>) : !loading ? <Empty>No restaurants match these filters. Try collection or a nearby postcode.</Empty> : null}
  </ScrollView>;
}

const styles = StyleSheet.create({ page: { padding: 18, paddingBottom: 110, gap: 14, backgroundColor: colours.cream }, row: { flexDirection: "row", gap: 13 }, wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 }, meta: { color: colours.muted, lineHeight: 20 }, price: { color: colours.ink, fontWeight: "800", fontSize: 17 }, itemTitle: { color: colours.ink, fontSize: 19, fontWeight: "800" }, restaurantImage: { width: 92, height: 92, borderRadius: 14, backgroundColor: colours.sky, alignItems: "center", justifyContent: "center" }, foodImage: { width: 84, height: 84, borderRadius: 12 }, foodFallback: { width: 84, height: 84, borderRadius: 12, backgroundColor: colours.sky, justifyContent: "center", alignItems: "center" }, allergy: { color: colours.amber, lineHeight: 19 }, allergyStrong: { color: colours.amber, fontWeight: "800" }, options: { gap: 8, paddingTop: 3 }, optionTitle: { color: colours.ink, fontWeight: "700" }, choice: { paddingHorizontal: 11, paddingVertical: 9, borderWidth: 1, borderColor: colours.line, borderRadius: 99, backgroundColor: colours.panel }, choiceActive: { backgroundColor: colours.blue, borderColor: colours.blue }, choiceText: { color: colours.ink, fontWeight: "600" }, errorText: { color: colours.danger }, qty: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 16 }, quantity: { minWidth: 25, textAlign: "center", fontSize: 18, color: colours.ink, fontWeight: "800" }, basketBar: { position: "absolute", left: 12, right: 12, bottom: 8, minHeight: 74, borderRadius: 18, padding: 12, backgroundColor: colours.panel, borderWidth: 1, borderColor: colours.line, flexDirection: "row", justifyContent: "space-between", alignItems: "center", shadowOpacity: .12, shadowRadius: 12, shadowOffset: { width: 0, height: 5 } }, basketTitle: { color: colours.ink, fontWeight: "800" }, segment: { flexDirection: "row", padding: 4, backgroundColor: colours.sky, borderRadius: 14 }, segmentButton: { flex: 1, alignItems: "center", paddingVertical: 11, borderRadius: 11 }, segmentActive: { backgroundColor: colours.panel }, segmentText: { color: colours.muted, fontWeight: "700" }, segmentTextActive: { color: colours.blue } });
