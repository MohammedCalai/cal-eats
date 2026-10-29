import {mergeLocationChoices} from "./location-ui.js";
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
 async function manual(postcode){state.locationAddress=null;state.postcode=String(postcode||"").trim().toUpperCase();remember();state.locationSelectorOpen=false;await reload();}
 async function gps(){
  const generation=state.generation,navigation=state.navigationVersion,current=()=>generation===state.generation&&navigation===state.navigationVersion&&state.view==="discover";if(!navigator.geolocation){message("Location is unavailable on this device. Enter your postcode instead.");return;}
  state.locationLoading=true;state.locationSelectorOpen=true;render();
  try{const position=await new Promise((resolve,reject)=>navigator.geolocation.getCurrentPosition(resolve,reject,{enableHighAccuracy:false,timeout:10000,maximumAge:60000}));if(!current())return;const result=await api("/api/location/postcode",{method:"POST",body:JSON.stringify({latitude:position.coords.latitude,longitude:position.coords.longitude,consent:true})});if(!current())return;await choose({label:"Current location",line1:"",city:result.city,postcode:result.postcode});message("Nearby postcode found. Add your exact street address at checkout.");}
  catch(error){if(generation===state.generation)message(error.code===1?"Location permission was not granted. You can enter your postcode.":error.message||"Location could not be found. Enter your postcode instead.");}
  finally{if(generation===state.generation){state.locationLoading=false;if(state.view==="discover")render();}}
 }
 return {hydrate,choose,manual,gps};
}
