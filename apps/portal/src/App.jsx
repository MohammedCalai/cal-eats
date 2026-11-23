import "./AdminShell.css";
import {PlatformAdminLogin,PlatformAdminShell,PlatformConnection} from "./CalaiPlatform.jsx";
import {AdminResolutionHistory} from "./ResolutionHistory.jsx";
import BusinessSoundSetting from "./BusinessSoundSetting.jsx";
import BusinessHomeLink from "./BusinessHomeLink.jsx";
import TabletConnectionControls from "./TabletConnectionControls.jsx";
import {BusinessMessageReminderProvider} from "./BusinessMessageReminder.jsx";
import "./BusinessOrders.css";
import { canPrintOrderReceipt, orderCustomerName, orderDeliveryAddress, orderDestination, orderStatusText, orderDatePreset } from "./order-presentation.js";
import { deliveryDeadlineAt, deliveryDispatchWarning } from "./delivery-deadline.js";
import { DeliveryDeadlineBadge, useDeliveryDeadlineClock } from "./DeliveryDeadline.jsx";
import CalaiPrinters from "./CalaiPrinters.jsx";
import OrderReceiptPrintDialog from "./OrderReceiptPrintDialog.jsx";
import "./Settings.css";
import { useSidebarLayout } from "./sidebar-layout.js";
import ServiceAreas from "./ServiceAreas.jsx";
import MenuItemEditor from "./BusinessMenuEditor.jsx";
import Loyalty from "./Loyalty.jsx";
import { CustomerDirectory, CustomerInbox, WorkspaceDialog } from "./CustomerWorkspace.jsx";
import SupportWorkspace from "./SupportWorkspace.jsx";
import AdminSupportOverview from "./AdminSupportOverview.jsx";
import { businessReturnPath } from "./model.js";
import RefinedMenu from "./MenuWorkspace.jsx";
import DeliverySettings from "./DeliverySettings.jsx";
import OwnerDashboardView, { DashboardCsvDownload } from "./OwnerDashboard.jsx";
import { OrderActivityDashboard } from "./DashboardOrderActivity.jsx";
import EarningsPage from "./EarningsPage.jsx";
import MerchantAgreement from "./MerchantAgreement.jsx";
import OrderFinancialBreakdown from "./OrderFinancialBreakdown.jsx";
import { useFinanceResource } from "./finance-resource.js";
import { OrderAlertProvider, useOrderAlerts } from "./NewOrderAlerts.jsx";
import { businessOrderTransitions } from "./order-alert-model.js";
import { OrderConversation, MessagingSettings } from "./OrderMessaging.jsx";
import { NotificationsPanel } from "./NotificationsPanel.jsx";
import { StripeAdminReadiness } from "./StripePayments.jsx";
import { connectLiveNotifications } from "../../web/live-notifications.js";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Navigate, Outlet, Route, Routes, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { api, json, newKey, setBusinessApiPrincipal } from "./api.js";
import { connectAutomaticTerminal, disconnectLocalTerminal, terminalStatus, terminalApi, recheckLoopbackPermission, clearTabletDiscoveryHint, subscribeTerminalStatus } from "./terminal-client.js";
import {createBusinessBootstrap} from "./business-bootstrap.js";
import { BusinessWorkspaceProvider, useBusinessWorkspace, BusinessAccountSwitcher, BusinessConnections, NativeCalaiView, ProductStatements, AdminBusinessAccounts, EmbeddedSessionBridge, StaffCapabilityControls } from "./UnifiedBusiness.jsx";
import { businessNavigation, productPresentation, operationalTabletFor, businessToolPermissions, canLoadEatsRestaurantWorkspace, dashboardOrderProducts } from "./unified-business-model.js";
import { endOperationalPresence,resumeOperationalPresenceAfterSignIn } from "./surface-presence-client.js";
import { adminNavigation, listItems, ownerNavigation, ownerMobileNavigation, parseMenuCsv, pounds, poundsInputMinor, roleHome, shortDate } from "./model.js";

const AdminCustomers=React.lazy(()=>import("./AdminCustomers.jsx"));
const AdminRestaurantsWorkspace=React.lazy(()=>import("./AdminRestaurantsWorkspace.jsx"));
const AdminDashboardWorkspace=React.lazy(()=>import("./AdminDashboardWorkspace.jsx"));
const AdminOrdersWorkspace=React.lazy(()=>import("./AdminOrdersWorkspace.jsx"));
const AdminFinanceWorkspace=React.lazy(()=>import("./AdminFinanceWorkspace.jsx"));
const AdminOperationsWorkspace=React.lazy(()=>import("./AdminOperationsWorkspace.jsx"));
const AdminAccessWorkspace=React.lazy(()=>import("./AdminOperationsWorkspace.jsx").then(module=>({default:module.AdminAccessWorkspace})));
const AdminTablets=React.lazy(()=>import("./AdminTablets.jsx"));
const CalaiPlatformPage=React.lazy(()=>import("./CalaiPlatformPages.jsx").then(module=>({default:module.CalaiPlatformPage})));
const SessionContext = React.createContext(null);
const RestaurantContext = React.createContext(null);
const BUSINESS_ROLES = new Set(["admin", "restaurant", "owner", "staff"]);
const canDiscoverTablet = user => (/Win/i.test(globalThis.navigator?.platform || "") || /Windows/i.test(globalThis.navigator?.userAgent || "")) && (!user || BUSINESS_ROLES.has(user.role));
function OwnerStripeFinance(){return <Navigate to="/owner/earnings?view=payouts" replace/>}

function useLoad(loader, deps = []) {
  const [state, setState] = useState({ loading: true, value: null, error: "" });
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    const request = ++sequence.current;
    setState((old) => ({ ...old, loading: old.value === null, error: "" }));
    try { const value = await loader(); if (request === sequence.current) setState({ loading: false, value, error: "" }); }
    catch (error) { if (request === sequence.current) setState({ loading: false, value: null, error: error.message }); }
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); return () => { sequence.current++; }; }, [reload]);
  return { ...state, reload };
}

function Brand() {
  return <span className="brand"><img className="brand-logo" src="/assets/cal-eats-logo.png" alt="Cal-Eats" /><svg className="brand-mark" role="img" aria-label="Cal-Eats" viewBox="420 180 330 380"><image href="/assets/cal-eats-logo.png" width="2170" height="725"/></svg></span>;
}

function TabletConnectionAccess() {
  const { user, embedded, connectTablet, recheckTablet, automaticSignInSuspended } = React.useContext(SessionContext);
  return <TabletConnectionControls enabled={Boolean(user) && canDiscoverTablet(user)} suspended={automaticSignInSuspended} embedded={embedded} onConnect={connectTablet} onRecheck={recheckTablet}/>;
}

function App() {
  const [session, setSession] = useState({ loading: true, user: null, generation: 0 });
  const embedded = useRef(window.parent !== window && window.location.pathname.startsWith("/business/embedded"));
  const bootstrap = useRef(null);
  if (!bootstrap.current) bootstrap.current = createBusinessBootstrap({
    readHuman: options => api("/api/auth/me", { ...options, humanSession: true }),
    connectTerminal: connectAutomaticTerminal,
    readTerminal: options => terminalApi("/api/auth/me", options),
    terminalStatus,
    onSignOut: clearTabletDiscoveryHint,
    // Platform detection only avoids unnecessary local discovery on phones;
    // it cannot confer operational permission without a signed native grant.
    canDiscover: canDiscoverTablet,
    setPrincipal: setBusinessApiPrincipal,
    onLoading: () => setSession(old => ({ ...old, loading: true })),
    onSession: result => setSession(old => ({ ...old, loading: false, user: result.user, generation: old.generation + 1 })),
    onTerminal: ({afterSignIn, restored}) => {
      if (restored) { window.dispatchEvent(new Event("cal-eats-terminal-session-restored")); return; }
      if (afterSignIn) resumeOperationalPresenceAfterSignIn();
      setSession(old => ({ ...old, terminalRevision: (old.terminalRevision || 0) + 1 }));
    }
  });
  const refresh = useCallback(options => bootstrap.current.refresh(options), []);
  const connectTablet = useCallback(() => bootstrap.current.connectFromInteraction(), []);
  const recheckTablet = useCallback(async () => {
    if (bootstrap.current.isSuspended()) throw Error("Sign in to your business account before reconnecting this tablet.");
    const permission = await recheckLoopbackPermission();
    if (permission === "granted" && !bootstrap.current.isSuspended()) await refresh();
  }, [refresh]);
  const suspendAutomaticSignIn = useCallback(() => bootstrap.current.signOut(), []);
  useEffect(() => { void refresh(); return () => bootstrap.current.stop(); }, [refresh]);
  useEffect(() => subscribeTerminalStatus(bootstrap.current.observeTerminal), []);
  useEffect(()=>{const restored=()=>setSession(old=>({...old,terminalRevision:(old.terminalRevision||0)+1}));window.addEventListener("cal-eats-terminal-session-restored",restored);return()=>window.removeEventListener("cal-eats-terminal-session-restored",restored);},[]);
  if (session.loading) return <PageState text="Opening business platform…" />;
  return <SessionContext.Provider value={{ ...session, refresh, setSession, suspendAutomaticSignIn, connectTablet, recheckTablet, automaticSignInSuspended:bootstrap.current.isSuspended(), embedded:embedded.current }}><EmbeddedSessionBridge enabled={embedded.current} user={session.user}/><Routes>
    <Route path="/login" element={<Login />} />
    <Route path="/embedded" element={<Navigate to="/owner/connections" replace/>}/>
    <Route path="/admin/login" element={<PlatformAdminLogin user={session.user} onSignedIn={()=>refresh({afterSignIn:true})}/>} />
    <Route element={<RequireSession />}>
      <Route path="/" element={<PortalHome />} />
      <Route path="/owner" element={<OwnerBootstrap />}>
        <Route element={<Shell kind="owner" />}>
          <Route path="dashboard" element={<OwnerDashboard />} />
          <Route path="connections" element={<BusinessConnections tabletConnection={<TabletConnectionAccess/>}/>}/>
          <Route path="statements" element={<ProductStatements/>}/>
          <Route path="devices" element={<Navigate to="/owner/printers" replace/>}/>
          <Route path="calai/orders" element={<NativeCalaiView section="orders"/>}/>
          <Route path="calai/calls" element={<NativeCalaiView section="calls"/>}/>
          <Route path="calai/settings" element={<NativeCalaiView section="settings"/>}/>
          <Route element={<RequireEatsAccount/>}>
          <Route path="orders" element={<Orders />} />
          <Route path="menu" element={<Menu />} />
          <Route path="inbox" element={<CustomerTools view="inbox" />} />
          <Route path="customers" element={<CustomerTools view="customers" />} />
          <Route path="offers" element={<CustomerTools view="offers" />} />
          <Route path="support" element={<OwnerSupport />} />
          <Route path="printers" element={<Printers />} />
          <Route path="earnings" element={<FinanceOnly><Earnings /></FinanceOnly>} />
          <Route path="agreement" element={<OwnerOnly><OwnerMerchantAgreement /></OwnerOnly>} />
          <Route path="stripe" element={<OwnerOnly><OwnerStripeFinance /></OwnerOnly>} />
          <Route path="refunds" element={<OwnerOnly><Navigate to="/owner/support?scope=customer" replace/></OwnerOnly>} />
          <Route path="settings" element={<OwnerOnly><Settings /></OwnerOnly>} />
          </Route>
        </Route>
      </Route>
      <Route path="/admin" element={<React.Suspense fallback={<PageState text="Opening admin tools…"/>}><RequireRole role="admin" /></React.Suspense>}>
        <Route element={<PlatformAdminShell user={session.user} onRefresh={refresh}/>}>
          <Route path="connection" element={<PlatformConnection/>}/>
          <Route path="calai/dashboard" element={<CalaiPlatformPage section="dashboard"/>}/>
          <Route path="calai/ai-training" element={<CalaiPlatformPage section="training"/>}/>
          <Route path="calai/tenants" element={<CalaiPlatformPage section="tenants"/>}/>
          <Route path="calai/tenants/:tenantId" element={<CalaiPlatformPage section="tenant"/>}/>
          <Route path="calai/telephony" element={<CalaiPlatformPage section="telephony"/>}/>
          <Route path="calai/billing" element={<CalaiPlatformPage section="billing"/>}/>
          <Route path="calai/settings" element={<CalaiPlatformPage section="settings"/>}/>
          <Route path="dashboard" element={<AdminDashboard />} />
          <Route path="restaurants" element={<AdminRestaurants />} />
          <Route path="business-accounts" element={<AdminBusinessAccounts/>}/>
          <Route path="tablets" element={<AdminTablets/>}/>
          <Route path="surface-monitoring" element={<Navigate to="/admin/tablets" replace/>}/>
          <Route path="customers" element={<AdminCustomers />} />
          <Route path="orders" element={<AdminOrdersWorkspace />} />
          <Route path="finance" element={<AdminFinanceWorkspace />} />
          <Route path="stripe" element={<Page title="Payment readiness" intro="Payment setup, restaurant verification and bank payout status."><StripeAdminReadiness /></Page>} />
          <Route path="refunds" element={<AdminRefunds />} />
          <Route path="governance" element={<AdminGovernance />} />
          <Route path="support" element={<SupportWorkspace kind="admin" />} />
          <Route path="operations" element={<AdminOperations />} />
          <Route path="service-areas" element={<ServiceAreas />} />
        </Route>
      </Route>
    </Route>
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes></SessionContext.Provider>;
}

function RequireSession() { const { user } = React.useContext(SessionContext); const location=useLocation(); return user ? <Outlet /> : <Navigate to={location.pathname.startsWith("/admin/")?"/admin/login":"/login"} state={{returnTo:`${location.pathname}${location.search}`}} replace />; }
function PortalHome() { const { user } = React.useContext(SessionContext); return BUSINESS_ROLES.has(user?.role) ? <Navigate to={roleHome(user.role)} replace /> : <BusinessAccessUnavailable />; }
function RequireRole({ role }) { const { user } = React.useContext(SessionContext); return user?.role === role ? <Outlet /> : BUSINESS_ROLES.has(user?.role) ? <Denied /> : <BusinessAccessUnavailable />; }
function useRestaurantTools(){const context=React.useContext(RestaurantContext),workspace=useBusinessWorkspace();return businessToolPermissions({permission:context?.permission,capabilities:context?.restaurant?.capabilities,principalKind:workspace?.business?.principalKind});}
function FinanceOnly({children}){const tools=useRestaurantTools();return tools.viewFinance?children:<Denied message="Financial viewing permission is required for this restaurant."/>;}
function OwnerOnly({ children }) { const { permission, restaurant } = React.useContext(RestaurantContext); return restaurant && permission === "owner" ? children : <Denied message="A Cal-Eats account with owner permission is required." />; }
function RequireEatsAccount() {
  const context = React.useContext(RestaurantContext), workspace = useBusinessWorkspace();
  if (workspace?.business?.products?.["cal-eats"]?.allowedOnTablet === false) return <Navigate to="/owner/dashboard" replace/>;
  if (context?.eatsError) return <section className="panel">
    <h1>Cal-Eats tools unavailable</h1>
    <button className="quiet" type="button" onClick={context.refreshRestaurants}>Try again</button>
  </section>;
  return context?.restaurant ? <Outlet/> : <section className="panel">
    <h1>Cal-Eats account required</h1><p>Connect an authorised Cal-Eats restaurant account to open this section.</p>
    <NavLink className="button-link" to="/owner/connections">Accounts & connections</NavLink>
  </section>;
}

function Login() {
  const { user, refresh, embedded } = React.useContext(SessionContext), navigate=useNavigate(),location=useLocation();
  const [mode,setMode]=useState(embedded?"calai":"cal-eats"),[error,setError]=useState(""),[busy,setBusy]=useState(false),formRef=useRef(null),inFlight=useRef(false);
  if(user)return BUSINESS_ROLES.has(user.role)?<Navigate to={businessReturnPath(location.state?.returnTo,user.role)} replace/>:<BusinessAccessUnavailable/>;
  function choose(next){if(inFlight.current)return;formRef.current?.reset();setError("");setMode(next);}
  async function submit(event){
    event.preventDefault();if(inFlight.current)return;const form=event.currentTarget,fields=new FormData(form),endpoint=mode==="calai"?"/api/business/auth/calai/login":"/api/auth/login";
    inFlight.current=true;setBusy(true);setError("");
    try{const signed=await api(endpoint,json("POST",{email:String(fields.get("email")||"").trim(),password:String(fields.get("password")||"")}));form.reset();const target=businessReturnPath(location.state?.returnTo,signed.user?.role);await refresh({afterSignIn:true});navigate(target,{replace:true});}
    catch(caught){setError(caught.message);}
    finally{const password=form.elements.namedItem("password");if(password)password.value="";inFlight.current=false;setBusy(false);}
  }
  return <main className="auth"><section className="auth-card"><Brand/><p className="eyebrow">{mode==="calai"?"Calai business connection":"Cal-Eats Business"}</p><h1>{mode==="calai"?"Verify your Calai business account":"Sign in to the business platform"}</h1><p>{mode==="calai"?"Use your existing Calai owner sign-in to open its authorised business connection. Calai and Cal-Eats keep separate native accounts and permissions.":"Restaurant teams and Cal-Eats administrators use this platform. Your account determines the tools you can access."}</p>{error&&<Alert>{error}</Alert>}<form ref={formRef} onSubmit={submit}><Field label={mode==="calai"?"Calai owner email":"Email"} name="email" type="email" required disabled={busy} autoComplete="username"/><Field label={mode==="calai"?"Calai password":"Password"} name="password" type="password" required disabled={busy} autoComplete="current-password"/><button className="primary" disabled={busy}>{busy?"Signing in…":mode==="calai"?"Verify Calai account":"Sign in"}</button></form><p><button className="quiet" type="button" disabled={busy} onClick={()=>choose(mode==="calai"?"cal-eats":"calai")}>{mode==="calai"?"Use a Cal-Eats account instead":"Use your existing Calai business account"}</button></p><p>New to Cal-Eats? <a href="/order/?view=register-restaurant">List your restaurant</a></p><p className="fine">Payment availability, bank payouts and printer connections are shown in your workspace.</p></section></main>;
}

function OwnerBootstrap() {
  const { user, embedded } = React.useContext(SessionContext);
  return <BusinessWorkspaceProvider key={user.id} userId={user.id} embedded={embedded}><OwnerRestaurantWorkspace user={user}/></BusinessWorkspaceProvider>;
}

function OwnerRestaurantWorkspace({ user }) {
  const workspace = useBusinessWorkspace(), selectedBusinessId = workspace?.business?.id;
  const needsEats = canLoadEatsRestaurantWorkspace(workspace?.business);
  const result = useLoad(() => needsEats ? api("/api/restaurant/restaurants") : [], [user.id, needsEats]);
  const storageKey = `cal-eats:business:last-restaurant:${user.id}`;
  const eatsError = needsEats && Boolean(result.error);
  const restaurants = needsEats && !eatsError ? listItems(result.value) : [];
  const [selected, setSelectedId] = useState(() => {
    try { return window.localStorage.getItem(storageKey) || ""; } catch { return ""; }
  });
  const scopedRestaurant = workspace?.business?.eatsRestaurantId;
  const restaurant = restaurants.find(item => item.id === scopedRestaurant) ?? null;
  useEffect(() => {
    if (result.loading || result.error) return;
    if (restaurant && selected !== restaurant.id) setSelectedId(restaurant.id);
    try {
      if (restaurant) window.localStorage.setItem(storageKey, restaurant.id);
      else window.localStorage.removeItem(storageKey);
    } catch { /* The workspace also works when browser storage is unavailable. */ }
  }, [restaurant?.id, selected, storageKey, result.loading, result.error]);
  const setSelected = useCallback(id => {
    const authorized = restaurants.find(item => item.id === id);
    if (!authorized) return;
    setSelectedId(authorized.id);
    try { window.localStorage.setItem(storageKey, authorized.id); } catch { /* Keep the current in-memory selection. */ }
  }, [restaurants, storageKey]);
  if (!["restaurant", "owner", "staff"].includes(user.role)) return BUSINESS_ROLES.has(user.role) ? <Denied /> : <BusinessAccessUnavailable />;
  if (needsEats && result.loading) return <PageState text="Loading your business…"/>;
  if (eatsError && !dashboardOrderProducts(workspace?.business).includes("calai")) return <PageState error={result.error} retry={result.reload}/>;
  const permission = restaurant?.permission || restaurant?.membershipPermission || "staff";
  return <RestaurantContext.Provider key={selectedBusinessId} value={{ restaurant, restaurants, setSelected, permission, eatsError, refreshRestaurants:result.reload }}><Outlet /></RestaurantContext.Provider>;
}

function NavIcon({label}) {
  const paths={Menu:"M4 5h16M4 12h16M4 19h16",Inbox:"M3 5h18v14H3zM3 12h5l2 3h4l2-3h5",Customers:"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M20 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",Offers:"M3 3h8l10 10-8 8L3 11zM7 7h.01",Cases:"M8 3h8v4H8zM8 5H5v16h14V5h-3M9 12h6M9 16h6",Home:"M3 11 12 3l9 8M5 10v11h14V10M9 21v-7h6v7",Orders:"M5 3h14v18l-3-2-4 2-4-2-3 2zM8 8h8M8 12h8"};
  const tools={Account:"M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M4 22v-3a8 8 0 0 1 16 0v3",Down:"M6 9l6 6 6-6",Toggle:"M4 6h16M4 12h16M4 18h16",Close:"M6 6l12 12M18 6 6 18",More:"M4 12h.01M12 12h.01M20 12h.01",location:"M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0M15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0",Printers:"M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6zM18 12h.01",Support:"M3 14v-3a9 9 0 0 1 18 0v3M3 12h4v8H3zM17 12h4v8h-4zM17 20c0 2-3 2-5 2",Settings:"M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z",bank:"M3 8l9-5 9 5H3zM5 11v7M10 11v7M15 11v7M20 11v7M3 21h18",card:"M2 8h20M4 3h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2M6 16h4",Restaurants:"M3 10h18L19 3H5zM4 10v11h16V10M8 21v-7h8v7",Operations:"M3 12h4l3-8 4 16 3-8h4",clock:"M12 6v6l4 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0"};
  const key=({"Service areas":"location",Marketing:"Offers",Dashboard:"Home","Refund cases":"Cases","Earnings & payouts":"bank",Finance:"bank","Stripe setup":"card","Stripe readiness":"card","Access & deadlines":"clock","Account access":"clock","Payment readiness":"card","Resolution history":"Cases"})[label]||label;
  return <svg aria-hidden="true" viewBox="0 0 24 24"><path d={paths[key]||tools[key]||paths.Home}/></svg>;
}
function Shell({ kind }) {
  const { user, refresh, suspendAutomaticSignIn } = React.useContext(SessionContext), owner = React.useContext(RestaurantContext), workspace = useBusinessWorkspace();
  const { desktop, collapsed, toggleDesktop } = useSidebarLayout(), [open, setOpen] = useState(false), [messageCount,setMessageCount]=useState(0), location=useLocation();
  const business=workspace?.business, hasEats=Boolean(owner?.restaurant), canOperate=operationalTabletFor(business?.id,owner?.restaurant?.id,workspace?.terminal);
  const tools=businessToolPermissions({permission:owner?.permission,capabilities:owner?.restaurant?.capabilities,principalKind:business?.principalKind});
  const groups=businessNavigation(business,hasEats?ownerNavigation(owner.permission,tools):[]), nav=groups.flatMap(group=>group.items);
  const mobileNav=hasEats?ownerMobileNavigation(owner.permission,tools):[["Home","/owner/dashboard"],["Accounts","/owner/connections"]];
  useEffect(()=>{setOpen(false);window.scrollTo({top:0,left:0,behavior:"instant"});},[location.pathname]);
  useEffect(()=>{const close=event=>{if(event.key==="Escape")setOpen(false);},counts=event=>setMessageCount(event.detail?.messages||0);addEventListener("keydown",close);addEventListener("cal-eats-notification-counts",counts);return()=>{removeEventListener("keydown",close);removeEventListener("cal-eats-notification-counts",counts);};},[]);
  async function selectRestaurant(id){const account=workspace.accounts.find(row=>row.eatsRestaurantId===id);if(account)await workspace.selectAccount(account.id);}
  async function logout(){suspendAutomaticSignIn();await endOperationalPresence();await api("/api/auth/logout",{...json("POST",{}),humanSession:true}).catch(()=>{});disconnectLocalTerminal();await refresh();}
  const showHeaderShortcuts=location.pathname.replace(/\/+$/,"")!=="/owner/dashboard";
  return <OrderAlertProvider operationalRestaurantId={owner?.restaurant?.id} enabled={hasEats&&canOperate} restaurants={owner?.restaurants} onSelectRestaurant={selectRestaurant} onRefreshRestaurants={owner?.refreshRestaurants} userId={user.id}><BusinessMessageReminderProvider enabled={hasEats} userId={user.id} restaurantId={owner?.restaurant?.id}><div className={`portal calai-theme${collapsed?" sidebar-collapsed":""}`}><a className="skip" href="#portal-main">Skip to content</a>{open&&!desktop&&<button className="sidebar-shade" aria-label="Close navigation" onClick={()=>setOpen(false)}/>}<aside id="business-navigation" inert={!desktop&&!open?true:undefined} className={open?"sidebar open":"sidebar"}><div className="sidebar-top"><Brand/><button className="icon-button mobile-only" onClick={()=>setOpen(false)} aria-label="Close menu"><NavIcon label="Close"/></button></div><BusinessAccountSwitcher/><nav aria-label="Business navigation">{groups.map(group=><section className="business-nav-section" key={group.title}>{group.title&&<h2>{group.title}</h2>}{group.items.map(([label,path])=><NavLink key={path} to={path} title={label} aria-label={path==="/owner/inbox"&&messageCount>0?`${label}, ${messageCount} unread messages`:label}><span className="sidebar-nav-icon"><NavIcon label={label}/></span><span className="sidebar-nav-label">{label}</span>{path==="/owner/inbox"&&messageCount>0&&<b className="nav-count">{messageCount}</b>}</NavLink>)}</section>)}</nav><div className="sidebar-note"><strong>{hasEats&&owner.permission==="staff"?"Restaurant staff":"Business account"}</strong><span>{user.name}</span><button className="quiet mobile-only" onClick={()=>void logout()}>Sign out</button></div></aside><div className="portal-body"><header className={`topbar business-header${showHeaderShortcuts?" business-header--with-shortcuts":""}`}><div className="business-header-identity"><button className="icon-button menu-button" onClick={()=>desktop?toggleDesktop():setOpen(value=>!value)} aria-label={desktop?(collapsed?"Expand side menu":"Collapse side menu"):(open?"Close menu":"Open menu")} aria-controls="business-navigation" aria-expanded={desktop?!collapsed:open}><NavIcon label="Toggle"/></button><div className="topbar-title"><span className="eyebrow">{business?.name||owner?.restaurant?.name||"Business platform"}</span><strong>{nav.find(([,path])=>location.pathname.startsWith(path))?.[0]||"Business platform"}</strong></div></div><nav className="business-header-navigation" aria-label="Business shortcuts" hidden={!showHeaderShortcuts}>{showHeaderShortcuts&&<BusinessHomeLink/>}<NotificationsPanel userId={user.id} restaurantId={owner?.restaurant?.id} enableSound={false} kind="owner" onSelectRestaurant={selectRestaurant} visible={showHeaderShortcuts} labelled/></nav><div className="top-actions"><button className="quiet topbar-signout" onClick={()=>void logout()}>Sign out</button><span className="user-avatar" aria-label={user.name}>{user.name?.slice(0,1)||"C"}</span></div></header><main id="portal-main" className="content" tabIndex={-1}><Outlet/></main><nav className="mobile-bottom-nav" style={{gridTemplateColumns:`repeat(${mobileNav.length+1},minmax(0,1fr))`}} aria-label="Quick business tools">{mobileNav.map(([label,path])=><NavLink key={path} to={path}><span className="nav-icon"><NavIcon label={label}/>{label==="Inbox"&&messageCount>0&&<b className="nav-count">{messageCount}</b>}</span><span>{label}</span></NavLink>)}<button type="button" aria-label="More business tools" onClick={()=>setOpen(true)}><span className="more-icon"><NavIcon label="More"/></span><span>More</span></button></nav></div></div></BusinessMessageReminderProvider></OrderAlertProvider>;
}

function OwnerDashboard() {
  const {user}=React.useContext(SessionContext);
  const { restaurant, permission, eatsError, refreshRestaurants } = React.useContext(RestaurantContext);
  const workspace = useBusinessWorkspace(), business = workspace?.business;
  const canOperate = operationalTabletFor(business?.id, restaurant?.id, workspace?.terminal);
  const products = dashboardOrderProducts(business);
  if (restaurant) return <OwnerDashboardView key={`${restaurant.id}:${permission}`}
    restaurant={restaurant} permission={permission} userId={user.id} canOperate={canOperate}
    business={business} products={products}/>;
  if (products.includes("calai")) return <OrderActivityDashboard business={business} products={products}
    onRetryRestaurant={eatsError ? refreshRestaurants : undefined}/>;
  return <>
    <header className="page-heading"><h1>Dashboard</h1><p>{business?.name}</p></header>
    <section className="panel"><h2>Orders</h2><p>Connect your business account to view orders.</p>
      <NavLink className="button-link" to="/owner/connections">Accounts & connections</NavLink>
    </section>
  </>;
}

function Orders() {
  const { restaurant, permission } = React.useContext(RestaurantContext), alerts = useOrderAlerts();
  const [, setParams] = useSearchParams(), priorRestaurant = useRef(restaurant.id);
  useEffect(() => { if (priorRestaurant.current !== restaurant.id) { priorRestaurant.current = restaurant.id; setParams({}); } }, [restaurant.id]);
  return <OrdersWorkspace key={restaurant.id} restaurant={restaurant} permission={permission} alerts={alerts}/>;
}
function OrdersWorkspace({ restaurant, permission, alerts }) {
  const workspace=useBusinessWorkspace(),canOperate=operationalTabletFor(workspace?.business?.id,restaurant.id,workspace?.terminal);
  const canPrint = canOperate && workspace?.business?.products?.["cal-eats"]?.allowedOnTablet !== false;
  const [printOrder, setPrintOrder] = useState(null);
  const tools=businessToolPermissions({permission,capabilities:restaurant.capabilities,principalKind:workspace?.business?.principalKind});
  const [page, setPage] = useState(1), [status, setStatus] = useState("all"), [datePreset,setDatePreset]=useState("all"),[dates,setDates]=useState({from:"",to:""});
  const query = new URLSearchParams({ page: String(page), pageSize: "25", status, ...(dates.from?{from:dates.from}:{}), ...(dates.to?{to:dates.to}:{}) });
  const result = useFinanceResource(`/api/restaurant/restaurants/${restaurant.id}/orders?${query}`);
  const [active, setActive] = useState(null), [error, setError] = useState(""), [progressing, setProgressing] = useState(""), [detailLoading, setDetailLoading] = useState(false);
  const deadlineNow = useDeliveryDeadlineClock(listItems(result.value).some(order => deliveryDeadlineAt(order) !== null) || deliveryDeadlineAt(active) !== null), activeDeliveryWarning = deliveryDispatchWarning(active, deadlineNow);
  const [params, setParams] = useSearchParams(), selectedOrder = params.get("order");
  const selectedRef = useRef(selectedOrder), restaurantRef = useRef(restaurant.id);
  selectedRef.current = selectedOrder; restaurantRef.current = restaurant.id;
  useEffect(() => setError(""), [selectedOrder]);
  useEffect(() => connectLiveNotifications({ onRefresh: result.reload }), [result.reload]);
  useEffect(() => { const refresh = () => void result.reload(); addEventListener("cal-eats-orders-updated", refresh); return () => removeEventListener("cal-eats-orders-updated", refresh); }, [result.reload]);
  useEffect(() => {
    if (!selectedOrder) { setActive(null); setDetailLoading(false); return; }
    const loaded = listItems(result.value).find(order => order.id === selectedOrder && order.restaurantId === restaurant.id);
    if (loaded) { setActive(loaded); setDetailLoading(false); return; }
    const controller = new AbortController(), requestedOrder = selectedOrder, requestedRestaurant = restaurant.id;
    const timer = window.setTimeout(() => controller.abort(), 20000);
    let current = true;
    setActive(previous => previous?.id === requestedOrder && previous.restaurantId === requestedRestaurant ? previous : null); setDetailLoading(true);
    void api(`/api/orders/${encodeURIComponent(requestedOrder)}`, { signal: controller.signal }).then(order => {
      if (!current || selectedRef.current !== requestedOrder || restaurantRef.current !== requestedRestaurant) return;
      if (order.restaurantId !== requestedRestaurant) throw new Error("This order is not available in the selected restaurant.");
      setActive(order);
    }).catch(caught => {
      if (current && selectedRef.current === requestedOrder && restaurantRef.current === requestedRestaurant) { setActive(null); setError(caught.name === "AbortError" ? "The order took too long to load. Close it and try again." : caught.message); }
    }).finally(() => { window.clearTimeout(timer); if (current) setDetailLoading(false); });
    return () => { current = false; window.clearTimeout(timer); controller.abort(); };
  }, [selectedOrder, result.value, restaurant.id]);
  async function update(order, next) {
    if (progressing) return;
    if (next === "accepted") { setParams({}); alerts.openOrder(order); return; }
    setError(""); setProgressing(next);
    try {
      const value = await api(`/api/restaurant/orders/${order.id}/status`, json("PATCH", { status: next })), updated = value.order || value;
      if (selectedRef.current === order.id && restaurantRef.current === order.restaurantId) setActive(updated);
      window.dispatchEvent(new Event("cal-eats-orders-updated"));
      if (restaurantRef.current === order.restaurantId) await result.reload();
    } catch (caught) { if (restaurantRef.current === order.restaurantId) { setError(caught.message); await result.reload(); } }
    finally { if (restaurantRef.current === order.restaurantId) setProgressing(""); }
  }
  async function estimate(order, value) {
    if (progressing) return; setError(""); setProgressing("eta");
    try {
      const updated = await api(`/api/restaurant/orders/${order.id}/preparation`, json("PATCH", { estimatedReadyAt: new Date(value).toISOString() }));
      if (selectedRef.current === order.id && restaurantRef.current === order.restaurantId) setActive(updated.order || updated);
      window.dispatchEvent(new Event("cal-eats-orders-updated"));
      if (restaurantRef.current === order.restaurantId) await result.reload();
    } catch (caught) { if (restaurantRef.current === order.restaurantId) setError(caught.message); }
    finally { if (restaurantRef.current === order.restaurantId) setProgressing(""); }
  }
  const actionLabel = (next, order) => ({ accepted: "Confirm order", preparing: "Start preparing", ready: "Mark ready", out_for_delivery: "Out for delivery", completed: order.fulfillment === "delivery" ? "Mark delivered" : "Mark collected" })[next] || next.replaceAll("_", " ");
  const pagination = result.value?.pagination;
  useEffect(() => { if (pagination && page > Math.max(1, pagination.totalPages)) setPage(Math.max(1, pagination.totalPages)); }, [pagination?.totalPages, page]);
  const statuses = [["all", "All orders"], ["placed", "Awaiting confirmation"], ["accepted", "Confirmed"], ["preparing", "Preparing"], ["ready", "Ready"], ["out_for_delivery", "Out for delivery"], ["completed", "Completed"], ["rejected", "Rejected"]];
  return <Page title="Orders" intro={<>View order details and messages. {!canPrint && <>
    Print receipts and process orders from the registered restaurant tablet.
    {tools.manageSettings && <> Check its setup in <NavLink to="/owner/printers">Printers</NavLink>.</>}
  </>}</>}>
    <section className="business-order-dates" aria-label="Order date range"><div className="business-order-date-presets" role="group" aria-label="Order date presets">{[["all","All dates"],["today","Today"],["yesterday","Yesterday"],["this_week","This week"],["last_week","Last week"],["custom","Custom dates"]].map(([value,label])=><button type="button" key={value} aria-pressed={datePreset===value} onClick={()=>{setError("");setDatePreset(value);if(value!=="custom"){setDates(orderDatePreset(value));setPage(1);}}}>{label}</button>)}</div>{datePreset==="custom"&&<form className="business-order-custom-dates" key={`${dates.from}:${dates.to}`} onSubmit={event=>{event.preventDefault();const fields=new FormData(event.currentTarget),from=String(fields.get("from")||""),to=String(fields.get("to")||"");if(from>to){setError("Choose an end date on or after the start date.");return;}setError("");setDates({from,to});setPage(1);}}><label>From<input name="from" type="date" required defaultValue={dates.from}/></label><label>To<input name="to" type="date" required defaultValue={dates.to}/></label><button className="primary">Apply dates</button></form>}<small>{dates.from||dates.to?`Placed from ${dates.from||"the beginning"} to ${dates.to||"today"}`:"Showing all order dates"} · London time · weeks start Monday</small></section>
    <div className="workspace-toolbar"><label>Order status<select value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}>{statuses.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button className="quiet" disabled={result.loading} onClick={() => void result.reload()}>Refresh orders</button></div>
    {error && !active && <Alert>{error}</Alert>}
    {result.loading && !result.value ? <Skeleton/> : result.error ? <PageState error={result.error} retry={result.reload}/> : <OrderTable
      items={listItems(result.value)} now={deadlineNow} canOperate={canOperate} canPrint={canPrint} restaurantId={restaurant.id}
      onOpen={order => { setError(""); setParams({ order: order.id }); }}
      onPrint={order => { if (canPrint && canPrintOrderReceipt(order, restaurant.id)) setPrintOrder(order); }}/>}
    {pagination && <div className="finance-pagination" aria-label="Order pages"><button className="quiet" disabled={page <= 1 || result.loading} onClick={() => setPage(value => value - 1)}>Previous orders</button><span>{pagination.total} orders · Page {page} of {Math.max(1, pagination.totalPages)}</span><button className="quiet" disabled={!pagination.hasNext || result.loading} onClick={() => setPage(value => value + 1)}>Next orders</button></div>}
    {printOrder && <OrderReceiptPrintDialog key={printOrder.id} order={printOrder} businessId={workspace?.business?.id}
      restaurantId={restaurant.id} allowed={canPrint} onClose={() => setPrintOrder(null)}/>}
    {selectedOrder && detailLoading && !active && <Dialog title={`Order ${selectedOrder.slice(0, 8).toUpperCase()}`} onClose={() => setParams({})}><p role="status">Loading order…</p></Dialog>}
    {active?.id === selectedOrder && active.restaurantId === restaurant.id && <Dialog title={active.fulfillment === "delivery" ? "Delivery order" : `Collection · ${orderCustomerName(active)}`} onClose={() => setParams({})}>
      {error && <Alert>{error}</Alert>}
      <section aria-label="Order status and customer"><div className={`business-order-customer${activeDeliveryWarning ? " business-delivery-due" : ""}`}><DeliveryDeadlineBadge warning={activeDeliveryWarning}/><small>{active.fulfillment === "delivery" ? "Deliver to" : "Collection customer"}</small><strong>{orderDestination(active)}</strong>{active.fulfillment === "delivery"&&<span>{orderCustomerName(active)}</span>}{active.deliveryInstructions&&<p><b>Delivery note:</b> {active.deliveryInstructions}</p>}<div className="business-order-contact">{active.customerPhone&&<a href={`tel:${active.customerPhone}`}>Call customer · {active.customerPhone}</a>}</div><span className="order-reference">Reference #{active.id.slice(0,8).toUpperCase()}</span></div><div className="detail-list"><p><span>Order status</span><strong>{({placed:"Awaiting confirmation",accepted:"Confirmed",preparing:"Preparing",ready:"Ready",out_for_delivery:"Out for delivery",completed:active.fulfillment === "delivery" ? "Delivered" : "Collected",rejected:"Rejected"})[active.status] || active.status?.replaceAll("_", " ")}</strong></p><p><span>Customer</span><strong>{active.customerName || active.contactName || "Customer"}</strong></p>{(active.customerEtaAt || active.estimatedReadyAt) && <p><span>{active.fulfillment === "delivery" ? "Expected delivery arrival" : "Ready for collection"}</span><strong>{shortDate(active.customerEtaAt || active.estimatedReadyAt)}</strong></p>}</div></section>
      <div className="button-row order-progress-actions">{terminalStatus().context?.restaurantId!==active.restaurantId&&<p className="business-view-only-note">{active.status==="placed"?"Awaiting acceptance on restaurant tablet.":"Order processing is available on the registered restaurant tablet."}</p>}{nextStatuses(active.status, active.fulfillment, active.restaurantId).map(next => <button type="button" className="primary" key={next} disabled={Boolean(progressing)} onClick={() => void update(active, next)}>{progressing === next ? "Updating…" : actionLabel(next, active)}</button>)}</div>
      {terminalStatus().context?.principalKind==="terminal"&&terminalStatus().context.restaurantId===active.restaurantId&&["accepted", "preparing"].includes(active.status) && <form className="order-eta-update" onSubmit={event => { event.preventDefault(); const value = new FormData(event.currentTarget).get("eta"); if (value) void estimate(active, value); }}><label>{active.fulfillment === "delivery" ? "Expected delivery arrival" : "Ready for collection"}<input name="eta" type="datetime-local" required disabled={Boolean(progressing)}/></label><button className="quiet" disabled={Boolean(progressing)}>{progressing === "eta" ? "Updating ETA…" : "Update customer ETA"}</button></form>}
      {(active.messagingAvailable ?? ["placed", "accepted", "preparing", "ready", "out_for_delivery"].includes(active.status)) && <OrderConversation key={active.id} orderId={active.id}/>}
      <section aria-label="Order items and totals"><h3>Order details</h3><OrderDetail order={active}/></section>
      {tools.viewFinance && <OrderFinancialBreakdown key={`${restaurant.id}:${active.id}`} restaurantId={restaurant.id} orderId={active.id}/>}
    </Dialog>}
  </Page>;
}

function Menu(){const {restaurant,permission}=React.useContext(RestaurantContext),tools=useRestaurantTools();return <RefinedMenu key={restaurant.id} restaurantId={restaurant.id} permission={permission} canManageMenu={tools.manageMenu} Editor={MenuItemEditor} imageBody={imageBody} emailReports={permission==="owner"} showTemplateDownload={false}/>;}

const splitEditorList=value=>value.split(",").map(entry=>entry.trim()).filter(Boolean);
const newEditorId=prefix=>`${prefix}-${crypto.randomUUID().slice(0,8)}`;

function CustomerTools({view}){const {restaurant,permission}=React.useContext(RestaurantContext),tools=useRestaurantTools();if(permission!=="owner"&&!(view==="offers"&&tools.manageMarketing))return <Denied message="The relevant restaurant permission is required for these customer tools."/>;return view==="inbox"?<CustomerInbox key={restaurant.id} restaurantId={restaurant.id}/>:view==="offers"?<Loyalty key={restaurant.id} restaurantId={restaurant.id}/>:<CustomerDirectory key={restaurant.id} restaurantId={restaurant.id}/>;}
function OwnerSupport(){const{restaurant}=React.useContext(RestaurantContext);return <SupportWorkspace key={restaurant.id} kind="restaurant" restaurantId={restaurant.id}/>;}

function Printers() {
  const { restaurant, permission } = React.useContext(RestaurantContext);
  const workspace = useBusinessWorkspace();
  const canPrint = operationalTabletFor(workspace?.business?.id, restaurant.id, workspace?.terminal);
  return <CalaiPrinters key={restaurant.id} restaurant={restaurant} permission={permission} canPrint={canPrint} tabletSetup={<TabletConnectionAccess/>}/>;
}

function PrinterWorkspace({ restaurant, permission }) {
  const root = `/api/restaurant/restaurants/${restaurant.id}`;
  const result = useLoad(() => api(`${root}/printers`), [restaurant.id]);
  const orders = useLoad(() => api(`${root}/orders`), [restaurant.id]);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const printers = listItems(result.value);
  const printable = printers.filter(p => p.enabled && !p.revoked);
  const confirmedOrders = listItems(orders.value).filter(o => ["accepted", "preparing", "ready", "out_for_delivery", "completed"].includes(o.status));
  const needsReview = printers.reduce((total, p) => total + (p.jobs?.failed || 0) + (p.jobs?.uncertain || 0), 0);

  useEffect(() => {
    const refreshWhenVisible = () => { if (!document.hidden) void result.reload(); };
    const timer = window.setInterval(refreshWhenVisible, 15000);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [result.reload]);

  async function refresh() {
    setRefreshing(true);
    try { await Promise.all([result.reload(), orders.reload()]); }
    finally { setRefreshing(false); }
  }
  async function add(e) {
    e.preventDefault();
    if (busy) return;
    const form = e.currentTarget, data = new FormData(form);
    setBusy("add"); setError(""); setNotice("");
    try {
      await api(`${root}/printers`, json("POST", { name: data.get("name"), enabled: true }));
      form.reset();
      setNotice("Printer added with auto-print on. Pair its Cal-Eats bridge to receive confirmed orders.");
      await result.reload();
    } catch (x) { setError(x.message); }
    finally { setBusy(""); }
  }
  async function pair(id) {
    if (busy) return;
    setBusy(id); setError(""); setNotice("");
    try {
      const data = await api(`${root}/printers/${id}/pairing-code`, json("POST", {}));
      setNotice(`Pairing code ${data.code} expires ${shortDate(data.expiresAt)}. It is shown once. Enter it in the Cal-Eats printer bridge on the connected tablet.`);
    } catch (x) { setError(x.message); }
    finally { setBusy(""); }
  }
  async function toggle(printer) {
    if (busy) return;
    setBusy(printer.id); setError(""); setNotice("");
    try {
      await api(`${root}/printers/${printer.id}`, json("PATCH", { enabled: !printer.enabled }));
      setNotice(printer.enabled ? "Auto-print is off for this printer." : "Auto-print is on for this printer. New confirmed orders will be queued automatically.");
      await result.reload();
    } catch (x) { setError(x.message); }
    finally { setBusy(""); }
  }
  async function reprint(e) {
    e.preventDefault();
    if (busy) return;
    const data = new FormData(e.currentTarget);
    setBusy("reprint"); setError(""); setNotice("");
    try {
      await api(`${root}/printers/${data.get("printerId")}/reprints`, json("POST", { orderId: data.get("orderId") }));
      setNotice("A labelled manual reprint was queued. Check the printer before requesting another copy.");
      await result.reload();
    } catch (x) { setError(x.message); }
    finally { setBusy(""); }
  }
  const connectionLabel = {
    disabled: "Disabled", revoked: "Revoked", awaiting_device: "Not paired", online: "Connected", offline: "Offline"
  };
  return <Page title="Receipt printers" intro="Automatically send a receipt to each enabled printer when your business confirms an order.">
    <Simulation/>
    {error && <Alert>{error}</Alert>}
    {notice && <Alert tone="success">{notice}</Alert>}
    <Section title="Print after confirmation">
      <p>Confirming an order queues its original receipt automatically. Opening an order, changing its preparation status or retrying confirmation does not create another original copy.</p>
      <p className="fine">Keep the Cal-Eats printer bridge running on the tablet connected to your printer. Receipts wait in the queue while it is offline. A recent bridge connection does not prove the printer has paper or has produced a receipt.</p>
      {needsReview > 0 && <Alert>Some receipts need review. Check the printer and its bridge before requesting a labelled reprint, especially when an earlier result is uncertain.</Alert>}
    </Section>
    {permission === "owner" && <Section title="Add printer">
      <form className="inline-form" onSubmit={add}>
        <Field label="Printer name" name="name" required maxLength={100}/>
        <button className="primary" disabled={Boolean(busy)}>{busy === "add" ? "Adding…" : "Add printer"}</button>
      </form>
    </Section>}
    <Section title="Configured printers">
      <div className="workspace-toolbar">
        <p className="fine">Connection and receipt reports refresh while this page is open.</p>
        <button className="quiet" disabled={refreshing || result.loading} onClick={() => void refresh()}>{refreshing ? "Refreshing…" : "Refresh"}</button>
      </div>
      {!result.loading && !result.error && !printers.length && <p>Add a printer, pair its Cal-Eats bridge, then confirm a test order. No receipt printer is configured for this restaurant yet.</p>}
      <DataTable headers={["Name", "Auto-print", "Connection", "Last contact", "Receipt queue", "Action"]} rows={printers.map(printer => {
        const jobs = printer.jobs || {}, status = printer.status || (printer.revoked ? "revoked" : !printer.enabled ? "disabled" : "awaiting_device");
        return [
          printer.name,
          printer.revoked ? "Revoked" : printer.enabled ? "On" : "Off",
          <div><strong>{connectionLabel[status] || "Not connected"}</strong><div className="fine">{printer.pairedDeviceCount || 0} paired device{printer.pairedDeviceCount === 1 ? "" : "s"}</div></div>,
          printer.lastSeenAt ? shortDate(printer.lastSeenAt) : "Never connected",
          <div><div>{jobs.queued || 0} waiting · {jobs.claimed || 0} in progress</div><div className="fine">{jobs.printed || 0} reported complete · {jobs.failed || 0} failed · {jobs.uncertain || 0} uncertain</div></div>,
          permission === "owner" && !printer.revoked ? <div className="button-row">
            <button className="quiet" disabled={Boolean(busy) || !printer.enabled} onClick={() => void pair(printer.id)}>Pair bridge</button>
            <button className="quiet" disabled={Boolean(busy)} onClick={() => void toggle(printer)}>{printer.enabled ? "Turn off" : "Turn on"}</button>
          </div> : "View only"
        ];
      })} loading={result.loading} error={result.error}/>
      <p className="fine">Reported complete is the bridge's acknowledgement; simulator reports do not prove paper output. An uncertain result needs a check before reprinting.</p>
    </Section>
    {permission === "owner" && terminalStatus().context?.principalKind==="terminal" && <Section title="Manual reprint">
      <p className="fine">Use this for an extra copy of a confirmed order. Every manual copy is labelled as a reprint.</p>
      {orders.error && <Alert>{orders.error}</Alert>}
      {!printable.length ? <p>Enable a printer to queue a manual reprint.</p> : orders.loading ? <p>Loading confirmed orders…</p> : !confirmedOrders.length ? <p>No confirmed orders are available to reprint.</p> : <form className="inline-form" onSubmit={reprint}>
        <label>Printer<select name="printerId" required>{printable.map(printer => <option key={printer.id} value={printer.id}>{printer.name}</option>)}</select></label>
        <label>Order<select name="orderId" required>{confirmedOrders.map(order => <option key={order.id} value={order.id}>{order.id.slice(0, 8)} · {order.customerName || "Customer"}</option>)}</select></label>
        <button className="primary" disabled={Boolean(busy) || orders.loading}>{busy === "reprint" ? "Queueing…" : "Queue labelled reprint"}</button>
      </form>}
    </Section>}
  </Page>;
}


function Earnings(){const{restaurant}=React.useContext(RestaurantContext),tools=useRestaurantTools();return <EarningsPage key={restaurant.id} restaurantId={restaurant.id} viewFinance={tools.viewFinance} canManageBank={tools.manageBank}/>;}
function OwnerMerchantAgreement(){const{restaurant}=React.useContext(RestaurantContext);return <MerchantAgreement key={restaurant.id} restaurantId={restaurant.id}/>;}


function Settings(){
  const{restaurant,permission}=React.useContext(RestaurantContext);
  return <OwnerSettings key={restaurant.id} restaurant={restaurant} permission={permission}/>;
}
function OwnerSettings({restaurant,permission}){
  const {user}=React.useContext(SessionContext);
  const paymentPolicy=useLoad(()=>api("/api/payments/config"),[]);
  const liveCardOnly=paymentPolicy.value?.providerMode==="stripe_live"||paymentPolicy.value?.cashAvailable===false;
  const account=useLoad(()=>api("/api/account"),[]),staff=useLoad(()=>api(`/api/restaurant/restaurants/${restaurant.id}/staff`),[restaurant.id]),readiness=useLoad(()=>api(`/api/restaurant/restaurants/${restaurant.id}/readiness`),[restaurant.id]);
  const business=useLoad(async()=>{const value=listItems(await api("/api/restaurant/restaurants")).find(item=>item.id===restaurant.id);if(!value)throw new Error("This restaurant is no longer available to your account.");return value;},[restaurant.id]);
  const profileValues=value=>{const p=value.profile||{};return{description:p.description||"",cuisine:p.cuisine||value.cuisine||"",phone:p.phone||"",address:p.address||"",collectionEnabled:Boolean(p.collectionEnabled),cashEnabled:Boolean(p.cashEnabled),alwaysOpen:Boolean(p.alwaysOpen),busyMinutes:String(p.busyMinutes??0),estimatedCollectionMinutes:String(p.estimatedCollectionMinutes??20),estimatedDeliveryMinutes:String(p.estimatedDeliveryMinutes??35),openingHours:(p.openingHours||[]).map(row=>({...row}))};};
  const[savedBusiness,setSavedBusiness]=useState(restaurant),[profile,setProfile]=useState(()=>profileValues(restaurant)),[editingProfile,setEditingProfile]=useState(false),[editingAccount,setEditingAccount]=useState(false),[savedAccount,setSavedAccount]=useState(null),[accountDraft,setAccountDraft]=useState({name:"",phone:""}),[staffDraft,setStaffDraft]=useState({name:"",email:"",password:""}),[staffOpen,setStaffOpen]=useState(false),[pending,setPending]=useState(""),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const alive=useRef(true),working=useRef(false),messageRef=useRef(null),canManage=permission==="owner";
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;working.current=false;};},[]);
  useEffect(()=>{if(business.value){setSavedBusiness(business.value);if(!editingProfile)setProfile(profileValues(business.value));}},[business.value]);
  useEffect(()=>{if(account.value){setSavedAccount(account.value);if(!editingAccount)setAccountDraft({name:account.value.name||"",phone:account.value.phone||""});}},[account.value]);
  useEffect(()=>{if(error||notice)messageRef.current?.focus();},[error,notice]);
  const changeProfile=(key,value)=>{setProfile(old=>({...old,[key]:value}));setError("");setNotice("");};
  async function run(kind,action){if(working.current)return;working.current=true;setPending(kind);setError("");setNotice("");try{await action();}catch(caught){if(alive.current)setError(caught.message);}finally{if(alive.current){working.current=false;setPending("");}}}
  async function saveAccount(event){event.preventDefault();await run("account",async()=>{const value=await api("/api/account",json("PATCH",{name:accountDraft.name.trim(),phone:accountDraft.phone.trim()}));if(!alive.current)return;setSavedAccount(value);setAccountDraft({name:value.name||"",phone:value.phone||""});setEditingAccount(false);setNotice("Your account details have been saved.");});}
  async function saveProfile(event){event.preventDefault();if(!canManage)return;await run("profile",async()=>{
    const hours=profile.openingHours;if(hours.length>21||hours.some(row=>!Number.isInteger(row.day)||row.day<0||row.day>6||!/^([01]\d|2[0-3]):[0-5]\d$/.test(row.open)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(row.close)||row.open===row.close))throw new Error("Check your opening hours. Each row needs a day and different opening and closing times; use up to 21 rows.");
    const body={...profile,cashEnabled:liveCardOnly?false:profile.cashEnabled,busyMinutes:Number(profile.busyMinutes),estimatedCollectionMinutes:Number(profile.estimatedCollectionMinutes),estimatedDeliveryMinutes:Number(profile.estimatedDeliveryMinutes),openingHours:hours};
    const value=await api(`/api/restaurant/restaurants/${restaurant.id}/profile`,json("PATCH",body));if(!alive.current)return;setSavedBusiness(value);setProfile(profileValues(value));setEditingProfile(false);setNotice("Your restaurant details, opening hours and order settings have been saved.");void readiness.reload();
  });}
  async function addStaff(event){event.preventDefault();if(!canManage)return;await run("staff",async()=>{await api(`/api/restaurant/restaurants/${restaurant.id}/staff`,json("POST",{name:staffDraft.name.trim(),email:staffDraft.email.trim(),password:staffDraft.password}));if(!alive.current)return;setStaffDraft({name:"",email:"",password:""});setStaffOpen(false);setNotice("The staff account has been created with staff access.");void staff.reload();});}
  async function cover(file){if(!canManage||!file)return;await run("cover",async()=>{const body=await imageBody(file);if(!alive.current)return;const value=await api(`/api/restaurant/restaurants/${restaurant.id}/cover`,json("POST",body));if(!alive.current)return;setSavedBusiness(old=>({...old,coverImageUrl:value.url||old.coverImageUrl}));setNotice("Your restaurant cover photo has been updated.");});}
  const saved=savedBusiness.profile||{},checks=Object.entries(readiness.value?.checks||{}),days=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"],hoursSummary=[1,2,3,4,5,6,0].map(day=>({day,times:(saved.openingHours||[]).filter(row=>row.day===day)}));
  const title=(icon,label,description)=><div className="business-settings-card-heading"><span aria-hidden="true"><NavIcon label={({"Business profile":"Restaurants","Customer messages":"Inbox","Team & access":"Customers","Business readiness":"Cases","Your account":"Account","Help with your setup":"Support"})[label]||"Settings"}/></span><div><h2>{label}</h2><p>{description}</p></div></div>;
  return <div className="business-settings"><header className="page-heading"><p className="eyebrow">Your restaurant</p><h1>Settings</h1><p>Keep your business details, service settings and team access in order.</p></header>
    <nav className="business-settings-nav" aria-label="Settings sections"><a href="#business-profile">Business profile</a><a href="#business-operations">Order settings</a><a href="#business-team">Team</a><a href="#business-account">Your account</a></nav>
    {(error||notice)&&<p ref={messageRef} tabIndex={-1} className={error?"alert settings-feedback":"alert success settings-feedback"} role={error?"alert":"status"}>{error||notice}</p>}
    <div className="business-settings-grid"><div className="business-settings-main"><section id="business-profile" className="panel business-settings-card"><div className="business-settings-card-top">{title("⌂","Business profile","The details customers see when they choose your restaurant.")}{!editingProfile&&canManage&&<button className="quiet" disabled={Boolean(pending)||business.loading||Boolean(business.error)} onClick={()=>{setProfile(profileValues(savedBusiness));setEditingProfile(true);setError("");setNotice("");}}>Edit details</button>}</div>
      {business.error&&<div className="alert" role="alert">{business.error}<button className="quiet" type="button" onClick={()=>void business.reload()}>Try again</button></div>}
      {business.loading&&!business.value?<p className="fine" role="status">Refreshing your business details…</p>:null}
      {!editingProfile?<><div className="settings-business-identity">{savedBusiness.coverImageUrl?<img src={savedBusiness.coverImageUrl} alt={savedBusiness.name}/>:<span className="settings-business-placeholder" aria-hidden="true">{savedBusiness.name.slice(0,2).toUpperCase()}</span>}<div><h3>{savedBusiness.name}</h3><p>{saved.cuisine||"Cuisine not added"}</p><span className={savedBusiness.acceptingOrders&&savedBusiness.status==="approved"&&!savedBusiness.suspended?"settings-state":"settings-state paused"}>{saved.paused?"New orders paused":savedBusiness.suspended?"Restaurant suspended":savedBusiness.status!=="approved"?savedBusiness.status.replaceAll("_"," "):savedBusiness.acceptingOrders?"Open for orders":"Currently closed"}</span></div></div><p className="settings-description">{saved.description||"Add a description to introduce your restaurant to customers."}</p><dl className="settings-detail-grid"><div><dt>Business phone</dt><dd>{saved.phone||"Not added"}</dd></div><div><dt>Business address</dt><dd>{saved.address||"Not added"}</dd></div><div><dt>Collection</dt><dd>{saved.collectionEnabled?"Enabled":"Disabled"}</dd></div><div><dt>Cash payments</dt><dd>{liveCardOnly?"Unavailable for real orders":saved.cashEnabled?"Enabled":"Disabled"}</dd></div><div><dt>Collection estimate</dt><dd>{saved.estimatedCollectionMinutes?`${saved.estimatedCollectionMinutes} minutes`:"Not set"}</dd></div><div><dt>Delivery estimate</dt><dd>{saved.estimatedDeliveryMinutes?`${saved.estimatedDeliveryMinutes} minutes`:"Not set"}</dd></div><div><dt>Extra busy delay</dt><dd>{saved.busyMinutes||0} minutes</dd></div></dl><details className="settings-hours-summary"><summary>Opening hours</summary>{saved.alwaysOpen?<p>Open around the clock</p>:<dl>{hoursSummary.map(({day,times})=><div key={day}><dt>{days[day]}</dt><dd>{times.length?times.map(row=>`${row.open}–${row.close}${row.close<row.open?" (next day)":""}`).join(", "):"Closed"}</dd></div>)}</dl>}</details><div className="settings-cover-action"><div><strong>Restaurant cover photo</strong><p>Use a clear photo of your food or restaurant.</p></div><label className="file-button">{pending==="cover"?"Updating photo…":"Change photo"}<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" disabled={!canManage||Boolean(pending)} onChange={event=>{const file=event.target.files?.[0];event.target.value="";if(file)void cover(file);}}/></label></div></>:<form className="settings-edit-form" onSubmit={saveProfile}><fieldset disabled={Boolean(pending)}><legend>Business details</legend><label className="full">Description<textarea rows={3} maxLength={500} value={profile.description} onChange={event=>changeProfile("description",event.target.value)}/></label><div className="form-grid"><Field label="Cuisine" maxLength={80} value={profile.cuisine} onChange={event=>changeProfile("cuisine",event.target.value)}/><Field label="Business phone" type="tel" maxLength={30} value={profile.phone} onChange={event=>changeProfile("phone",event.target.value)}/><label className="full">Business address<textarea rows={2} maxLength={250} value={profile.address} onChange={event=>changeProfile("address",event.target.value)}/></label></div></fieldset><fieldset disabled={Boolean(pending)}><legend>Order preferences & timing</legend><div className="settings-switch-list">{[["collectionEnabled","Allow collection","Customers can collect orders from your restaurant."],["cashEnabled","Accept cash","Show cash as a payment option where available."],["alwaysOpen","Open around the clock","Accept orders at all times, subject to pause and holiday settings."]].map(([key,label,hint])=><label className="settings-switch" key={key}><span><strong>{label}</strong><small>{key==="cashEnabled"&&liveCardOnly?"Real orders use secure card checkout. Cash cannot be enabled.":hint}</small></span><input type="checkbox" checked={key==="cashEnabled"&&liveCardOnly?false:profile[key]} disabled={key==="cashEnabled"&&(liveCardOnly||paymentPolicy.loading||Boolean(paymentPolicy.error))} onChange={event=>changeProfile(key,event.target.checked)}/></label>)}</div><div className="form-grid"><Field label="Extra busy delay (minutes)" type="number" min="0" max="240" step="1" required value={profile.busyMinutes} onChange={event=>changeProfile("busyMinutes",event.target.value)}/><Field label="Collection estimate (minutes)" type="number" min="1" max="240" step="1" required value={profile.estimatedCollectionMinutes} onChange={event=>changeProfile("estimatedCollectionMinutes",event.target.value)}/><Field label="Delivery estimate (minutes)" type="number" min="1" max="240" step="1" required value={profile.estimatedDeliveryMinutes} onChange={event=>changeProfile("estimatedDeliveryMinutes",event.target.value)}/></div></fieldset><fieldset disabled={Boolean(pending)||profile.alwaysOpen} className="settings-hours-editor"><HoursEditor value={profile.openingHours} onChange={value=>changeProfile("openingHours",value)}/></fieldset>{profile.alwaysOpen&&<p className="fine">Opening around the clock is enabled. Switch it off above to use your scheduled opening hours.</p>}<div className="settings-form-actions"><button className="quiet" type="button" disabled={Boolean(pending)} onClick={()=>{setProfile(profileValues(savedBusiness));setEditingProfile(false);setError("");}}>Cancel</button><button className="primary" disabled={Boolean(pending)}>{pending==="profile"?"Saving…":"Save business details"}</button></div></form>}
    </section>
    <BusinessSoundSetting userId={user.id}/><section id="business-operations" className="settings-operations"><div className="settings-section-title"><h2>Order settings</h2><p>Delivery, customer messages and day-to-day service.</p></div><DeliverySettings key={restaurant.id} restaurant={savedBusiness} permission={permission}/><details className="panel business-settings-card settings-message-settings"><summary><div>{title("✉","Customer messages","Support window and quick replies for order conversations.")}</div><span aria-hidden="true"><NavIcon label="Down"/></span></summary><MessagingSettings key={restaurant.id} restaurantId={restaurant.id}/></details></section>
    <section id="business-team" className="panel business-settings-card"><div className="business-settings-card-top">{title("♧","Team & access","Give each member of your team their own business sign-in.")}{canManage&&!staffOpen&&<button className="quiet" disabled={Boolean(pending)} onClick={()=>setStaffOpen(true)}>Add staff member</button>}</div>{staff.loading?<p className="fine" role="status">Loading your team…</p>:staff.error?<div className="alert" role="alert">{staff.error}<button className="quiet" onClick={()=>void staff.reload()}>Try again</button></div>:<div className="settings-team-list">{listItems(staff.value).map(person=><article key={person.id}><span className="settings-person-avatar" aria-hidden="true">{person.name.slice(0,1).toUpperCase()}</span><div><strong>{person.name}</strong><span>{person.email}</span></div><span className="settings-permission">{person.permission==="owner"?"Owner":"Staff"}</span>{canManage&&person.permission==="staff"&&<StaffCapabilityControls restaurantId={restaurant.id} person={person} onSaved={staff.reload}/>}</article>)}</div>}<p className="fine">Staff access is limited to the restaurant tools available to their role.</p>{staffOpen&&canManage&&<form className="settings-edit-form settings-staff-form" onSubmit={addStaff}><h3>New staff account</h3><div className="form-grid"><Field label="Staff name" required maxLength={100} autoComplete="off" disabled={Boolean(pending)} value={staffDraft.name} onChange={event=>setStaffDraft(old=>({...old,name:event.target.value}))}/><Field label="Staff email" type="email" required maxLength={254} autoComplete="off" disabled={Boolean(pending)} value={staffDraft.email} onChange={event=>setStaffDraft(old=>({...old,email:event.target.value}))}/><Field label="Temporary password" type="password" required minLength={12} maxLength={200} autoComplete="new-password" disabled={Boolean(pending)} value={staffDraft.password} onChange={event=>setStaffDraft(old=>({...old,password:event.target.value}))}/></div><p className="fine">Use at least 12 characters. Share the password with the staff member privately.</p><div className="settings-form-actions"><button className="quiet" type="button" disabled={Boolean(pending)} onClick={()=>{setStaffOpen(false);setStaffDraft({name:"",email:"",password:""});}}>Cancel</button><button className="primary" disabled={Boolean(pending)}>{pending==="staff"?"Creating…":"Create staff account"}</button></div></form>}</section>
    </div><aside className="business-settings-side"><section className="panel business-settings-card settings-readiness">{title("✓","Business readiness","Your restaurant’s current setup checklist.")}{readiness.loading?<p className="fine" role="status">Checking setup…</p>:readiness.error?<div className="alert" role="alert">{readiness.error}<button className="quiet" onClick={()=>void readiness.reload()}>Try again</button></div>:<><div className="settings-readiness-count"><strong>{checks.filter(([,value])=>value).length}<span>/{checks.length}</span></strong><span>setup checks complete</span></div><ul>{checks.map(([key,value])=><li key={key} className={value?"done":""}><span aria-hidden="true">{value?"✓":"○"}</span>{({contact:"Contact details",address:"Business address",hours:"Opening hours",usableMenu:"Available menu items",fulfillment:"Delivery or collection"})[key]||key.replaceAll("_"," ")}</li>)}</ul></>}</section>
    <section id="business-account" className="panel business-settings-card"><div className="business-settings-card-top">{title("◎","Your account","Your personal contact details for Cal-Eats.")}{!editingAccount&&<button className="quiet" disabled={Boolean(pending)||account.loading||Boolean(account.error)} onClick={()=>{setAccountDraft({name:savedAccount?.name||"",phone:savedAccount?.phone||""});setEditingAccount(true);setError("");}}>Edit</button>}</div>{account.loading&&!savedAccount?<p className="fine" role="status">Loading account…</p>:account.error?<div className="alert" role="alert">{account.error}<button className="quiet" onClick={()=>void account.reload()}>Try again</button></div>:editingAccount?<form className="settings-edit-form" onSubmit={saveAccount}><Field label="Your name" required maxLength={100} autoComplete="name" disabled={Boolean(pending)} value={accountDraft.name} onChange={event=>setAccountDraft(old=>({...old,name:event.target.value}))}/><Field label="Contact phone" type="tel" maxLength={30} autoComplete="tel" disabled={Boolean(pending)} value={accountDraft.phone} onChange={event=>setAccountDraft(old=>({...old,phone:event.target.value}))}/><div className="settings-form-actions"><button type="button" className="quiet" disabled={Boolean(pending)} onClick={()=>{setEditingAccount(false);setAccountDraft({name:savedAccount?.name||"",phone:savedAccount?.phone||""});}}>Cancel</button><button className="primary" disabled={Boolean(pending)}>{pending==="account"?"Saving…":"Save account"}</button></div></form>:<dl className="settings-account-summary"><div><dt>Name</dt><dd>{savedAccount?.name||"Not added"}</dd></div><div><dt>Sign-in email</dt><dd>{savedAccount?.email||"Not available"}</dd></div><div><dt>Contact phone</dt><dd>{savedAccount?.phone||"Not added"}</dd></div><div><dt>Restaurant access</dt><dd>{canManage?"Owner":"Staff"}</dd></div></dl>}</section>
    <section className="panel business-settings-card settings-help-card">{title("?","Help with your setup","Keep questions and replies together.")}<p>Contact the Cal-Eats team about your business account, service settings or platform access.</p><NavLink className="button-link" to="/owner/support">Open business support →</NavLink></section></aside></div>
  </div>;
}

function AdminDashboard(){const {user}=React.useContext(SessionContext);return <AdminDashboardWorkspace userId={user.id}/>;}

function AdminRestaurants(){return <AdminRestaurantsWorkspace Editor={MenuItemEditor} imageBody={imageBody}/>;}

function AdminRefunds(){return <AdminResolutionHistory/>;}

function AdminGovernance(){const {user}=React.useContext(SessionContext);return <AdminAccessWorkspace userId={user.id}/>;}

function AdminOperations(){return <AdminOperationsWorkspace/>;}

function caseEvidenceUrl(caseId,item){const evidenceId=String(item?.id||"");const safeId=/^[A-Za-z0-9-]{1,100}$/;if(!safeId.test(String(caseId||""))||!safeId.test(evidenceId))return null;const expected=`/api/refund-cases/${caseId}/evidence/${evidenceId}`;return item.url===expected?expected:null}
function formatBytes(value){const bytes=Number(value);if(!Number.isFinite(bytes)||bytes<0)return "Size unavailable";return bytes<1024?`${bytes} bytes`:`${(bytes/1024).toFixed(1)} KB`}
function messageAudience(audience){return ({internal:"Internal note",customer:"Message for customer",restaurant:"Message for restaurant",admin:"Reply to administrator"})[audience]||"Case message"}
function CaseEventDetails({details}){return <dl className="case-event-details">{Object.entries(details).map(([key,value])=><div key={key}><dt>{key.replace(/([a-z])([A-Z])/g,"$1 $2").replaceAll("_"," ")}</dt><dd>{/minor$/i.test(key)&&Number.isSafeInteger(value)?pounds(value):typeof value==="boolean"?(value?"Yes":"No"):Array.isArray(value)?value.join(", "):value&&typeof value==="object"?JSON.stringify(value):String(value??"—")}</dd></div>)}</dl>}
function HoursEditor({value,onChange}){const days=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];function patch(index,key,next){onChange(value.map((row,i)=>i===index?{...row,[key]:key==="day"?Number(next):next}:row))}return <fieldset className="hours"><legend>Opening hours</legend>{value.map((row,index)=><div className="hours-row" key={`${row.day}-${index}`}><select aria-label="Day" value={row.day} onChange={e=>patch(index,"day",e.target.value)}>{days.map((d,i)=><option key={d} value={i}>{d}</option>)}</select><input aria-label="Opens" type="time" value={row.open} onChange={e=>patch(index,"open",e.target.value)}/><input aria-label="Closes" type="time" value={row.close} onChange={e=>patch(index,"close",e.target.value)}/><button type="button" className="quiet" onClick={()=>onChange(value.filter((_,i)=>i!==index))}>Remove</button></div>)}<button type="button" className="quiet" onClick={()=>onChange([...value,{day:1,open:"09:00",close:"17:00"}])}>Add hours row</button><p className="fine">Multiple rows per day and overnight closing times are supported.</p></fieldset>}
function Page({title,intro,children}){return <><header className="page-heading"><p className="eyebrow">Cal-Eats Business</p><h1>{title}</h1><p>{intro}</p></header>{children}</>}
function Section({title,children}){return <section className="panel"><h2>{title}</h2>{children}</section>}
function Stat({label,value}){return <article className="stat"><span>{label}</span><strong>{value ?? "—"}</strong></article>}
function Alert({children,tone="error"}){return <div className={`alert ${tone}`} role="status">{children}</div>}
function Simulation({mode="local_simulator"}){const stripe=String(mode).startsWith("stripe"),mixed=mode==="mixed";return <div className="simulation"><strong>{mixed?"Multiple payment modes":stripe?"Stripe capability":"Simulated marketplace"}</strong><span>{mixed?"This history includes different payment modes. Check each operation’s provider label before treating it as live money.":stripe?(mode==="stripe_live"?"Live card capability; each account and payout still has its own status.":"Stripe test mode; no real card or bank movement."):"Local deterministic simulator. No live payment, payout or printing claim."}</span></div>}
function Field({label,...props}){return <label>{label}<input {...props}/></label>}
function Skeleton(){return <div className="skeleton" aria-label="Loading"><i/><i/><i/></div>}
function PageState({text,error,retry}){return <main className="state"><Brand/><p>{error||text}</p>{retry&&<button className="primary" onClick={retry}>Try again</button>}</main>}
function BusinessAccessUnavailable(){const{user,refresh,suspendAutomaticSignIn}=React.useContext(SessionContext),[busy,setBusy]=useState(false),[error,setError]=useState("");async function switchAccount(){setBusy(true);setError("");suspendAutomaticSignIn();try{await endOperationalPresence();await api("/api/auth/logout",{...json("POST",{}),humanSession:true});disconnectLocalTerminal();await refresh()}catch(x){setError(x.message)}finally{setBusy(false)}}return <main className="auth"><section className="auth-card"><Brand/><p className="eyebrow">Business portal</p><h1>Use a business account</h1><p>You are signed in as {user?.name||"a customer"}. This account does not have restaurant or administrator access.</p>{error&&<Alert>{error}</Alert>}<div className="button-row"><a className="button-link" href="/order/">Return to customer ordering</a><button className="quiet" type="button" disabled={busy} onClick={switchAccount}>{busy?"Signing out…":"Sign out and switch account"}</button></div><p className="fine">Business access is not added by switching accounts. Sign in with an account that already has an authorised business role.</p></section></main>}
function Denied({message="This workspace is not available for your account role."}){return <div className="panel"><h2>Access unavailable</h2><p>{message}</p></div>}
function DataTable({headers,rows=[],loading,error,rowClasses=[]}){if(loading)return <Skeleton/>;if(error)return <Alert>{error}</Alert>;if(!rows.length)return <p className="empty">Nothing to show yet.</p>;return <div className="table-wrap responsive-table"><table><thead><tr>{headers.map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>{rows.map((r,i)=><tr key={i} className={rowClasses[i]||undefined}>{r.map((c,j)=><td key={j} data-label={headers[j]}>{c??"—"}</td>)}</tr>)}</tbody></table></div>}
function OrderTable({ items, onOpen, onPrint, restaurantId, now, canOperate, canPrint }) {
  const warnings = items.map(order => deliveryDispatchWarning(order, now));
  return <div className="business-orders-table"><DataTable
    headers={["Customer & destination", "Status", "Placed", "Total", "Actions"]}
    rowClasses={warnings.map(warning => warning ? "business-delivery-due" : "")}
    rows={items.map((order, index) => {
      const customer = orderCustomerName(order), printable = canPrintOrderReceipt(order, restaurantId);
      const open = canOperate ? "Manage order" : "View order";
      return [
        <div className="order-person"><strong>{orderDestination(order)}</strong>
          <span>{order.fulfillment === "delivery" ? `Delivery · ${customer}` : "Collection"}</span>
          <small>#{String(order.id || "").slice(0, 8).toUpperCase()}</small>
        </div>,
        <div className="business-order-warning-state"><span className="order-state">{orderStatusText(order)}</span>
          <DeliveryDeadlineBadge warning={warnings[index]}/>
        </div>,
        shortDate(order.createdAt),
        pounds(order.totalMinor),
        <div className="business-order-row-actions">
          <button type="button" className="primary" aria-label={`${open} for ${customer}`} onClick={() => onOpen(order)}>{open}</button>
          <button type="button" className="quiet" aria-label={`Print receipt for ${customer}`} disabled={!canPrint || !printable}
            title={!canPrint ? "Print from the registered restaurant tablet" : !printable ? "Available for confirmed orders" : undefined}
            onClick={() => onPrint(order)}>Print</button>
        </div>,
      ];
    })}
  /></div>;
}
function OrderDetail({order}){return <div className="detail-list"><p><span>Fulfilment</span><strong>{order.fulfillment}</strong></p><p><span>Payment</span><strong>{order.paymentMethod?.replaceAll("_"," ")}</strong></p>{(order.customerEtaAt||order.estimatedReadyAt)&&<p><span>{order.fulfillment==="delivery"?"Expected delivery arrival":"Ready for collection"}</span><strong>{shortDate(order.customerEtaAt||order.estimatedReadyAt)}</strong></p>}{order.restaurantDiscountMinor>0&&<><p><span>Food before promotion</span><strong>{pounds(order.grossFoodMinor)}</strong></p><p><span>Restaurant promotion</span><strong>−{pounds(order.restaurantDiscountMinor)}</strong></p></>}<p><span>Total</span><strong>{pounds(order.totalMinor)}</strong></p>{listItems(order.items).map((i,n)=><p key={i.id||n}><span>{i.quantity} × {i.name||i.itemName}</span><strong>{i.isOfferItem?"Free offer":pounds(i.lineTotalMinor)}</strong></p>)}</div>}
function Dialog({title,onClose,children}){return <WorkspaceDialog title={title} onClose={onClose}>{children}</WorkspaceDialog>}
function nextStatuses(status,fulfillment,restaurantId){return terminalStatus().status==="ready"&&terminalStatus().context?.principalKind==="terminal"&&terminalStatus().context.restaurantId===restaurantId?businessOrderTransitions(status,fulfillment):[];}
function menuPayload(form){
  const tags=name=>String(form.get(name)||"").split(",").map(v=>v.trim()).filter(Boolean);
  const groupName=String(form.get("modifierName")||"").trim();
  let modifierGroups=[];
  if(groupName){
    const options=String(form.get("modifierOptions")||"").split("|").map((entry,index)=>{const[name,raw="0"]=entry.split(":");const priceMinor=Number(raw.trim());if(!name?.trim()||!Number.isSafeInteger(priceMinor)||priceMinor<0)throw new Error("Each modifier option needs Name:whole-pence.");return{id:`option-${index+1}`,name:name.trim(),priceMinor,available:true}});
    if(!options.length)throw new Error("Add at least one modifier option.");
    const required=form.get("modifierRequired")==="required";
    modifierGroups=[{id:`group-${Date.now().toString(36)}`,name:groupName,minSelections:required?1:0,maxSelections:1,options}];
  }
  return{name:form.get("name"),description:form.get("description")||"",priceMinor:Math.round(Number(form.get("price"))*100),category:form.get("category")||"",allergens:tags("allergens"),dietaryTags:tags("dietaryTags"),modifierGroups};
}
async function imageBody(file){
  if(!["image/jpeg","image/png","image/webp","image/gif"].includes(file.type))throw new Error("Choose a JPEG, PNG, WebP or GIF image.");
  if(file.size>10*1024*1024)throw new Error("Choose a photo smaller than 10 MB.");
  const bitmap=await createImageBitmap(file),max=1400,scale=Math.min(1,max/Math.max(bitmap.width,bitmap.height));
  const canvas=document.createElement("canvas");canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));canvas.getContext("2d").drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
  let quality=.9,blob;do{blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/jpeg",quality));quality-=.1}while(blob?.size>1024*1024&&quality>=.4);
  if(!blob||blob.size>1024*1024)throw new Error("Image could not be reduced below 1 MiB.");
  const dataBase64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(",")[1]);reader.onerror=()=>reject(new Error("Could not read image."));reader.readAsDataURL(blob)});
  return{mimeType:"image/jpeg",dataBase64};
}
export default App;
