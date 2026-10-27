import { useEffect, useRef, useState } from "react";
import { Linking, StyleSheet, Text, View } from "react-native";
import { api } from "./api";
import { Button, Card, ErrorBanner, Field } from "./components";
import { colours } from "./theme";
type Conversation = { items: Array<{id:string; senderRole:string; message:string; createdAt:string}>; isOpen:boolean; restaurantPhone?:string|null };
export function OrderMessages({ token, orderId, phone, available=true }: { token:string; orderId:string; phone?:string|null; available?:boolean }) {
  const [open,setOpen]=useState(false), [data,setData]=useState<Conversation|null>(null), [message,setMessage]=useState(""), [error,setError]=useState(""), [busy,setBusy]=useState(false),[closed,setClosed]=useState(false);
  const key=useRef<string|null>(null);
  useEffect(()=>{setOpen(false);setData(null);setClosed(false);setError("");},[orderId]);
  async function load() {
    try { const value=await api<Conversation>(`/api/orders/${orderId}/messages`,{token}); setData(value);setError("");
      const last=value.items.at(-1);if(last)await api(`/api/orders/${orderId}/messages/read`,{method:"POST",token,body:JSON.stringify({lastMessageId:last.id})});
    } catch(e) { if((e as {code?:string}).code==="MESSAGING_CLOSED"){setData(null);setOpen(false);setClosed(true);}else setError((e as Error).message); }
  }
  useEffect(()=>{if(!open)return;void load();const timer=setInterval(()=>void load(),15000);return()=>clearInterval(timer);},[open,orderId,token]);
  async function send() {
    if(busy||!message.trim())return;setBusy(true);setError("");key.current??=`native-message-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {await api(`/api/orders/${orderId}/messages`,{method:"POST",token,idempotencyKey:key.current,body:JSON.stringify({message:message.trim()})});setMessage("");key.current=null;await load();}catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  const restaurantPhone=data?.restaurantPhone??phone;
  return <Card>{restaurantPhone?<Button tone="secondary" onPress={()=>void Linking.openURL(`tel:${restaurantPhone.replace(/[^+0-9]/g,"")}`).catch(()=>setError("Calling is unavailable on this device."))}>Call restaurant</Button>:null}{available&&!closed?<Button tone="secondary" onPress={()=>setOpen(v=>!v)}>{open?"Close messages":"Message restaurant"}</Button>:null}
    {open?<><Text style={styles.title}>Order messages</Text><Text style={styles.meta}>For this order only. Messages cannot change paid items, prices or payment terms. Conversations close after the support window.</Text><ErrorBanner message={error}/>{data?.items.map(item=><View style={styles.message} key={item.id}><Text style={styles.meta}>{item.senderRole==="customer"?"You":"Restaurant"} · {new Date(item.createdAt).toLocaleTimeString()}</Text><Text style={styles.body}>{item.message}</Text></View>)}{data?.isOpen?<><Field label="Message (300 characters maximum)" value={message} onChangeText={v=>{setMessage(v);key.current=null;}} maxLength={300} multiline/><Button busy={busy} disabled={!message.trim()} onPress={()=>void send()}>Send message</Button></>:null}</>:null}
  </Card>;
}
const styles=StyleSheet.create({title:{color:colours.ink,fontWeight:"800",fontSize:18},body:{color:colours.ink,lineHeight:21},meta:{color:colours.muted,lineHeight:19},message:{borderLeftWidth:3,borderLeftColor:colours.blue,paddingLeft:10,gap:4,paddingVertical:6}});
