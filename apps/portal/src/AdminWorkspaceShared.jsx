import React,{useCallback,useEffect,useRef,useState} from "react";
import {api} from "./api.js";

// Keep the last successful snapshot while refreshing. A poll never blanks a table.
export function useAdminResource(path,{poll=0}={}) {
  const [state,setState]=useState({path:"",value:null,error:"",loading:true,refreshing:false});
  const generation=useRef(0),active=useRef(null);
  const reload=useCallback(async()=>{
    if(active.current?.path===path)return;
    active.current?.controller.abort();
    const request=++generation.current,controller=new AbortController();active.current={path,controller};
    setState(old=>({...old,path,value:old.path===path?old.value:null,loading:old.path!==path||!old.value,refreshing:true,error:""}));
    const timeout=setTimeout(()=>controller.abort(),20000);
    try{const value=await api(path,{signal:controller.signal});if(request===generation.current)setState({path,value,error:"",loading:false,refreshing:false});}
    catch(error){if(request===generation.current)setState(old=>({...old,path,loading:false,refreshing:false,error:error.name==="AbortError"?"The connection took too long. The last checked information is still shown.":error.message}));}
    finally{clearTimeout(timeout);if(request===generation.current)active.current=null;}
  },[path]);
  useEffect(()=>{void reload();const timer=poll?setInterval(()=>void reload(),poll):null,visible=()=>{if(!document.hidden)void reload();};if(poll){window.addEventListener("focus",visible);document.addEventListener("visibilitychange",visible);}return()=>{if(timer)clearInterval(timer);generation.current++;active.current?.controller.abort();active.current=null;window.removeEventListener("focus",visible);document.removeEventListener("visibilitychange",visible);};},[reload,poll]);
  return {...(state.path===path?state:{value:null,error:"",loading:true,refreshing:false}),reload};
}
export function AdminPager({pagination,page,onChange,busy}) {const p=pagination;return <div className="admin-pager"><span>{p?.total?`${(p.page-1)*p.pageSize+1}–${Math.min(p.page*p.pageSize,p.total)} of ${p.total}`:"No records"} · Page {p?.page||page} of {Math.max(1,p?.totalPages||1)}</span><div><button className="quiet" disabled={busy||!p?.hasPrevious} onClick={()=>onChange(page-1)}>Previous</button><button className="quiet" disabled={busy||!p?.hasNext} onClick={()=>onChange(page+1)}>Next</button></div></div>;}
export function AdminResourceMessage({resource,emptyText="No records to show."}) {if(resource.error)return <p className="alert" role="alert">{resource.error}<button className="quiet" onClick={()=>void resource.reload()}>Refresh</button></p>;if(resource.loading)return <p className="admin-loading" role="status">Loading…</p>;if(resource.value?.items?.length===0)return <p className="empty">{emptyText}</p>;return null;}
export function AdminTable({headers,children,label}) {return <div className="admin-table-wrap" tabIndex="0" role="region" aria-label={label}><table className="admin-table"><thead><tr>{headers.map((title,index)=><th scope="col" key={`${title}-${index}`}>{title}</th>)}</tr></thead><tbody>{children}</tbody></table></div>;}
export function AdminPageHeading({eyebrow="Platform administration",title,intro,children}) {return <header className="admin-page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{intro}</p></div>{children}</header>;}
