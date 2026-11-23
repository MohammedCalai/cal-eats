import React,{useEffect,useRef,useState} from "react";
import {Link} from "react-router-dom";
import {pounds,shortDate} from "./model.js";
import {DashboardCsvDownload} from "./OwnerDashboard.jsx";
import AdminSupportOverview from "./AdminSupportOverview.jsx";
import OrderConfirmationAlerts from "./OrderConfirmationAlerts.jsx";
import {createOrderAudio} from "./business-order-audio.js";
import {readBusinessSoundPreference,subscribeBusinessSoundPreference} from "./business-sound-preference.js";
import {AdminPageHeading,AdminPager,AdminResourceMessage,useAdminResource} from "./AdminWorkspaceShared.jsx";
import "./AdminWorkspace.css";
import "./AdminDashboardWorkspace.css";

function AdminWaitingSound({count,userId}) {
  const player=useRef(null),[error,setError]=useState(""),[soundEnabled,setSoundEnabled]=useState(()=>readBusinessSoundPreference(userId));
  useEffect(()=>{const controller=createOrderAudio(new Audio());player.current=controller;const stop=controller.subscribe(state=>setError(state.error)),interact=e=>{if(e.isTrusted)controller.interact();},resume=()=>controller.resume();document.addEventListener("pointerdown",interact,true);document.addEventListener("keydown",interact,true);window.addEventListener("focus",resume);return()=>{stop();controller.stop();document.removeEventListener("pointerdown",interact,true);document.removeEventListener("keydown",interact,true);window.removeEventListener("focus",resume);player.current=null;};},[]);
  useEffect(()=>subscribeBusinessSoundPreference(userId,setSoundEnabled),[userId]);
  useEffect(()=>{player.current?.update({enabled:soundEnabled,count,path:"/business/notification.wav"});},[count,soundEnabled]);
  return error&&count>0?<p className="alert" role="alert">{error}</p>:null;
}

export default function AdminDashboardWorkspace({userId}) {
  const[range,setRange]=useState({from:"",to:""}),[page,setPage]=useState(1),[state,setState]=useState("all"),[search,setSearch]=useState(""),[draftSearch,setDraftSearch]=useState("");
  const dates=new URLSearchParams(Object.entries(range).filter(([,value])=>value)).toString();
  const overview=useAdminResource(`/api/admin/workspace/dashboard${dates?`?${dates}`:""}`,{poll:5000});
  const query=new URLSearchParams({page:String(page),pageSize:"12",state,q:search}).toString(),queue=useAdminResource(`/api/admin/workspace/unconfirmed-orders?${query}`,{poll:5000}),knownSummary=useRef({});
  if(queue.value?.summary)knownSummary.current=queue.value.summary;
  const summary=knownSummary.current;
  const totals=overview.value,filters=[["all","All unconfirmed",summary.total],["overdue","Over 3 minutes",summary.overdue],["confirmation","Needs confirmation",summary.needsConfirmation],["payment","Awaiting payment",summary.awaitingPayment]];
  useEffect(()=>{const totalPages=queue.value?.pagination?.totalPages;if(totalPages!==undefined&&page>Math.max(1,totalPages))setPage(Math.max(1,totalPages));},[queue.value?.pagination?.totalPages,page]);
  return <div className="admin-workspace admin-dashboard"><AdminPageHeading title="Dashboard" intro="Follow up on waiting orders, review applications and answer support requests."><Link className="button-link" to="/admin/restaurants">Restaurants →</Link></AdminPageHeading>
    <AdminWaitingSound count={summary.needsConfirmation||0} userId={userId}/>
    <section className={`panel admin-order-watch ${summary.needsConfirmation>0?"has-waiting":""}`} aria-labelledby="unconfirmed-orders-title"><div className="admin-watch-heading"><div><p className="eyebrow">Needs attention</p><h2 id="unconfirmed-orders-title">Orders awaiting confirmation</h2><p>Open an order or call the restaurant to follow up.</p></div><span className={`admin-watch-count ${summary.overdue>0?"overdue":""}`} aria-live="polite">{summary.overdue??"—"}<small>waiting over 3 minutes</small></span></div>
      <div className="admin-watch-note"><span className="admin-live-dot"/> {queue.value?.checkedAt?`Last checked ${shortDate(queue.value.checkedAt)}`:"Checking incoming orders…"}</div>
      <div className="admin-filter-tabs" role="group" aria-label="Unconfirmed order filter">{filters.map(([value,label,count])=><button key={value} className={state===value?"selected":""} aria-pressed={state===value} onClick={()=>{setState(value);setPage(1);}}>{label}<b>{count??"—"}</b></button>)}</div>
      <form className="admin-inline-search" onSubmit={e=>{e.preventDefault();setSearch(draftSearch.trim());setPage(1);}}><label>Search waiting orders<input value={draftSearch} onChange={e=>setDraftSearch(e.target.value)} maxLength={100} type="search" placeholder="Restaurant, customer or order reference"/></label><button className="quiet">Search</button>{search&&<button className="quiet" type="button" onClick={()=>{setSearch("");setDraftSearch("");setPage(1);}}>Clear</button>}</form>
      <AdminResourceMessage resource={queue} emptyText={search?"No waiting orders match your search.":"No waiting orders in this view. New orders appear automatically."}/>
      <div className="admin-waiting-list" aria-label="Waiting orders">{queue.value?.items?.map(order=><article key={order.id} className={`admin-waiting-row ${order.confirmationOverdue?"late":order.confirmationState==="awaiting_payment"?"payment":"waiting"}`}><div><span className={`admin-state-chip ${order.confirmationOverdue?"late":""}`}>{order.confirmationOverdue?"Overdue":order.confirmationState==="awaiting_payment"?"Awaiting payment":"Needs confirmation"}</span><h3>{order.restaurantName}</h3><p>{order.customerName} · {order.fulfillment==="delivery"?"Delivery":"Collection"}</p><small>#{order.reference} · {shortDate(order.createdAt)}{order.scheduledFor?` · Scheduled ${shortDate(order.scheduledFor)}`:""}</small></div><div className="admin-waiting-contact"><strong>{pounds(order.totalMinor)}</strong>{order.restaurantPhone?<a href={`tel:${order.restaurantPhone.replace(/[^+\d]/g,"")}`}>Call {order.restaurantPhone}</a>:<small>No contact number recorded</small>}<small>{order.confirmationState==="awaiting_payment"?"Confirmation starts after payment.":order.confirmationDueAt?`Due ${shortDate(order.confirmationDueAt)}`:"Awaiting restaurant confirmation"}</small></div><div className="admin-row-actions"><Link className="primary button-link" to={`/admin/orders?order=${encodeURIComponent(order.id)}`}>View order</Link><Link className="button-link" to={`/admin/restaurants?restaurant=${encodeURIComponent(order.restaurantId)}`}>Restaurant details</Link></div></article>)}</div>
      <AdminPager pagination={queue.value?.pagination} page={page} onChange={setPage} busy={queue.loading}/>
    </section>
    <div className="admin-overview-grid">{[["Restaurants",totals?.restaurants?.total,"View directory","/admin/restaurants"],["Applications",totals?.restaurants?.pending,"Review pending businesses","/admin/restaurants?status=pending"],["Customers",totals?.customers,"Find an account","/admin/customers"],["Live orders",totals?.liveOrders,"View current orders","/admin/orders"]].map(([label,value,note,link])=><Link className="admin-overview-card" key={label} to={link}><span>{label}</span><strong>{value??(overview.loading?"…":"—")}</strong><small>{note} →</small></Link>)}</div>
    <AdminSupportOverview/>
    <section className="panel admin-dashboard-report"><div className="workspace-toolbar"><div><p className="eyebrow">Reporting</p><h2>Order activity</h2></div><Link className="button-link" to="/admin/finance">Finance →</Link></div><form className="admin-report-range" key={`${range.from}:${range.to}`} onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);setRange({from:String(f.get("from")||""),to:String(f.get("to")||"")});}}><label>From<input name="from" type="date" defaultValue={range.from} max={range.to||undefined}/></label><label>To<input name="to" type="date" defaultValue={range.to} min={range.from||undefined}/></label><button className="quiet">Apply dates</button><button className="quiet" type="button" onClick={()=>setRange({from:"",to:""})}>All dates</button></form>{overview.error&&<p className="alert" role="alert">{overview.error}</p>}<div className="admin-activity-stats"><div><span>Accepted orders</span><strong>{totals?.orders?.count??"—"}</strong></div><div><span>Order value</span><strong>{totals?pounds(totals.orders.valueMinor):"—"}</strong></div><div><span>Order commission</span><strong>{totals?pounds(totals.orders.commissionMinor):"—"}</strong></div></div><p className="fine">Accepted orders by order date, using London time. Payouts and adjustments are available in Finance.</p><div className="button-row">{[["metrics","Export statistics"],["orders","Export orders"],["restaurants","Export restaurants"]].map(([kind,label])=><DashboardCsvDownload key={kind} href={`/api/admin/dashboard/${kind}.csv${dates?`?${dates}`:""}`}>{label}</DashboardCsvDownload>)}</div></section>
    <details className="panel admin-history-details"><summary>Order confirmation alert history</summary><OrderConfirmationAlerts/></details>
  </div>;
}
