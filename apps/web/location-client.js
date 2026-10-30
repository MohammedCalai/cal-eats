import {mergeLocationChoices} from "./location-ui.js";
import {outwardPostcode} from "./model.js";
export function createLocationClient({state,api,reload,render,message}){
 const key=()=>`cal-eats-postcode:${state.user?.id||"guest"}`;
 function remember(){try{sessionStorage.setItem(key(),state.postcode);}catch{}}
 async function hydrate(){
  const scope=state.user?.id||"guest",generation=state.generation;if(state.locationChoicesScope===scope)return;
  try{if(!state.postcode)state.postcode=sessionStorage.getItem(key())||"";}catch{}
  if(state.user?.role!=="customer"){state.locationChoices=[];state.locationChoicesScope=scope;return;}
  try{const[saved,recent]=await Promise.all([api("/api/account/addresses"),api("/api/account/recent-addresses")]);if(generation!==state.generation)return;state.locationChoices=mergeLocationChoices(saved,recent);state.addresses=saved;state.locationChoicesScope=scope;}catch{if(generation===state.generation)state.locationChoices=[];}
 }
 async function choose(address){state.locationAddress={...address};state.postcode=address.postcode.trim().toUpperCase();remember();state.locationSelectorOpen=false;await reload();}
 const postcodeField=()=>typeof document!=="undefined"?document.querySelector("#postcode"):null;
 async function manual(postcode){
  const value=String(postcode||"").trim().toUpperCase();
  if(!outwardPostcode(value)){
   state.locationSelectorOpen=true;
   const error="Enter a valid postcode, for example LU1 2AB.",field=postcodeField();
   if(field){field.setAttribute("aria-invalid","true");const hint=document.querySelector("#postcode-error");if(hint)hint.textContent=error;field.focus();}else message(error);
   return false;
  }
  state.locationAddress=null;state.postcode=value;remember();state.locationSelectorOpen=false;await reload();return true;
 }
 async function gps(){
  const generation=state.generation,navigation=state.navigationVersion,current=()=>generation===state.generation&&navigation===state.navigationVersion&&state.view==="discover";if(!navigator.geolocation){message("Location is unavailable on this device. Enter your postcode instead.");return;}
  const draft=postcodeField()?.value;let failed=false;
  state.locationLoading=true;state.locationSelectorOpen=true;render();if(draft!==undefined&&postcodeField())postcodeField().value=draft;
  try{const position=await new Promise((resolve,reject)=>navigator.geolocation.getCurrentPosition(resolve,reject,{enableHighAccuracy:false,timeout:10000,maximumAge:60000}));if(!current())return;const result=await api("/api/location/postcode",{method:"POST",body:JSON.stringify({latitude:position.coords.latitude,longitude:position.coords.longitude,consent:true})});if(!current())return;await choose({label:"Current location",line1:"",city:result.city,postcode:result.postcode});message("Nearby postcode found. Add your exact street address at checkout.");}
  catch(error){failed=true;if(current())message(error.code===1?"Location permission was not granted. You can enter your postcode.":error.message||"Location could not be found. Enter your postcode instead.");}
  finally{if(generation===state.generation){state.locationLoading=false;if(current()){const latestDraft=postcodeField()?.value??draft;render();if(failed){const field=postcodeField();if(field){if(latestDraft!==undefined)field.value=latestDraft;field.focus();}}}}}
 }
 return {hydrate,choose,manual,gps};
}
