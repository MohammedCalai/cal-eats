import React,{useEffect,useId,useRef,useState} from "react";
import {api,json} from "./api.js";

export default function BankingPasswordChange({onChanged,title="Choose your banking password",description="Before entering real bank details, replace your testing password with a unique password only you know. Use at least 12 characters with letters and numbers."}){
  const titleId=useId();
  const [currentPassword,setCurrentPassword]=useState(""),[newPassword,setNewPassword]=useState(""),[confirmation,setConfirmation]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const active=useRef(false),working=useRef(false);
  useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  async function submit(event){
    event.preventDefault();if(working.current)return;
    if(newPassword.length<12||!/[A-Za-z]/.test(newPassword)||!/[0-9]/.test(newPassword)){setError("Choose a new password with at least 12 characters, including letters and numbers.");return;}
    if(newPassword!==confirmation){setError("The new passwords do not match.");return;}
    if(newPassword===currentPassword){setError("Choose a different password from your current one.");return;}
    working.current=true;setBusy(true);setError("");
    try{
      const result=await api("/api/auth/password",json("POST",{currentPassword,newPassword}));
      if(result.changed!==true)throw new Error("Your password change could not be confirmed. Try again.");
      if(!active.current)return;
      setCurrentPassword("");setNewPassword("");setConfirmation("");
      await onChanged?.();
    }catch(cause){if(active.current)setError(cause.message||"Your password could not be changed. Please try again.");}
    finally{working.current=false;if(active.current)setBusy(false);}
  }
  return <section className="finance-empty" aria-labelledby={titleId}><h3 id={titleId}>{title}</h3><p>{description}</p>{error&&<p className="alert" role="alert">{error}</p>}<form className="form-grid" onSubmit={submit} aria-busy={busy}><label className="full">Current password<input name="currentPassword" type="password" autoComplete="current-password" autoCapitalize="none" spellCheck={false} required maxLength={200} value={currentPassword} onChange={event=>setCurrentPassword(event.target.value)} disabled={busy}/></label><label>New password<input name="newPassword" type="password" autoComplete="new-password" autoCapitalize="none" spellCheck={false} required minLength={12} maxLength={200} value={newPassword} onChange={event=>setNewPassword(event.target.value)} disabled={busy}/></label><label>Confirm new password<input name="confirmPassword" type="password" autoComplete="new-password" autoCapitalize="none" spellCheck={false} required minLength={12} maxLength={200} value={confirmation} onChange={event=>setConfirmation(event.target.value)} disabled={busy}/></label><div className="button-row full"><button className="primary" type="submit" disabled={busy}>{busy?"Updating password…":"Save password & continue"}</button></div></form></section>;
}
