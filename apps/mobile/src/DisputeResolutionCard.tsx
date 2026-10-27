import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text } from "react-native";
import { api } from "./api";
import { Button, Card, ErrorBanner } from "./components";
import { money } from "./model";
import { colours } from "./theme";
type Proposal = { id:string; type:string; status:string; description:string; amountMinor?:number|null; voucherValueMinor?:number|null; expiresAt?:string|null; redemptionConditions?:string|null; fulfilments:Array<{action:string}> };
type Resolution = { phase:string; proposals:Proposal[] };
export function DisputeResolutionCard({token,caseId}:{token:string;caseId:string}) {
  const [value,setValue]=useState<Resolution|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const keys=useRef<Record<string,string>>({});
  async function load(){try{setValue(await api<Resolution>(`/api/refund-cases/${caseId}/resolution`,{token}));setError("");}catch(e){setError((e as Error).message);}}
  useEffect(()=>{void load();const timer=setInterval(()=>void load(),30000);return()=>clearInterval(timer);},[token,caseId]);
  async function act(proposal:Proposal,decision:"accept"|"decline"|"confirm") {
    if(busy)return;setBusy(true);const action=`${proposal.id}:${decision}`;
    keys.current[action]??=`native-remedy-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {await api(`/api/refund-cases/${caseId}/proposals/${proposal.id}/${decision==="confirm"?"confirm-fulfilment":"respond"}`,{method:"POST",token,idempotencyKey:keys.current[action],body:JSON.stringify(decision==="confirm"?{}:{decision})});await load();}catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  const proposal=value?.proposals.at(-1);
  return <Card><Text style={styles.title}>Restaurant resolution</Text><ErrorBanner message={error}/><Text style={styles.meta}>{value?.phase.replaceAll("_"," ")??"Loading resolution…"}</Text>{proposal?<><Text style={styles.title}>{proposal.type.replaceAll("_"," ")}</Text><Text style={styles.body}>{proposal.description}</Text>{proposal.amountMinor!=null?<Text style={styles.body}>{money(proposal.amountMinor)} · restaurant funded</Text>:null}{proposal.voucherValueMinor!=null?<Text style={styles.body}>Voucher value: {money(proposal.voucherValueMinor)}</Text>:null}{proposal.redemptionConditions?<Text style={styles.body}>{proposal.redemptionConditions}</Text>:null}{proposal.expiresAt?<Text style={styles.meta}>Expires {new Date(proposal.expiresAt).toLocaleString()}</Text>:null}{proposal.status==="pending"?<><Button busy={busy} onPress={()=>void act(proposal,"accept")}>Accept proposed remedy</Button><Button tone="secondary" disabled={busy} onPress={()=>void act(proposal,"decline")}>Decline and ask Cal-Eats to review</Button></>:null}{proposal.status==="accepted"&&proposal.fulfilments.some(f=>f.action==="restaurant_evidence")?<Button busy={busy} onPress={()=>void act(proposal,"confirm")}>Confirm I received the agreed remedy</Button>:null}</>:<Text style={styles.meta}>The restaurant has the first opportunity to respond. Submitting a case does not issue a refund.</Text>}<Text style={styles.meta}>Accepting an offer is separate from receiving it. Refunds are confirmed only after execution succeeds.</Text></Card>;
}
const styles=StyleSheet.create({title:{fontSize:18,fontWeight:"700",color:colours.ink},body:{color:colours.ink,lineHeight:21},meta:{color:colours.muted,lineHeight:20}});
