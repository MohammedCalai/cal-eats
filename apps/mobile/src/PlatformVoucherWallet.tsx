import {useEffect,useState,useRef} from "react";
import {StyleSheet,Text,View} from "react-native";
import {api} from "./api";
import {Card,ErrorBanner} from "./components";
import {money} from "./model";
import {colours} from "./theme";
import {useForegroundRefresh} from "./useForegroundRefresh";
type Voucher={id:string;title:string;message:string;remainingMinor:number;expiresAt:string;status:string};
export function PlatformVoucherWallet({token}:{token:string}){
  const currentToken=useRef(token);currentToken.current=token;
  const [vouchers,setVouchers]=useState<Voucher[]>([]),[error,setError]=useState("");
  useEffect(()=>{let active=true;setVouchers([]);api<Voucher[]>("/api/account/vouchers",{token}).then(rows=>{if(active){setVouchers(rows);setError("");}}).catch(()=>{if(active)setError("Your Cal-Eats vouchers could not be loaded. Pull to refresh or reopen Offers.");});return()=>{active=false;};},[token]);
  useForegroundRefresh(async()=>{const requested=token;try{const rows=await api<Voucher[]>("/api/account/vouchers",{token});if(currentToken.current===requested){setVouchers(rows);setError("");}}catch{if(currentToken.current===requested)setError("Your voucher balance could not be refreshed.");}});
  const active=vouchers.filter(v=>v.status==="available"&&v.remainingMinor>0&&Date.parse(v.expiresAt)>Date.now());
  return <View style={styles.wallet}><ErrorBanner message={error}/>{active.length?<><Text style={styles.heading}>Your Cal-Eats vouchers</Text><Text style={styles.meta}>Credit applies automatically at checkout. Cal-Eats credits the restaurant.</Text>{active.map(v=><Card key={v.id} tone="info"><View style={styles.row}><View style={styles.copy}><Text style={styles.title}>{v.title}</Text>{v.message?<Text style={styles.meta}>{v.message}</Text>:null}</View><Text style={styles.amount}>{money(v.remainingMinor)}</Text></View><Text style={styles.meta}>Ends {new Date(v.expiresAt).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric",timeZone:"Europe/London"})}</Text><Text style={styles.fine}>Use with digital payment. Fully covered orders need no payment; partial cash use is unavailable.</Text></Card>)}</>:null}</View>;
}
const styles=StyleSheet.create({wallet:{gap:10},heading:{fontSize:19,fontWeight:"800",color:colours.ink},row:{flexDirection:"row",justifyContent:"space-between",gap:14},copy:{flex:1,gap:6},title:{fontWeight:"800",fontSize:16,color:colours.ink,lineHeight:23},meta:{color:colours.muted,fontSize:13,lineHeight:20},amount:{fontSize:24,fontWeight:"800",color:colours.blueDark},fine:{color:colours.muted,fontSize:11,lineHeight:18}});
