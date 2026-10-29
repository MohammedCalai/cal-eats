import type {Address} from "./src/types";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { CustomerBrandBanner, CustomerTabIcon } from "./src/CustomerBrandBanner";
import { useForegroundRefresh } from "./src/useForegroundRefresh";
import { ApiError, api } from "./src/api";
import { Brand, Button, ErrorBanner } from "./src/components";
import { sessionStore } from "./src/session";
import { colours } from "./src/theme";
import type { CartEntry, Fulfillment, Restaurant, User } from "./src/types";
import { AccountScreen } from "./src/screens/AccountScreen";
import { AuthScreen } from "./src/screens/AuthScreen";
import { BasketScreen } from "./src/screens/BasketScreen";
import { CheckoutScreen } from "./src/screens/CheckoutScreen";
import { DiscoverScreen } from "./src/screens/DiscoverScreen";
import { InboxScreen } from "./src/screens/InboxScreen";
import { OrdersScreen } from "./src/screens/OrdersScreen";

type Tab = "discover" | "orders" | "offers" | "inbox" | "account";
const tabs: Array<{ id: Tab; label: string }> = [
  { id: "discover", label: "Browse" }, { id: "orders", label: "Orders" }, { id: "offers", label: "Offers" }, { id: "inbox", label: "Messages" }, { id: "account", label: "Account" }
];
export default function App() {
  const [unread, setUnread] = useState(0); const [focusRestaurantId, setFocusRestaurantId] = useState<string | null>(null); const [preferredOffer, setPreferredOffer] = useState<{ restaurantId: string; offerId: string } | null>(null);
  const [token, setToken] = useState<string | null>(null); const [user, setUser] = useState<User | null>(null); const [booting, setBooting] = useState(true); const [bootError, setBootError] = useState("");
  const [deliveryAddress,setDeliveryAddress]=useState<Address|null>(null);
  const [basketOpen,setBasketOpen]=useState(false);
  const [tab, setTab] = useState<Tab>("discover"); const [checkout, setCheckout] = useState(false); const [restaurant, setRestaurant] = useState<Restaurant | null>(null); const [cart, setCart] = useState<CartEntry[]>([]); const [fulfillment, setFulfillment] = useState<Fulfillment>("delivery"); const [focusOrder, setFocusOrder] = useState<string | null>(null);

  async function refreshUnread() { if (token) { const result = await api<{unreadCount:number}>("/api/notifications", { token }); setUnread(result.unreadCount); } }
  useForegroundRefresh(refreshUnread, Boolean(token));
  useEffect(() => { if (token) void refreshUnread().catch(() => undefined); else setUnread(0); }, [token]);
  function useOffer(restaurantId: string, offerId: string) { const open = () => { setPreferredOffer({restaurantId,offerId}); setFocusRestaurantId(restaurantId); setTab("discover"); setCheckout(false); setBasketOpen(false); if (restaurant?.id !== restaurantId) { setRestaurant(null); setCart([]); } }; if (cart.length && restaurant?.id !== restaurantId) Alert.alert("Start a new basket?", "This offer is for another restaurant. Continuing replaces your current basket.", [{text:"Keep basket",style:"cancel"},{text:"Use offer",onPress:open}]); else open(); }

  async function restore() {
    setBooting(true); setBootError("");
    try { const saved = await sessionStore.get(); if (!saved) return; const result = await api<{ user: User; session: { id: string; createdAt: string; expiresAt: string } }>("/api/native/auth/me", { token: saved }); setToken(saved); setUser(result.user); }
    catch (caught) { if (caught instanceof ApiError && caught.status === 401) await sessionStore.clear(); else setBootError((caught as Error).message); }
    finally { setBooting(false); }
  }
  useEffect(() => { void restore(); }, []);
  async function authenticated(nextToken: string, nextUser: User) { await sessionStore.set(nextToken); setDeliveryAddress(null);setToken(nextToken); setUser(nextUser); }
  async function logout() { if (token) await api("/api/native/auth/logout", { method: "POST", token, body: "{}" }).catch(() => undefined); await sessionStore.clear(); setDeliveryAddress(null);setToken(null); setUser(null); setUnread(0); setFocusRestaurantId(null); setPreferredOffer(null); setCart([]); setRestaurant(null); setCheckout(false); setBasketOpen(false); setTab("discover"); }
  function openBasket(){if(checkout){Alert.alert("Checkout is open","Use the Back button in checkout to return safely to your basket.");return;}setBasketOpen(true);}
  const basketCount=cart.reduce((sum,line)=>sum+line.quantity,0);
  function openOrder(id: string) { setFocusOrder(id); setCheckout(false); setTab("orders"); }

  if (booting) return <SafeAreaView style={styles.center}><StatusBar style="dark"/><Brand/><ActivityIndicator size="large" color={colours.blue}/><Text style={styles.muted}>Opening Cal-Eats…</Text></SafeAreaView>;
  if (bootError && !user) return <SafeAreaView style={styles.center}><Brand/><ErrorBanner message={bootError}/><Button onPress={() => void restore()}>Try again</Button><Button tone="quiet" onPress={() => { void sessionStore.clear(); setBootError(""); }}>Use another account</Button></SafeAreaView>;
  if (!token || !user) return <><StatusBar style="dark"/><AuthScreen onAuthenticated={authenticated}/></>;
  if (basketOpen && !restaurant) return <SafeAreaView style={styles.shell}><StatusBar style="dark"/><CustomerBrandBanner basketCount={basketCount} onBasket={openBasket}/><View style={styles.center}><Text style={{fontSize:28,fontWeight:"800",color:colours.ink}}>Your basket is empty</Text><Text style={styles.muted}>Choose a restaurant and add something you fancy. Your items stay in your basket while you browse the app.</Text><Button onPress={()=>{setBasketOpen(false);setTab("discover");}}>Browse restaurants</Button><Button tone="quiet" onPress={()=>setBasketOpen(false)}>Back</Button></View></SafeAreaView>;
  if (basketOpen && restaurant) return <SafeAreaView style={styles.shell}><StatusBar style="dark"/><CustomerBrandBanner basketCount={basketCount} onBasket={openBasket}/><BasketScreen token={token} restaurant={restaurant} cart={cart} fulfillment={fulfillment} offerId={preferredOffer?.restaurantId===restaurant.id?preferredOffer.offerId:undefined} onOffer={offerId=>setPreferredOffer(offerId?{restaurantId:restaurant.id,offerId}:null)} onCart={setCart} onBack={()=>setBasketOpen(false)} onCheckout={()=>{setBasketOpen(false);setCheckout(true);}}/></SafeAreaView>;
  if (checkout && restaurant) return <SafeAreaView style={styles.shell}><StatusBar style="dark"/><CustomerBrandBanner basketCount={basketCount} onBasket={openBasket}/><KeyboardAvoidingView style={styles.content} behavior={Platform.OS === "ios" ? "padding" : undefined}><CheckoutScreen initialAddress={deliveryAddress} initialOfferId={preferredOffer?.restaurantId === restaurant.id ? preferredOffer.offerId : undefined} token={token} restaurant={restaurant} cart={cart} fulfillment={fulfillment} onBack={() => {setCheckout(false);setBasketOpen(true);}} onCheckOrders={() => { setCart([]); setPreferredOffer(null); setCheckout(false); setTab("orders"); }} onOrdered={(order) => { setCart([]); setPreferredOffer(null); setCheckout(false); openOrder(order.id); }}/></KeyboardAvoidingView></SafeAreaView>;

  return <SafeAreaView style={styles.shell}><StatusBar style="dark"/><CustomerBrandBanner basketCount={basketCount} onBasket={openBasket}/><KeyboardAvoidingView style={styles.content} behavior={Platform.OS === "ios" ? "padding" : undefined}>
    {tab === "discover" ? <DiscoverScreen userId={user.id} address={deliveryAddress} onAddress={setDeliveryAddress} onUseOffer={useOffer} focusRestaurantId={focusRestaurantId} onRestaurantFocused={() => setFocusRestaurantId(null)} token={token} fulfillment={fulfillment} onFulfillment={setFulfillment} restaurant={restaurant} cart={cart} onRestaurant={setRestaurant} onCart={setCart} onCheckout={() => setBasketOpen(true)}/> : null}
    {tab === "orders" ? <OrdersScreen token={token} focusOrder={focusOrder} onFocused={() => setFocusOrder(null)}/> : null}
    {tab === "offers" ? <InboxScreen key="offers" initialTab="offers" token={token} onOpenOrder={openOrder} onUseOffer={useOffer} onUnreadChange={setUnread}/> : null}
    {tab === "inbox" ? <InboxScreen key="messages" initialTab="messages" token={token} onOpenOrder={openOrder} onUseOffer={useOffer} onUnreadChange={setUnread}/> : null}
    {tab === "account" ? <AccountScreen token={token} user={user} onUser={setUser} onLogout={logout}/> : null}
  </KeyboardAvoidingView><View style={styles.nav}>{tabs.map((item) => <Pressable accessibilityRole="tab" accessibilityState={{ selected: tab === item.id }} key={item.id} onPress={() => { setCheckout(false); setTab(item.id); }} style={styles.navItem}><CustomerTabIcon name={item.id} active={tab === item.id}/><Text style={[styles.navLabel, tab === item.id && styles.navActive]}>{item.label}{item.id === "inbox" && unread > 0 ? ` (${Math.min(unread, 99)}${unread > 99 ? "+" : ""})` : ""}</Text></Pressable>)}</View></SafeAreaView>;
}

const styles = StyleSheet.create({ shell: { flex: 1, backgroundColor: colours.cream }, content: { flex: 1 }, center: { flex: 1, padding: 30, gap: 22, justifyContent: "center", alignItems: "stretch", backgroundColor: colours.cream }, muted: { color: colours.muted, textAlign: "center" }, nav: { minHeight: 66, paddingBottom: 4, borderTopWidth: 1, borderTopColor: colours.line, backgroundColor: colours.cream, flexDirection: "row" }, navItem: { flex: 1, justifyContent: "center", alignItems: "center", gap: 2 }, navIcon: { fontSize: 20, color: colours.muted, fontWeight: "700" }, navLabel: { fontSize: 11, color: colours.muted, fontWeight: "700" }, navActive: { color: colours.blue } });
