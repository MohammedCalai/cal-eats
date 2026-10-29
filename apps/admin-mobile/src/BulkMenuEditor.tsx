import {useRef,useState} from "react";
import {Text,View} from "react-native";
import {menuBatchItems} from "../../../packages/contracts/src/menu-tools.js";
import {api,json} from "./api";
import {operationKey} from "./model";
import {Button,Card,ErrorText,Field,Notice,Page,Sheet,styles} from "./ui";
const blank=()=>({id:operationKey(),name:"",price:"",category:"",description:""});
export function BulkMenuEditor({token,root,onClose,onSaved}:{token:string;root:string;onClose:()=>void;onSaved:()=>void}){
  const [rows,setRows]=useState(()=>[blank(),blank()]),[busy,setBusy]=useState(false),[error,setError]=useState("");const attempt=useRef<{key:string;items:ReturnType<typeof menuBatchItems>}|null>(null);
  const update=(id:string,key:"name"|"price"|"category",value:string)=>setRows(old=>old.map(row=>row.id===id?{...row,[key]:value}:row));
  async function save(){if(busy)return;setError("");try{const items=menuBatchItems(rows);attempt.current??={key:operationKey(),items};setBusy(true);await api(`${root}/import`,json(token,"POST",{items:attempt.current.items},attempt.current.key));onSaved();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  return <Sheet title="Add several menu items" onClose={onClose}><Page><Text style={styles.muted}>Create up to 50 items together. Add photos and meal choices after saving.</Text>{rows.map((row,index)=><Card key={row.id}><Text style={styles.heading}>Item {index+1}</Text><Field label="Name" value={row.name} editable={!busy&&!attempt.current} maxLength={120} onChangeText={value=>update(row.id,"name",value)}/><Field label="Price (£)" value={row.price} editable={!busy&&!attempt.current} keyboardType="decimal-pad" onChangeText={value=>update(row.id,"price",value)}/><Field label="Category" value={row.category} editable={!busy&&!attempt.current} maxLength={80} onChangeText={value=>update(row.id,"category",value)}/>{rows.length>1&&<Button quiet disabled={busy||!!attempt.current} onPress={()=>setRows(old=>old.filter(item=>item.id!==row.id))}>Remove item</Button>}</Card>)}<Button quiet disabled={rows.length>=50||busy||!!attempt.current} onPress={()=>setRows(old=>[...old,blank()])}>＋ Add another item</Button>{attempt.current&&error&&<Notice>Retry keeps the same items to prevent duplicate imports. Close and check the menu before starting another batch.</Notice>}<ErrorText message={error}/></Page><View style={{padding:16}}><Button busy={busy} onPress={()=>void save()}>{attempt.current?"Retry original batch":`Save ${rows.length} items`}</Button></View></Sheet>;
}
