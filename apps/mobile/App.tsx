import type {Address} from "./src/types";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { CustomerBrandBanner, CustomerTabIcon } from "./src/CustomerBrandBanner";
import { useCustomerAlerts } from "./src/useCustomerAlerts";
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

  const [notificationIds,setNotificationIds]=useState<string[]>([]),[inboxRoute,setInboxRoute]=useState<"messages"|"updates">("messages");
  const tokenRef=useRef(token);tokenRef.current=token;const customerAlerts=useCustomerAlerts(user?.id||null,notificationIds);
  async function refreshUnread() { if (token) { const requestedToken=token;const result=await api<{unreadCount:number;items:Array<{id:string;readAt?:string|null}>}>("/api/notifications",{token});if(tokenRef.current!==requestedToken)return;setUnread(result.unreadCount);setNotificationIds(result.items.filter(item=>!item.readAt).map(item=>item.id)); } }
  useForegroundRefresh(refreshUnread, Boolean(token));
  useEffect(() => { if (token) void refreshUnread().catch(() => undefined); else setUnread(0); }, [token]);
  function useOffer(restaurantId: string, offerId: string, campaignType?:string|null) { const open = () => { if(campaignType==="free_delivery")setFulfillment("delivery"); setPreferredOffer({restaurantId,offerId}); setFocusRestaurantId(restaurantId); setTab("discover"); setCheckout(false); setBasketOpen(false); if (restaurant?.id !== restaurantId) { setRestaurant(null); setCart([]); } }; if (cart.length && restaurant?.id !== restaurantId) Alert.alert("Start a new basket?", "This offer is for another restaurant. Continuing replaces your current basket.", [{text:"Keep basket",style:"cancel"},{text:"Use offer",onPress:open}]); else open(); }

  async function restore() {
    setBooting(true); setBootError("");
    try { const saved = await sessionStore.get(); if (!saved) return; const result = await api<{ user: User; session: { id: string; createdAt: string; expiresAt: string } }>("/api/native/auth/me", { token: saved }); setToken(saved); setUser(result.user); }
    catch (caught) { if (caught instanceof ApiError && caught.status === 401) await sessionStore.clear(); else setBootError((caught as Error).message); }
    finally { setBooting(false); }
  }
  useEffect(() => { void restore(); }, []);
  async function authenticated(nextToken: string, nextUser: User) { await sessionStore.set(nextToken); setDeliveryAddress(null);setToken(nextToken); setUser(nextUser); }
  async function logout() { if (token) await api("/api/native/auth/logout", { method: "POST", token, body: "{}" }).catch(() => undefined); await sessionStore.clear(); setDeliveryAddress(null);setToken(null); setUser(null); setUnread(0);setNotificationIds([]); setFocusRestaurantId(null); setPreferredOffer(null); setCart([]); setRestaurant(null); setCheckout(false); setBasketOpen(false); setTab("discover"); }
  function openNotifications(){customerAlerts.acknowledge();if(checkout){Alert.alert("Reminders silenced","Complete checkout or use its Back button, then open the notification bell to see your updates.");return;}setBasketOpen(false);setInboxRoute("updates");setTab("inbox");}
  function selectTab(next:Tab){if(checkout){Alert.alert("Checkout is open","Use the Back button in checkout before changing sections.");return;}setBasketOpen(false);if(next==="inbox")setInboxRoute("messages");setTab(next);}
  function openBasket(){if(checkout){Alert.alert("Checkout is open","Use the Back button in checkout to return safely to your basket.");return;}setBasketOpen(true);}
  const basketCount=cart.reduce((sum,line)=>sum+line.quantity,0);
  function openOrder(id: string) { setFocusOrder(id); setCheckout(false); setTab("orders"); }

  if (booting) return <SafeAreaView style={styles.center}><StatusBar style="dark"/><Brand/><ActivityIndicator size="large" color={colours.blue}/><Text style={styles.muted}>Opening Cal-Eats…</Text></SafeAreaView>;
  if (bootError && !user) return <SafeAreaView style={styles.center}><Brand/><ErrorBanner message={bootError}/><Button onPress={() => void restore()}>Try again</Button><Button tone="quiet" onPress={() => { void sessionStore.clear(); setBootError(""); }}>Use another account</Button></SafeAreaView>;
  if (!token || !user) return <><StatusBar style="dark"/><AuthScreen onAuthenticated={authenticated}/></>;
  const banner=<CustomerBrandBanner basketCount={basketCount} onBasket={openBasket} unreadCount={unread} onBell={openNotifications} reminderPending={customerAlerts.pending} soundEnabled={customerAlerts.enabled} onToggleSound={customerAlerts.toggle}/>;
  const navigation=<View style={styles.nav}>{tabs.map(item=><Pressable accessibilityRole="tab" accessibilityLabel={item.label+(item.id==="inbox"&&unread>0?`, ${unread} unread notifications`:"")} accessibilityState={{selected:tab===item.id}} key={item.id} onPress={()=>selectTab(item.id)} style={[styles.navItem,tab===item.id&&styles.navSelected]}>{tab===item.id?<View style={styles.navIndicator}/>:null}<View style={[styles.navIconGlow,tab===item.id&&styles.navIconGlowSelected]}><CustomerTabIcon name={item.id} active={tab===item.id} colourOverride={colours.blue}/>{item.id==="inbox"&&unread>0?<View style={styles.navBadge}><Text style={styles.navBadgeText}>{unread>99?"99+":unread}</Text></View>:null}</View><Text style={[styles.navLabel,tab===item.id&&styles.navActive]}>{item.label}</Text></Pressable>)}</View>;
  if (basketOpen && !restaurant) return <SafeAreaView style={styles.shell}><StatusBar style="dark"/>{banner}<View style={styles.center}><Text style={{fontSize:28,fontWeight:"800",color:colours.ink}}>Your basket is empty</Text><Text style={styles.muted}>Choose a restaurant and add something you fancy. Your items stay in your basket while you browse the app.</Text><Button onPress={()=>{setBasketOpen(false);setTab("discover");}}>Browse restaurants</Button><Button tone="quiet" onPress={()=>setBasketOpen(false)}>Back</Button></View>{navigation}</SafeAreaView>;
  if (basketOpen && restaurant) return <SafeAreaView style={styles.shell}><StatusBar style="dark"/>{banner}<BasketScreen token={token} restaurant={restaurant} cart={cart} fulfillment={fulfillment} initialAddress={deliveryAddress} onOffer={offerId=>setPreferredOffer(offerId?{restaurantId:restaurant.id,offerId}:null)} onCart={setCart} onBack={()=>setBasketOpen(false)} onCheckout={()=>{setBasketOpen(false);setCheckout(true);}}/>{navigation}</SafeAreaView>;
  if (checkout && restaurant) return <SafeAreaView style={styles.shell}><StatusBar style="dark"/>{banner}<KeyboardAvoidingView style={styles.content} behavior={Platform.OS === "ios" ? "padding" : undefined}><CheckoutScreen initialAddress={deliveryAddress} onAddress={setDeliveryAddress} onOfferResolved={offerId=>setPreferredOffer(offerId?{restaurantId:restaurant.id,offerId}:null)} token={token} restaurant={restaurant} cart={cart} fulfillment={fulfillment} onBack={() => {setCheckout(false);setBasketOpen(true);}} onCheckOrders={() => { setCart([]); setPreferredOffer(null); setCheckout(false); setTab("orders"); }} onOrdered={(order) => { setCart([]); setPreferredOffer(null); setCheckout(false); openOrder(order.id); }}/></KeyboardAvoidingView>{navigation}</SafeAreaView>;

  return <SafeAreaView style={styles.shell}><StatusBar style="dark"/>{banner}<KeyboardAvoidingView style={styles.content} behavior={Platform.OS === "ios" ? "padding" : undefined}>
    <ErrorBanner message={customerAlerts.error}/>
    {tab === "discover" ? <DiscoverScreen userId={user.id} address={deliveryAddress} onAddress={setDeliveryAddress} onUseOffer={useOffer} focusRestaurantId={focusRestaurantId} onRestaurantFocused={() => setFocusRestaurantId(null)} token={token} fulfillment={fulfillment} onFulfillment={setFulfillment} restaurant={restaurant} cart={cart} onRestaurant={setRestaurant} onCart={setCart} onCheckout={() => setBasketOpen(true)}/> : null}
    {tab === "orders" ? <OrdersScreen token={token} focusOrder={focusOrder} onFocused={() => setFocusOrder(null)}/> : null}
    {tab === "offers" ? <InboxScreen key="offers" initialTab="offers" token={token} onOpenOrder={openOrder} onUseOffer={useOffer} onOfferDismissed={id=>setPreferredOffer(current=>current?.offerId===id?null:current)} onUnreadChange={setUnread}/> : null}
    {tab === "inbox" ? <InboxScreen key={`messages:${inboxRoute}`} initialTab={inboxRoute} token={token} onOpenOrder={openOrder} onUseOffer={useOffer} onOfferDismissed={id=>setPreferredOffer(current=>current?.offerId===id?null:current)} onUnreadChange={setUnread}/> : null}
    {tab === "account" ? <AccountScreen token={token} user={user} onUser={setUser} onLogout={logout}/> : null}
  </KeyboardAvoidingView>{navigation}</SafeAreaView>;
}

const styles = StyleSheet.create({ shell: { flex: 1, backgroundColor: colours.cream }, content: { flex: 1 }, center: { flex: 1, padding: 30, gap: 22, justifyContent: "center", alignItems: "stretch", backgroundColor: colours.cream }, muted: { color: colours.muted, textAlign: "center" }, nav: { flexShrink:0,minHeight:74,paddingHorizontal:6,paddingVertical:5,borderTopWidth:1,borderTopColor:colours.line,backgroundColor:colours.panel,flexDirection:"row",shadowColor:"#173C68",shadowOpacity:.08,shadowRadius:9,elevation:5 }, navBadge:{position:"absolute",right:-9,top:-5,minWidth:19,height:19,paddingHorizontal:4,borderRadius:10,alignItems:"center",justifyContent:"center",backgroundColor:colours.blue,borderWidth:1.5,borderColor:colours.panel},navBadgeText:{fontSize:10,fontWeight:"800",color:colours.white},navIndicator:{position:"absolute",top:2,width:22,height:3,borderRadius:2,backgroundColor:colours.blue},navIconGlowSelected:{backgroundColor:"#DDEFFF",shadowOpacity:.3},navIconGlow:{width:36,height:32,borderRadius:14,alignItems:"center",justifyContent:"center",backgroundColor:"#EDF6FF",shadowColor:colours.blue,shadowOpacity:.24,shadowRadius:6,shadowOffset:{width:0,height:0},elevation:2}, navSelected:{backgroundColor:"#F1F8FF",borderColor:"#D8E9F8",shadowColor:colours.blue,shadowOpacity:.14,shadowRadius:8,shadowOffset:{width:0,height:0}}, navItem:{flex:1,minHeight:60,marginHorizontal:2,borderRadius:15,borderWidth:1,borderColor:"transparent",justifyContent:"center",alignItems:"center",gap:4,paddingTop:5}, navIcon: { fontSize: 20, color: colours.muted, fontWeight: "700" }, navLabel: { fontSize: 11, color: colours.muted, fontWeight: "700" }, navActive: { color: colours.blue } });
