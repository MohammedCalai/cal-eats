import {useState} from "react";
import {Platform,Text,View} from "react-native";
import DateTimePicker,{type DateTimePickerChangeEvent} from "@react-native-community/datetimepicker";
import {Button,Card,colour,styles} from "./ui";
export function CampaignDateTime({label,value,onChange}:{label:string;value:string;onChange:(value:string)=>void}){
  const [mode,setMode]=useState<"date"|"time"|null>(null);
  const date=new Date(value),zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  function change(_event:DateTimePickerChangeEvent,selected:Date){
    if(Platform.OS==="android")setMode(null);
    if(!mode)return;
    const next=new Date(value);
    if(mode==="date")next.setFullYear(selected.getFullYear(),selected.getMonth(),selected.getDate());
    else next.setHours(selected.getHours(),selected.getMinutes(),0,0);
    onChange(next.toISOString());
  }
  return <Card><Text style={styles.heading}>{label}</Text><View style={styles.row}><Button quiet onPress={()=>setMode("date")}>{label} date · {date.toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short",year:"numeric"})}</Button><Button quiet onPress={()=>setMode("time")}>{label} time · {date.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"})}</Button></View><Text style={styles.hint}>Device time{zone?` (${zone.replaceAll("_"," ")})`:""}. The review also shows UK time.</Text>{mode?<><DateTimePicker value={date} mode={mode} display={Platform.OS==="ios"?"spinner":"default"} onValueChange={change} onDismiss={()=>setMode(null)} themeVariant="dark" accentColor={colour.cyan}/>{Platform.OS==="ios"?<Button quiet onPress={()=>setMode(null)}>Done</Button>:null}</>:null}</Card>;
}
