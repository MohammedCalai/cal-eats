import React, {createContext, useCallback, useContext, useEffect, useRef, useState} from "react";
import {NavLink} from "react-router-dom";
import {api, json} from "./api.js";
import {createOrderingTerminalClient, installOrderingTerminalClient} from "./ordering-terminal-client.js";
import {shortDate} from "./model.js";
import "./OrderingTerminal.css";

const TerminalContext = createContext(null);
const EMPTY = {ready:false, sessionVerified:false, localAvailable:false, paired:false, connecting:false, error:"", status:null};
export function useOrderingTerminal() { return useContext(TerminalContext); }

export function OrderingTerminalProvider({restaurant, userId, children}) {
  const [state,setState] = useState(EMPTY), [health,setHealth] = useState(null), [healthError,setHealthError] = useState("");
  const instance = useRef(null), scope = `${userId}:${restaurant.id}`, currentScope = useRef(scope), healthSequence = useRef(0);
  currentScope.current = scope;
  const canProcess = restaurant.eligibleTerminalOperator === true;
  const remoteCanViewDevices = restaurant.capabilities?.canViewDevices === true;
  const refreshHealth = useCallback(async () => {
    const client=instance.current,local=client?.canReadHealth(restaurant.id)===true;
    if (!remoteCanViewDevices&&!local) {setHealth(null);setHealthError("");return;}
    const requested = scope, sequence = ++healthSequence.current;
    const path=`/api/restaurant/restaurants/${encodeURIComponent(restaurant.id)}/operations-health`;
    try { const value = await (local?client.forward(path,{method:"GET"}):api(path)); if(currentScope.current === requested && sequence === healthSequence.current) {setHealth(value);setHealthError("");} }
    catch(error) { if(currentScope.current === requested && sequence === healthSequence.current) {setHealth(null);setHealthError(error.message);} }
  },[scope,remoteCanViewDevices]);
  useEffect(() => {
    let alive = true;
    setState(EMPTY);setHealth(null);setHealthError("");
    const client = createOrderingTerminalClient({restaurantId:restaurant.id, screenId:crypto.randomUUID().replaceAll("-",""), request:api, canProcess, onChange:value=>{if(alive)setState({...value,scope});}});
    instance.current = client;
    const uninstall = installOrderingTerminalClient(client);
    const pulse = () => {void client.pulse().catch(()=>{}).then(()=>{if(alive&&!document.hidden)return refreshHealth();});};
    pulse();const timer = setInterval(pulse,15_000);
    document.addEventListener("visibilitychange",pulse);window.addEventListener("focus",pulse);
    return () => {alive=false;clearInterval(timer);document.removeEventListener("visibilitychange",pulse);window.removeEventListener("focus",pulse);uninstall();client.dispose();if(instance.current===client)instance.current=null;healthSequence.current++;};
  },[scope,canProcess,refreshHealth]);
  const current = state.scope === scope ? state : EMPTY;
  const connect = async () => {const client=instance.current;if(client)await client.connect();await refreshHealth();};
  const pair = async value => {const client=instance.current;if(!client)throw new Error("Open the restaurant workspace again.");await client.pair(value);await refreshHealth();};
  const canOperate = restaurantId => current.ready && instance.current?.canOperate(restaurantId) === true;
  async function readIncident(id){const client=instance.current,path=`/api/restaurant/incidents/${encodeURIComponent(id)}/read`;if(client?.canReadHealth(restaurant.id))return client.forward(path,json("PATCH",{read:true}));if(remoteCanViewDevices)return api(path,json("PATCH",{read:true}));throw new Error("Open Devices on your registered restaurant tablet.");}
  const canViewDevices=remoteCanViewDevices||(canProcess&&current.sessionVerified);
  return <TerminalContext.Provider value={{...current,restaurantId:restaurant.id,health,healthError,canViewDevices,canProcess,canOperate,canPrint:canOperate(restaurant.id),connect,pair,refreshHealth,readIncident}}>{children}</TerminalContext.Provider>;
}

export function TabletHealthWarning() {
  const terminal = useOrderingTerminal();
  if(!terminal?.canViewDevices)return null;
  const health=terminal.health, tablet=health?.tablet;
  const incidents=health?.incidents?.filter(item=>item.status==="active") || [];
  const healthy=tablet?.status==="online" && health?.bridge?.status==="online" && health?.printer?.state==="ready" && health?.printer?.physicalReadinessKnown===true && !incidents.length;
  if(healthy)return null;
  let title="Checking restaurant tablet and printer",message="The latest device status has not been confirmed.";
  if(terminal.healthError){title="Device status unavailable";message="The tablet and printer status could not be refreshed. Check Devices before relying on automatic order processing.";}
  else if(tablet?.status==="not_registered" || tablet?.registered===false){title="Register your restaurant tablet";message="Orders can only be accepted and processed on the registered restaurant tablet.";}
  else if(tablet?.status==="offline"){title="Restaurant tablet is offline";message="Keep the ordering screen open on the registered tablet. New orders are awaiting acceptance there.";}
  else if(health?.bridge?.status==="offline"){title="Restaurant tablet connection needs attention";message="The automatic printer connection is offline. Check that the Windows setup is running.";}
  else if(health?.printer?.state==="not_configured"){title="No receipt printer configured";message="Add and connect a receipt printer in printer settings.";}
  else if(health?.printer?.state && health.printer.state!=="ready"){title=health.printer.label || "Receipt printer needs attention";message=health.printer.faults?.join(" · ") || "Check the printer’s power, connection and paper before printing again.";}
  else if(incidents.length){title=incidents[0].title;message=incidents[0].message;}
  else if(health?.printer?.physicalReadinessKnown===false){title="Check the receipt printer";message="A network connection does not confirm paper, ink or physical receipt output.";}
  return <aside className="terminal-health-warning" role="status"><span aria-hidden="true">!</span><div><strong>{title}</strong><p>{message}</p></div><NavLink to="/owner/devices">View devices</NavLink></aside>;
}

export function TabletOrderReadOnly({restaurantId}) {
  const terminal=useOrderingTerminal();
  if(terminal?.canOperate(restaurantId))return null;
  return <p className="terminal-readonly" role="status">Awaiting acceptance on restaurant tablet. <NavLink to="/owner/devices">View tablet connection</NavLink></p>;
}

export function OrderingDevices({restaurant,permission}) {
  const terminal=useOrderingTerminal(),[name,setName]=useState("Restaurant ordering tablet"),[replace,setReplace]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
  if(!terminal?.canViewDevices)return <section><h1>Devices</h1><p>Your account does not have access to device information.</p></section>;
  const health=terminal.health,status=terminal.status || health?.tablet;
  const registered=status?.registered===true;
  const owner=permission==="owner";
  async function run(work){if(busy)return;setBusy(true);setError("");setNotice("");try{await work();}catch(caught){setError(caught.message);}finally{setBusy(false);}}
  async function pair(event){event.preventDefault();await run(async()=>{await terminal.pair({deviceName:name.trim(),replace});setNotice("Tablet registration completed. Keep this screen or the dashboard open for live orders.");setReplace(false);});}
  async function revoke(){if(!window.confirm("Remove this restaurant tablet? It will stop accepting orders and printing receipts until a tablet is registered again."))return;await run(async()=>{await api(`/api/restaurant/restaurants/${encodeURIComponent(restaurant.id)}/terminal/revoke`,json("POST",{}));await terminal.connect();await terminal.refreshHealth();setNotice("Tablet registration removed.");});}
  async function markRead(id){await run(async()=>{await terminal.readIncident(id);await terminal.refreshHealth();});}
  return <div className="ordering-devices"><header className="page-heading"><div><h1>Devices</h1><p>Your ordering tablet, printer connection and device alerts.</p></div><button className="quiet" disabled={busy||terminal.connecting} onClick={()=>void run(()=>terminal.connect())}>{terminal.connecting?"Connecting…":"Check connection"}</button></header>
    {(error||terminal.error||terminal.healthError)&&<p className="alert" role="alert">{error||terminal.error||terminal.healthError}</p>}{notice&&<p className="alert success" role="status">{notice}</p>}
    <div className="ordering-device-grid"><section className="ordering-device-card"><span className="eyebrow">Restaurant ordering tablet</span><h2>{status?.name||(status?.registered===false?"No tablet registered":"Restaurant tablet")}</h2><strong>{terminal.canOperate(restaurant.id)?"This screen is connected":registered?(status?.status==="online"?"Registered tablet online":"Registered tablet needs attention"):status?.registered===false?"Not registered":"Status not confirmed"}</strong><p>{terminal.canOperate(restaurant.id)?"Order actions and physical print requests are available on this registered tablet.":"This website is view-only for order processing. Use the registered tablet to accept orders, update progress and print receipts."}</p><small>Last contact: {shortDate(status?.lastContactAt)}<br/>Ordering screen: {shortDate(status?.screenLastSeenAt)}</small>{owner&&registered&&<button className="quiet" disabled={busy} onClick={()=>void revoke()}>Remove tablet registration</button>}</section>
    <section className="ordering-device-card"><span className="eyebrow">Receipt printing</span><h2>{health?.printer?.name||"Receipt printer"}</h2><strong>{health?.printer?.label||"Status not confirmed"}</strong><p>{health?.printer?.faults?.join(" · ") || "A recent network check alone does not prove paper output. Check the physical printer if a receipt result is uncertain."}</p><small>Automatic connection: {({online:"Online",offline:"Offline",unknown:"Not confirmed"})[health?.bridge?.status]||"Not confirmed"}</small><NavLink className="button-link" to="/owner/printers">Printer settings</NavLink></section></div>
    {owner&&!terminal.canOperate(restaurant.id)&&<section className="ordering-device-card"><h2>{registered?"Connect or replace the ordering tablet":"Register this Windows tablet"}</h2><p>Open this page on the Windows device that runs your restaurant’s Cal-Eats printer setup. Its private device identity stays on that device.</p>{registered&&<p>To use the existing tablet, open the ordering screen there and choose Check connection. A replacement disables the previous tablet. Replacing the same Windows installation also requires the documented local setup replacement procedure.</p>}<form onSubmit={pair}><label>Tablet name<input value={name} required minLength={2} maxLength={80} onChange={event=>setName(event.target.value)}/></label>{registered&&<label className="check"><input type="checkbox" checked={replace} onChange={event=>setReplace(event.target.checked)}/>Replace the current registered tablet</label>}<button className="primary" disabled={busy||terminal.connecting||(registered&&!replace)}>{busy?"Registering…":registered?"Register replacement tablet":"Register this tablet"}</button></form></section>}
    <section className="ordering-device-card"><h2>Device alerts</h2>{!health?<p>Device alerts have not been confirmed.</p>:health.incidents?.length?health.incidents.map(incident=><article className="ordering-device-incident" key={incident.id}><div><strong>{incident.title}</strong><p>{incident.message}</p><small>{incident.status==="resolved"?"Recovered":"Needs attention"} · {shortDate(incident.openedAt)}{incident.readAt?" · Read":""}</small></div>{!incident.readAt&&<button className="quiet" disabled={busy} onClick={()=>void markRead(incident.id)}>Mark read</button>}</article>):<p>No device alerts reported.</p>}<p className="fine">Marking an alert read does not resolve a device fault. Status clears only after the connection or printer recovers.</p></section>
  </div>;
}
