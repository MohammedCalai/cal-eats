// A single-shot three-note message chime, separate from the order ringtone.
// Preparing an AudioContext is silent: oscillators exist only for real playback.
export function createBusinessMessageMelody(
  getContext=()=>typeof window==="undefined"?null:window.AudioContext||window.webkitAudioContext,
  {setTimeout:schedule=setTimeout,clearTimeout:cancelTimer=clearTimeout}={}
){
  let context,preparation=null,revision=0,nodes=[],finish=null,playbackTimer=null,disposed=false;
  const released=new WeakSet();
  const interactionRequired=()=>Object.assign(new Error("Audio interaction required"),{name:"NotAllowedError"});
  const cancelled=()=>Object.assign(new Error("Message audio was disposed"),{name:"AbortError"});
  function release(previous){
    if(context===previous)context=null;
    if(!previous||released.has(previous))return;
    released.add(previous);
    try{void Promise.resolve(previous.close()).catch(()=>{});}catch{}
  }
  function pause(){
    revision++;
    if(playbackTimer!==null){cancelTimer(playbackTimer);playbackTimer=null;}
    const playing=nodes;nodes=[];
    for(const {oscillator,gain} of playing){
      oscillator.onended=null;
      try{oscillator.stop();}catch{}
      try{oscillator.disconnect();}catch{}
      try{gain?.disconnect();}catch{}
    }
    const done=finish;finish=null;done?.();
  }
  function prepare(retryPending=true){
    if(disposed)return Promise.reject(cancelled());
    if(preparation){if(retryPending)preparation.retry();return preparation.promise;}
    let active;
    try{
      if(context?.state==="closed")context=null;
      if(!context){const Context=getContext();if(!Context)throw new Error("Message audio is unavailable");context=new Context();}
      active=context;
    }catch(error){return Promise.reject(error);}
    if(active.state==="running")return Promise.resolve();

    // Some browsers leave resume() pending when autoplay is blocked. Bound the
    // wait and retire that context so a later trusted gesture can retry safely.
    let resolve,reject;
    const pending={context:active,promise:new Promise((yes,no)=>{resolve=yes;reject=no;}),settled:false,timer:null,cancel:null,retry:null,resumeRevision:0};
    preparation=pending;
    const settle=(error)=>{
      if(pending.settled)return;
      pending.settled=true;cancelTimer(pending.timer);
      if(preparation===pending)preparation=null;
      if(error){release(active);reject(error);}else resolve();
    };
    pending.cancel=()=>settle(cancelled());
    pending.timer=schedule(()=>settle(interactionRequired()),1000);
    pending.retry=()=>{
      if(pending.settled)return;
      if(active.state==="running")return settle();
      const request=++pending.resumeRevision;
      const rejected=error=>{if(request===pending.resumeRevision)settle(error||interactionRequired());};
      try{
        // Retry synchronously on a new trusted gesture even if the browser has
        // left an older resume() pending. The original timeout is not extended.
        Promise.resolve(active.resume()).then(()=>{
          if(pending.settled)return;
          if(disposed||context!==active)return settle(cancelled());
          if(active.state==="running")settle();
          else if(request===pending.resumeRevision)settle(interactionRequired());
        },rejected);
      }catch(error){rejected(error);}
    };
    pending.retry();
    return pending.promise;
  }
  return {
    prepare:()=>prepare(),
    play(){
      pause();const attempt=revision;
      return new Promise((resolve,reject)=>{
        finish=resolve;
        // Playback joins trusted preparation rather than superseding it from
        // an unrelated reminder timer.
        prepare(false).then(()=>{
          if(attempt!==revision)return;
          try{
            const active=context,start=active.currentTime+.015;
            [523.25,659.25,783.99].forEach((frequency,index)=>{
              const oscillator=active.createOscillator(),node={oscillator,gain:null};nodes.push(node);
              const gain=active.createGain(),at=start+index*.18;node.gain=gain;
              oscillator.type="sine";oscillator.frequency.value=frequency;
              gain.gain.setValueAtTime(.0001,at);gain.gain.exponentialRampToValueAtTime(.14,at+.025);gain.gain.exponentialRampToValueAtTime(.0001,at+.34);
              oscillator.connect(gain).connect(active.destination);
              if(index===2)oscillator.onended=()=>{if(attempt===revision)pause();};
              oscillator.start(at);oscillator.stop(at+.36);
            });
            // A suspended/interrupted context may never emit onended. Release
            // the waiting reminder loop even when its audio clock stops.
            playbackTimer=schedule(()=>{if(attempt===revision)pause();},1000);
          }catch(error){finish=null;pause();reject(error);}
        },error=>{if(attempt===revision){finish=null;pause();reject(error);}});
      });
    },
    pause,
    dispose(){if(disposed)return;disposed=true;pause();preparation?.cancel();release(context);}
  };
}

let shared;
export function businessMessageMelody(){
  if(shared||typeof window==="undefined"||typeof document==="undefined")return shared;
  shared=createBusinessMessageMelody();
  const interact=event=>{
    const path=window.location.pathname;
    if(event.isTrusted===true&&(path==="/business"||path.startsWith("/business/")))void shared.prepare().catch(()=>{});
  };
  document.addEventListener("pointerdown",interact,true);
  document.addEventListener("keydown",interact,true);
  return shared;
}
businessMessageMelody();
