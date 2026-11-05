import { StyleSheet, View } from "react-native";
import { CustomerIcon } from "./CustomerBrandBanner";
import type { Offer } from "./types";
export function RestaurantMark() { return <CustomerIcon name="storefront" size={30} colour="#175C9B"/>; }
export function offerVisual(offer:Offer) {
  if(offer.campaignType==="free_delivery")return {icon:"offer_delivery" as const,label:"Delivery offer",tint:"#DDF5F5",ink:"#187480"};
  if(offer.campaignType==="buy_one_get_one")return {icon:"offer_bundle" as const,label:"Buy one, get one",tint:"#EEE9FF",ink:"#6351A7"};
  if(offer.campaignType==="happy_hour")return {icon:"offer_hour" as const,label:"Happy hour",tint:"#FFF1DC",ink:"#946125"};
  if(["free_item_with_purchase","buy_one_get_free_item"].includes(offer.campaignType||"")||offer.offerType==="free_item")return {icon:"offer_gift" as const,label:"Free item offer",tint:"#FCE9EF",ink:"#9B4769"};
  if(offer.offerType==="fixed_off")return {icon:"offer_money" as const,label:"Money off your order",tint:"#E6F5ED",ink:"#287452"};
  if(offer.offerType==="percent_off")return {icon:"offer_percent" as const,label:offer.campaignType==="percent_items"?"Selected item savings":"Order discount",tint:"#E7F2FF",ink:"#2064B4"};
  return {icon:"offer_general" as const,label:"Restaurant offer",tint:"#E7F2FF",ink:"#2064B4"};
}
export function OfferMark({offer}:{offer:Offer}) { const visual=offerVisual(offer); return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[s.offer,{backgroundColor:visual.tint}]}><CustomerIcon name={visual.icon} size={30} colour={visual.ink}/></View>; }
const s=StyleSheet.create({offer:{width:52,height:60,borderRadius:15,alignItems:"center",justifyContent:"center"}});
