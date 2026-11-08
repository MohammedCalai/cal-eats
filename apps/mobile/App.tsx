import type {Address} from "./src/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from "react-native";
import { CustomerEmailVerification, CustomerEmailVerificationBanner, useCustomerEmailVerification } from "./src/CustomerEmailVerification";
import { StatusBar } from "expo-status-bar";
import { CustomerBrandBanner, CustomerIcon, CustomerTabIcon } from "./src/CustomerBrandBanner";
import { useCustomerAlerts } from "./src/useCustomerAlerts";
import { customerUnreadPromptVisible } from "./src/customer-unread-prompt";
import { useCustomerPush } from "./src/useCustomerPush";
import { useCustomerLiveActivity } from "./src/useCustomerLiveActivity";
import type { CustomerPushTarget } from "./src/push-model";
import { useForegroundRefresh } from "./src/useForegroundRefresh";
import { ApiError, api } from "./src/api";
import { notificationRevision } from "./src/notificationRevision";
import { Button, ErrorBanner } from "./src/components";
import { sessionStore } from "./src/session";
import { bindCustomerProfileUpdate } from "./src/session-identity";
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
  const [headerCompact,setHeaderCompact]=useState(false),headerCompactRef=useRef(false);
  const onScrollOffset=useCallback((offset:number)=>{const compact=headerCompactRef.current?offset>16:offset>48;if(compact!==headerCompactRef.current){headerCompactRef.current=compact;setHeaderCompact(compact);}},[]);
  const resetHeader=useCallback(()=>{headerCompactRef.current=false;setHeaderCompact(false);},[]);
  const [unread, setUnread] = useState(0); const [focusRestaurantId, setFocusRestaurantId] = useState<string | null>(null); const [preferredOffer, setPreferredOffer] = useState<{ restaurantId: string; offerId: string } | null>(null);
  const [token, setToken] = useState<string | null>(null); const [user, setUser] = useState<User | null>(null); const [booting, setBooting] = useState(true); const [bootError, setBootError] = useState("");
  const emailVerification=useCustomerEmailVerification(token);
  const [welcomeVerificationOpen,setWelcomeVerificationOpen]=useState(false);
  const[scheduleDraft,setScheduleDraft]=useState<{restaurantId:string;fulfillment:Fulfillment;mode:"asap"|"scheduled";scheduledFor:string|null}|null>(null);
  const [deliveryAddress,setDeliveryAddress]=useState<Address|null>(null);
  const [basketOpen,setBasketOpen]=useState(false);
  const [authOpen,setAuthOpen]=useState(false);
  const pendingCheckout=useRef(false);
  const [notificationsOpen,setNotificationsOpen]=useState(false);
  const [conversationOpen,setConversationOpen]=useState(false),[keyboardVisible,setKeyboardVisible]=useState(false);
  useEffect(()=>{
    const listeners=[Keyboard.addListener("keyboardWillShow",()=>setKeyboardVisible(true)),Keyboard.addListener("keyboardDidShow",()=>setKeyboardVisible(true)),Keyboard.addListener("keyboardWillHide",()=>setKeyboardVisible(false)),Keyboard.addListener("keyboardDidHide",()=>setKeyboardVisible(false))];
    return()=>listeners.forEach(listener=>listener.remove());
  },[]);
  const pendingNotifications=useRef(false);
  const [tab, setTab] = useState<Tab>("discover"); const [checkout, setCheckout] = useState(false); const [restaurant, setRestaurant] = useState<Restaurant | null>(null); const [cart, setCart] = useState<CartEntry[]>([]); const [fulfillment, setFulfillment] = useState<Fulfillment>("delivery"); const [focusOrder, setFocusOrder] = useState<string | null>(null);

  const [notificationIds,setNotificationIds]=useState<string[]>([]),[inboxRoute,setInboxRoute]=useState<"messages"|"updates">("messages");
  const [focusContact,setFocusContact]=useState<{id:string;title:string;support?:boolean}|null>(null);
  useEffect(resetHeader,[tab,basketOpen,checkout,inboxRoute,user?.id,resetHeader]);
  const tokenRef=useRef(token),unreadRequest=useRef(0);tokenRef.current=token;const customerAlerts=useCustomerAlerts(user?.id||null,notificationIds);
  const customerPush=useCustomerPush({token,userId:user?.id||null,booting,blocked:checkout,unreadCount:unread,onOpen:openPushTarget,onReceived:refreshUnread,onSignIn:requestPushSignIn});
  const customerLiveActivity=useCustomerLiveActivity({token,userId:user?.id||null,booting,sessionUncertain:Boolean(bootError&&!user),blocked:checkout,onOpenOrder:openOrder,onSignIn:requestPushSignIn});
  useEffect(()=>{if(!user)setNotificationsOpen(false);},[user?.id]);
  useEffect(()=>{if(notificationsOpen&&user&&customerAlerts.ready)customerAlerts.acknowledge();},[notificationsOpen,notificationIds.join("|"),user?.id,customerAlerts.ready]);
  async function refreshUnread() { if (token) { const requestedToken=token,revision=notificationRevision(),request=++unreadRequest.current;const result=await api<{unreadCount:number;items:Array<{id:string;readAt?:string|null}>}>("/api/notifications",{token});if(tokenRef.current!==requestedToken||notificationRevision()!==revision||unreadRequest.current!==request)return;setUnread(result.unreadCount);setNotificationIds(result.items.filter(item=>!item.readAt).map(item=>item.id)); } }
  useForegroundRefresh(refreshUnread, Boolean(token));
  useEffect(() => { setUnread(0);setNotificationIds([]);if (token) void refreshUnread().catch(() => undefined); }, [token]);
  function useOffer(restaurantId: string, offerId: string, campaignType?:string|null) { const open = () => { if(campaignType==="free_delivery")setFulfillment("delivery"); setPreferredOffer({restaurantId,offerId}); setFocusRestaurantId(restaurantId); setTab("discover"); setCheckout(false); setBasketOpen(false); if (restaurant?.id !== restaurantId) { setRestaurant(null); setCart([]); } }; if (cart.length && restaurant?.id !== restaurantId) Alert.alert("Start a new basket?", "This offer is for another restaurant. Continuing replaces your current basket.", [{text:"Keep basket",style:"cancel"},{text:"Use offer",onPress:open}]); else open(); }

  async function restore() {
    setBooting(true); setBootError("");
    try { const saved = await sessionStore.get(); if (!saved) return; const result = await api<{ user: User; session: { id: string; createdAt: string; expiresAt: string } }>("/api/native/auth/me", { token: saved }); setToken(saved); setUser(result.user); }
    catch (caught) { if (caught instanceof ApiError && caught.status === 401) await sessionStore.clear(); else setBootError((caught as Error).message); }
    finally { setBooting(false); }
  }
  useEffect(() => { void restore(); }, []);
  async function authenticated(nextToken: string, nextUser: User, context?: { created: boolean }) {
    await sessionStore.set(nextToken);
    const resumeCheckout=pendingCheckout.current;
    const resumeNotifications=pendingNotifications.current;
    pendingCheckout.current=false;
    pendingNotifications.current=false;
    setToken(nextToken);setUser(nextUser);setAuthOpen(false);
    setWelcomeVerificationOpen(context?.created===true);
    if(resumeCheckout&&restaurant&&cart.length){setBasketOpen(false);setCheckout(true);}
    if(resumeNotifications&&!context?.created)setNotificationsOpen(true);
  }
  async function logout() { await customerLiveActivity.stop();await customerPush.unregister();if (token) await api("/api/native/auth/logout", { method: "POST", token, body: "{}" }).catch(() => undefined); await sessionStore.clear(); pendingCheckout.current=false;setFocusOrder(null);setFocusContact(null);setAuthOpen(false);setScheduleDraft(null);setDeliveryAddress(null);setToken(null); setUser(null); setUnread(0);setNotificationIds([]); setFocusRestaurantId(null); setPreferredOffer(null); setCart([]); setRestaurant(null); setCheckout(false); setBasketOpen(false); setTab("discover"); }
  function continueBrowsing(){pendingCheckout.current=false;pendingNotifications.current=false;setAuthOpen(false);setCheckout(false);setBasketOpen(false);setTab("discover");}
  function requestCheckout(){pendingNotifications.current=false;setBasketOpen(false);if(!token||!user){pendingCheckout.current=true;setAuthOpen(true);return;}setCheckout(true);}
  function openNotifications(){customerAlerts.acknowledge();if(checkout){Alert.alert("Checkout is open","Return to your basket or finish checkout before opening notifications.");return;}if(!token||!user){pendingCheckout.current=false;pendingNotifications.current=true;setBasketOpen(false);setTab("account");setAuthOpen(true);return;}setNotificationsOpen(true);}
  function selectTab(next:Tab){if(checkout){Alert.alert("Checkout is open","Use the Back button in checkout before changing sections.");return;}pendingCheckout.current=false;pendingNotifications.current=false;setBasketOpen(false);if(next==="inbox")setInboxRoute("messages");setTab(next);setAuthOpen(next!=="discover"&&(!token||!user));}
  function openBasket(){pendingNotifications.current=false;if(checkout){Alert.alert("Checkout is open","Use the Back button in checkout to return safely to your basket.");return;}pendingCheckout.current=false;setAuthOpen(false);setBasketOpen(true);}
  const basketCount=cart.reduce((sum,line)=>sum+line.quantity,0);
  function openOrder(id: string) { pendingCheckout.current=false;pendingNotifications.current=false;setAuthOpen(false);setBasketOpen(false);setFocusOrder(id);setCheckout(false);setTab("orders"); }
  function openOffers(){pendingCheckout.current=false;pendingNotifications.current=false;setAuthOpen(false);setBasketOpen(false);setCheckout(false);setTab("offers");}
  function requestPushSignIn(){pendingCheckout.current=false;pendingNotifications.current=false;setBasketOpen(false);setTab("account");setAuthOpen(true);}
  function openPushTarget(target:CustomerPushTarget){
    setNotificationsOpen(false);customerAlerts.acknowledge();setFocusContact(null);
    if(target.kind==="order"&&target.orderId){openOrder(target.orderId);return;}
    if(target.kind==="offers"){openOffers();return;}
    pendingCheckout.current=false;pendingNotifications.current=false;setAuthOpen(false);setBasketOpen(false);
    if(target.kind==="conversation"&&target.conversationId){setFocusContact({id:target.conversationId,title:"Restaurant messages"});setInboxRoute("messages");setTab("inbox");}
    else if(target.kind==="support"&&target.supportCaseId){setFocusContact({id:target.supportCaseId,title:"Support request",support:true});setInboxRoute("messages");setTab("inbox");}
    else setTab("account");
  }

  const notificationPanel=token&&user?<Modal transparent visible={notificationsOpen} animationType="fade" onRequestClose={()=>setNotificationsOpen(false)}><SafeAreaView style={styles.dialogBackdrop}><View accessibilityViewIsModal style={styles.notificationDialog}><View style={styles.dialogToolbar}><Text style={styles.dialogTitle}>Notifications</Text><Pressable accessibilityRole="button" accessibilityLabel="Close notifications" onPress={()=>setNotificationsOpen(false)} style={styles.dialogClose}><CustomerIcon name="close" size={22} colour={colours.blueDark}/></Pressable></View><InboxScreen embedded key={`notifications:${user.id}`} initialTab="updates" token={token} onUnreadChange={setUnread} onOpenOrder={id=>{setNotificationsOpen(false);openOrder(id);}} onOpenOffers={()=>{setNotificationsOpen(false);openOffers();}} onUseOffer={(id,offerId,campaign)=>{setNotificationsOpen(false);useOffer(id,offerId,campaign);}} onOfferDismissed={id=>setPreferredOffer(current=>current?.offerId===id?null:current)}/></View></SafeAreaView></Modal>:null;
  const showUnreadPrompt=customerUnreadPromptVisible(customerAlerts.pending,customerAlerts.foreground,unread===0||booting||authOpen||checkout||notificationsOpen||conversationOpen||keyboardVisible);
  const welcomeVerificationPanel=token&&user?<Modal transparent visible={welcomeVerificationOpen} animationType="fade" onRequestClose={()=>setWelcomeVerificationOpen(false)}><SafeAreaView style={styles.dialogBackdrop}><View accessibilityViewIsModal style={styles.notificationDialog}><View style={styles.dialogToolbar}><Text style={styles.dialogTitle}>Email verification</Text><Pressable accessibilityRole="button" accessibilityLabel="Close welcome message" onPress={()=>setWelcomeVerificationOpen(false)} style={styles.dialogClose}><CustomerIcon name="close" size={22} colour={colours.blueDark}/></Pressable></View><ScrollView contentContainerStyle={{padding:16,gap:14}}><CustomerEmailVerification review={emailVerification} context="welcome"/><Button onPress={()=>{setWelcomeVerificationOpen(false);if(!emailVerification.canOrder)continueBrowsing();}}>{emailVerification.canOrder?"Continue to Cal-Eats":"Keep browsing"}</Button></ScrollView></View></SafeAreaView></Modal>:null;
  const banner=<><View style={styles.bannerLayer}><CustomerBrandBanner compact={headerCompact} onHome={()=>selectTab("discover")} basketCount={basketCount} onBasket={openBasket} unreadCount={unread} onBell={openNotifications} reminderPending={customerAlerts.pending}/>{token&&user?.role==="customer"?<CustomerEmailVerificationBanner review={emailVerification} onPress={()=>setWelcomeVerificationOpen(true)}/>:null}{showUnreadPrompt?<View accessibilityLiveRegion="polite" style={styles.unreadPrompt}><View style={styles.unreadPromptHeading}><CustomerIcon name="bell" size={23} colour={colours.blue}/><Text style={styles.unreadPromptText}>You have unread notifications</Text></View><View style={styles.unreadPromptActions}><Pressable accessibilityRole="button" onPress={openNotifications} style={styles.unreadPromptView}><Text style={styles.unreadPromptViewText}>View notifications</Text></Pressable><Pressable accessibilityRole="button" onPress={customerAlerts.acknowledge} style={styles.unreadPromptDismiss}><Text style={styles.unreadPromptDismissText}>Dismiss</Text></Pressable></View></View>:null}</View>{notificationPanel}{welcomeVerificationPanel}</>;
  const navigation=<View style={styles.nav}>{tabs.map(item=><Pressable accessibilityRole="tab" accessibilityLabel={item.label+(item.id==="inbox"&&unread>0?`, ${unread} unread notifications`:"")} accessibilityState={{selected:tab===item.id}} key={item.id} onPress={()=>selectTab(item.id)} style={[styles.navItem,tab===item.id&&styles.navSelected]}>{tab===item.id?<View style={styles.navIndicator}/>:null}<View style={[styles.navIconGlow,tab===item.id&&styles.navIconGlowSelected]}><CustomerTabIcon name={item.id} active={tab===item.id}/>{item.id==="inbox"&&unread>0?<View style={styles.navBadge}><Text style={styles.navBadgeText}>{unread>99?"99+":unread}</Text></View>:null}</View><Text style={[styles.navLabel,tab===item.id&&styles.navActive]}>{item.label}</Text></Pressable>)}</View>;
  if(booting)return <SafeAreaView style={styles.shell}><StatusBar style="dark"/>{banner}<View style={styles.center}><ActivityIndicator size="large" color={colours.blue}/><Text style={styles.muted}>Opening Cal-Eats…</Text></View></SafeAreaView>;
  if(bootError&&!user)return <SafeAreaView style={styles.shell}><StatusBar style="dark"/>{banner}<View style={styles.center}><ErrorBanner message={bootError}/><Button onPress={()=>void restore()}>Try again</Button><Button tone="quiet" onPress={()=>setBootError("")}>Browse restaurants</Button></View>{navigation}</SafeAreaView>;
  if(authOpen||((!token||!user)&&tab!=="discover"&&!basketOpen))return <SafeAreaView style={styles.shell}><StatusBar style="dark"/>{banner}<AuthScreen onAuthenticated={authenticated} onContinueBrowsing={continueBrowsing}/>{navigation}</SafeAreaView>;
  if (basketOpen && !restaurant) return <SafeAreaView style={styles.shell}><StatusBar style="dark"/>{banner}<View style={styles.center}><Text style={{fontSize:28,fontWeight:"800",color:colours.ink}}>Your basket is empty</Text><Text style={styles.muted}>Choose a restaurant and add something you fancy. Your items stay in your basket while you browse the app.</Text><Button onPress={continueBrowsing}>Browse restaurants</Button><Button tone="quiet" onPress={()=>setBasketOpen(false)}>Back</Button></View>{navigation}</SafeAreaView>;
  if (basketOpen && restaurant) return <SafeAreaView style={styles.shell}><StatusBar style="dark"/>{banner}<BasketScreen onScrollOffset={onScrollOffset} token={token||""} restaurant={restaurant} cart={cart} fulfillment={fulfillment} initialAddress={deliveryAddress} onOffer={offerId=>setPreferredOffer(offerId?{restaurantId:restaurant.id,offerId}:null)} onCart={setCart} onBack={()=>setBasketOpen(false)} onCheckout={requestCheckout}/>{navigation}</SafeAreaView>;
  if (checkout && restaurant && token && user) return <SafeAreaView style={styles.shell}><StatusBar style="dark"/>{banner}<KeyboardAvoidingView style={styles.content} behavior={Platform.OS === "ios" ? "padding" : undefined}><CheckoutScreen emailVerification={emailVerification} initialPhone={user.phone||""} initialSchedule={scheduleDraft?.restaurantId===restaurant.id&&scheduleDraft?.fulfillment===fulfillment?scheduleDraft:null} onScheduleChange={choice=>setScheduleDraft({...choice,restaurantId:restaurant.id,fulfillment})} onScrollOffset={onScrollOffset} initialAddress={deliveryAddress} onAddress={setDeliveryAddress} onOfferResolved={offerId=>setPreferredOffer(offerId?{restaurantId:restaurant.id,offerId}:null)} token={token} restaurant={restaurant} cart={cart} fulfillment={fulfillment} onBack={() => {setCheckout(false);setBasketOpen(true);}} onCheckOrders={() => { setCart([]); setPreferredOffer(null); setCheckout(false); setTab("orders"); }} onOrdered={(order) => {void customerLiveActivity.refresh();setScheduleDraft(null); setCart([]); setPreferredOffer(null); setCheckout(false); openOrder(order.id); }}/></KeyboardAvoidingView>{navigation}</SafeAreaView>;

  return <SafeAreaView style={styles.shell}><StatusBar style="dark"/>{banner}<KeyboardAvoidingView style={styles.content} behavior={Platform.OS === "ios" ? "padding" : undefined}>
    {tab === "discover" ? <DiscoverScreen onScrollOffset={onScrollOffset} userId={user?.id||"guest"} address={deliveryAddress} onAddress={setDeliveryAddress} onUseOffer={useOffer} focusRestaurantId={focusRestaurantId} onRestaurantFocused={() => setFocusRestaurantId(null)} token={token||""} fulfillment={fulfillment} onFulfillment={setFulfillment} restaurant={restaurant} cart={cart} onRestaurant={setRestaurant} onCart={setCart} onCheckout={() => setBasketOpen(true)}/> : null}
    {tab === "orders" && token ? <OrdersScreen onConversationActiveChange={setConversationOpen} onScrollOffset={onScrollOffset} token={token} focusOrder={focusOrder} onFocused={() => setFocusOrder(null)}/> : null}
    {tab === "offers" && token ? <InboxScreen onConversationActiveChange={setConversationOpen} onScrollOffset={onScrollOffset} key="offers" initialTab="offers" token={token} onOpenOrder={openOrder} onUseOffer={useOffer} onOfferDismissed={id=>setPreferredOffer(current=>current?.offerId===id?null:current)} onUnreadChange={setUnread}/> : null}
    {tab === "inbox" && token ? <InboxScreen onConversationActiveChange={setConversationOpen} onScrollOffset={onScrollOffset} key={`messages:${inboxRoute}`} initialTab={inboxRoute} focusContact={focusContact} onContactFocused={()=>setFocusContact(null)} token={token} onOpenOrder={openOrder} onUseOffer={useOffer} onOfferDismissed={id=>setPreferredOffer(current=>current?.offerId===id?null:current)} onUnreadChange={setUnread}/> : null}
    {tab === "account" && token && user ? <AccountScreen emailVerification={emailVerification} onScrollOffset={onScrollOffset} token={token} user={user} onUser={bindCustomerProfileUpdate<User>(token,user.id,()=>tokenRef.current,setUser)} onLogout={logout} onConversationActiveChange={setConversationOpen} phoneNotifications={customerPush.state} onPhoneNotifications={customerPush.requestPermission}/> : null}
  </KeyboardAvoidingView>{navigation}</SafeAreaView>;
}

const styles = StyleSheet.create({
  bannerLayer:{flexShrink:0,zIndex:20},
  unreadPrompt:{marginHorizontal:12,marginVertical:8,padding:15,gap:11,borderRadius:18,borderWidth:1,borderColor:"#AACDEF",backgroundColor:"#F5FAFF",shadowColor:"#1C4F7D",shadowOpacity:.17,shadowRadius:16,shadowOffset:{width:0,height:5},elevation:9},
  unreadPromptHeading:{flexDirection:"row",alignItems:"center",gap:10},
  unreadPromptText:{flex:1,color:colours.ink,fontSize:16,lineHeight:23,fontWeight:"800"},
  unreadPromptActions:{flexDirection:"row",alignItems:"center",gap:10},
  unreadPromptView:{minHeight:44,paddingHorizontal:15,borderRadius:12,justifyContent:"center",backgroundColor:colours.blue},
  unreadPromptViewText:{color:colours.white,fontWeight:"800",fontSize:14},
  unreadPromptDismiss:{minHeight:44,paddingHorizontal:14,justifyContent:"center"},
  unreadPromptDismissText:{color:colours.blueDark,fontWeight:"700",fontSize:14},
  dialogBackdrop:{flex:1,justifyContent:"center",padding:16,backgroundColor:"rgba(37,78,117,.4)"},
  notificationDialog:{height:"82%",width:"100%",maxWidth:640,alignSelf:"center",backgroundColor:colours.panel,borderWidth:1,borderColor:colours.line,borderRadius:20,overflow:"hidden"},
  dialogToolbar:{minHeight:60,paddingHorizontal:16,flexDirection:"row",alignItems:"center",justifyContent:"space-between",borderBottomWidth:1,borderBottomColor:colours.line,backgroundColor:"#F2F8FF"},
  dialogTitle:{color:colours.ink,fontSize:20,fontWeight:"800"},
  dialogClose:{width:44,height:44,alignItems:"center",justifyContent:"center",borderRadius:14,backgroundColor:colours.sky},
  dialogCloseText:{color:colours.blueDark,fontSize:30,lineHeight:34},
  shell: { flex: 1, backgroundColor: colours.cream }, content: { flex: 1 }, center: { flex: 1, padding: 30, gap: 22, justifyContent: "center", alignItems: "stretch", backgroundColor: colours.cream }, muted: { color: colours.muted, textAlign: "center" }, nav: { flexShrink:0,minHeight:74,paddingHorizontal:6,paddingVertical:5,borderTopWidth:1,borderTopColor:colours.line,backgroundColor:colours.panel,flexDirection:"row",shadowColor:"#173C68",shadowOpacity:.08,shadowRadius:9,elevation:5 }, navBadge:{position:"absolute",right:-9,top:-5,minWidth:19,height:19,paddingHorizontal:4,borderRadius:10,alignItems:"center",justifyContent:"center",backgroundColor:colours.blue,borderWidth:1.5,borderColor:colours.panel},navBadgeText:{fontSize:10,fontWeight:"800",color:colours.white},navIndicator:{position:"absolute",top:2,width:22,height:3,borderRadius:2,backgroundColor:colours.blue},navIconGlowSelected:{backgroundColor:"#DDEFFF",shadowOpacity:.3},navIconGlow:{width:36,height:32,borderRadius:14,alignItems:"center",justifyContent:"center",backgroundColor:"#EDF6FF",shadowColor:colours.blue,shadowOpacity:.24,shadowRadius:6,shadowOffset:{width:0,height:0},elevation:2}, navSelected:{backgroundColor:"#DCEEFF",borderColor:"#D8E9F8",shadowColor:colours.blue,shadowOpacity:.14,shadowRadius:8,shadowOffset:{width:0,height:0}}, navItem:{flex:1,minHeight:60,marginHorizontal:2,borderRadius:15,borderWidth:1,borderColor:"transparent",justifyContent:"center",alignItems:"center",gap:4,paddingTop:5}, navIcon: { fontSize: 20, color: colours.muted, fontWeight: "700" }, navLabel: { fontSize: 11, color: colours.muted, fontWeight: "700" }, navActive: { color: colours.blue } });
