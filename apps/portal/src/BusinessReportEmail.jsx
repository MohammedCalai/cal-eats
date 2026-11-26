import React,{useEffect,useRef,useState} from "react";
import {createBusinessReportEmail,reportEmailMessage} from "./business-report-email.js";
import "./BusinessReportEmail.css";

export default function BusinessReportEmail({href,children,className="quiet"}){
  return <ReportEmailScope key={href} reportPath={href} className={className}>{children}</ReportEmailScope>;
}
function ReportEmailScope({reportPath,children,className}){
  const controller=useRef(null),[state,setState]=useState({busy:false,action:"",job:null,error:""});
  useEffect(()=>{
    const current=createBusinessReportEmail({reportPath});controller.current=current;
    const unsubscribe=current.subscribe(setState);
    return()=>{unsubscribe();current.close();if(controller.current===current)controller.current=null;};
  },[reportPath]);
  const status=state.job?.status,label=state.busy?(state.action==="check"?"Checking email status…":"Preparing email…"):["pending","claimed","unknown"].includes(status)?"Check email status":["failed","cancelled"].includes(status)||state.error&&!state.job?"Retry email":["sent","local_saved"].includes(status)?"Email another copy":children;
  return <span className="business-report-email"><button type="button" className={className} disabled={state.busy} onClick={()=>void controller.current?.send()}>{label}</button>{state.job&&<span className={`business-report-email-status status-${status}`} role={status==="failed"?"alert":"status"}>{reportEmailMessage(state.job)}{status==="unknown"&&<> <a href="mailto:caleats@calai.info?subject=Cal-Eats%20report%20email%20delivery">Contact support</a>.</>}</span>}{state.error&&<span className="business-report-email-error" role="alert">{state.error}</span>}</span>;
}
