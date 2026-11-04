import { useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { api } from "./api";
import { Button, Card, ErrorBanner } from "./components";
import { colours } from "./theme";
import type { Order } from "./types";

type Rating = { stars: number; createdAt: string };
export function ShopRating({ token, order, onRated }: { token: string; order: Order; onRated: (rating: Rating) => void }) {
  const [saved, setSaved] = useState<Rating | null>(order.shopRating ?? null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const sending=useRef(false),attempt=useRef<number|null>(null);
  if(!order.canRateShop&&!saved)return null;
  async function rate(stars:number){
    if(sending.current||saved)return;sending.current=true;attempt.current??=stars;setBusy(true);setError("");
    try{
      const result=await api<{shopRating:Rating}>(`/api/orders/${encodeURIComponent(order.id)}/shop-rating`,{method:"POST",token,body:JSON.stringify({stars:attempt.current})});
      setSaved(result.shopRating);onRated(result.shopRating);
    }catch(caught){
      // A response can be lost after saving. Refresh before offering the same rating again.
      const latest=await api<Order>(`/api/orders/${encodeURIComponent(order.id)}`,{token}).catch(()=>null);
      if(latest?.shopRating){setSaved(latest.shopRating);onRated(latest.shopRating);}else setError((caught as Error).message);
    }finally{sending.current=false;setBusy(false);}
  }
  return <Card><Text style={styles.eyebrow}>HOW WAS YOUR ORDER?</Text><Text accessibilityRole="header" style={styles.title}>{saved?"Thanks for rating the shop":"Rate your restaurant"}</Text><Text style={styles.copy}>{saved?`You gave ${order.restaurantName} ${saved.stars} out of 5 stars.`:`Tap a star to rate ${order.restaurantName}. Just stars, no comments.`}</Text><View accessibilityRole="radiogroup" accessibilityLabel="Shop rating" style={styles.stars}>{[1,2,3,4,5].map(stars=><Pressable key={stars} accessibilityRole="radio" accessibilityLabel={`${stars} out of 5 stars`} accessibilityState={{checked:saved?.stars===stars,disabled:busy||Boolean(saved)}} disabled={busy||Boolean(saved)||Boolean(error)} onPress={()=>void rate(stars)} style={styles.starButton}><Text style={[styles.star,saved&&stars<=saved.stars&&styles.starFilled]}>{saved&&stars<=saved.stars?"★":"☆"}</Text></Pressable>)}</View>{busy?<ActivityIndicator color={colours.blue} accessibilityLabel="Saving your rating"/>:null}<ErrorBanner message={error}/>{error&&attempt.current?<Button tone="secondary" onPress={()=>void rate(attempt.current!)}>Retry {attempt.current}-star rating</Button>:null}</Card>;
}
const styles=StyleSheet.create({eyebrow:{color:colours.blueDark,fontSize:11,lineHeight:17,letterSpacing:.7,fontWeight:"800"},title:{color:colours.ink,fontSize:21,lineHeight:28,fontWeight:"800"},copy:{color:colours.muted,fontSize:14,lineHeight:22},stars:{flexDirection:"row",gap:4,alignItems:"center"},starButton:{minWidth:44,minHeight:50,alignItems:"center",justifyContent:"center"},star:{fontSize:39,lineHeight:48,color:colours.blue},starFilled:{color:"#D99514"}});
