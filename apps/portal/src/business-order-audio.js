// Order sound defaults on; the account preference controls playback.
// Reuse one player so the sign-in gesture can prepare it before the portal mounts.
export function createOrderAudio(player) {
  let enabled=false,pending=false,path="/business/notification.wav",revision=0;
  let state={ready:false,testing:false,error:""};
  const listeners=new Set();
  const publish=patch=>{state={...state,...patch};for(const listener of listeners)listener(state);};
  const stop=()=>{player.pause();player.currentTime=0;player.loop=false;};
  const failure=error=>error?.name==="NotAllowedError"?"Your browser is waiting for an interaction. Tap anywhere in the business platform to allow automatic order alerts.":"Order sound could not play. Check device volume and audio permissions; the waiting orders still need confirmation.";
  async function play({test=false}={}) {
    const attempt=++revision,ring=enabled&&pending;
    player.src=ring?path:"/business/notification.wav";
    player.loop=ring;player.volume=ring||test?1:0;
    try {
      await player.play();
      if(attempt!==revision)return;
      publish({ready:true,error:"",testing:test&&!ring});
      if(!ring&&!test){stop();player.volume=1;}
    } catch(error) {
      if(attempt===revision)publish({ready:false,testing:false,error:ring||test?failure(error):""});
    }
  }
  player.onended=()=>publish({testing:false});
  player.onerror=()=>{if(enabled&&pending)publish({ready:false,error:failure()});};
  return {
    getSnapshot:()=>state,
    subscribe(listener){listeners.add(listener);listener(state);return()=>listeners.delete(listener);},
    update(next){
      const nextEnabled=Boolean(next.enabled),nextPending=nextEnabled&&next.count>0;
      const changed=nextEnabled!==enabled||nextPending!==pending||next.path!==path;
      enabled=nextEnabled;pending=nextPending;path=next.path||"/business/notification.wav";
      if(!enabled||!pending){if(changed){revision++;stop();publish({testing:false});}return;}
      if(changed)void play();
    },
    // This is called synchronously within a trusted click/key event, never a timer.
    interact(){if(!state.ready||enabled&&pending&&player.paused)void play();},
    resume(){if(enabled&&pending)void play();},
    test(){if(enabled)return play({test:true});},
    stopTest(){if(!pending){revision++;stop();publish({testing:false});}},
    stop(){enabled=false;pending=false;revision++;stop();publish({testing:false});}
  };
}

let shared;
export function businessOrderAudio(){
  if(shared||typeof window==="undefined")return shared;
  const player=new Audio();player.preload="auto";
  shared=createOrderAudio(player);
  const interact=event=>{if(event.isTrusted&&window.location.pathname.startsWith("/business"))shared.interact();};
  document.addEventListener("pointerdown",interact,true);
  document.addEventListener("keydown",interact,true);
  window.addEventListener("focus",()=>shared.resume());
  document.addEventListener("visibilitychange",()=>{if(!document.hidden)shared.resume();});
  return shared;
}
businessOrderAudio();
