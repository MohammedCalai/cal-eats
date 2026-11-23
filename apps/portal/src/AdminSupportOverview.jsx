import React, {useEffect} from "react";
import {NavLink} from "react-router-dom";
import {useFinanceResource} from "./finance-resource.js";
import {connectLiveNotifications} from "../../web/live-notifications.js";
import {shortDate} from "./model.js";

export default function AdminSupportOverview(){
  const result=useFinanceResource("/api/admin/support?page=1&pageSize=5&assignedTo=platform&status=open&waitingFor=team");
  const readiness=useFinanceResource("/api/admin/operational-settings");
  useEffect(()=>connectLiveNotifications({onRefresh:result.reload}),[result.reload]);
  return <section className="panel admin-support-overview" aria-labelledby="admin-support-title"><div className="workspace-toolbar"><div><p className="eyebrow">Needs your reply</p><h2 id="admin-support-title">Support requests</h2></div><NavLink className="button-link" to="/admin/support">View all requests →</NavLink></div>{readiness.value?.messaging?.configured===false&&<p className="alert" role="alert">Replies are temporarily unavailable. Requests are saved; check the messaging connection in Operations.</p>}<p className="support-overview-count"><strong>{result.value?.total??(result.loading?"Checking…":"—")}</strong> awaiting a reply from Cal-Eats</p>{result.error&&<p className="alert" role="alert">{result.error}<button className="quiet" onClick={()=>void result.reload()}>Try again</button></p>}{result.loading&&!result.value&&<p role="status" className="admin-loading">Loading support requests…</p>}{result.value?.items?.length>0&&<ul className="support-overview-list">{result.value.items.map(ticket=><li key={ticket.id}><NavLink to={`/admin/support?case=${encodeURIComponent(ticket.id)}`} aria-label={`Open support request ${ticket.reference}: ${ticket.subject}`}><span><strong>{ticket.subject}</strong><small>{ticket.requesterRestaurantName||ticket.requesterName||ticket.customerName||"Support request"} · #{ticket.reference} · {ticket.requesterRole==="restaurant"?"Business":"Customer"}</small></span><time dateTime={ticket.updatedAt}>{shortDate(ticket.updatedAt)}</time><span aria-hidden="true">→</span></NavLink></li>)}</ul>}{result.value?.total===0&&<p className="empty">You’re up to date. No requests need a Cal-Eats reply.</p>}</section>;
}
