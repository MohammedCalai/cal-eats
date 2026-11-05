// A soft, single-shot three-note message chime, separate from the order ringtone.
export function createBusinessMessageMelody(getContext=()=>window.AudioContext||window.webkitAudioContext){
  let context,revision=0,nodes=[],finish=null;
  function pause(){
    revision++;
    const playing=nodes;nodes=[];
    for(const {oscillator,gain} of playing){oscillator.onended=null;try{oscillator.stop();}catch{}oscillator.disconnect();gain.disconnect();}
    const done=finish;finish=null;done?.();
  }
  async function prepare(){
    const Context=getContext();
    if(!Context)throw new Error("Message audio is unavailable");
    context??=new Context();
    await context.resume();
    if(context.state!=="running")throw Object.assign(new Error("Audio interaction required"),{name:"NotAllowedError"});
  }
  return {
    prepare,
    async play(){
      pause();const attempt=revision;
      await prepare();
      if(attempt!==revision)return;
      return new Promise((resolve,reject)=>{
        finish=resolve;
        try{
          const start=context.currentTime+.015;
          [523.25,659.25,783.99].forEach((frequency,index)=>{
            const oscillator=context.createOscillator(),gain=context.createGain(),at=start+index*.18;
            oscillator.type="sine";oscillator.frequency.value=frequency;
            gain.gain.setValueAtTime(.0001,at);gain.gain.exponentialRampToValueAtTime(.09,at+.025);gain.gain.exponentialRampToValueAtTime(.0001,at+.34);
            oscillator.connect(gain).connect(context.destination);nodes.push({oscillator,gain});
            if(index===2)oscillator.onended=()=>{if(attempt!==revision)return;pause();};
            oscillator.start(at);oscillator.stop(at+.36);
          });
        }catch(error){finish=null;pause();reject(error);}
      });
    },
    pause,
    dispose(){pause();const previous=context;context=null;void previous?.close().catch(()=>{});}
  };
}
