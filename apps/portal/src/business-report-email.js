import {api,json,newKey} from "./api.js";

const statuses=new Set(["pending","claimed","sent","failed","unknown","cancelled","local_saved"]);
const waiting=job=>job&&["pending","claimed"].includes(job.status);
export function reportEmailMessage(job){
  if(!job)return "";
  const destination=job.recipient;
  return ({pending:`Report queued for email to ${destination}.`,claimed:`Preparing the report email for ${destination}.`,sent:`Email accepted for delivery to ${destination}.`,failed:`The report email to ${destination} could not be sent. You can retry.`,unknown:`Delivery to ${destination} could not be confirmed. Contact Cal-Eats support before requesting another copy.`,cancelled:`The report request for ${destination} was cancelled.`,local_saved:`Report saved locally for ${destination}. No email was sent.`})[job.status];
}

/** One report intent per scope. Ambiguous request retries reuse the same key;
 * a definitely failed/completed job needs an explicit new click for a new email. */
export function createBusinessReportEmail({reportPath,request=api,keyFactory=()=>newKey("business-report-email"),schedule=setTimeout,cancel=clearTimeout}){
  let state={busy:false,action:"",job:null,error:""},closed=false,revision=0,pending=null,poll=null,polls=0,key=null;
  const listeners=new Set();
  const publish=patch=>{state={...state,...patch};for(const listener of listeners)listener(state);};
  const stopPoll=()=>{if(poll!==null)cancel(poll);poll=null;};
  function validate(value,expectedId){
    if(!value||typeof value.id!=="string"||!/^[A-Za-z0-9_-]{8,100}$/.test(value.id)||!statuses.has(value.status)||typeof value.recipient!=="string"||!/^\S+@\S+\.\S+$/.test(value.recipient)||expectedId&&value.id!==expectedId)throw new Error("The report request could not be confirmed. Try again to check the same request.");
    return value;
  }
  async function perform(action){
    if(closed||pending)return;
    stopPoll();const attempt=++revision,controller=new AbortController();let timer;
    const operation={controller,cancelTimeout:()=>cancel(timer)};pending=operation;
    const expectedId=action==="check"?state.job?.id:null;
    publish({busy:true,action,error:""});
    try{
      const timeout=new Promise((_,reject)=>{timer=schedule(()=>{controller.abort();reject(new Error("The report service took too long to respond. Try again to check the same request."));},15000);});
      const options=action==="send"?{...json("POST",{reportPath},key),signal:controller.signal}:{signal:controller.signal};
      const value=await Promise.race([request(action==="send"?"/api/restaurant/report-emails":`/api/restaurant/report-emails/${encodeURIComponent(expectedId)}`,options),timeout]);
      if(closed||attempt!==revision)return;
      publish({job:validate(value,expectedId),error:""});
    }catch(error){if(!closed&&attempt===revision)publish({error:error.name==="AbortError"?"The report service took too long to respond. Try again to check the same request.":error.message||"The report request could not be confirmed. Try again."});}
    finally{
      cancel(timer);
      if(pending===operation)pending=null;
      if(!closed&&attempt===revision){
        publish({busy:false,action:""});
        if(waiting(state.job)&&polls<12)poll=schedule(()=>{poll=null;polls++;void perform("check");},5000);
      }
    }
  }
  return {
    getSnapshot:()=>state,
    subscribe(listener){listeners.add(listener);listener(state);return()=>listeners.delete(listener);},
    send(){
      if(closed||pending)return;
      if(state.job&&(waiting(state.job)||state.job.status==="unknown"))return perform("check");
      if(!key||state.job){key=keyFactory();publish({job:null,error:""});}
      polls=0;return perform("send");
    },
    check(){if(state.job)return perform("check");},
    close(){closed=true;revision++;stopPoll();pending?.cancelTimeout();pending?.controller.abort();pending=null;listeners.clear();}
  };
}
