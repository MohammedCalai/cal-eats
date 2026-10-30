import { StyleSheet, Text, View } from "react-native";
import type { Offer } from "./types";

export function RestaurantMark() {
  return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={s.store}><View style={s.roof}/><View style={s.awning}>{[0,1,2,3].map(i=><View key={i} style={[s.stripe,i%2===0&&s.stripeLight]}/>)}</View><View style={s.building}><View style={s.window}/><View style={s.door}/></View></View>;
}

export function offerVisual(offer:Offer) {
  if(offer.campaignType==="buy_one_get_one") return {symbol:"2×",label:"Two for one",tint:"#E4EEFF",ink:"#225EB1"};
  if(offer.campaignType==="free_delivery") return {symbol:"↗",label:"Delivery on us",tint:"#E1F5F4",ink:"#176D72"};
  if(offer.campaignType==="happy_hour") return {symbol:"◷",label:"Happy hour",tint:"#FFF2DB",ink:"#865719"};
  if(offer.offerType==="percent_off") return {symbol:"%",label:offer.campaignType==="percent_items"?"Selected items":"Food savings",tint:"#EEE9FF",ink:"#6950A5"};
  if(offer.offerType==="fixed_off") return {symbol:"£",label:"Money off",tint:"#E4F3EA",ink:"#2C7051"};
  return {symbol:"+",label:"A little extra",tint:"#FCEAF0",ink:"#A4486D"};
}

export function OfferMark({offer}:{offer:Offer}) {
  const visual=offerVisual(offer);
  const gift=visual.label==="A little extra",delivery=offer.campaignType==="free_delivery";
  return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[s.offer,{backgroundColor:visual.tint}]}>{gift?<View style={{width:27,height:25,borderWidth:2,borderColor:visual.ink,borderRadius:4,marginTop:5}}><View style={{position:"absolute",top:6,left:-3,right:-3,height:2,backgroundColor:visual.ink}}/><View style={{position:"absolute",top:-7,bottom:-1,left:10,width:3,backgroundColor:visual.ink}}/><View style={{position:"absolute",top:-8,left:3,width:17,height:8,borderWidth:2,borderColor:visual.ink,borderRadius:8}}/></View>:delivery?<View style={{width:30,height:22}}><View style={{position:"absolute",left:0,top:0,width:20,height:16,borderWidth:2,borderColor:visual.ink,borderRadius:3}}/><View style={{position:"absolute",right:0,top:5,width:11,height:11,borderWidth:2,borderColor:visual.ink,borderTopRightRadius:6}}/>{[4,23].map(left=><View key={left} style={{position:"absolute",left,bottom:0,width:7,height:7,borderRadius:4,backgroundColor:visual.ink}}/>)}</View>:<Text style={[s.symbol,{color:visual.ink}]}>{visual.symbol}</Text>}</View>;
}

const s=StyleSheet.create({store:{width:30,height:29,alignItems:"center",justifyContent:"flex-end"},roof:{position:"absolute",top:1,width:27,height:7,backgroundColor:"#438ED5",borderTopLeftRadius:5,borderTopRightRadius:5},awning:{position:"absolute",top:7,left:0,right:0,height:8,flexDirection:"row",zIndex:1,overflow:"hidden",borderBottomLeftRadius:4,borderBottomRightRadius:4},stripe:{flex:1,backgroundColor:"#2D73B9",borderBottomLeftRadius:3,borderBottomRightRadius:3},stripeLight:{backgroundColor:"#A9D8FA"},building:{width:25,height:18,borderWidth:1.5,borderColor:"#4381B7",borderBottomLeftRadius:3,borderBottomRightRadius:3,backgroundColor:"#F3FAFF",flexDirection:"row",alignItems:"flex-end",justifyContent:"space-evenly"},window:{width:8,height:7,borderRadius:1,backgroundColor:"#A9D8FA",marginBottom:4},door:{width:6,height:12,borderTopLeftRadius:2,borderTopRightRadius:2,backgroundColor:"#6EA8D9"},offer:{width:52,height:60,borderRadius:15,alignItems:"center",justifyContent:"center"},symbol:{fontSize:26,fontWeight:"800",lineHeight:34}});
