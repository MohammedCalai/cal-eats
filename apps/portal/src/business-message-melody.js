import { createBusinessMessageMelody } from "./business-message-melody-player.js";
export { createBusinessMessageMelody };

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
