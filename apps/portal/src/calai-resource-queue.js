// Polls share an in-flight read. An explicit invalidation waits for that read
// and a fresh successor, so a pre-save response cannot become the final list.
export function createCalaiResourceQueue({read,onStart=()=>{},onValue=()=>{},onError=()=>{},timeoutMs=45000}){
 let active=null,disposed=false;
 function reload(force=false){
  if(disposed)return Promise.resolve();
  if(active){if(force)active.queued=true;return active.promise;}
  const entry={queued:false,controller:null,promise:null};active=entry;
  const work=(async()=>{
   do{
    entry.queued=false;const controller=new AbortController();entry.controller=controller;
    const timer=setTimeout(()=>controller.abort(),timeoutMs);onStart();
    try{const value=await read(controller.signal);if(controller.signal.aborted)throw Object.assign(Error("The read timed out"),{name:"AbortError"});if(!disposed&&active===entry&&!entry.queued)onValue(value);}
    catch(error){if(!disposed&&active===entry&&!entry.queued)onError(error);}
    finally{clearTimeout(timer);}
   }while(!disposed&&active===entry&&entry.queued);
  })();
  entry.promise=work.finally(()=>{if(active===entry)active=null;});return entry.promise;
 }
 return {reload,dispose(){disposed=true;active?.controller?.abort();active=null;}};
}
