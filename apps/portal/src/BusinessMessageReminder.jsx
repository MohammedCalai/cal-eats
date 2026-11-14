import React,{createContext,useCallback,useContext,useEffect,useRef,useState} from "react";
import {api} from "./api.js";
import {connectLiveNotifications} from "../../web/live-notifications.js";
import {createBusinessMessageAudio} from "./business-message-audio.js";
import {businessMessageMelody} from "./business-message-melody.js";
import {readBusinessSoundPreference,subscribeBusinessSoundPreference} from "./business-sound-preference.js";
import {useOrderAlerts} from "./NewOrderAlerts.jsx";
import "./BusinessMessageSound.css";

export const MESSAGE_OPENED_EVENT="cal-eats-business-message-opened";
const MessageSoundContext=createContext(null);

/** A verified conversation read acknowledges attention; other unread badges stay. */
export function useBusinessMessageReminder({enabled,userId,restaurantId,soundEnabled,orderAlarmActive}){
  const [player]=useState(()=>businessMessageMelody());
  const [controller]=useState(()=>createBusinessMessageAudio(player));
  const [state,setState]=useState(()=>controller.getSnapshot());
  const [feed,setFeed]=useState({scope:"",checked:false,error:""});
  const scope=enabled&&userId&&restaurantId?`${userId}:${restaurantId}`:"";
  const settings=useRef(null),attention=useRef({scope:"",pending:0,revision:0}),sequence=useRef(0),pending=useRef(null);
  settings.current={scope,enabled:Boolean(enabled&&soundEnabled),orderAlarmActive:Boolean(orderAlarmActive)};
  const apply=useCallback(()=>{const current=settings.current,value=attention.current;controller.update({...current,pending:value.scope===current.scope?value.pending:0,revision:value.scope===current.scope?value.revision:0});},[controller]);
  const load=useCallback(()=>{
    if(!scope)return Promise.resolve();
    if(pending.current?.scope===scope)return pending.current.promise;
    pending.current?.abort.abort();
    const request=++sequence.current,abort=new AbortController();
    const timer=setTimeout(()=>abort.abort(),12000);
    const work=(async()=>{
      try{
        const value=await api(`/api/restaurant/restaurants/${encodeURIComponent(restaurantId)}/message-attention`,{signal:abort.signal});
        if(request!==sequence.current||settings.current.scope!==scope)return;
        if(value?.restaurantId!==restaurantId||!Number.isSafeInteger(value.unreadCount)||value.unreadCount<0||!Number.isSafeInteger(value.revision)||value.revision<0)throw new Error("Invalid customer message update");
        attention.current={scope,pending:value.unreadCount,revision:value.revision};
        setFeed({scope,checked:true,error:""});apply();
      }catch(error){
        if(request!==sequence.current||settings.current.scope!==scope)return;
        setFeed({scope,checked:false,error:"Customer message updates could not be checked. Reconnecting automatically."});
        if([401,403,404].includes(error.status)){attention.current={scope,pending:0,revision:0};apply();}
      }finally{clearTimeout(timer);if(pending.current?.request===request)pending.current=null;}
    })();
    pending.current={scope,request,abort,promise:work};return work;
  },[scope,restaurantId,apply]);
  useEffect(()=>controller.subscribe(setState),[controller]);
  useEffect(()=>{apply();},[scope,soundEnabled,orderAlarmActive,apply]);
  useEffect(()=>{
    if(!scope){controller.stop();return;}
    void load();
    const disconnect=connectLiveNotifications({onRefresh:load});
    const poll=()=>{if(!document.hidden||attention.current.pending>0)void load();};
    const timer=setInterval(poll,5000);
    const opened=event=>{
      const detail=event.detail;
      if(detail?.restaurantId!==restaurantId||detail?.viewerUserId!==userId)return;
      controller.acknowledge({scope,revision:detail.messageAttentionRevision,unreadCount:detail.unreadCount});
      void load();
    };
    window.addEventListener(MESSAGE_OPENED_EVENT,opened);
    window.addEventListener("cal-eats-notifications-read",poll);
    window.addEventListener("focus",poll);
    return()=>{sequence.current++;pending.current?.abort.abort();pending.current=null;disconnect();clearInterval(timer);window.removeEventListener(MESSAGE_OPENED_EVENT,opened);window.removeEventListener("cal-eats-notifications-read",poll);window.removeEventListener("focus",poll);controller.stop();};
  },[scope,userId,restaurantId,controller,load]);
  useEffect(()=>{
    const interact=event=>{if(!event.isTrusted||!settings.current.enabled)return;void player.prepare().catch(()=>{});controller.interact();};
    document.addEventListener("pointerdown",interact,true);document.addEventListener("keydown",interact,true);
    return()=>{document.removeEventListener("pointerdown",interact,true);document.removeEventListener("keydown",interact,true);controller.stop();};
  },[controller,player]);
  return {...state,available:Boolean(scope),soundEnabled:Boolean(soundEnabled),orderAlarmActive:Boolean(orderAlarmActive),feedChecked:feed.scope===scope&&feed.checked,feedError:feed.scope===scope?feed.error:"",testSound:()=>controller.test(),stopTest:()=>controller.stopTest()};
}

export function BusinessMessageReminderProvider({enabled,userId,restaurantId,children}){
  const [soundEnabled,setSoundEnabled]=useState(()=>readBusinessSoundPreference(userId));
  useEffect(()=>{setSoundEnabled(readBusinessSoundPreference(userId));return subscribeBusinessSoundPreference(userId,setSoundEnabled);},[userId]);
  const orderAlerts=useOrderAlerts();
  const value=useBusinessMessageReminder({enabled,userId,restaurantId,soundEnabled,orderAlarmActive:Boolean(orderAlerts?.total||orderAlerts?.testing)});
  return <MessageSoundContext.Provider value={value}>{children}</MessageSoundContext.Provider>;
}
export const useBusinessMessageAlerts=()=>useContext(MessageSoundContext);

export function BusinessMessageSoundControls({compact=false}){
  const sound=useBusinessMessageAlerts();if(!sound?.available)return null;
  const needsAction=sound.pending&&sound.acknowledgedRevision<sound.revision;
  const detail=!sound.soundEnabled?"Message sound is muted in Settings.":sound.orderAlarmActive?"Confirm waiting orders first. Message reminders resume afterwards.":needsAction?"A short melody repeats every 10 seconds until you open a customer conversation.":"Automatic message alerts are on. Keep this platform open and your device volume audible.";
  return <section className={`business-message-sound${compact?" compact":""}${sound.blocked||sound.feedError?" needs-attention":""}`} aria-label="Customer message sound"><div>{!compact&&<strong>Customer message alerts</strong>}<p>{detail}</p>{sound.feedError&&<p className="message-sound-error" role="status">{sound.feedError}</p>}{sound.error&&<p className="message-sound-error" role="alert">{sound.error}</p>}{sound.testing&&<p role="status">Playing message sound…</p>}</div><div className="button-row"><button type="button" className="quiet" disabled={!sound.soundEnabled||sound.orderAlarmActive} onClick={sound.testSound}>Test message sound</button>{sound.testing&&<button type="button" className="quiet" onClick={sound.stopTest}>Stop sample</button>}</div></section>;
}
