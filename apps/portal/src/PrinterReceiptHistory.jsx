import React,{useCallback,useEffect,useRef,useState} from "react";
import {api,json} from "./api.js";
import {shortDate} from "./model.js";
import {useOrderingTerminal} from "./OrderingTerminal.jsx";

const label=job=>job.checkedResult==="receipt_found"?"Receipt found by operator":job.checkedResult==="not_printed"?"Checked: receipt not printed":({queued:"Waiting",dispatched:"Sent to Windows",claimed:"Sending",submitted:"Submitted to printer",printed:"Reported printed",failed:"Failed",uncertain:"Check physical receipt",cancelled:"Cancelled"})[job.status]||"Result not confirmed";
export default function PrinterReceiptHistory({restaurantId,printers}) {
  const [selected,setSelected]=useState(""),[opened,setOpened]=useState(false),[cursor,setCursor]=useState(0),[state,setState]=useState({items:[],nextCursor:null,error:"",loading:false}),[busy,setBusy]=useState("");
  const terminal=useOrderingTerminal(),sequence=useRef(0),scope=useRef("");
  const printerId=printers.some(item=>item.id===selected)?selected:printers[0]?.id||"";
  scope.current=`${restaurantId}:${printerId}`;
  const load=useCallback(async()=>{
    if(!opened||!printerId)return;
    const current=scope.current,request=++sequence.current;
    setState(old=>({...old,loading:true,error:""}));
    try{const value=await api(`/api/restaurant/restaurants/${encodeURIComponent(restaurantId)}/printers/${encodeURIComponent(printerId)}/jobs?cursor=${cursor}`);if(request===sequence.current&&scope.current===current)setState({items:value.items||[],nextCursor:value.nextCursor??null,error:"",loading:false});}
    catch(error){if(request===sequence.current&&scope.current===current)setState(old=>({...old,loading:false,error:error.message}));}
  },[restaurantId,printerId,cursor,opened]);
  useEffect(()=>{setState({items:[],nextCursor:null,error:"",loading:false});void load();return()=>{sequence.current++;};},[load]);
  async function check(job,result){
    if(busy||!terminal?.canPrint)return;
    const explanation=result==="receipt_found"?"Confirm you have physically found this receipt. This records your check; it does not print another copy.":"Confirm you have checked the printer and this receipt was not printed. This records the result; you must explicitly request a reprint if needed.";
    if(!window.confirm(explanation))return;
    const current=scope.current;setBusy(job.id);
    try{await api(`/api/restaurant/restaurants/${encodeURIComponent(restaurantId)}/printers/${encodeURIComponent(printerId)}/jobs/${encodeURIComponent(job.id)}/check`,json("POST",{result}));if(scope.current===current){await load();await terminal.refreshHealth();}}
    catch(error){if(scope.current===current)setState(old=>({...old,error:error.message}));}
    finally{if(scope.current===current)setBusy("");}
  }
  return <details className="calai-printer-advanced" onToggle={event=>setOpened(event.currentTarget.open)}><summary>Receipt results & checks</summary><div className="calai-printer-advanced-body"><p>Check the physical receipt before resolving a failed or uncertain result. A submitted job alone does not confirm a paper receipt.</p><label>Printer<select value={printerId} disabled={!printers.length} onChange={event=>{setSelected(event.target.value);setCursor(0);setBusy("");}}>{printers.map(printer=><option key={printer.id} value={printer.id}>{printer.name}</option>)}</select></label>{state.error&&<p className="alert" role="alert">{state.error}</p>}{state.loading&&<p role="status">Checking receipt history…</p>}{!state.loading&&!state.items.length&&<p>No receipt jobs reported for this page.</p>}{state.items.map(job=><article className="calai-printer-controls" key={job.id}><div><strong>{job.testReceipt?"Sample test receipt":job.manualReprint?"Labelled manual reprint":"Order receipt"}</strong><p>{label(job)}</p><small>{shortDate(job.updatedAt||job.createdAt)}{job.orderId?` · Order ${job.orderId.slice(0,8).toUpperCase()}`:""} · Attempt {job.attempt||1}</small>{job.detail&&<p className="fine">{job.detail}</p>}</div>{terminal?.canPrint&&["failed","uncertain"].includes(job.status)&&!job.checkedResult&&<div className="button-row"><button className="quiet" disabled={Boolean(busy)} onClick={()=>void check(job,"receipt_found")}>Receipt found</button><button className="quiet" disabled={Boolean(busy)} onClick={()=>void check(job,"not_printed")}>Checked: not printed</button></div>}</article>)}<div className="button-row"><button className="quiet" disabled={state.loading} onClick={()=>void load()}>Refresh receipt results</button>{cursor>0&&<button className="quiet" disabled={state.loading} onClick={()=>setCursor(0)}>Newest receipts</button>}{state.nextCursor!==null&&<button className="quiet" disabled={state.loading} onClick={()=>setCursor(state.nextCursor)}>Older receipts</button>}</div></div></details>;
}
