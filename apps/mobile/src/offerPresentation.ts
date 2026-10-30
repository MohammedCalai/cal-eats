import { money } from "./model";
import type { Fulfillment, Offer } from "./types";

export function offerBenefit(offer:Offer):string {
  switch(offer.campaignType){
    case "buy_one_get_one":return "Buy 1, get 1 free";
    case "buy_one_get_free_item":return `Free ${offer.itemName||"item"} with ${offer.campaignRules?.buyItemName||"a qualifying purchase"}`;
    case "free_delivery":return "Free delivery";
    case "happy_hour":return `${(offer.value||0)/100}% off · Happy hour`;
    case "percent_items":return `${(offer.value||0)/100}% off selected items`;
    case "percent_order":return `${(offer.value||0)/100}% off food`;
    case "amount_order":return `${money(offer.value||0)} off food`;
    case "free_item_with_purchase":return `Free ${offer.itemName||"item"} with purchase`;
    default:return offer.offerType==="percent_off"?`${(offer.value||0)/100}% off`:offer.offerType==="fixed_off"?`${money(offer.value||0)} off`:`Free ${offer.itemName||"item"}`;
  }
}
export function offerEndDate(offer:Offer):string {
  return Number.isFinite(Date.parse(offer.expiresAt))?`${new Date(offer.expiresAt).toLocaleString("en-GB",{weekday:"short",day:"numeric",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit",timeZone:"Europe/London"})} · UK time`:"End date unavailable";
}
export function offerMatchesFulfillment(offer:Offer,fulfillment:Fulfillment):boolean {return offer.campaignType!=="free_delivery"||fulfillment==="delivery";}
export function isPersonalOffer(offer:Offer):boolean {return (offer.campaignRules?.audienceSegment??offer.recipientSegment)==="selected";}
export function offerConditions(offer:Offer):string {
  if(offer.campaignType==="buy_one_get_one")return "Add two of the same eligible item. One base item in each pair is free; extras stay paid.";
  if(offer.campaignType==="buy_one_get_free_item")return `Add ${offer.campaignRules?.buyItemName||"the qualifying purchase item"} to receive one free gift. Eligibility is checked at checkout.`;
  if(offer.campaignType==="free_delivery")return "Delivery orders only. Your restaurant funds the delivery fee.";
  if(offer.campaignType==="happy_hour")return "Valid during the exact start and end window shown. This is not a repeating daily offer.";
  if(offer.campaignType==="percent_items")return "Applies only to selected menu items. Eligible savings are checked at checkout.";
  return "Final eligibility and savings are checked at checkout.";
}
