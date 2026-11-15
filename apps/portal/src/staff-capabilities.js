export const STAFF_CAPABILITIES=[
  {key:"canViewFinance",label:"View earnings and payouts",description:"Read financial summaries and order breakdowns. Bank changes stay owner-only."},
  {key:"canViewDevices",label:"View devices and service alerts",description:"Check tablet, printer and connection incidents."},
  {key:"canManageMenu",label:"Manage menu and photos",description:"Edit dishes, prices, availability and menu images."},
  {key:"canManageMarketing",label:"Manage marketing",description:"Create, edit and end restaurant-funded offers."},
  {key:"canManageCustomers",label:"Manage customer conversations",description:"View your customer directory and read or reply to customer messages."},
  {key:"canManageSettings",label:"Manage business and service settings",description:"Edit the business profile, opening hours and delivery settings."},
  {key:"canProcessOrders",label:"Process orders on registered tablet",description:"Process orders and receipt actions on the registered, connected tablet. Phones and ordinary browsers stay view-only."}
];
const keys=STAFF_CAPABILITIES.map(row=>row.key),validId=value=>typeof value==="string"&&/^[A-Za-z0-9_-]{1,100}$/.test(value);
const empty=()=>({open:false,loading:false,saving:false,loaded:false,requiresReload:false,error:"",saved:false,baseline:null,draft:null});
export function staffAccessError(error,saving=false){
  if(error?.status===401)return "Your sign-in has expired. Close this window and sign in again.";
  if(error?.status===403)return "Only the restaurant owner can change this access. Close this window and refresh Team & access.";
  if(error?.status===404)return "This person’s restaurant access has changed. Close this window and refresh Team & access.";
  return saving?"The save could not be confirmed. Reload current access before making another change.":"Current access could not be loaded. Try again before making changes.";
}
export function createStaffCapabilities({restaurantId,userId,owner,permission,request}){
  const allowed=owner===true&&permission==="staff"&&validId(restaurantId)&&validId(userId),path=`/api/restaurant/restaurants/${encodeURIComponent(restaurantId||"")}/staff/${encodeURIComponent(userId||"")}/capabilities`;
  let state=empty(),disposed=false,sequence=0,controller=null,pending=null;const listeners=new Set();
  const publish=next=>{if(disposed)return;state={...state,...next};for(const listener of listeners)listener();};
  function parse(value){if(value?.restaurantId!==restaurantId||value?.userId!==userId||keys.some(key=>typeof value.capabilities?.[key]!=="boolean"))throw Error("ACCESS_RESPONSE_INVALID");return Object.fromEntries(keys.map(key=>[key,value.capabilities[key]]));}
  async function load(){
    if(!allowed||disposed||state.saving)return false;if(state.loading)return pending;
    controller?.abort();controller=new AbortController();const currentController=controller,active=++sequence,signal=controller.signal;publish({...empty(),open:true,loading:true});
    const timer=setTimeout(()=>currentController.abort(),15000);
    pending=(async()=>{try{const values=parse(await request(path,{signal}));if(disposed||active!==sequence)return false;publish({loading:false,loaded:true,baseline:values,draft:{...values}});return true;}catch(error){if(!disposed&&active===sequence)publish({loading:false,error:staffAccessError(error)});return false;}finally{clearTimeout(timer);if(active===sequence){controller=null;pending=null;}}})();return pending;
  }
  return {allowed,getSnapshot:()=>state,subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},
    activate(){if(disposed){disposed=false;publish(empty());}},
    open(){if(state.open)return pending??Promise.resolve(state.loaded);return load();},reload:load,
    set(key,value){if(!allowed||disposed||!state.loaded||state.loading||state.saving||state.requiresReload||!keys.includes(key)||typeof value!=="boolean")return;publish({draft:{...state.draft,[key]:value},error:"",saved:false});},
    changes(){return state.loaded?Object.fromEntries(keys.filter(key=>state.draft[key]!==state.baseline[key]).map(key=>[key,state.draft[key]])):{};},
    async save(){
      if(!allowed||disposed||!state.open||!state.loaded||state.loading||state.saving||state.requiresReload)return false;
      const changes=this.changes();if(!Object.keys(changes).length)return false;
      controller=new AbortController();const currentController=controller,active=++sequence,signal=controller.signal;publish({saving:true,error:""});const timer=setTimeout(()=>currentController.abort(),15000);
      try{const values=parse(await request(path,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(changes),signal}));if(disposed||active!==sequence)return false;publish({open:false,saving:false,loaded:true,baseline:values,draft:{...values},saved:true});return true;}
      catch(error){if(!disposed&&active===sequence)publish({saving:false,requiresReload:true,error:staffAccessError(error,true)});return false;}
      finally{clearTimeout(timer);if(active===sequence)controller=null;}
    },
    close(){if(state.saving)return;sequence++;controller?.abort();controller=null;pending=null;publish(empty());},
    dispose(){disposed=true;sequence++;controller?.abort();controller=null;listeners.clear();}
  };
}
