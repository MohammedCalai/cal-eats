import {useEffect,useRef,useState} from "react";
import {AppState,Platform} from "react-native";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import Constants from "expo-constants";
import {api,json} from "./api";
export const BUSINESS_PROJECT_ID="6282b87e-36ae-43bb-80b7-12d69108a411";
const installationKey="cal_eats_admin_installation_v1",channel="cal-eats-admin-updates";
let signedIn=false;
Notifications.setNotificationHandler({handleNotification:async()=>({shouldShowBanner:signedIn,shouldShowList:signedIn,shouldPlaySound:signedIn,shouldSetBadge:signedIn})});
export async function clearBusinessNotifications(){await Promise.allSettled([Notifications.dismissAllNotificationsAsync(),Notifications.setBadgeCountAsync(0)]);}
async function installation(){let id=await SecureStore.getItemAsync(installationKey);if(!id){id=Crypto.randomUUID();await SecureStore.setItemAsync(installationKey,id);}return id;}
export async function disconnectBusinessPush(token:string){const id=await SecureStore.getItemAsync(installationKey);if(id)await api(`/api/native/business/push/devices/${encodeURIComponent(id)}`,{token,method:"DELETE"});}
export function useBusinessPush(token:string|null,onOpen:(data:Record<string,unknown>)=>void,onRefresh:()=>void){
 const [state,setState]=useState({busy:false,status:"checking",note:"Checking phone notifications…"}),callbacks=useRef({onOpen,onRefresh}),retry=useRef<((ask:boolean)=>Promise<void>)|null>(null);callbacks.current={onOpen,onRefresh};
 useEffect(()=>{
  signedIn=Boolean(token);
  if(!token){setState({busy:false,status:"signed_out",note:"Sign in to connect phone notifications."});return;}
  let active=true,running=false,registered=false;
  const received=Notifications.addNotificationReceivedListener(()=>{if(active)callbacks.current.onRefresh();});
  const open=(response:Notifications.NotificationResponse)=>{if(!active)return;callbacks.current.onOpen(response.notification.request.content.data||{});try{Notifications.clearLastNotificationResponse();}catch{}};
  const response=Notifications.addNotificationResponseReceivedListener(open);
  try{const last=Notifications.getLastNotificationResponse();if(last)open(last);}catch{}
  async function sync(ask:boolean){
   if(running||!active)return;running=true;setState(old=>({...old,busy:true}));
   try{
    const settings=await api<{enabled:boolean;configured:boolean;iosProjectIds:string[];androidProjectIds:string[]}>("/api/native/business/push/settings",{token});if(!active)return;
    const projectId=Constants.easConfig?.projectId||Constants.expoConfig?.extra?.eas?.projectId;
    const supported=Platform.OS==="ios"||Platform.OS==="android",allowed=Platform.OS==="ios"?settings.iosProjectIds:settings.androidProjectIds;
    if(!settings.enabled||!settings.configured||!supported||projectId!==BUSINESS_PROJECT_ID||!allowed.includes(BUSINESS_PROJECT_ID)||(Platform.OS==="android"&&Constants.expoConfig?.extra?.businessPush?.androidConfigured!==true)){setState({busy:false,status:"unavailable",note:"Phone notification delivery is not connected for this app yet. Updates remain available in Notifications."});return;}
    if(Platform.OS==="android")await Notifications.setNotificationChannelAsync(channel,{name:"Cal Eats Admin updates",importance:Notifications.AndroidImportance.HIGH,sound:"default"});
    let permission=await Notifications.getPermissionsAsync();if(ask&&!permission.granted&&permission.canAskAgain)permission=await Notifications.requestPermissionsAsync();if(!active)return;
    if(!permission.granted){if(registered){await disconnectBusinessPush(token!).catch(()=>{});registered=false;}if(!active)return;setState({busy:false,status:permission.canAskAgain?"permission_needed":"denied",note:permission.canAskAgain?"Allow notifications to receive restaurant device and account updates.":"Notifications are off for Cal Eats Admin. Enable them in your phone’s Settings."});return;}
    const id=await installation(),push=await Notifications.getExpoPushTokenAsync({projectId:BUSINESS_PROJECT_ID});if(!active)return;
    await api("/api/native/business/push/devices",json(token!,"POST",{installationId:id,expoPushToken:push.data,platform:Platform.OS,projectId:BUSINESS_PROJECT_ID}));if(active){registered=true;setState({busy:false,status:"registered",note:"This phone is connected for business updates. Device settings control banners and sound."});}
   }catch(e){if(active)setState({busy:false,status:"error",note:(e as Error).message});}finally{running=false;if(active)setState(old=>({...old,busy:false}));}
  }
  const foreground=AppState.addEventListener("change",value=>{if(value==="active"){void sync(false);if(active)callbacks.current.onRefresh();}});
  const changed=Notifications.addPushTokenListener(()=>void sync(false));
  retry.current=sync;void sync(false);
  return()=>{active=false;retry.current=null;received.remove();response.remove();foreground.remove();changed.remove();};
 },[token]);
 return {...state,connect:()=>retry.current?.(true)};
}
