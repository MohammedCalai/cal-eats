import React from "react";
import {NavLink} from "react-router-dom";
import "./BusinessHomeLink.css";

export default function BusinessHomeLink(){
  return <NavLink to="/owner/dashboard" className="business-home-link" aria-label="Go to dashboard" title="Dashboard" onClick={event=>{if(!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey)window.scrollTo({top:0,left:0,behavior:"instant"});}}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 11 12 3l9 8M5 10v11h14V10M9 21v-7h6v7"/></svg><span>Home</span></NavLink>;
}
