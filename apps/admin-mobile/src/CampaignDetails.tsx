import {useEffect,useRef,useState} from "react";
import {Text,View} from "react-native";
import {api,json} from "./api";
import {money,readable} from "./model";
import {campaignEditDraft,campaignEditFingerprint,campaignEditPayload,type CampaignEditDraft,type EditableCampaign} from "./campaign-edit";
import {CampaignDateTime} from "./CampaignDateTime";
import {Button,Card,ErrorText,Field,Notice,Page,Sheet,styles,Title,useRemote} from "./ui";
type Campaign=EditableCampaign&{id:string;campaignType:string;offerType:string;value:number;itemName:string|null;minSubtotalMinor:number;recipientSegment:string;recipientCount:number;openedCount:number;reservedCount:number;redeemedCount:number;committedBudgetMinor:number;weeklyCommittedBudgetMinor:number;eligibleItemIds:string[];eligibleCategories:string[]};
const when=(value:string|null)=>value?new Date(value).toLocaleString("en-GB",{timeZone:"Europe/London",dateStyle:"medium",timeStyle:"short"})+" UK time":"Not recorded";
export function CampaignDetails({token,restaurantId,campaignId,canManage,onClose,onUpdated}:{token:string;restaurantId:string;campaignId:string;canManage:boolean;onClose:()=>void;onUpdated:()=>void}){
 const path=`/api/restaurant/restaurants/${encodeURIComponent(restaurantId)}/loyalty/promotions/${encodeURIComponent(campaignId)}`,result=useRemote<Campaign>(path,token);
 const [draft,setDraft]=useState<CampaignEditDraft|null>(null),[baseline,setBaseline]=useState<Campaign|null>(null),[ending,setEnding]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState(""),[conflict,setConflict]=useState(false);
 const lock=useRef(false),active=useRef(true);useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
 const value=result.value?.id===campaignId?result.value:null,ended=Boolean(value&&Date.parse(value.expiresAt)<=Date.now()),scheduled=Boolean(value?.startsAt&&Date.parse(value.startsAt)>Date.now());
 function edit(){if(!value||!canManage||result.error||ended)return;setBaseline(value);setDraft(campaignEditDraft(value));setEnding(false);setNotice("");setError("");setConflict(false);}
 async function save(){
  if(lock.current||!canManage||!draft||!baseline)return;setError("");setNotice("");
  let body;try{body=campaignEditPayload(draft,baseline);}catch(e){setError((e as Error).message);return;}
  if(!Object.keys(body).length){setDraft(null);setNotice("No campaign details changed.");return;}
  lock.current=true;setBusy(true);
  try{
   const latest=await api<Campaign>(path,{token});if(!active.current)return;
   if(campaignEditFingerprint(latest)!==campaignEditFingerprint(baseline)){result.setValue(latest);setConflict(true);throw new Error("This campaign changed while you were editing it. Reload its latest details before editing again.");}
   const updated=await api<Campaign>(path,json(token,"PATCH",body));if(!active.current)return;
   result.setValue(updated);setDraft(null);setBaseline(null);setNotice("Campaign updated. Existing orders keep their saved offer amounts.");onUpdated();
  }catch(e){if(active.current){setError((e as Error).message);void result.reload();}}
  finally{lock.current=false;if(active.current)setBusy(false);}
 }
 async function end(){
  if(lock.current||!canManage||!value||ended)return;lock.current=true;setBusy(true);setError("");setNotice("");
  try{const updated=await api<Campaign>(`${path}/end`,json(token,"POST",{}));if(!active.current)return;result.setValue(updated);setEnding(false);setDraft(null);setNotice("Campaign ended. Unused offers are no longer available; existing orders keep their saved offer amounts.");onUpdated();}
  catch(e){if(active.current){setError((e as Error).message);void result.reload();}}
  finally{lock.current=false;if(active.current)setBusy(false);}
 }
 async function reload(){setDraft(null);setBaseline(null);setConflict(false);setEnding(false);setError("");await result.reload();}
 return <Sheet title="Campaign" onClose={onClose}><Page loading={result.loading} onRefresh={()=>void reload()}><ErrorText message={error||result.error}/>{notice&&<Notice>{notice}</Notice>}{value&&<><Title title={value.title}>{ended?"Ended":scheduled?"Scheduled":"Active"} · {readable(value.campaignType||value.offerType)}</Title><Card><Text style={styles.text}>{value.message}</Text><Text style={styles.hint}>Starts {when(value.startsAt)}</Text><Text style={styles.text}>Ends {when(value.expiresAt)}</Text><Text style={styles.text}>Audience · {readable(value.recipientSegment)}</Text><Text style={styles.text}>Minimum food spend · {money(value.minSubtotalMinor)}</Text>{["percent_off","happy_hour"].includes(value.offerType)?<Text style={styles.text}>Discount · {value.value/100}%</Text>:value.offerType==="fixed_off"?<Text style={styles.text}>Discount · {money(value.value)}</Text>:value.itemName?<Text style={styles.text}>Offer item · {value.itemName}</Text>:null}<View style={styles.row}><Text style={styles.muted}>{value.recipientCount} recipients</Text><Text style={styles.muted}>{value.openedCount} opened</Text><Text style={styles.muted}>{value.redeemedCount} redeemed</Text></View><Text style={styles.hint}>Reserved or redeemed value {money(value.committedBudgetMinor)} · This week {money(value.weeklyCommittedBudgetMinor)}</Text><Text style={styles.hint}>Redemption limit {value.redemptionLimit.toLocaleString()} · Total budget {value.budgetMinor==null?"No limit":money(value.budgetMinor)} · Weekly budget {value.weeklyBudgetMinor==null?"No limit":money(value.weeklyBudgetMinor)}</Text></Card>
 {draft&&baseline&&!ended?<><Title title="Edit campaign">The offer benefit and audience stay fixed. Create a new campaign to change them.</Title><Field label="Title" value={draft.title} maxLength={80} editable={!busy&&!conflict} onChangeText={title=>setDraft({...draft,title})}/><Field label="Customer message" value={draft.message} maxLength={500} multiline editable={!busy&&!conflict} onChangeText={message=>setDraft({...draft,message})}/>{scheduled&&!busy&&!conflict&&<CampaignDateTime label="Starts" value={draft.startsAt} onChange={startsAt=>setDraft({...draft,startsAt})}/>}<Text style={styles.hint}>An active campaign’s start time cannot be changed.</Text>{!busy&&!conflict&&<CampaignDateTime label="Ends" value={draft.expiresAt} onChange={expiresAt=>setDraft({...draft,expiresAt})}/>}<Field label="Redemption limit" value={draft.redemptionLimit} keyboardType="number-pad" editable={!busy&&!conflict} onChangeText={redemptionLimit=>setDraft({...draft,redemptionLimit})}/><Field label="Total budget (£)" hint="Leave blank for no limit." value={draft.budget} keyboardType="decimal-pad" editable={!busy&&!conflict} onChangeText={budget=>setDraft({...draft,budget})}/><Field label="Weekly budget (£)" hint="Resets Monday in London time. Leave blank for no limit." value={draft.weeklyBudget} keyboardType="decimal-pad" editable={!busy&&!conflict} onChangeText={weeklyBudget=>setDraft({...draft,weeklyBudget})}/><Text style={styles.hint}>Limits cannot be reduced below redemptions or savings already committed to orders. The server confirms the latest amounts when saving.</Text><Button busy={busy} disabled={conflict||Boolean(result.error)||!canManage} onPress={()=>void save()}>Save campaign changes</Button><Button quiet disabled={busy} onPress={()=>{setDraft(null);setBaseline(null);setConflict(false);}}>Cancel edit</Button></>:null}
 {!draft&&canManage&&!ended&&!ending&&<View style={styles.row}><Button quiet disabled={busy||Boolean(result.error)} onPress={edit}>Edit campaign</Button><Button quiet disabled={busy||Boolean(result.error)} onPress={()=>{setEnding(true);setError("");setNotice("");}}>End campaign</Button></View>}
 {ending&&canManage&&!ended&&<Card><Text style={styles.heading}>End this campaign now?</Text><Text style={styles.text}>Unused offers stop being available. Reservations and offers already saved on existing orders keep their financial snapshot.</Text><Button busy={busy} disabled={Boolean(result.error)} onPress={()=>void end()}>End campaign now</Button><Button quiet disabled={busy} onPress={()=>setEnding(false)}>Keep campaign running</Button></Card>}
 {ended&&<Text style={styles.hint}>Ended campaigns are view-only. Create another campaign to run a new offer.</Text>}
 </>}<Button quiet disabled={busy} onPress={()=>void reload()}>Reload latest campaign</Button></Page></Sheet>;
}
