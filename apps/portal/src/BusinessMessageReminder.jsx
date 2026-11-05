import {useCallback,useEffect,useRef,useState} from "react";
import {api} from "./api.js";
import {connectLiveNotifications} from "../../web/live-notifications.js";
import {createBusinessMessageAudio} from "./business-message-audio.js";
import {createBusinessMessageMelody} from "./business-message-melody.js";

export const MESSAGE_OPENED_EVENT="cal-eats-business-message-opened";
const storageKey=scope=>`cal-eats-message-ack:${scope}`;

/** Mounted in the business shell, so visiting Dashboard cannot restart an acknowledged backlog. */
export function useBusinessMessageReminder({enabled,userId,restaurantId,soundEnabled,orderAlarmActive}){
  const [player]=useState(()=>createBusinessMessageMelody());
  const [controller]=useState(()=>createBusinessMessageAudio(player,{
    readAcknowledged:scope=>Number(sessionStorage.getItem(storageKey(scope)))||0,
    writeAcknowledged:(scope,revision)=>sessionStorage.setItem(storageKey(scope),String(revision))
  }));
  const [state,setState]=useState(()=>controller.getSnapshot());
  const scope=enabled&&userId&&restaurantId?`${userId}:${restaurantId}`:"";
  const settings=useRef(null),attention=useRef({scope:"",pending:0,revision:0}),sequence=useRef(0);
  settings.current={scope,enabled:Boolean(enabled&&soundEnabled),orderAlarmActive:Boolean(orderAlarmActive)};
  const apply=useCallback(()=>{const current=settings.current,value=attention.current;controller.update({...current,pending:value.scope===current.scope?value.pending:0,revision:value.scope===current.scope?value.revision:0});},[controller]);
  const load=useCallback(async()=>{
    if(!scope)return;
    const request=++sequence.current;
    try{
      const value=await api(`/api/restaurant/restaurants/${encodeURIComponent(restaurantId)}/message-attention`);
      if(request!==sequence.current||settings.current.scope!==scope)return;
      attention.current={scope,pending:value.unreadCount,revision:value.revision};apply();
    }catch(error){
      if(request===sequence.current&&settings.current.scope===scope&&[401,403,404].includes(error.status)){attention.current={scope,pending:0,revision:0};apply();}
    }
  },[scope,restaurantId,apply]);
  useEffect(()=>controller.subscribe(setState),[controller]);
  useEffect(()=>{apply();},[scope,soundEnabled,orderAlarmActive,apply]);
  useEffect(()=>{
    if(!scope){controller.stop();return;}
    void load();
    const disconnect=connectLiveNotifications({onRefresh:load});
    const poll=()=>{if(!document.hidden)void load();};
    const timer=setInterval(poll,15000);
    const opened=event=>{if(event.detail?.restaurantId!==restaurantId||event.detail?.viewerUserId!==userId)return;controller.acknowledge(scope,event.detail.messageAttentionRevision);void load();};
    window.addEventListener(MESSAGE_OPENED_EVENT,opened);
    window.addEventListener("cal-eats-notifications-read",poll);
    window.addEventListener("focus",poll);
    return()=>{sequence.current++;disconnect();clearInterval(timer);window.removeEventListener(MESSAGE_OPENED_EVENT,opened);window.removeEventListener("cal-eats-notifications-read",poll);window.removeEventListener("focus",poll);controller.stop();};
  },[scope,userId,restaurantId,controller,load]);
  useEffect(()=>{
    const interact=event=>{if(!event.isTrusted||!settings.current.enabled)return;void player.prepare().catch(()=>{});controller.interact();};
    document.addEventListener("pointerdown",interact,true);document.addEventListener("keydown",interact,true);
    return()=>{document.removeEventListener("pointerdown",interact,true);document.removeEventListener("keydown",interact,true);controller.stop();player.dispose();};
  },[controller,player]);
  return state;
}
