import React,{useCallback,useEffect,useRef,useState} from "react";
import {api,json,newKey} from "./api.js";
import {shortDate} from "./model.js";

export default function BusinessApplicationAccess({restaurantId,onSaved=()=>{}}){
  const [state,setState]=useState({loading:true,value:null,error:"",restaurantId}),[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const serial=useRef(0),attempt=useRef(null),scope=useRef(restaurantId),active=useRef(true);scope.current=restaurantId;
  const load=useCallback(async()=>{const ticket=++serial.current;setState(old=>({...old,loading:true,error:""}));try{const value=await api(`/api/admin/restaurants/${encodeURIComponent(restaurantId)}/application`);if(ticket===serial.current)setState({loading:false,value,error:"",restaurantId});}catch(cause){if(ticket===serial.current)setState({loading:false,value:null,error:cause.message,restaurantId});}},[restaurantId]);
  useEffect(()=>{active.current=true;attempt.current=null;setBusy(false);setError("");setNotice("");void load();return()=>{active.current=false;serial.current++;attempt.current=null;};},[load]);
  async function save(event){
    event.preventDefault();if(busy||state.loading||state.restaurantId!==restaurantId||!state.value?.access?.canSetInitialPassword)return;
    const form=event.currentTarget,values=new FormData(form),body={password:String(values.get("password")||""),passwordConfirmation:String(values.get("passwordConfirmation")||""),reason:String(values.get("reason")||"").trim()};
    if(body.password!==body.passwordConfirmation){setError("The two passwords must match.");return;}
    if(!attempt.current||Object.keys(body).some(key=>attempt.current.body[key]!==body[key]))attempt.current={key:newKey("business-access"),body};
    const request=attempt.current,id=restaurantId,current=()=>active.current&&scope.current===id&&attempt.current===request;
    setBusy(true);setError("");setNotice("");
    try{
      await api(`/api/admin/restaurants/${encodeURIComponent(id)}/application/password`,json("POST",request.body,request.key));
      if(!current())return;
      form.reset();attempt.current=null;setNotice("Business login prepared. Give the owner its sign-in details through your private contact channel. Restaurant approval and banking checks still apply.");
      await load();await onSaved();
    }catch(cause){if(current()){setError(cause.message);if(["BUSINESS_PASSWORD_ALREADY_SET","APPLICATION_ACCESS_CONFLICT"].includes(cause.code))void load();}}
    finally{if(active.current&&scope.current===id)setBusy(false);}
  }
  const access=state.value?.access;
  return <section className="panel"><div className="admin-rest-section-title"><div><h2>Business login</h2><p>Cal-Eats prepares the initial password for new restaurant applicants.</p></div></div>
    {state.loading||state.restaurantId!==restaurantId?<p role="status">Loading business access…</p>:state.error?<p className="alert" role="alert">{state.error}</p>:!access?<p className="fine">This business uses an existing account. Its owner can change or recover its password from the sign-in page.</p>:<>
      <p><strong>{access.name}</strong><br/>{access.email}</p>
      {!access.passwordSetupRequired?<><span className="pill subtle">Login prepared</span><p className="fine">Prepared {shortDate(access.passwordSetAt)}.{!access.loginEnabled&&" Account access is currently disabled."} Existing passwords are never displayed here.</p></>:!access.canSetInitialPassword?<p className="alert">Review this restaurant’s marketplace access and owner membership before preparing its login.</p>:<form key={restaurantId} className="admin-rest-access-form" onSubmit={save}>
        <span className="pill attention">Awaiting initial password</span><p className="fine">Saving this form enables the applicant’s business login. The restaurant remains subject to its marketplace approval, availability and bank setup.</p>
        <label>Initial business password<input name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={200} disabled={busy}/></label>
        <label>Confirm password<input name="passwordConfirmation" type="password" autoComplete="new-password" required minLength={12} maxLength={200} disabled={busy}/></label>
        <p className="fine">Use 12–200 characters with letters and numbers. The password is not included in email or the audit history.</p>
        <label>Administrator reason<textarea name="reason" required minLength={3} maxLength={500} rows={2} disabled={busy} placeholder="Initial access for the restaurant applicant"/></label>
        <button className="primary" disabled={busy}>{busy?"Preparing login…":"Save password & enable login"}</button>
      </form>}
    </>}
    {error&&<p className="alert" role="alert">{error}</p>}{notice&&<p className="alert success" role="status">{notice}</p>}
  </section>;
}
