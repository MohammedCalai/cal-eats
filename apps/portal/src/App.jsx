import Loyalty, { AdminPromotionActivity } from "./Loyalty.jsx";
import { CustomerDirectory, CustomerInbox, WorkspaceDialog } from "./CustomerWorkspace.jsx";
import SupportWorkspace from "./SupportWorkspace.jsx";
import RefinedMenu from "./MenuWorkspace.jsx";
import DeliverySettings from "./DeliverySettings.jsx";
import OwnerDashboardView from "./OwnerDashboard.jsx";
import { OrderAlertProvider, OrderAlertBar, useOrderAlerts } from "./NewOrderAlerts.jsx";
import { businessOrderTransitions } from "./order-alert-model.js";
import OrderConfirmationAlerts from "./OrderConfirmationAlerts.jsx";
import CustomerEmailDelivery from "./CustomerEmailDelivery.jsx";
import { OrderConversation, MessagingSettings, AdminMessageIncidents, AdminMessageReview } from "./OrderMessaging.jsx";
import { DisputeResolution } from "./DisputeResolution.jsx";
import { NotificationsPanel } from "./NotificationsPanel.jsx";
import { StripeAdminReadiness, StripeRestaurantFinance } from "./StripePayments.jsx";
import { connectLiveNotifications } from "../../web/live-notifications.js";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Navigate, Outlet, Route, Routes, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { api, json, newKey } from "./api.js";
import { adminNavigation, listItems, ownerNavigation, ownerMobileNavigation, parseMenuCsv, pounds, poundsInputMinor, roleHome, shortDate } from "./model.js";

const SessionContext = React.createContext(null);
const RestaurantContext = React.createContext(null);
const BUSINESS_ROLES = new Set(["admin", "restaurant", "owner", "staff"]);
function OwnerStripeFinance(){const{restaurant}=React.useContext(RestaurantContext);return <Page title="Stripe payments & payouts" intro="Hosted card payments, account verification and actual bank payout status."><StripeRestaurantFinance restaurantId={restaurant.id}/></Page>}

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
  return <span className="brand"><img className="brand-logo" src="/assets/cal-eats-logo.png" alt="Cal-Eats" /></span>;
}

function App() {
  const [session, setSession] = useState({ loading: true, user: null, generation: 0 });
  const refresh = useCallback(async () => {
    const generation = session.generation + 1;
    setSession((s) => ({ ...s, loading: true, generation }));
    try {
      const result = await api("/api/auth/me");
      setSession((s) => s.generation === generation ? { loading: false, user: result.user || result, generation } : s);
    } catch { setSession((s) => s.generation === generation ? { loading: false, user: null, generation } : s); }
  }, [session.generation]);
  useEffect(() => { refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (session.loading) return <PageState text="Opening business platform…" />;
  return <SessionContext.Provider value={{ ...session, refresh, setSession }}><Routes>
    <Route path="/login" element={<Login />} />
    <Route element={<RequireSession />}>
      <Route path="/" element={<PortalHome />} />
      <Route path="/owner" element={<OwnerBootstrap />}>
        <Route element={<Shell kind="owner" />}>
          <Route path="dashboard" element={<OwnerDashboard />} />
          <Route path="orders" element={<Orders />} />
          <Route path="menu" element={<Menu />} />
          <Route path="inbox" element={<CustomerTools view="inbox" />} />
          <Route path="customers" element={<CustomerTools view="customers" />} />
          <Route path="offers" element={<CustomerTools view="offers" />} />
          <Route path="support" element={<OwnerSupport />} />
          <Route path="printers" element={<Printers />} />
          <Route path="earnings" element={<OwnerOnly><Earnings /></OwnerOnly>} />
          <Route path="stripe" element={<OwnerOnly><OwnerStripeFinance /></OwnerOnly>} />
          <Route path="refunds" element={<OwnerOnly><OwnerRefunds /></OwnerOnly>} />
          <Route path="settings" element={<OwnerOnly><Settings /></OwnerOnly>} />
        </Route>
      </Route>
      <Route path="/admin" element={<RequireRole role="admin" />}>
        <Route element={<Shell kind="admin" />}>
          <Route path="dashboard" element={<AdminDashboard />} />
          <Route path="restaurants" element={<AdminRestaurants />} />
          <Route path="orders" element={<AdminOrders />} />
          <Route path="finance" element={<AdminFinance />} />
          <Route path="stripe" element={<Page title="Stripe readiness" intro="Payment setup, restaurant verification and bank payout status."><StripeAdminReadiness /></Page>} />
          <Route path="refunds" element={<AdminRefunds />} />
          <Route path="governance" element={<Page title="Access & deadlines" intro="Audited account access, restaurant permissions and refund response policy."><AdminGovernance /></Page>} />
          <Route path="support" element={<SupportWorkspace kind="admin" />} />
          <Route path="operations" element={<AdminOperations />} />
        </Route>
      </Route>
    </Route>
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes></SessionContext.Provider>;
}

function RequireSession() { const { user } = React.useContext(SessionContext); return user ? <Outlet /> : <Navigate to="/login" replace />; }
function PortalHome() { const { user } = React.useContext(SessionContext); return BUSINESS_ROLES.has(user?.role) ? <Navigate to={roleHome(user.role)} replace /> : <BusinessAccessUnavailable />; }
function RequireRole({ role }) { const { user } = React.useContext(SessionContext); return user?.role === role ? <Outlet /> : BUSINESS_ROLES.has(user?.role) ? <Denied /> : <BusinessAccessUnavailable />; }
function OwnerOnly({ children }) { const { permission } = React.useContext(RestaurantContext); return permission === "owner" ? children : <Denied message="Owner permission is required." />; }

function Login() {
  const { user, refresh } = React.useContext(SessionContext); const navigate = useNavigate();
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  if (user) return BUSINESS_ROLES.has(user.role) ? <Navigate to={roleHome(user.role)} replace /> : <BusinessAccessUnavailable />;
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError(""); const data = new FormData(event.currentTarget);
    try { await api("/api/auth/login", json("POST", { email: data.get("email"), password: data.get("password") })); await refresh(); navigate("/"); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <main className="auth"><section className="auth-card"><Brand /><p className="eyebrow">Cal-Eats Business</p><h1>Sign in to the business platform</h1><p>Restaurant teams and Cal-Eats administrators use this same platform. Your account determines the tools you can access.</p>{error && <Alert>{error}</Alert>}<form onSubmit={submit}><Field label="Email" name="email" type="email" required autoComplete="email"/><Field label="Password" name="password" type="password" required autoComplete="current-password"/><button className="primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button></form><p className="fine">Local preview. Payments, payouts and device printing are simulated unless explicitly labelled otherwise.</p></section></main>;
}

function OwnerBootstrap() {
  const { user } = React.useContext(SessionContext); const result = useLoad(() => api("/api/restaurant/restaurants"), [user.id]);
  const restaurants = listItems(result.value); const [selected, setSelected] = useState("");
  useEffect(() => { if (!selected && restaurants[0]) setSelected(restaurants[0].id); }, [restaurants, selected]);
  if (!["restaurant", "owner", "staff"].includes(user.role)) return BUSINESS_ROLES.has(user.role) ? <Denied /> : <BusinessAccessUnavailable />;
  if (result.loading) return <PageState text="Loading restaurant workspace…"/>;
  if (result.error) return <PageState error={result.error} retry={result.reload}/>;
  if (!restaurants.length) return <PageState text="No restaurant membership is available for this account."/>;
  const restaurant = restaurants.find((r) => r.id === selected) || restaurants[0];
  const permission = restaurant.permission || restaurant.membershipPermission || "owner";
  return <RestaurantContext.Provider value={{ restaurant, restaurants, setSelected, permission, refreshRestaurants:result.reload }}><Outlet /></RestaurantContext.Provider>;
}

function NavIcon({label}) {
  const paths={Menu:"M4 5h16M4 12h16M4 19h16",Inbox:"M3 5h18v14H3zM3 12h5l2 3h4l2-3h5",Customers:"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M20 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",Offers:"M3 3h8l10 10-8 8L3 11zM7 7h.01",Cases:"M8 3h8v4H8zM8 5H5v16h14V5h-3M9 12h6M9 16h6",Home:"M3 11 12 3l9 8M5 10v11h14V10M9 21v-7h6v7",Orders:"M5 3h14v18l-3-2-4 2-4-2-3 2zM8 8h8M8 12h8"};
  return <svg aria-hidden="true" viewBox="0 0 24 24"><path d={paths[label]||paths.Home}/></svg>;
}
function Shell({ kind }) {
  const { user, refresh } = React.useContext(SessionContext); const restaurantContext = React.useContext(RestaurantContext); const owner = kind === "owner" ? restaurantContext : null;
  const [open, setOpen] = useState(false),[messageCount,setMessageCount]=useState(0); const location = useLocation(); useEffect(() => setOpen(false), [location.pathname]);
  useEffect(()=>{const close=e=>{if(e.key==="Escape")setOpen(false);},counts=e=>setMessageCount(e.detail?.messages||0);addEventListener("keydown",close);addEventListener("cal-eats-notification-counts",counts);return()=>{removeEventListener("keydown",close);removeEventListener("cal-eats-notification-counts",counts);};},[]);
  const nav = kind === "admin" ? adminNavigation : ownerNavigation(owner.permission);
  const mobileNav=kind==="owner"?ownerMobileNavigation(owner.permission):[["Home","/admin/dashboard"],["Orders","/admin/orders"],["Cases","/admin/refunds"]];
  async function logout() { await api("/api/auth/logout", json("POST", {})).catch(() => {}); await refresh(); }
  return <OrderAlertProvider enabled={kind==="owner"} restaurants={owner?.restaurants} onSelectRestaurant={owner?.setSelected} onRefreshRestaurants={owner?.refreshRestaurants} userId={user.id}><div className="portal"><a className="skip" href="#portal-main">Skip to content</a>{open&&<button className="sidebar-shade" aria-label="Close navigation" onClick={()=>setOpen(false)}/>}<aside id="business-navigation" className={open ? "sidebar open" : "sidebar"}><div className="sidebar-top"><Brand /><button className="icon-button mobile-only" onClick={() => setOpen(false)} aria-label="Close menu">×</button></div>{owner && <label className="restaurant-switch">Restaurant<select value={owner.restaurant.id} onChange={(e) => owner.setSelected(e.target.value)}>{owner.restaurants.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>}<nav aria-label={`${kind} portal`}>{nav.map(([label, path]) => <NavLink key={path} to={path}>{label}{path==="/owner/inbox"&&messageCount>0&&<b className="nav-count">{messageCount}</b>}</NavLink>)}</nav><div className="sidebar-note"><strong>{kind === "admin" ? "Platform administrator" : owner.permission === "staff" ? "Restaurant staff" : "Restaurant owner"}</strong><span>{user.name}</span><button className="quiet mobile-only" onClick={logout}>Sign out</button></div></aside><div className="portal-body"><header className="topbar"><button className="icon-button menu-button" onClick={() => setOpen(v=>!v)} aria-label="Open menu" aria-controls="business-navigation" aria-expanded={open}>☰</button><div className="topbar-title"><span className="eyebrow">{kind === "admin" ? "Cal-Eats platform" : owner.restaurant.name}</span><strong>{nav.find(([, path]) => location.pathname.startsWith(path))?.[0] || "Business platform"}</strong></div><div className="top-actions"><NotificationsPanel enableSound={kind==="owner"} kind={kind} onSelectRestaurant={owner?.setSelected}/><button className="quiet topbar-signout" onClick={logout}>Sign out</button><span className="user-avatar" aria-label={user.name}>{user.name?.slice(0,1)||"C"}</span></div></header><OrderAlertBar/><main id="portal-main" className="content" tabIndex={-1}><Outlet /></main><nav className="mobile-bottom-nav" aria-label="Quick business tools">{mobileNav.map(([label,path])=><NavLink key={path} to={path}><span className="nav-icon"><NavIcon label={label}/>{label==="Inbox"&&messageCount>0&&<b className="nav-count">{messageCount}</b>}</span><span>{label}</span></NavLink>)}</nav></div></div></OrderAlertProvider>;
}

function OwnerDashboard() {
  const { restaurant, permission } = React.useContext(RestaurantContext);
  return <OwnerDashboardView key={`${restaurant.id}:${permission}`} restaurant={restaurant} permission={permission}/>;
}

function Orders() {
  const { restaurant } = React.useContext(RestaurantContext); const alerts=useOrderAlerts();const result=useLoad(()=>api(`/api/restaurant/restaurants/${restaurant.id}/orders`),[restaurant.id]);
  const[active,setActive]=useState(null),[error,setError]=useState(""),[progressing,setProgressing]=useState(""),[params,setParams]=useSearchParams(),selectedOrder=params.get("order");const selectedRef=useRef(selectedOrder),restaurantRef=useRef(restaurant.id),priorRestaurant=useRef(restaurant.id);selectedRef.current=selectedOrder;restaurantRef.current=restaurant.id;
  useEffect(()=>connectLiveNotifications({onRefresh:result.reload}),[result.reload]);
  useEffect(()=>{const refresh=()=>void result.reload();addEventListener("cal-eats-orders-updated",refresh);return()=>removeEventListener("cal-eats-orders-updated",refresh);},[result.reload]);
  useEffect(()=>{if(priorRestaurant.current!==restaurant.id){priorRestaurant.current=restaurant.id;setActive(null);setError("");setProgressing("");setParams({});}},[restaurant.id]);
  useEffect(()=>{if(!selectedOrder){setActive(null);return;}const order=listItems(result.value).find(item=>item.id===selectedOrder&&item.restaurantId===restaurant.id);if(order)setActive(order);},[selectedOrder,result.value,restaurant.id]);
  async function update(order,status){
    if(progressing)return;if(status==="accepted"){setParams({});alerts.openOrder(order);return;}setError("");setProgressing(status);
    try{const value=await api(`/api/restaurant/orders/${order.id}/status`,json("PATCH",{status})),updated=value.order||value;if(selectedRef.current===order.id&&restaurantRef.current===order.restaurantId)setActive(updated);if(restaurantRef.current===order.restaurantId)await result.reload();}
    catch(e){if(restaurantRef.current===order.restaurantId){setError(e.message);await result.reload();}}finally{if(restaurantRef.current===order.restaurantId)setProgressing("");}
  }
  async function estimate(order,value){if(progressing)return;setError("");setProgressing("eta");try{const updated=await api(`/api/restaurant/orders/${order.id}/preparation`,json("PATCH",{estimatedReadyAt:new Date(value).toISOString()}));if(selectedRef.current===order.id&&restaurantRef.current===order.restaurantId)setActive(updated.order||updated);if(restaurantRef.current===order.restaurantId)await result.reload();}catch(e){if(restaurantRef.current===order.restaurantId)setError(e.message);}finally{if(restaurantRef.current===order.restaurantId)setProgressing("");}}
  const actionLabel=(status,order)=>({accepted:"Confirm order",preparing:"Start preparing",ready:"Mark ready",out_for_delivery:"Out for delivery",completed:order.fulfillment==="delivery"?"Mark delivered":"Mark collected"})[status]||status.replaceAll("_"," ");
  return <Page title="Orders" intro="Confirm new orders, keep the customer’s ETA clear and update each step.">{error&&!active&&<Alert>{error}</Alert>}{result.loading?<Skeleton/>:result.error?<PageState error={result.error} retry={result.reload}/>:<OrderTable items={listItems(result.value)} onOpen={order=>{setError("");setParams({order:order.id});}}/>}{active&&<Dialog title={`Order ${active.id.slice(0,8).toUpperCase()}`} onClose={()=>setParams({})}>{error&&<Alert>{error}</Alert>}<OrderDetail order={active}/>{(active.messagingAvailable??["placed","accepted","preparing","ready","out_for_delivery"].includes(active.status))&&<OrderConversation key={active.id} orderId={active.id}/>}<div className="button-row order-progress-actions">{nextStatuses(active.status,active.fulfillment).map(status=><button type="button" className="primary" key={status} disabled={Boolean(progressing)} onClick={()=>void update(active,status)}>{progressing===status?"Updating…":actionLabel(status,active)}</button>)}</div>{["accepted","preparing"].includes(active.status)&&<form className="order-eta-update" onSubmit={e=>{e.preventDefault();const value=new FormData(e.currentTarget).get("eta");if(value)void estimate(active,value);}}><label>{active.fulfillment==="delivery"?"Expected delivery arrival":"Ready for collection"}<input name="eta" type="datetime-local" required disabled={Boolean(progressing)}/></label><button className="quiet" disabled={Boolean(progressing)}>{progressing==="eta"?"Updating ETA…":"Update customer ETA"}</button></form>}</Dialog>}</Page>;
}

function Menu(){const {restaurant,permission}=React.useContext(RestaurantContext);return <RefinedMenu key={restaurant.id} restaurantId={restaurant.id} permission={permission} Editor={MenuItemEditor} imageBody={imageBody}/>;}

function MenuItemEditor({item,onSave,submitLabel,photoControl}){
  const blank={name:"",description:"",priceMinor:0,category:"",allergens:[],dietaryTags:[],modifierGroups:[]};
  const[value,setValue]=useState(()=>structuredClone(item||blank)),[price,setPrice]=useState(item?(Number(item.priceMinor)/100).toFixed(2):""),[allergenText,setAllergenText]=useState((item?.allergens||[]).join(", ")),[dietText,setDietText]=useState((item?.dietaryTags||[]).join(", ")),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const change=(key,next)=>setValue(old=>({...old,[key]:next}));
  const patchGroup=(index,patch)=>change("modifierGroups",value.modifierGroups.map((g,i)=>i===index?{...g,...patch}:g));
  const addGroup=()=>change("modifierGroups",[...value.modifierGroups,{id:newEditorId("group"),name:"",minSelections:0,maxSelections:1,options:[]}]);
  const addOption=index=>patchGroup(index,{options:[...value.modifierGroups[index].options,{id:newEditorId("option"),name:"",priceMinor:0,available:true}]});
  const patchOption=(groupIndex,optionIndex,patch)=>patchGroup(groupIndex,{options:value.modifierGroups[groupIndex].options.map((o,i)=>i===optionIndex?{...o,...patch}:o)});
  async function submit(event){event.preventDefault();if(busy)return;setError("");try{const groups=value.modifierGroups.map(group=>{const min=Number(group.minSelections),max=Number(group.maxSelections);if(!group.name.trim()||!group.options.length)throw new Error("Each modifier group needs a name and at least one option.");if(!Number.isSafeInteger(min)||!Number.isSafeInteger(max)||min<0||max<min||max>group.options.length)throw new Error(`Check the minimum and maximum choices for ${group.name}.`);const options=group.options.map(option=>{if(!option.name.trim())throw new Error(`Every option in ${group.name} needs a name.`);return{id:option.id,name:option.name.trim(),priceMinor:option.priceDisplay===undefined?Number(option.priceMinor):poundsInputMinor(option.priceDisplay,"Extra price"),available:option.available!==false}});return{...group,name:group.name.trim(),minSelections:min,maxSelections:max,options}});setBusy(true);await onSave({name:value.name.trim(),description:value.description.trim(),priceMinor:poundsInputMinor(price),category:value.category.trim(),allergens:splitEditorList(allergenText),dietaryTags:splitEditorList(dietText),modifierGroups:groups});}catch(x){setError(x.message);setBusy(false)}}
  return <form className="form-grid menu-editor" onSubmit={submit}><Field label="Name" value={value.name} onChange={e=>change("name",e.target.value)} required maxLength="120"/><label>Description<textarea value={value.description} onChange={e=>change("description",e.target.value)} maxLength="500"/></label><Field label="Price (£)" inputMode="decimal" value={price} onChange={e=>setPrice(e.target.value)} required/><Field label="Category" value={value.category||""} onChange={e=>change("category",e.target.value)} maxLength="80"/><Field label="Allergens (comma separated)" value={allergenText} onChange={e=>setAllergenText(e.target.value)}/><Field label="Dietary tags (comma separated)" value={dietText} onChange={e=>setDietText(e.target.value)}/>{photoControl}<details className="menu-advanced full" open={item?.modifierGroups?.length?true:undefined}><summary>Choices & extras (optional)</summary><fieldset className="modifier-editor full"><legend>Choice groups</legend>{value.modifierGroups.map((group,groupIndex)=><section className="modifier-editor-group" key={group.id}><div className="modifier-editor-heading"><Field label="Group name" value={group.name} onChange={e=>patchGroup(groupIndex,{name:e.target.value})} required/><Field label="Minimum choices" type="number" min="0" value={group.minSelections} onChange={e=>patchGroup(groupIndex,{minSelections:Number(e.target.value)})}/><Field label="Maximum choices" type="number" min="1" value={group.maxSelections} onChange={e=>patchGroup(groupIndex,{maxSelections:Number(e.target.value)})}/><button type="button" className="quiet" onClick={()=>change("modifierGroups",value.modifierGroups.filter((_,i)=>i!==groupIndex))}>Remove group</button></div><div className="modifier-option-rows">{group.options.map((option,optionIndex)=><div className="modifier-option-row" key={option.id}><Field label="Option name" value={option.name} onChange={e=>patchOption(groupIndex,optionIndex,{name:e.target.value})} required/><Field label="Extra price (£)" inputMode="decimal" value={option.priceDisplay??(Number(option.priceMinor)/100).toFixed(2)} onChange={e=>patchOption(groupIndex,optionIndex,{priceDisplay:e.target.value})}/><label className="check-field"><input type="checkbox" checked={option.available!==false} onChange={e=>patchOption(groupIndex,optionIndex,{available:e.target.checked})}/> Available</label><button type="button" className="quiet" onClick={()=>patchGroup(groupIndex,{options:group.options.filter((_,i)=>i!==optionIndex)})}>Remove option</button></div>)}</div><button type="button" className="quiet" onClick={()=>addOption(groupIndex)}>Add option</button></section>)}<button type="button" className="quiet" onClick={addGroup}>Add choice group</button></fieldset></details>{error&&<Alert>{error}</Alert>}<button className="primary" disabled={busy}>{busy?"Saving…":submitLabel}</button></form>;
}

const splitEditorList=value=>value.split(",").map(entry=>entry.trim()).filter(Boolean);
const newEditorId=prefix=>`${prefix}-${crypto.randomUUID().slice(0,8)}`;

function CustomerTools({view}){const {restaurant,permission}=React.useContext(RestaurantContext);if(permission!=="owner")return <Denied message="Owner permission is required for customer tools."/>;return view==="inbox"?<CustomerInbox key={restaurant.id} restaurantId={restaurant.id}/>:view==="offers"?<Loyalty key={restaurant.id} restaurantId={restaurant.id}/>:<CustomerDirectory key={restaurant.id} restaurantId={restaurant.id}/>;}
function OwnerSupport(){const{restaurant}=React.useContext(RestaurantContext);return <SupportWorkspace kind="restaurant" restaurantId={restaurant.id}/>;}

function Printers() {
  const { restaurant, permission } = React.useContext(RestaurantContext);
  return <PrinterWorkspace key={restaurant.id} restaurant={restaurant} permission={permission}/>;
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
    {permission === "owner" && <Section title="Manual reprint">
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


function Earnings(){const{restaurant}=React.useContext(RestaurantContext);const root=`/api/restaurant/restaurants/${restaurant.id}/finance`;const summary=useLoad(()=>api(`${root}/summary`),[restaurant.id]);const orders=useLoad(()=>api(`${root}/orders`),[restaurant.id]);const payouts=useLoad(()=>api(`${root}/payouts`),[restaurant.id]);const policy=useLoad(()=>api(`${root}/commission-policy`),[restaurant.id]);const mandate=useLoad(()=>api(`${root}/cash-mandate`),[restaurant.id]);const provider=useLoad(()=>api(`${root}/provider-account`),[restaurant.id]);const[error,setError]=useState("");const paymentSetup=useLoad(()=>api("/api/payments/config"),[]);const s=summary.value||{};async function post(path,body,label){setError("");try{await api(`${root}/${path}`,json("POST",body,newKey(label)));summary.reload();policy.reload();mandate.reload();provider.reload()}catch(x){setError(x.message)}}return <Page title="Earnings & payouts" intro="Reconciled marketplace earnings, separate cash receivables and payout state."><Simulation mode={paymentSetup.value?.providerMode??s.providerMode}/>{(summary.error||error)&&<Alert>{summary.error||error}</Alert>}<div className="stats"><Stat label="Gross sales" value={pounds(s.grossSalesMinor)}/><Stat label="Recognised commission" value={pounds(s.commissionMinor)}/><Stat label="Net earnings" value={pounds(s.netEarningsMinor)}/><Stat label="Available" value={pounds(s.availableMinor)}/><Stat label="Pending" value={pounds(s.pendingMinor)}/><Stat label="Held" value={pounds(s.heldMinor)}/><Stat label="Cash commission due" value={pounds(s.cashCommissionOutstandingMinor)}/></div><Section title="Development commission agreement"><p>{policy.value?`${policy.value.rateBasisPoints/100}% of ${policy.value.base?.replaceAll("_"," ")} · ${policy.value.durationMonths} months · ${policy.value.developmentAssumption?"development assumption":"approved policy"}`:"No policy available."}</p>{policy.value&&!policy.value.acceptedAt&&<button className="primary" onClick={()=>post("commission-policy/accept",{},"policy")}>Accept displayed development agreement</button>}</Section><Section title="Provider and cash collection">{paymentSetup.value?.providerMode==="local_simulator"?<><p>Provider account: <strong>{provider.value?.status||"not configured"}</strong>. Cash mandate: <strong>{mandate.value?.status||"not authorised"}</strong>.</p><div className="button-row"><button className="quiet" onClick={()=>post("provider-account",{action:"create_test"},"provider")}>Create test provider account</button><button className="quiet" onClick={()=>post("provider-account",{action:"refresh"},"provider-refresh")}>Refresh provider status</button><button className="quiet" onClick={()=>post("cash-mandate",{action:"create"},"mandate")}>Create simulated mandate</button><button className="quiet" onClick={()=>post("cash-mandate",{action:"authorize_simulation"},"mandate-authorize")}>Authorise simulation</button><button className="quiet" onClick={()=>post("cash-mandate",{action:"revoke"},"mandate-revoke")}>Revoke mandate</button></div><p className="fine">No real bank mandate or provider onboarding is completed by these local actions.</p></>:<><p>Card onboarding, verification and bank payout status are managed through Stripe setup.</p><NavLink to="/owner/stripe">Open Stripe setup and payouts</NavLink><p className="fine">Cash is paid directly to the restaurant. Cash commission remains a separate receivable; an automatic bank debit is not activated by this screen.</p></>}</Section><Section title="Order earnings"><DataTable headers={["Order","Total","Refunds","Commission","Merchant net","Settlement"]} rows={listItems(orders.value).map(o=>[o.orderId.slice(0,8),pounds(o.orderTotalMinor),pounds(o.refundsMinor),pounds(o.commissionMinor),pounds(o.merchantNetMinor),o.settlementState])} loading={orders.loading} error={orders.error}/></Section><Section title="Payouts"><DataTable headers={["Payout","Amount","Status","Required action"]} rows={listItems(payouts.value).map(p=>[(p.id||"").slice(0,8),pounds(p.amountMinor),p.status,p.requiredAction||"—"])} loading={payouts.loading} error={payouts.error}/><a className="button-link" href={`${root}/statement.csv`}>Download statement CSV</a></Section></Page>}

function OwnerRefunds(){
  const{restaurant}=React.useContext(RestaurantContext);const result=useLoad(()=>api(`/api/restaurant/restaurants/${restaurant.id}/refund-cases`),[restaurant.id]);const[params,setParams]=useSearchParams(),caseId=params.get("case"),[active,setActive]=useState(null),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  useEffect(()=>{let valid=true;setActive(null);setError("");if(caseId)void api(`/api/refund-cases/${encodeURIComponent(caseId)}`).then(value=>{if(valid)setActive(value);}).catch(e=>{if(valid)setError(e.message);});return()=>{valid=false;};},[caseId,restaurant.id]);
  async function reply(e){e.preventDefault();setBusy(true);setError("");const message=new FormData(e.currentTarget).get("message");try{await api(`/api/restaurant/restaurants/${restaurant.id}/refund-cases/${active.id}/reply`,json("POST",{message}));setParams({});result.reload();}catch(x){setError(x.message);}finally{setBusy(false);}}
  return <Page title="Refund cases" intro="See what needs a reply, review the customer’s report and agree the next step.">{error&&<Alert>{error}</Alert>}<CaseTable result={result} onOpen={item=>setParams({case:item.id})}/>{caseId&&!active&&!error&&<p className="empty" role="status">Opening case…</p>}{active&&<Dialog title={`Case ${active.reference}`} onClose={()=>setParams({})}>{error&&<Alert>{error}</Alert>}<CaseDetail value={active}/><DisputeResolution key={active.id} caseId={active.id} role="restaurant" restaurantId={restaurant.id} onChange={()=>{result.reload();void api(`/api/refund-cases/${active.id}`).then(setActive).catch(()=>{});}}/><form onSubmit={reply}><label>Restaurant reply<textarea name="message" required maxLength={1000} rows={3} placeholder="Write a helpful reply to this case"/></label><button className="primary" disabled={busy}>{busy?"Sending…":"Send reply"}</button></form></Dialog>}</Page>;
}

function Settings(){
  const{restaurant,permission}=React.useContext(RestaurantContext);const account=useLoad(()=>api("/api/account"),[]);const staff=useLoad(()=>api(`/api/restaurant/restaurants/${restaurant.id}/staff`),[restaurant.id]);const readiness=useLoad(()=>api(`/api/restaurant/restaurants/${restaurant.id}/readiness`),[restaurant.id]);const[error,setError]=useState(""),[hours,setHours]=useState(restaurant.profile?.openingHours||[]);
  async function saveAccount(e){e.preventDefault();const f=new FormData(e.currentTarget);try{await api("/api/account",json("PATCH",{name:f.get("name"),phone:f.get("phone")}));account.reload()}catch(x){setError(x.message)}}
  async function saveProfile(e){e.preventDefault();const f=new FormData(e.currentTarget);try{await api(`/api/restaurant/restaurants/${restaurant.id}/profile`,json("PATCH",{description:f.get("description"),cuisine:f.get("cuisine"),phone:f.get("phone"),address:f.get("address"),collectionEnabled:f.get("collectionEnabled")==="on",cashEnabled:f.get("cashEnabled")==="on",paused:f.get("paused")==="on",busyMinutes:Number(f.get("busyMinutes")||0),estimatedCollectionMinutes:Number(f.get("estimatedCollectionMinutes")||0),estimatedDeliveryMinutes:Number(f.get("estimatedDeliveryMinutes")||0),openingHours:hours}));readiness.reload()}catch(x){setError(x.message)}}
  async function addStaff(e){e.preventDefault();const f=new FormData(e.currentTarget);try{await api(`/api/restaurant/restaurants/${restaurant.id}/staff`,json("POST",{name:f.get("name"),email:f.get("email"),password:f.get("password")}));e.currentTarget.reset();staff.reload()}catch(x){setError(x.message)}}
  async function cover(file){try{await api(`/api/restaurant/restaurants/${restaurant.id}/cover`,json("POST",await imageBody(file)))}catch(x){setError(x.message)}}
  const profile=restaurant.profile||{};
  return <Page title="Settings" intro="Account, restaurant setup, opening times and team access.">{error&&<Alert>{error}</Alert>}<DeliverySettings key={restaurant.id} restaurant={restaurant} permission={permission}/><Section title="Order messages"><MessagingSettings key={restaurant.id} restaurantId={restaurant.id}/></Section><Section title="Readiness"><div className="checklist">{Object.entries(readiness.value?.checks||{}).map(([k,v])=><span key={k} className={v?"done":""}>{v?"✓":"○"} {({contact:"Contact details",address:"Business address",hours:"Opening hours",usableMenu:"Menu items",fulfillment:"Fulfilment"})[k]||k}</span>)}</div></Section><Section title="Account"><form className="inline-form" onSubmit={saveAccount}><Field label="Name" name="name" defaultValue={account.value?.name} required/><Field label="Phone" name="phone" defaultValue={account.value?.phone||""}/><button className="primary">Save account</button></form><p className="fine">Signed in as {account.value?.email}</p></Section><Section title="Restaurant profile"><form className="form-grid" onSubmit={saveProfile}><Field label="Description" name="description" defaultValue={profile.description||""}/><Field label="Cuisine" name="cuisine" defaultValue={profile.cuisine||restaurant.cuisine||""}/><Field label="Business phone" name="phone" defaultValue={profile.phone||""}/><Field label="Business address" name="address" defaultValue={profile.address||""}/><Field label="Busy delay (minutes)" name="busyMinutes" type="number" min="0" defaultValue={profile.busyMinutes||0}/><Field label="Collection estimate" name="estimatedCollectionMinutes" type="number" min="0" defaultValue={profile.estimatedCollectionMinutes||0}/><Field label="Delivery estimate" name="estimatedDeliveryMinutes" type="number" min="0" defaultValue={profile.estimatedDeliveryMinutes||0}/><label><input type="checkbox" name="collectionEnabled" defaultChecked={profile.collectionEnabled}/> Collection enabled</label><label><input type="checkbox" name="cashEnabled" defaultChecked={profile.cashEnabled}/> Cash enabled</label><label><input type="checkbox" name="paused" defaultChecked={profile.paused}/> Pause new orders</label><HoursEditor value={hours} onChange={setHours}/><button className="primary">Save restaurant</button></form><label className="file-button">Choose cover photo<input type="file" accept="image/jpeg,image/png" onChange={e=>e.target.files[0]&&cover(e.target.files[0])}/></label></Section><Section title="Team"><DataTable headers={["Name","Email","Permission"]} rows={listItems(staff.value).map(s=>[s.name,s.email,s.permission])} loading={staff.loading} error={staff.error}/><form className="inline-form" onSubmit={addStaff}><Field label="Staff name" name="name" required/><Field label="Email" name="email" type="email" required/><Field label="Temporary password" name="password" type="password" minLength="12" required/><button className="primary">Add staff account</button></form></Section></Page>}

function adminFinanceTotals(value){const items=listItems(value);const commissionMinor=items.reduce((sum,item)=>sum+(item.commissionMinor||0),0),providerCostMinor=value?.actualProviderCostMinor??items.reduce((sum,item)=>sum+(item.providerCostMinor||0),0);return{items,grossSalesMinor:items.reduce((sum,item)=>sum+(item.grossSalesMinor||0),0),commissionMinor,providerCostMinor,marginMinor:value?.marginMinor??commissionMinor-providerCostMinor,providerCostsPendingCount:items.reduce((sum,item)=>sum+(item.providerCostsPendingCount||0),0),providerMode:new Set(items.flatMap(item=>item.providerModes||[item.providerMode]).filter(Boolean)).size>1?"mixed":items[0]?.providerMode}}
function adminMoney(result,value){return result.loading?"Loading…":result.error?"Unavailable":pounds(value)}

function AdminDashboard(){const summary=useLoad(()=>api("/api/admin/finance/summary"),[]);const restaurants=useLoad(()=>api("/api/admin/restaurants"),[]);const totals=adminFinanceTotals(summary.value);return <Page title="Marketplace dashboard" intro="Restaurants, reconciled platform finance and operational exceptions."><Simulation mode={totals.providerMode}/>{totals.providerCostsPendingCount>0&&<Alert>Processing fees are still being confirmed for {totals.providerCostsPendingCount} card order(s). The margin remains an estimate.</Alert>}<AdminPromotionActivity/>{summary.error&&<Alert>Marketplace finance is unavailable: {summary.error}</Alert>}{restaurants.error&&<Alert>Restaurant totals are unavailable: {restaurants.error}</Alert>}<div className="stats"><Stat label="Restaurants" value={restaurants.loading?"Loading…":restaurants.error?"Unavailable":listItems(restaurants.value).length}/><Stat label="Gross marketplace sales" value={adminMoney(summary,totals.grossSalesMinor)}/><Stat label="Recognised commission" value={adminMoney(summary,totals.commissionMinor)}/><Stat label="Provider costs" value={adminMoney(summary,totals.providerCostMinor)}/><Stat label="Estimated margin" value={adminMoney(summary,totals.marginMinor)}/></div></Page>}

function AdminRestaurants(){
  const r=useLoad(()=>api("/api/admin/restaurants"),[]);const[error,setError]=useState("");const[active,setActive]=useState(null);
  async function approval(id,status){setError("");try{await api(`/api/admin/restaurants/${id}/approval`,json("PATCH",{status}));await r.reload();setActive(old=>old?.id===id?{...old,status,approvalStatus:status}:old)}catch(x){setError(x.message)}}
  async function suspension(event,restaurant){event.preventDefault();const form=new FormData(event.currentTarget),suspended=form.get("suspended")==="true";setError("");try{const updated=await api(`/api/admin/restaurants/${restaurant.id}/suspension`,json("PATCH",{suspended,reason:form.get("reason")}));setActive(updated);r.reload()}catch(x){setError(x.message)}}
  return <Page title="Restaurants" intro="Applications, readiness, menus, device diagnostics and marketplace enforcement.">{error&&<Alert>{error}</Alert>}<DataTable headers={["Restaurant","Approval","Suspended","Cuisine","Created","Action"]} rows={listItems(r.value).map(x=>[x.name,x.approvalStatus||x.status,x.suspended?"Yes":"No",x.profile?.cuisine||x.cuisine||"—",shortDate(x.createdAt),<div className="button-row"><button className="quiet" onClick={()=>setActive(x)}>Inspect</button><button className="quiet" onClick={()=>approval(x.id,"approved")}>Approve</button><button className="quiet" onClick={()=>approval(x.id,"rejected")}>Reject</button></div>])} loading={r.loading} error={r.error}/><p className="fine">Approval is server-blocked until readiness is complete. Suspension requires an administrator reason and is recorded in audit history.</p>{active&&<AdminRestaurantDetail restaurant={active} onClose={()=>setActive(null)} onSuspension={suspension}/>}</Page>}

function AdminRestaurantDetail({restaurant,onClose,onSuspension}){
  const readiness=useLoad(()=>api(`/api/admin/restaurants/${restaurant.id}/readiness`),[restaurant.id]);
  const menu=useLoad(()=>api(`/api/admin/restaurants/${restaurant.id}/menu`),[restaurant.id]);
  const diagnostics=useLoad(()=>api(`/api/admin/restaurants/${restaurant.id}/devices`),[restaurant.id]);
  const checks=readiness.value?.checks||{},devices=diagnostics.value||{};
  return <Dialog title={restaurant.name} onClose={onClose}><div className="admin-diagnostics"><div className="detail-list"><p><span>Approval</span><strong>{restaurant.approvalStatus||restaurant.status}</strong></p><p><span>Suspended</span><strong>{restaurant.suspended?"Yes":"No"}</strong></p><p><span>Cuisine</span><strong>{restaurant.profile?.cuisine||"—"}</strong></p><p><span>Contact</span><strong>{restaurant.profile?.phone||"—"}</strong></p><p><span>Address</span><strong>{restaurant.profile?.address||"—"}</strong></p></div><h3>Readiness</h3>{readiness.error?<Alert>{readiness.error}</Alert>:readiness.loading?<Skeleton/>:<div className="checklist">{Object.entries(checks).map(([key,value])=><span key={key} className={value?"done":""}>{value?"✓":"○"} {key}</span>)}</div>}<form className="inline-form" onSubmit={event=>onSuspension(event,restaurant)}><label>Marketplace access<select name="suspended" defaultValue={String(Boolean(restaurant.suspended))}><option value="false">Active</option><option value="true">Suspended</option></select></label><Field label="Administrator reason" name="reason" required maxLength="300"/><button className="primary">Apply access state</button></form><GovernanceMemberships restaurantId={restaurant.id}/><h3>Menu</h3><DataTable headers={["Item","Category","Price","Available","Allergens"]} rows={listItems(menu.value?.items).map(item=>[item.name,item.category||"—",pounds(item.priceMinor),item.available?"Yes":"No",item.allergens?.join(", ")||"None listed"])} loading={menu.loading} error={menu.error}/><h3>Printers</h3><DataTable headers={["Printer","Enabled","Revoked","Updated"]} rows={listItems(devices.printers).map(item=>[item.name,item.enabled?"Yes":"No",item.revoked?"Yes":"No",shortDate(item.updatedAt)])} loading={diagnostics.loading} error={diagnostics.error}/><h3>Paired devices</h3><DataTable headers={["Device","Printer","Revoked","Last seen"]} rows={listItems(devices.devices).map(item=>[item.name,item.printerId?.slice(0,8),item.revoked?"Yes":"No",shortDate(item.lastSeenAt)])} loading={diagnostics.loading} error={diagnostics.error}/><h3>Recent print jobs</h3><DataTable headers={["Job","Order","Status","Attempt","Reprint","Lease expiry","Detail","Updated"]} rows={listItems(devices.jobs).map(item=>[item.id?.slice(0,8),item.orderId?.slice(0,8),item.status,item.attempt,item.manualReprint?"Yes":"No",shortDate(item.leaseExpiresAt),item.detail||"—",shortDate(item.updatedAt)])} loading={diagnostics.loading} error={diagnostics.error}/><p className="fine">Diagnostics never expose bearer tokens, token hashes, receipts or claim credentials. Reported job state does not prove paper physically printed.</p></div></Dialog>
}

function GovernanceMemberships({restaurantId}){const members=useLoad(()=>api(`/api/admin/governance/restaurants/${restaurantId}/memberships`),[restaurantId]),accounts=useLoad(()=>api("/api/admin/governance/accounts"),[]),[error,setError]=useState("");async function change(userId,permission){const reason=window.prompt("Reason for this permission change");if(!reason)return;try{await api(`/api/admin/governance/restaurants/${restaurantId}/memberships/${userId}`,json("PATCH",{permission,reason}));members.reload()}catch(x){setError(x.message)}}async function remove(userId){const reason=window.prompt("Reason for removing this membership");if(!reason)return;try{await api(`/api/admin/governance/restaurants/${restaurantId}/memberships/${userId}`,json("DELETE",{reason}));members.reload()}catch(x){setError(x.message)}}async function add(e){e.preventDefault();const f=new FormData(e.currentTarget);try{await api(`/api/admin/governance/restaurants/${restaurantId}/memberships`,json("POST",{userId:f.get("userId"),permission:f.get("permission"),reason:f.get("reason")}));e.currentTarget.reset();members.reload()}catch(x){setError(x.message)}}const current=new Set(listItems(members.value).map(x=>x.userId)),eligible=listItems(accounts.value).filter(x=>x.role==="restaurant"&&x.enabled&&!current.has(x.id));return <section><h3>Restaurant access</h3>{error&&<Alert>{error}</Alert>}<DataTable headers={["Person","Email","Permission","Actions"]} rows={listItems(members.value).map(x=>[x.name,x.email,x.permission,<div className="button-row"><button className="quiet" onClick={()=>change(x.userId,x.permission==="owner"?"staff":"owner")}>{x.permission==="owner"?"Make staff":"Make owner"}</button><button className="quiet" onClick={()=>remove(x.userId)}>Remove</button></div>])} loading={members.loading} error={members.error}/>{eligible.length>0&&<form className="inline-form" onSubmit={add}><label>Restaurant user<select name="userId" required>{eligible.map(x=><option value={x.id} key={x.id}>{x.name} — {x.email}</option>)}</select></label><label>Permission<select name="permission"><option value="staff">Staff</option><option value="owner">Owner</option></select></label><Field label="Administrator reason" name="reason" required maxLength="500"/><button className="primary">Add access</button></form>}<p className="fine">Changes are audited. The server prevents removal or demotion of the final owner.</p></section>}

function AdminOrders(){const r=useLoad(()=>api("/api/admin/orders"),[]);const[active,setActive]=useState(null),[params,setParams]=useSearchParams(),selected=params.get("order");useEffect(()=>{if(!selected){setActive(null);return;}const order=listItems(r.value).find(item=>item.id===selected);if(order)setActive(order);},[selected,r.value]);return <Page title="Orders" intro="Marketplace order search and lifecycle visibility."><OrderConfirmationAlerts/><CustomerEmailDelivery/><OrderTable items={listItems(r.value)} onOpen={order=>setParams({order:order.id})}/>{r.error&&<Alert>{r.error}</Alert>}{active&&<Dialog title={`Order ${active.id.slice(0,8)}`} onClose={()=>setParams({})}><OrderDetail order={active}/><AdminMessageReview orderId={active.id}/><div className="detail-list"><p><span>Restaurant</span><strong>{active.restaurantName}</strong></p><p><span>Payment state</span><strong>{active.paymentStatus}</strong></p><p><span>Refunded</span><strong>{pounds(active.refundedTotalMinor)}</strong></p></div></Dialog>}</Page>}

function AdminFinance(){
  const summary=useLoad(()=>api("/api/admin/finance/summary"),[]),exceptions=useLoad(()=>api("/api/admin/finance/exceptions"),[]),contracts=useLoad(()=>api("/api/admin/contracts"),[]),statements=useLoad(()=>api("/api/admin/statements"),[]);const[notice,setNotice]=useState(""),[error,setError]=useState("");const totals=adminFinanceTotals(summary.value);
  async function runWorker(){setError("");setNotice("");try{await api("/api/admin/finance/workers/run",json("POST",{}));setNotice("One explicit local marketplace worker cycle completed.");summary.reload();exceptions.reload()}catch(x){setError(x.message)}}
  return <Page title="Finance" intro="Provider-labelled marketplace money, contracts, costs and exceptions."><Simulation mode={totals.providerMode}/>{totals.providerCostsPendingCount>0&&<Alert>Processing fees are still being confirmed for {totals.providerCostsPendingCount} card order(s). The margin remains an estimate.</Alert>}{summary.error&&<Alert>Finance summary is unavailable: {summary.error}</Alert>}{error&&<Alert>{error}</Alert>}{notice&&<Alert tone="success">{notice}</Alert>}<div className="stats"><Stat label="Gross sales" value={adminMoney(summary,totals.grossSalesMinor)}/><Stat label="Commission" value={adminMoney(summary,totals.commissionMinor)}/><Stat label="Provider costs" value={adminMoney(summary,totals.providerCostMinor)}/><Stat label="Margin" value={adminMoney(summary,totals.marginMinor)}/></div><div className="button-row"><button className="primary" onClick={runWorker}>Run one local finance cycle</button><a className="button-link" href="/api/admin/reports/orders.csv">Download orders CSV</a><a className="button-link" href="/api/admin/reports/ledger.csv">Download ledger CSV</a></div><p className="fine">The worker button runs one explicit local cycle. It does not start a background service or contact a live provider.</p><Section title="Restaurant summaries"><DataTable headers={["Restaurant","Gross","Commission","Provider cost","Available","Held"]} rows={totals.items.map(item=>[item.restaurantId?.slice(0,8),pounds(item.grossSalesMinor),pounds(item.commissionMinor),pounds(item.providerCostMinor),pounds(item.availableMinor),pounds(item.heldMinor)])} loading={summary.loading} error={summary.error}/></Section><Section title="Exceptions"><DataTable headers={["Type","Restaurant","Amount","Status","Required action"]} rows={listItems(exceptions.value).map(i=>[i.kind||i.type,i.restaurantName||i.restaurantId,pounds(i.amountMinor),i.status,i.requiredAction||i.error||"—"])} loading={exceptions.loading} error={exceptions.error}/></Section><Section title="Contracts"><DataTable headers={["Restaurant","Rate","Duration","Policy","Accepted"]} rows={listItems(contracts.value).map(item=>[item.restaurantId?.slice(0,8),`${item.rateBasisPoints/100}%`,`${item.durationMonths} months`,item.policyVersion,item.acceptedAt?shortDate(item.acceptedAt):"Not accepted"])} loading={contracts.loading} error={contracts.error}/></Section><Section title="Cash statements"><DataTable headers={["Restaurant","Card commission","Cash receivable","Cash settled","Outstanding"]} rows={listItems(statements.value).map(item=>[item.restaurantId?.slice(0,8),pounds(item.commissionCardMinor??((item.commissionMockMinor??0)+(item.commissionStripeMinor??0))),pounds(item.cashReceivableMinor),pounds(item.cashSettledMinor),pounds(item.cashOutstandingMinor)])} loading={statements.loading} error={statements.error}/></Section></Page>
}
function AdminRefunds(){const r=useLoad(()=>api("/api/admin/refund-cases"),[]);const[active,setActive]=useState(null),[error,setError]=useState("");async function decide(e){e.preventDefault();const f=new FormData(e.currentTarget),decision=f.get("decision"),body={decision,reason:f.get("reason"),remedy:f.get("remedy")};if(decision==="partial")body.amountMinor=Math.round(Number(f.get("amount"))*100);try{await api(`/api/admin/refund-cases/${active.id}/decision`,json("POST",body,newKey("refund-decision")));setActive(null);r.reload()}catch(x){setError(x.message)}}async function caseAction(e){e.preventDefault();const f=new FormData(e.currentTarget);try{await api(`/api/admin/refund-cases/${active.id}/actions`,json("POST",{action:f.get("action"),message:f.get("message")}));setActive(null);r.reload()}catch(x){setError(x.message)}}async function cash(e){e.preventDefault();const f=new FormData(e.currentTarget);try{await api(`/api/admin/refund-cases/${active.id}/cash-confirmation`,json("POST",{responsibility:f.get("responsibility"),method:f.get("method"),confirmationEvidence:f.get("confirmationEvidence")},newKey("cash-proof")));setActive(null);r.reload()}catch(x){setError(x.message)}}return <Page title="Refund cases" intro="Review customer evidence and decide remedies. Submission alone never moves money.">{error&&<Alert>{error}</Alert>}<CaseTable result={r} onOpen={setActive}/>{active&&<Dialog title={`Case ${active.reference}`} onClose={()=>setActive(null)}><CaseDetail value={active}/><DisputeResolution key={active.id} caseId={active.id} role="admin" onChange={()=>{r.reload();void api(`/api/refund-cases/${active.id}`).then(setActive).catch(()=>{});}}/><form onSubmit={caseAction}><label>Review action<select name="action"><option value="under_review">Start review</option><option value="request_information">Request customer information</option><option value="ask_restaurant">Ask restaurant</option><option value="internal_note">Internal note</option><option value="reopen">Reopen</option></select></label><Field label="Message" name="message" required maxLength="1000"/><button className="quiet">Record review action</button></form><hr/><form onSubmit={decide}><label>Decision<select name="decision"><option value="approve">Approve</option><option value="partial">Partially approve</option><option value="reject">Reject</option></select></label><Field label="Partial amount (£)" name="amount" type="number" min="0" step="0.01"/><label>Remedy<select name="remedy"><option value="refund">Refund</option><option value="goodwill">Goodwill</option></select></label><Field label="Decision reason" name="reason" required maxLength="500"/><button className="primary">Record decision</button></form>{active.status==="awaiting_cash_return"&&<><hr/><form onSubmit={cash}><Field label="Repayment responsibility" name="responsibility" required/><Field label="Return method" name="method" required/><Field label="Confirmation evidence" name="confirmationEvidence" required/><button className="primary">Confirm evidenced cash return</button></form></>}<p className="fine">Cash approvals remain awaiting cash return until the separate evidenced confirmation succeeds.</p></Dialog>}</Page>}
function AdminGovernance(){const accounts=useLoad(()=>api("/api/admin/governance/accounts"),[]),policy=useLoad(()=>api("/api/admin/governance/refund-policy"),[]),[error,setError]=useState(""),[notice,setNotice]=useState("");async function accountState(user){const reason=window.prompt(`Reason for ${user.enabled?"disabling":"enabling"} this account`);if(!reason)return;setError("");try{await api(`/api/admin/governance/accounts/${user.id}`,json("PATCH",{enabled:!user.enabled,reason}));setNotice(`${user.name}'s account is now ${user.enabled?"disabled":"enabled"}.`);accounts.reload()}catch(x){setError(x.message)}}async function savePolicy(e){e.preventDefault();const f=new FormData(e.currentTarget);setError("");try{await api("/api/admin/governance/refund-policy",json("PATCH",{customerResponseHours:Number(f.get("customerResponseHours")),restaurantResponseHours:Number(f.get("restaurantResponseHours")),reminderLeadHours:Number(f.get("reminderLeadHours"))}));setNotice("Refund response policy saved.");policy.reload()}catch(x){setError(x.message)}}return <><Section title="Account access governance">{error&&<Alert>{error}</Alert>}{notice&&<Alert tone="success">{notice}</Alert>}<DataTable headers={["Name","Email","Role","Access","Action"]} rows={listItems(accounts.value).map(user=>[user.name,user.email,user.role,user.enabled?"Enabled":"Disabled",<button className="quiet" onClick={()=>accountState(user)}>{user.enabled?"Disable":"Enable"}</button>])} loading={accounts.loading} error={accounts.error}/><p className="fine">Disabling revokes browser and native sessions. Self-disable and last-administrator lockout are blocked and every change requires a recorded reason.</p></Section><Section title="Refund response deadlines">{policy.loading?<Skeleton/>:policy.error?<Alert>{policy.error}</Alert>:<form className="inline-form" onSubmit={savePolicy} key={policy.value?.updatedAt}><Field label="Customer response (hours)" name="customerResponseHours" type="number" min="1" max="720" required defaultValue={policy.value?.customerResponseHours}/><Field label="Restaurant response (hours)" name="restaurantResponseHours" type="number" min="1" max="720" required defaultValue={policy.value?.restaurantResponseHours}/><Field label="Reminder lead (hours)" name="reminderLeadHours" type="number" min="1" max="168" required defaultValue={policy.value?.reminderLeadHours}/><button className="primary">Save deadline policy</button></form>}<p className="fine">Reminders and overdue escalations are in-app and deduplicated. A deadline never automatically approves or rejects a case.</p></Section></>}

function AdminOperations(){
  const settings=useLoad(()=>api("/api/admin/operational-settings"),[]),users=useLoad(()=>api("/api/admin/users"),[]),support=useLoad(()=>api("/api/admin/support"),[]),deletions=useLoad(()=>api("/api/admin/deletion-requests"),[]),audit=useLoad(()=>api("/api/admin/audit"),[]),jobs=useLoad(()=>api("/api/admin/jobs"),[]),integrations=useLoad(()=>api("/api/admin/integrations"),[]);const[activeDeletion,setActiveDeletion]=useState(null),[error,setError]=useState("");
  async function setSupport(id,status){setError("");try{await api(`/api/admin/support/${id}`,json("PATCH",{status}));support.reload()}catch(x){setError(x.message)}}
  async function reviewDeletion(event){event.preventDefault();const form=new FormData(event.currentTarget);setError("");try{await api(`/api/admin/deletion-requests/${activeDeletion.id}`,json("PATCH",{status:form.get("status"),note:form.get("note")}));setActiveDeletion(null);deletions.reload()}catch(x){setError(x.message)}}
  const config=settings.value||{};
  return <Page title="Operations" intro="Users, support, deletion reviews, sanitized settings, durable jobs and audit history.">{error&&<Alert>{error}</Alert>}<Section title="Operational settings"><div className="detail-list"><p><span>Run mode</span><strong>{settings.loading?"Loading…":settings.error?"Unavailable":config.runMode}</strong></p><p><span>Payment provider</span><strong>{settings.loading?"Loading…":settings.error?"Unavailable":config.paymentProviderMode}</strong></p><p><span>Secure cookies</span><strong>{settings.loading?"Loading…":settings.error?"Unavailable":config.secureCookies?"Required":"Not required"}</strong></p><p><span>Body limit</span><strong>{settings.loading?"Loading…":settings.error?"Unavailable":`${config.bodyLimit} bytes`}</strong></p><p><span>Worker mode</span><strong>{settings.loading?"Loading…":settings.error?"Unavailable":config.workerMode?.replaceAll("_"," ")}</strong></p></div>{settings.error&&<Alert>{settings.error}</Alert>}<p className="fine">This is a sanitized read-only view. Secrets and mutable runtime configuration are not exposed.</p></Section><Section title="User directory"><DataTable headers={["Name","Email","Role","Phone","Verified","Created"]} rows={listItems(users.value).map(user=>[user.name,user.email,user.role,user.phone||"—",user.emailVerified?"Yes":"No",shortDate(user.createdAt)])} loading={users.loading} error={users.error}/><p className="fine">Users are read-only because the API has no account-suspension mutation. Marketplace enforcement uses the audited restaurant suspension control.</p></Section><AdminMessageIncidents/><Section title="Support cases"><DataTable headers={["Subject","User","Order","Status","Updated","Action"]} rows={listItems(support.value).map(item=>[item.subject,item.userId?.slice(0,8),item.orderId?.slice(0,8)||"—",item.status,shortDate(item.updatedAt),<button className="quiet" onClick={()=>setSupport(item.id,item.status==="resolved"?"open":"resolved")}>{item.status==="resolved"?"Reopen":"Resolve"}</button>])} loading={support.loading} error={support.error}/></Section><Section title="Account deletion reviews"><DataTable headers={["User","Reason","Status","Updated","Action"]} rows={listItems(deletions.value).map(item=>[item.userId?.slice(0,8),item.reason,item.status,shortDate(item.updatedAt),<button className="quiet" onClick={()=>setActiveDeletion(item)}>Review</button>])} loading={deletions.loading} error={deletions.error}/></Section><Section title="Integrations"><div className="card-grid">{listItems(integrations.value).map((item,index)=><article className="item-card" key={item.id||index}><h3>{item.name}</h3><span className="pill">{item.enabled?"Enabled":"Disabled"} · {item.mode}</span><p>{item.detail||"No additional detail."}</p><p className="fine">Updated {shortDate(item.updatedAt)}</p></article>)}</div>{integrations.error&&<Alert>{integrations.error}</Alert>}</Section><Section title="Jobs"><DataTable headers={["Job","Kind","Entity","Status","Attempts","Error","Updated"]} rows={listItems(jobs.value).map(job=>[(job.id||"").slice(0,8),job.kind,job.entityId?.slice(0,8)||"—",job.status,job.attempts,job.error||"—",shortDate(job.updatedAt)])} loading={jobs.loading} error={jobs.error}/></Section><Section title="Audit"><DataTable headers={["Action","Entity","Actor","Details","Time"]} rows={listItems(audit.value).map(item=>[item.action,`${item.entityType}:${item.entityId?.slice(0,8)}`,item.actorUserId?.slice(0,8)||"system",JSON.stringify(item.details||{}),shortDate(item.createdAt)])} loading={audit.loading} error={audit.error}/></Section>{activeDeletion&&<Dialog title="Review deletion request" onClose={()=>setActiveDeletion(null)}><p>{activeDeletion.reason}</p><form onSubmit={reviewDeletion}><label>Status<select name="status" defaultValue={activeDeletion.status==="resolved"?"resolved":"under_review"}><option value="under_review">Under review</option><option value="resolved">Resolved</option></select></label><Field label="Review note" name="note" defaultValue={activeDeletion.note||""} maxLength="1000"/><button className="primary">Save review</button></form><p className="fine">Resolving a request records the review state. It does not claim immediate erasure of retained legal or financial records.</p></Dialog>}</Page>
}

function CaseTable({result,onOpen}){
  const[search,setSearch]=useState(""),[status,setStatus]=useState("all");const items=listItems(result.value),states=[...new Set(items.map(c=>c.phase||c.status))],filtered=items.filter(c=>(!search||`${c.reference} ${c.description||""} ${c.customerName||""}`.toLowerCase().includes(search.toLowerCase()))&&(status==="all"||(c.phase||c.status)===status));
  if(result.loading)return <Skeleton/>;if(result.error)return <Alert>{result.error}</Alert>;
  return <section className="panel"><div className="directory-filters"><label className="search-field">Find a case<input type="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Reference or issue"/></label><label>Status<select value={status} onChange={e=>setStatus(e.target.value)}><option value="all">All statuses</option>{states.map(value=><option key={value} value={value}>{value.replaceAll("_"," ")}</option>)}</select></label></div>{filtered.length?<div className="case-list">{filtered.map(c=><article className="case-card" key={c.id}><header><div><p className="eyebrow">{c.reference}</p><h3>{c.reason?.replaceAll("_"," ")||"Customer report"}</h3></div><span className="pill">{(c.phase||c.status).replaceAll("_"," ")}</span></header><p>{c.description||"Open this case to see the customer report and available remedies."}</p><div className="case-card-footer"><span><small>Requested</small><strong>{pounds(c.requestedAmountMinor)}</strong></span><span><small>Updated</small>{shortDate(c.updatedAt)}</span>{onOpen&&<button className="primary" onClick={()=>onOpen(c)}>Review case →</button>}</div></article>)}</div>:<div className="empty"><h3>{items.length?"No matching cases":"All clear"}</h3><p>{items.length?"Try another search or status.":"Customer refund requests will appear here with their reply and resolution status."}</p></div>}</section>;
}
function CaseDetail({value}){
  const messages=listItems(value.messages),events=listItems(value.events),evidence=listItems(value.evidence);
  const nonRefundRemedy=value.latestProposal&&["accepted","fulfilled"].includes(value.latestProposal.status)&&!["partial_refund","full_refund"].includes(value.latestProposal.type);
  const chronology=[...messages.map(item=>({...item,entryType:"message"})),...events.map(item=>({...item,entryType:"event"}))].sort((a,b)=>Date.parse(a.createdAt||0)-Date.parse(b.createdAt||0));
  const hasReviewFlags=Object.prototype.hasOwnProperty.call(value,"reviewFlags");
  return <div className="case-detail">
    <div className="detail-list"><p><span>Status</span><strong>{(value.phase??value.status)?.replaceAll("_"," ")}</strong></p><p><span>Order</span><strong>{value.orderId?.slice(0,8)}</strong></p><p><span>Issue</span><strong>{value.reason?.replaceAll("_"," ")}</strong></p><p><span>Requested</span><strong>{pounds(value.requestedAmountMinor)}</strong></p><p><span>Approved</span><strong>{nonRefundRemedy?"Non-refund remedy agreed":value.approvedAmountMinor==null?"Awaiting decision":pounds(value.approvedAmountMinor)}</strong></p><p><span>Remedy</span><strong>{(nonRefundRemedy?value.latestProposal.type:value.remedy)?.replaceAll("_"," ")||"Not decided"}</strong></p><p><span>Description</span><strong>{value.description}</strong></p><p><span>Execution</span><strong>{nonRefundRemedy?"Not required for this remedy":`${value.execution?.status||"Not started"} · ${value.execution?.providerMode||"—"}`}</strong></p>{value.execution?.error&&<p><span>Execution issue</span><strong>{value.execution.error}</strong></p>}</div>
    {hasReviewFlags&&<section className="case-section" aria-labelledby="case-review-flags"><h3 id="case-review-flags">Review flags</h3><p className={value.reviewFlags?.secondRequestThisMonth?"case-flag attention":"case-flag"}>Second refund request this month: <strong>{value.reviewFlags?.secondRequestThisMonth?"Yes":"No"}</strong></p></section>}
    <section className="case-section" aria-labelledby="case-evidence"><h3 id="case-evidence">Evidence</h3>{evidence.length?<div className="case-evidence-grid">{evidence.map((item,index)=>{const url=caseEvidenceUrl(value.id,item);return <article className="case-evidence-card" key={item.id||index}>{url?<a href={url} target="_blank" rel="noopener noreferrer"><img src={url} alt={`Evidence image ${index+1}`} loading="lazy"/><span>Open evidence image {index+1}</span></a>:<p>Evidence image {index+1} is unavailable.</p>}<small>{item.mimeType||"Image"} · {formatBytes(item.byteLength)} · {shortDate(item.createdAt)}</small></article>})}</div>:<p className="empty">No evidence images were supplied.</p>}</section>
    <section className="case-section" aria-labelledby="case-history"><h3 id="case-history">Case history</h3>{chronology.length?<ol className="case-timeline">{chronology.map((item,index)=><li key={`${item.entryType}-${item.id||index}`}><article><div className="case-timeline-heading"><strong>{item.entryType==="message"?messageAudience(item.audience):item.kind?.replaceAll("_"," ")||"Case event"}</strong><time dateTime={item.createdAt}>{shortDate(item.createdAt)}</time></div>{item.entryType==="message"?<p>{item.message}</p>:item.details&&Object.keys(item.details).length>0?<CaseEventDetails details={item.details}/>:<p className="fine">Status event</p>}</article></li>)}</ol>:<p className="empty">No replies or status events are visible to this account.</p>}</section>
  </div>
}
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
function BusinessAccessUnavailable(){const{user,refresh}=React.useContext(SessionContext),[busy,setBusy]=useState(false),[error,setError]=useState("");async function switchAccount(){setBusy(true);setError("");try{await api("/api/auth/logout",json("POST",{}));await refresh()}catch(x){setError(x.message)}finally{setBusy(false)}}return <main className="auth"><section className="auth-card"><Brand/><p className="eyebrow">Business portal</p><h1>Use a business account</h1><p>You are signed in as {user?.name||"a customer"}. This account does not have restaurant or administrator access.</p>{error&&<Alert>{error}</Alert>}<div className="button-row"><a className="button-link" href="/order/">Return to customer ordering</a><button className="quiet" type="button" disabled={busy} onClick={switchAccount}>{busy?"Signing out…":"Sign out and switch account"}</button></div><p className="fine">Business access is not added by switching accounts. Sign in with an account that already has an authorised business role.</p></section></main>}
function Denied({message="This workspace is not available for your account role."}){return <div className="panel"><h2>Access unavailable</h2><p>{message}</p></div>}
function DataTable({headers,rows=[],loading,error}){if(loading)return <Skeleton/>;if(error)return <Alert>{error}</Alert>;if(!rows.length)return <p className="empty">Nothing to show yet.</p>;return <div className="table-wrap responsive-table"><table><thead><tr>{headers.map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>{rows.map((r,i)=><tr key={i}>{r.map((c,j)=><td key={j} data-label={headers[j]}>{c??"—"}</td>)}</tr>)}</tbody></table></div>}
function OrderTable({items=[],onOpen}){return <DataTable headers={["Order","Customer","Fulfilment","Total","Payment","Status","Placed",...(onOpen?["Action"]:[])]} rows={items.map(o=>[(o.id||"").slice(0,8),o.customerName||o.contactName||"Customer",o.fulfillment,pounds(o.totalMinor),o.paymentMethod?.replaceAll("_"," "),o.status,shortDate(o.createdAt),...(onOpen?[<button className="quiet" onClick={()=>onOpen(o)}>View</button>]:[])])}/>}
function OrderDetail({order}){return <div className="detail-list"><p><span>Fulfilment</span><strong>{order.fulfillment}</strong></p><p><span>Payment</span><strong>{order.paymentMethod?.replaceAll("_"," ")}</strong></p>{(order.customerEtaAt||order.estimatedReadyAt)&&<p><span>{order.fulfillment==="delivery"?"Expected delivery arrival":"Ready for collection"}</span><strong>{shortDate(order.customerEtaAt||order.estimatedReadyAt)}</strong></p>}{order.restaurantDiscountMinor>0&&<><p><span>Food before promotion</span><strong>{pounds(order.grossFoodMinor)}</strong></p><p><span>Restaurant promotion</span><strong>−{pounds(order.restaurantDiscountMinor)}</strong></p></>}<p><span>Total</span><strong>{pounds(order.totalMinor)}</strong></p>{listItems(order.items).map((i,n)=><p key={i.id||n}><span>{i.quantity} × {i.name||i.itemName}</span><strong>{i.isOfferItem?"Free offer":pounds(i.lineTotalMinor)}</strong></p>)}</div>}
function Dialog({title,onClose,children}){return <WorkspaceDialog title={title} onClose={onClose}>{children}</WorkspaceDialog>}
function nextStatuses(status,fulfillment){return businessOrderTransitions(status,fulfillment);}
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
  if(!["image/jpeg","image/png"].includes(file.type))throw new Error("Choose a JPEG or PNG image.");
  const bitmap=await createImageBitmap(file),max=1400,scale=Math.min(1,max/Math.max(bitmap.width,bitmap.height));
  const canvas=document.createElement("canvas");canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));canvas.getContext("2d").drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
  let quality=.9,blob;do{blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/jpeg",quality));quality-=.1}while(blob?.size>1024*1024&&quality>=.4);
  if(!blob||blob.size>1024*1024)throw new Error("Image could not be reduced below 1 MiB.");
  const dataBase64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(",")[1]);reader.onerror=()=>reject(new Error("Could not read image."));reader.readAsDataURL(blob)});
  return{mimeType:"image/jpeg",dataBase64};
}
export default App;
