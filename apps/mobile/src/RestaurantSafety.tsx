import { SafeAreaView } from "react-native-safe-area-context";
import { CustomerModal as Modal } from "./CustomerModal";
import { useEffect, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { api } from "./api";
import { Button, ErrorBanner, Field } from "./components";
import { CustomerIcon } from "./CustomerBrandBanner";
import { colours } from "./theme";
import { createRestaurantContactControl, restaurantContactCopy, type RestaurantContactController, type RestaurantContactState } from "../../web/restaurant-contact-control.js";
import { useForegroundRefresh } from "./useForegroundRefresh";

const choices = [
  ["inappropriate_message", "Inappropriate message"], ["harassment", "Harassment or unwanted contact"],
  ["misleading_menu", "Misleading menu or photo"], ["unsafe_content", "Unsafe or offensive content"], ["other", "Something else"]
] as const;
type Props = { token: string; restaurantId?: string; orderId?: string; conversationId?: string; messageId?: string; menu?: boolean; reportOnly?: boolean; contactControls?: boolean; onBlockedChange?: (blocked: boolean) => void; onSignIn?: () => void };

export function RestaurantSafetyControls({ token, restaurantId, orderId, conversationId, messageId, menu, reportOnly, contactControls, onBlockedChange, onSignIn }: Props) {
  const [open, setOpen] = useState(false), [reason, setReason] = useState<string>(menu ? "misleading_menu" : "inappropriate_message"), [details, setDetails] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState(""), [reference, setReference] = useState("");
  const [contactState,setContactState]=useState<RestaurantContactState>({loaded:false,blocked:false,busy:false,error:""});
  const contact=useRef<RestaurantContactController|null>(null);
  const scope = useRef({ token, restaurantId, orderId, conversationId, messageId, menu, reportOnly, contactControls }), request = useRef<{ body: string; key: string } | null>(null);
  if (scope.current.token !== token || scope.current.restaurantId !== restaurantId || scope.current.orderId !== orderId || scope.current.conversationId !== conversationId || scope.current.messageId !== messageId || scope.current.menu !== menu || scope.current.reportOnly !== reportOnly || scope.current.contactControls !== contactControls) scope.current = { token, restaurantId, orderId, conversationId, messageId, menu, reportOnly, contactControls };
  const renderedScope = scope.current, activeScope = useRef<typeof renderedScope | null>(null), [stateScope, setStateScope] = useState(renderedScope);
  const reporting=useRef<typeof renderedScope|null>(null);
  const current = () => activeScope.current === renderedScope && scope.current === renderedScope;
  useEffect(() => {
    activeScope.current = renderedScope;
    setStateScope(renderedScope); setContactState({loaded:false,blocked:false,busy:false,error:""}); reporting.current=null; setOpen(false); setError(""); setDetails(""); setReference(""); setBusy(false); setReason(menu ? "misleading_menu" : "inappropriate_message"); request.current = null;
    onBlockedChange?.(false);
    const controller=token&&restaurantId&&contactControls&&!menu&&!reportOnly?createRestaurantContactControl({
      restaurantId,isCurrent:current,api:(path,options)=>api(path,{...options,token}),
      onState:value=>{if(current())setContactState(value);},onChanged:value=>{if(current())onBlockedChange?.(value);}
    }):null;
    contact.current=controller;void controller?.refresh();
    return () => { controller?.close();if(contact.current===controller)contact.current=null;if (activeScope.current === renderedScope) activeScope.current = null; };
  }, [token, restaurantId, orderId, conversationId, messageId, menu, reportOnly, contactControls]);
  useForegroundRefresh(()=>contact.current?.refresh()??Promise.resolve(false),Boolean(token&&restaurantId&&contactControls&&!menu&&!reportOnly&&!open),15000);
  if (!restaurantId) return null;
  if (!token) return <View style={styles.container}>{onSignIn ? <Button tone="quiet" onPress={onSignIn}>{reportOnly ? "Sign in to report this message" : "Sign in to report"}</Button> : <Text style={styles.notice}>Sign in to report.</Text>}</View>;
  if (stateScope !== renderedScope) return null;
  function confirmContactChange() {
    const controller=contact.current,value=controller?.snapshot();
    if(!current()||!controller||!value?.loaded||value.busy||busy||reporting.current===renderedScope)return;
    const copy=restaurantContactCopy(value.blocked);
    Alert.alert(copy.title,copy.explanation,[{text:"Cancel",style:"cancel"},{text:copy.confirm,onPress:()=>{
      if(!current()||contact.current!==controller||reporting.current===renderedScope||controller.snapshot().blocked!==value.blocked)return;
      void controller.change(!value.blocked);
    }}]);
  }
  async function sendReport() {
    if (!token || busy || reporting.current===renderedScope || contact.current?.snapshot().busy || !current()) return;
    const body = JSON.stringify({ restaurantId, ...(orderId ? { orderId } : {}), ...(conversationId ? { conversationId } : {}), ...(messageId ? { messageId } : {}), reason, details: details.trim() });
    if (request.current?.body !== body) request.current = { body, key: `safety-${Date.now()}-${Math.random().toString(36).slice(2)}` };
    reporting.current=renderedScope;setBusy(true); setError("");
    try {
      const result = await api<{ reference: string }>("/api/customer-safety/reports", { token, method: "POST", headers: { "Idempotency-Key": request.current.key }, body });
      if (current()) { setReference(result.reference); request.current = null; }
    } catch (cause) { if (current()) setError((cause as Error).message); }
    finally { if (current()) { reporting.current=null;setBusy(false); } }
  }
  const working=busy||contactState.busy,showContact=Boolean(contactControls&&!menu&&!reportOnly);
  return <View style={styles.container}><View style={styles.actions}><Button tone="quiet" disabled={working} onPress={() => { setOpen(true); setError(""); setReference(""); }}>{reportOnly ? "Report message" : menu ? "Report restaurant or menu" : "Report conversation"}</Button>{showContact?<Button tone="quiet" disabled={working||!contactState.loaded} onPress={confirmContactChange}>{contactState.loaded?restaurantContactCopy(contactState.blocked).action:contactState.busy?"Checking message preferences…":"Message preferences unavailable"}</Button>:null}{showContact&&!contactState.loaded&&!contactState.busy?<Button tone="quiet" disabled={busy} onPress={()=>void contact.current?.refresh()}>Check message preferences</Button>:null}</View>{showContact&&contactState.loaded&&contactState.blocked?<Text style={styles.notice}>{restaurantContactCopy(true).status}</Text>:null}{showContact?<ErrorBanner message={contactState.error}/>:null}{!open ? <ErrorBanner message={error}/> : null}
    <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}><SafeAreaView style={styles.backdrop}><View accessibilityViewIsModal style={styles.sheet}><View style={styles.heading}><Text accessibilityRole="header" style={styles.title}>Report to Cal-Eats</Text><Pressable accessibilityRole="button" accessibilityLabel="Close report" onPress={() => setOpen(false)} style={styles.close}><CustomerIcon name="close" size={22}/></Pressable></View><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}><ErrorBanner message={error}/>{reference ? <><Text style={styles.title}>Your report was received</Text><Text style={styles.copy}>Cal-Eats support will review your report. The restaurant does not receive it. You can follow replies in Account → Help requests.</Text><Text style={styles.notice}>Reference {reference}</Text><Button onPress={() => { setOpen(false); setDetails(""); }}>Done</Button></> : <><Text style={styles.copy}>This goes privately to Cal-Eats support, rather than the restaurant.</Text><Text style={styles.label}>What would you like us to review?</Text>{choices.map(([value, label]) => <Pressable key={value} accessibilityRole="radio" accessibilityState={{ checked: reason === value }} onPress={() => setReason(value)} style={[styles.choice, reason === value && styles.selected]}><Text style={styles.copy}>{reason === value ? "● " : "○ "}{label}</Text></Pressable>)}<Field label="Details" value={details} onChangeText={setDetails} multiline maxLength={1200}/><Text style={styles.notice}>Please include only information relevant to the report.</Text><Button busy={busy} onPress={() => void sendReport()}>Send report to Cal-Eats</Button></>}</ScrollView></View></SafeAreaView></Modal>
  </View>;
}
const styles = StyleSheet.create({ container: { gap: 6 }, actions: { flexDirection: "row", flexWrap: "wrap", gap: 6 }, notice: { color: colours.muted, fontSize: 12, lineHeight: 19 }, backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "#10283C80" }, sheet: { maxHeight: "90%", borderTopLeftRadius: 22, borderTopRightRadius: 22, backgroundColor: colours.panel, paddingBottom: 24 }, heading: { flexDirection: "row", alignItems: "center", paddingHorizontal: 18, paddingTop: 14, borderBottomWidth: 1, borderColor: colours.line }, title: { flex: 1, fontSize: 19, fontWeight: "800", color: colours.ink, lineHeight: 27 }, close: { minHeight: 48, minWidth: 48, alignItems: "center", justifyContent: "center" }, content: { padding: 18, gap: 13 }, copy: { color: colours.ink, fontSize: 14, lineHeight: 22 }, label: { color: colours.ink, fontSize: 15, fontWeight: "700", lineHeight: 22 }, choice: { minHeight: 48, padding: 12, borderWidth: 1, borderColor: colours.line, borderRadius: 12 }, selected: { borderColor: colours.blue, backgroundColor: colours.sky } });
