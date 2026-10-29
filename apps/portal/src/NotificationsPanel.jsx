import React, { useEffect, useRef, useState } from "react";
import { api, json } from "./api.js";
import { shortDate } from "./model.js";
import { connectLiveNotifications } from "../../web/live-notifications.js";
import { OrderConversation } from "./OrderMessaging.jsx";
import { useNavigate } from "react-router-dom";
import { OrderSoundControls } from "./NewOrderAlerts.jsx";

export function NotificationsPanel({ enableSound, kind="owner", onSelectRestaurant }) {
  const navigate=useNavigate();
  const [items,setItems]=useState([]),[unread,setUnread]=useState(0),[unreadMessages,setUnreadMessages]=useState(0),[open,setOpen]=useState(false),[conversation,setConversation]=useState(null);
  const [sound,setSound]=useState(()=>localStorage.getItem("cal-eats-portal-message-sound")==="on");
  const audio=useRef(null),seen=useRef(null),settings=useRef({sound,enableSound});settings.current={sound,enableSound};
  useEffect(()=>{let active=true;
    async function refresh(){const value=await api("/api/notifications");if(!active)return;const rows=value.items||[];
      if(seen.current){const fresh=rows.filter(n=>!seen.current.has(n.id));if(settings.current.sound&&settings.current.enableSound&&fresh.some(n=>["order_message","customer_message","support_request","support_reply"].includes(n.type)))tone(audio.current);fresh.forEach(n=>seen.current.add(n.id));}else seen.current=new Set(rows.map(n=>n.id));
      setItems(rows);setUnread(value.unreadCount??rows.filter(n=>!n.readAt).length);setUnreadMessages(value.unreadMessageCount??rows.filter(n=>["order_message","customer_message"].includes(n.type)&&!n.readAt).length);
      window.dispatchEvent(new CustomEvent("cal-eats-notification-counts",{detail:{messages:value.unreadMessageCount??rows.filter(n=>["order_message","customer_message"].includes(n.type)&&!n.readAt).length,unread:value.unreadCount}}));
    }
    const stop=connectLiveNotifications({onRefresh:refresh});
    const read=()=>{void refresh().catch(()=>{});};window.addEventListener("cal-eats-notifications-read",read);
    return()=>{active=false;stop();window.removeEventListener("cal-eats-notifications-read",read);void audio.current?.close().catch(()=>{});};
  },[]);
  async function toggle(){const next=!sound;if(next){const Context=window.AudioContext||window.webkitAudioContext;if(!Context)return;audio.current??=new Context();await audio.current.resume().catch(()=>{});tone(audio.current);}setSound(next);localStorage.setItem("cal-eats-portal-message-sound",next?"on":"off");}
  async function read(item){await api(`/api/notifications/${item.id}`,json("PATCH",{read:true})).catch(()=>{});setItems(old=>old.map(n=>n.id===item.id?{...n,readAt:n.readAt||new Date().toISOString()}:n));setUnread(n=>Math.max(0,n-(item.readAt?0:1)));if(!item.readAt&&["order_message","customer_message"].includes(item.type))setUnreadMessages(n=>Math.max(0,n-1));setOpen(false);if(item.restaurantId)onSelectRestaurant?.(item.restaurantId);if(item.type==="order_message"&&item.orderId){setConversation(item.orderId);return;}if(item.type==="customer_message"&&item.customerId&&kind==="owner")navigate(`/owner/inbox?customer=${encodeURIComponent(item.customerId)}`);else if(item.supportCaseId)navigate(`/${kind}/support?case=${encodeURIComponent(item.supportCaseId)}`);else if(item.type?.startsWith("support_"))navigate(`/${kind}/support`);else if(item.type?.includes("refund"))navigate(`/${kind}/refunds${item.caseId?`?case=${encodeURIComponent(item.caseId)}`:""}`);else if(item.orderId)navigate(`/${kind}/orders?order=${encodeURIComponent(item.orderId)}`);window.dispatchEvent(new Event("cal-eats-notifications-read"));}
  const messages=unreadMessages;
  return <><div className="notifications"><button className="icon-button bell" aria-label={`${unread} unread notifications, ${messages} unread messages`} aria-expanded={open} onClick={()=>setOpen(v=>!v)}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>{unread>0&&<b>{unread}</b>}</button>{open&&<section className="notification-panel"><div className="notification-head"><strong>Updates · {messages} messages</strong><button className="quiet notification-dismiss" aria-label="Close notifications" onClick={()=>setOpen(false)}>×</button>{enableSound&&<button className="quiet" onClick={()=>void toggle()}>{sound?"Mute message sounds":"Message sounds"}</button>}</div><OrderSoundControls compact/>{!items.length?<p className="empty">No notifications.</p>:items.slice(0,20).map(n=><button className={n.readAt?"notification":"notification unread"} key={n.id} onClick={()=>void read(n)}><strong>{n.title}</strong><span>{n.message}</span><small>{n.orderId?`Order ${n.orderId.slice(0,8)} · `:""}{shortDate(n.createdAt)}</small></button>)}</section>}</div>{conversation&&<div className="dialog-backdrop"><div className="dialog" role="dialog" aria-modal="true" aria-label="Order messages"><OrderConversation orderId={conversation} onClose={()=>setConversation(null)}/></div></div>}</>;
}
function tone(context){if(context?.state!=="running")return;const oscillator=context.createOscillator(),gain=context.createGain();oscillator.frequency.value=660;gain.gain.setValueAtTime(.0001,context.currentTime);gain.gain.exponentialRampToValueAtTime(.12,context.currentTime+.02);gain.gain.exponentialRampToValueAtTime(.0001,context.currentTime+.2);oscillator.connect(gain).connect(context.destination);oscillator.start();oscillator.stop(context.currentTime+.22);oscillator.onended=()=>{oscillator.disconnect();gain.disconnect();};}
