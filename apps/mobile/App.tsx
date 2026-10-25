import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { ApiError, api } from "./src/api";
import { Brand, Button, ErrorBanner } from "./src/components";
import { sessionStore } from "./src/session";
import { colours } from "./src/theme";
import type { CartEntry, Fulfillment, Restaurant, User } from "./src/types";
import { AccountScreen } from "./src/screens/AccountScreen";
import { AuthScreen } from "./src/screens/AuthScreen";
import { CheckoutScreen } from "./src/screens/CheckoutScreen";
import { DiscoverScreen } from "./src/screens/DiscoverScreen";
import { InboxScreen } from "./src/screens/InboxScreen";
import { OrdersScreen } from "./src/screens/OrdersScreen";

type Tab = "discover" | "orders" | "inbox" | "account";
const tabs: Array<{ id: Tab; label: string; icon: string }> = [
  { id: "discover", label: "Food", icon: "⌕" }, { id: "orders", label: "Orders", icon: "▤" }, { id: "inbox", label: "Inbox", icon: "●" }, { id: "account", label: "Account", icon: "☺" }
];

export default function App() {
  const [token, setToken] = useState<string | null>(null); const [user, setUser] = useState<User | null>(null); const [booting, setBooting] = useState(true); const [bootError, setBootError] = useState("");
  const [tab, setTab] = useState<Tab>("discover"); const [checkout, setCheckout] = useState(false); const [restaurant, setRestaurant] = useState<Restaurant | null>(null); const [cart, setCart] = useState<CartEntry[]>([]); const [fulfillment, setFulfillment] = useState<Fulfillment>("delivery"); const [focusOrder, setFocusOrder] = useState<string | null>(null);

  async function restore() {
    setBooting(true); setBootError("");
    const saved = await sessionStore.get();
    if (!saved) { setBooting(false); return; }
    try { const result = await api<{ user: User; session: { id: string; createdAt: string; expiresAt: string } }>("/api/native/auth/me", { token: saved }); setToken(saved); setUser(result.user); }
    catch (caught) { if (caught instanceof ApiError && caught.status === 401) await sessionStore.clear(); else setBootError((caught as Error).message); }
    finally { setBooting(false); }
  }
  useEffect(() => { void restore(); }, []);
  async function authenticated(nextToken: string, nextUser: User) { await sessionStore.set(nextToken); setToken(nextToken); setUser(nextUser); }
  async function logout() { if (token) await api("/api/native/auth/logout", { method: "POST", token, body: "{}" }).catch(() => undefined); await sessionStore.clear(); setToken(null); setUser(null); setCart([]); setRestaurant(null); setCheckout(false); setTab("discover"); }
  function openOrder(id: string) { setFocusOrder(id); setCheckout(false); setTab("orders"); }

  if (booting) return <SafeAreaView style={styles.center}><StatusBar style="dark"/><Brand/><ActivityIndicator size="large" color={colours.blue}/><Text style={styles.muted}>Opening Cal-Eats…</Text></SafeAreaView>;
  if (bootError && !user) return <SafeAreaView style={styles.center}><Brand/><ErrorBanner message={bootError}/><Button onPress={() => void restore()}>Try again</Button><Button tone="quiet" onPress={() => { void sessionStore.clear(); setBootError(""); }}>Use another account</Button></SafeAreaView>;
  if (!token || !user) return <><StatusBar style="dark"/><AuthScreen onAuthenticated={authenticated}/></>;
  if (checkout && restaurant) return <SafeAreaView style={styles.shell}><StatusBar style="dark"/><CheckoutScreen token={token} restaurant={restaurant} cart={cart} fulfillment={fulfillment} onBack={() => setCheckout(false)} onOrdered={(order) => { setCart([]); setCheckout(false); openOrder(order.id); }}/></SafeAreaView>;

  return <SafeAreaView style={styles.shell}><StatusBar style="dark"/><View style={styles.content}>
    {tab === "discover" ? <DiscoverScreen token={token} fulfillment={fulfillment} onFulfillment={setFulfillment} restaurant={restaurant} cart={cart} onRestaurant={setRestaurant} onCart={setCart} onCheckout={() => setCheckout(true)}/> : null}
    {tab === "orders" ? <OrdersScreen token={token} focusOrder={focusOrder} onFocused={() => setFocusOrder(null)}/> : null}
    {tab === "inbox" ? <InboxScreen token={token} onOpenOrder={openOrder}/> : null}
    {tab === "account" ? <AccountScreen token={token} user={user} onUser={setUser} onLogout={logout}/> : null}
  </View><View style={styles.nav}>{tabs.map((item) => <Pressable accessibilityRole="tab" accessibilityState={{ selected: tab === item.id }} key={item.id} onPress={() => { setCheckout(false); setTab(item.id); }} style={styles.navItem}><Text style={[styles.navIcon, tab === item.id && styles.navActive]}>{item.icon}</Text><Text style={[styles.navLabel, tab === item.id && styles.navActive]}>{item.label}</Text></Pressable>)}</View></SafeAreaView>;
}

const styles = StyleSheet.create({ shell: { flex: 1, backgroundColor: colours.cream }, content: { flex: 1 }, center: { flex: 1, padding: 30, gap: 22, justifyContent: "center", alignItems: "stretch", backgroundColor: colours.cream }, muted: { color: colours.muted, textAlign: "center" }, nav: { minHeight: 66, paddingBottom: 4, borderTopWidth: 1, borderTopColor: "#183251", backgroundColor: "#06101F", flexDirection: "row" }, navItem: { flex: 1, justifyContent: "center", alignItems: "center", gap: 2 }, navIcon: { fontSize: 20, color: "#AFC3D9", fontWeight: "700" }, navLabel: { fontSize: 11, color: "#AFC3D9", fontWeight: "700" }, navActive: { color: "#26A7FF" } });
