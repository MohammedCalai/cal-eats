const eventName="cal-eats-business-sound-change";
const key=userId=>`cal-eats-business-sound:${userId||"signed-out"}`;
export function readBusinessSoundPreference(userId){try{return localStorage.getItem(key(userId))!=="off";}catch{return true;}}
export function saveBusinessSoundPreference(userId,enabled){try{localStorage.setItem(key(userId),enabled?"on":"off");}catch{}window.dispatchEvent(new CustomEvent(eventName,{detail:{userId,enabled:Boolean(enabled)}}));}
export function subscribeBusinessSoundPreference(userId,listener){const change=event=>{if(event.type==="storage"&&event.key!==key(userId))return;if(event.type!=="storage"&&event.detail?.userId!==userId)return;listener(readBusinessSoundPreference(userId));};window.addEventListener(eventName,change);window.addEventListener("storage",change);return()=>{window.removeEventListener(eventName,change);window.removeEventListener("storage",change);};}
