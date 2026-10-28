import React, {useEffect} from "react";
import {NavLink} from "react-router-dom";
import {useFinanceResource} from "./finance-resource.js";
import {connectLiveNotifications} from "../../web/live-notifications.js";
import {shortDate} from "./model.js";

export default function AdminSupportOverview(){
  const result=useFinanceResource("/api/admin/support?page=1&pageSize=5&assignedTo=platform&status=open&waitingFor=team");
  useEffect(()=>connectLiveNotifications({onRefresh:result.reload}),[result.reload]);
  return <section className="panel" aria-labelledby="admin-support-title"><div className="workspace-toolbar"><div><p className="eyebrow">Needs your attention</p><h2 id="admin-support-title">Cal-Eats support inbox</h2></div><NavLink className="button-link" to="/admin/support">Open support inbox</NavLink></div><p><strong>{result.value?.total??(result.loading?"Loading…":"Unavailable")}</strong> requests awaiting Cal-Eats. Business requests come directly to this team.</p>{result.error&&<p className="alert" role="alert">{result.error}<button className="quiet" onClick={()=>void result.reload()}>Try again</button></p>}<div className="case-list">{result.value?.items?.map(ticket=><NavLink className="case-card support-card" key={ticket.id} to={`/admin/support?case=${encodeURIComponent(ticket.id)}`}><strong>#{ticket.reference} · {ticket.subject}</strong><p>{ticket.requesterName||ticket.customerName} · {ticket.requesterRole==="restaurant"?"Business support":"Customer support"}{ticket.requesterRestaurantName?` · ${ticket.requesterRestaurantName}`:""}</p><small>{shortDate(ticket.updatedAt)}</small></NavLink>)}</div>{result.value?.total===0&&<p>No platform requests are waiting for your reply.</p>}</section>;
}
