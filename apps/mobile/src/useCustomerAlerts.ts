import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { setAudioModeAsync, useAudioPlayer } from "expo-audio";
import * as SecureStore from "expo-secure-store";

/** Foreground reminders only. The bell acknowledges attention, not message reads. */
export function useCustomerAlerts(userId: string | null, unreadIds: string[]) {
  const player=useAudioPlayer(require("../assets/sounds/notification.wav"));
  const [enabled,setEnabled]=useState(true),[ready,setReady]=useState(false),[acknowledged,setAcknowledged]=useState<Set<string>>(new Set()),[foreground,setForeground]=useState(AppState.currentState==="active"),[error,setError]=useState("");
  const scope=useRef(userId),currentIds=useRef(unreadIds);scope.current=userId;currentIds.current=unreadIds;
  const signature=unreadIds.slice().sort().join("|"),pending=Boolean(userId&&ready&&unreadIds.some(id=>!acknowledged.has(id)));
  useEffect(()=>{let active=true;setReady(false);setAcknowledged(new Set());setError("");if(!userId){player.pause();return;}void Promise.all([SecureStore.getItemAsync(`cal-eats-customer-sound-${userId}`),SecureStore.getItemAsync(`cal-eats-customer-alert-ack-${userId}`)]).then(([sound,saved])=>{if(!active)return;setEnabled(sound!=="off");try{const ids=JSON.parse(saved||"[]");setAcknowledged(new Set(Array.isArray(ids)?ids.filter((id):id is string=>typeof id==="string").slice(-400):[]));}catch{setAcknowledged(new Set());}setReady(true);}).catch(()=>{if(active){setEnabled(true);setReady(true);}});return()=>{active=false;player.pause();};},[userId,player]);
  useEffect(()=>{const subscription=AppState.addEventListener("change",state=>{setForeground(state==="active");if(state!=="active")player.pause();});return()=>subscription.remove();},[player]);
  useEffect(()=>{
    player.loop=false;
    if(!pending||!enabled||!foreground){player.pause();return;}
    let stopped=false;const reminderScope=userId;
    const ring=async()=>{try{await setAudioModeAsync({playsInSilentMode:false,shouldPlayInBackground:false,allowsRecording:false,interruptionMode:"mixWithOthers",shouldRouteThroughEarpiece:false});if(stopped||scope.current!==reminderScope||AppState.currentState!=="active")return;await player.seekTo(0);if(!stopped){player.play();setError("");}}catch{if(!stopped)setError("Sound could not play. Check your device volume; your updates are still available from the bell.");}};
    void ring();const timer=setInterval(()=>void ring(),15_000);
    return()=>{stopped=true;clearInterval(timer);player.pause();};
  },[pending,enabled,foreground,userId,signature,player]);
  function acknowledge(){player.pause();const ids=[...new Set([...acknowledged,...currentIds.current])].slice(-400);setAcknowledged(new Set(ids));if(userId)void SecureStore.setItemAsync(`cal-eats-customer-alert-ack-${userId}`,JSON.stringify(ids)).catch(()=>undefined);}
  function toggle(){const next=!enabled;setEnabled(next);if(!next)player.pause();if(userId)void SecureStore.setItemAsync(`cal-eats-customer-sound-${userId}`,next?"on":"off").catch(()=>undefined);}
  return {enabled,pending,ready,error,acknowledge,toggle};
}
