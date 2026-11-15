import {useEffect,useRef,useState} from "react";
import {Text} from "react-native";
import {api,json} from "./api";
import {operationKey} from "./model";
import {Button,ErrorText,styles} from "./ui";
type Job={id:string;status:"pending"|"claimed"|"sent"|"failed"|"unknown"|"cancelled"|"local_saved";recipient:string};
export function BusinessReportEmail({token,reportPath,label}:{token:string;reportPath:string;label:string}){
 return <ReportScope key={`${token}:${reportPath}`} token={token} reportPath={reportPath} label={label}/>;
}
function ReportScope({token,reportPath,label}:{token:string;reportPath:string;label:string}){
 const [job,setJob]=useState<Job|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState("");const current=useRef(true),lock=useRef(false),key=useRef<string|null>(null);
 useEffect(()=>{current.current=true;return()=>{current.current=false;};},[]);
 async function send(){if(lock.current)return;lock.current=true;setBusy(true);setError("");try{
  const checking=job&&["pending","claimed","unknown"].includes(job.status);
  if(!checking&&(!key.current||job)){key.current=operationKey();setJob(null);}
  const value=await api<Job>(checking?`/api/restaurant/report-emails/${encodeURIComponent(job!.id)}`:"/api/restaurant/report-emails",checking?{token}:json(token,"POST",{reportPath},key.current!));
  if(current.current){if(!value.id||!value.recipient)throw new Error("The email request could not be confirmed. Retry to check the same request.");setJob(value);}
 }catch(e){if(current.current)setError((e as Error).message);}finally{lock.current=false;if(current.current)setBusy(false);}}
 const message=job?({pending:"Queued for email",claimed:"Preparing email",sent:"Email accepted for delivery",failed:"Email delivery failed; you can retry",unknown:"Delivery is uncertain. Check status or contact support before requesting another copy",cancelled:"Request cancelled",local_saved:"Saved locally; no email sent"})[job.status]:"";
 return <><Button quiet busy={busy} onPress={()=>void send()}>{job&&["pending","claimed","unknown"].includes(job.status)?"Check report email":job&&["failed","cancelled"].includes(job.status)?"Retry report email":label}</Button>{job&&<Text accessibilityLiveRegion="polite" style={styles.hint}>{message} · {job.recipient}</Text>}<ErrorText message={error}/></>;
}
