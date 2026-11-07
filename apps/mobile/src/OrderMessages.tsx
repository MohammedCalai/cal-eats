import { useEffect, useRef, useState } from "react";
import { Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import { api } from "./api";
import { Button, Card, ErrorBanner, Field } from "./components";
import { colours } from "./theme";
import { completeThreadSend, createThreadRefresh, createThreadWindow } from "./thread-refresh";
import type { ThreadCursor } from "./thread-refresh";
import { useThreadScroll } from "./useThreadScroll";
import { useForegroundRefresh } from "./useForegroundRefresh";
type Conversation = { items: Array<{id:string; senderRole:string; message:string; createdAt:string}>; isOpen:boolean; restaurantPhone?:string|null; nextCursor?:ThreadCursor|null };
export function OrderMessages({ token, orderId, phone, available=true,onOpenChange }: { token:string; orderId:string; phone?:string|null; available?:boolean;onOpenChange?:(open:boolean)=>void }) {
  const [open,setOpen]=useState(false), [data,setData]=useState<Conversation|null>(null), [message,setMessage]=useState(""), [error,setError]=useState(""), [busy,setBusy]=useState(false),[closed,setClosed]=useState(false),[sent,setSent]=useState(false);
  const retryKeys=useRef(new Map<string,string>()),sendingScope=useRef<object|null>(null),lastRead=useRef<string|null>(null),active=useRef({token,orderId});if(active.current.token!==token||active.current.orderId!==orderId)active.current={token,orderId};
  const threadScroll=useThreadScroll(active.current,open),refresh=useRef<ReturnType<typeof createThreadRefresh<Conversation>>|null>(null);
  const messageWindow=useRef<ReturnType<typeof createThreadWindow<Conversation["items"][number]>>|null>(null);
  const [cursor,setCursor]=useState<ThreadCursor|null|undefined>(),[loading,setLoading]=useState(false);
  useEffect(()=>{onOpenChange?.(open);return()=>onOpenChange?.(false);},[open,onOpenChange]);
  useEffect(()=>{
    const scope=active.current;
    const window=createThreadWindow<Conversation["items"][number]>();messageWindow.current=window;
    setOpen(false);setData(null);setClosed(false);setError("");setMessage("");setSent(false);setBusy(false);setCursor(undefined);retryKeys.current.clear();lastRead.current=null;
    const controller=createThreadRefresh<Conversation>({
      isCurrent:()=>active.current===scope,
      load:page=>{const before=window.cursor();return api<Conversation>(`/api/orders/${orderId}/messages${page==="earlier"&&before?`?${new URLSearchParams(before)}`:""}`,{token});},
      apply:async (value,page)=>{
        const retained=window.receive(value.items,value.nextCursor||null,page,!threadScroll.isFollowing());
        setData({...value,items:retained.items});setCursor(retained.nextCursor);setClosed(false);setError("");
        const last=value.items.at(-1);
        if(last&&last.id!==lastRead.current){await api(`/api/orders/${orderId}/messages/read`,{method:"POST",token,body:JSON.stringify({lastMessageId:last.id})});if(active.current===scope)lastRead.current=last.id;}
      },
      onError:e=>{if((e as {code?:string}).code==="MESSAGING_CLOSED"){setData(null);setClosed(true);}else setError((e as Error).message);},onLoading:setLoading
    });
    refresh.current=controller;
    return()=>{controller.dispose();if(refresh.current===controller){refresh.current=null;messageWindow.current=null;}};
  },[orderId,token]);
  useEffect(()=>{if(open){threadScroll.requestLatest();void refresh.current?.refresh();}},[open,orderId,token]);
  useForegroundRefresh(()=>refresh.current?.refresh("latest",true)??Promise.resolve(),open,15000);
  async function send() {
    const text=message.trim(),current=active.current,controller=refresh.current;if(sendingScope.current===current||!data?.isOpen||!text||!controller)return;sendingScope.current=current;setBusy(true);setError("");setSent(false);
    const key=retryKeys.current.get(text)||`native-message-${Date.now()}-${Math.random().toString(36).slice(2)}`;retryKeys.current.set(text,key);
    try {
      await completeThreadSend({
        send:()=>api<Conversation["items"][number]>(`/api/orders/${orderId}/messages`,{method:"POST",token,idempotencyKey:key,body:JSON.stringify({message:text})}),
        text,isCurrent:()=>active.current===current&&controller.isActive(),updateDraft:setMessage,
        onSent:async sentMessage=>{
          controller.invalidate();threadScroll.requestLatest();setSent(true);retryKeys.current.delete(text);
          const retained=messageWindow.current!.append(sentMessage);setCursor(retained.nextCursor);
          setData(value=>value?{...value,items:retained.items}:value);
          await controller.refresh("latest",true);
        }
      });
    }catch(e){if(active.current===current&&controller.isActive())setError(`${(e as Error).message} Your draft is kept here so you can retry.`);}finally{if(active.current===current&&controller.isActive()){sendingScope.current=null;setBusy(false);}}
  }
  const restaurantPhone=data?.restaurantPhone??phone;
  return <Card><View style={styles.heading}><View style={styles.headingCopy}><Text accessibilityRole="header" style={styles.title}>Your restaurant</Text><Text style={styles.meta}>A direct line about this order.</Text></View><View style={styles.orderTag}><Text style={styles.orderTagText}>#{orderId.slice(0,8).toUpperCase()}</Text></View></View><View style={styles.actions}>{available&&!closed?<View style={styles.action}><Button tone={open?"secondary":"primary"} onPress={()=>setOpen(v=>!v)}>{open?"Hide conversation":"Message restaurant"}</Button></View>:null}{restaurantPhone?<View style={styles.action}><Button tone="secondary" onPress={()=>void Linking.openURL(`tel:${restaurantPhone.replace(/[^+0-9]/g,"")}`).catch(()=>setError("Calling is unavailable on this device."))}>Call restaurant</Button></View>:null}</View><ErrorBanner message={error}/>
    {open?<><ScrollView {...threadScroll.scrollProps} style={styles.history} contentContainerStyle={styles.historyContent} nestedScrollEnabled keyboardShouldPersistTaps="handled">{cursor?<Button tone="quiet" busy={loading} onPress={()=>{threadScroll.preserveHistory();void refresh.current?.refresh("earlier");}}>Earlier messages</Button>:null}{data?.items.length?data.items.map(item=><View accessible accessibilityLabel={`${item.senderRole==="customer"?"You":"Restaurant"}: ${item.message}`} style={[styles.message,item.senderRole==="customer"?styles.mine:styles.other]} key={item.id}><Text style={styles.sender}>{item.senderRole==="customer"?"You":"Restaurant"}</Text><Text style={styles.body}>{item.message}</Text><Text style={styles.time}>{new Date(item.createdAt).toLocaleString("en-GB",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit",timeZone:"Europe/London"})}</Text></View>):<View style={styles.empty}><Text style={styles.emptyTitle}>{data?"Start the conversation":closed?"Conversation closed":"Loading your conversation…"}</Text>{data?.isOpen?<Text style={styles.emptyCopy}>Ask about your delivery, collection or this order. Replies appear here.</Text>:null}</View>}</ScrollView>{data?.isOpen?<View style={styles.composer} onLayout={threadScroll.geometryChanged}><Field label="Message restaurant" placeholder="Write a message…" value={message} editable={!busy} onChangeText={value=>{setMessage(value);setSent(false);}} maxLength={300} multiline onContentSizeChange={threadScroll.geometryChanged} style={styles.input}/><View style={styles.composeMeta}><Text accessibilityLiveRegion="polite" style={styles.meta}>{busy?"Sending…":sent?"Message sent":""}</Text><Text style={styles.meta}>{message.length}/300</Text></View><Button busy={busy} disabled={!message.trim()} onPress={()=>void send()}>Send message</Button><Text style={styles.note}>Messages cannot change paid items, prices or payment terms.</Text></View>:closed||data?<Text style={styles.closed}>This order conversation is closed. You can still get help with your order below.</Text>:null}</>:closed||!available?<Text style={styles.meta}>Messaging is closed for this order. You can still get help below.</Text>:null}
  </Card>;
}
const styles=StyleSheet.create({heading:{flexDirection:"row",alignItems:"center",gap:12},headingCopy:{flex:1,gap:4},title:{color:colours.ink,fontWeight:"800",fontSize:18,lineHeight:25},orderTag:{paddingHorizontal:9,paddingVertical:6,borderRadius:8,backgroundColor:colours.sky},orderTagText:{fontSize:11,fontWeight:"700",color:colours.blueDark},actions:{flexDirection:"row",flexWrap:"wrap",gap:9,marginTop:4},action:{flexGrow:1,flexBasis:140},body:{color:colours.ink,fontSize:15,lineHeight:23},meta:{color:colours.muted,fontSize:12,lineHeight:19},history:{maxHeight:340,borderRadius:14,backgroundColor:colours.cream,marginTop:4},historyContent:{padding:12,gap:12,flexGrow:1},message:{maxWidth:"92%",borderWidth:1,borderColor:colours.line,borderRadius:15,paddingHorizontal:13,paddingVertical:10,gap:4},mine:{alignSelf:"flex-end",backgroundColor:"#D8EAFE",borderColor:"#BDD8F0",borderBottomRightRadius:4},other:{alignSelf:"flex-start",backgroundColor:colours.panel,borderBottomLeftRadius:4},sender:{fontSize:11,fontWeight:"700",color:colours.blueDark,lineHeight:17},time:{fontSize:11,color:colours.muted,textAlign:"right",lineHeight:17},empty:{minHeight:150,justifyContent:"center",alignItems:"center",gap:7,padding:14},emptyTitle:{fontSize:15,fontWeight:"700",color:colours.ink,textAlign:"center"},emptyCopy:{fontSize:13,lineHeight:21,color:colours.muted,textAlign:"center"},composer:{gap:8,paddingTop:4},input:{minHeight:64,maxHeight:120,borderRadius:16},composeMeta:{flexDirection:"row",justifyContent:"space-between",gap:12},note:{fontSize:11,lineHeight:18,color:colours.muted},closed:{fontSize:13,lineHeight:21,color:colours.muted,paddingVertical:10}});
