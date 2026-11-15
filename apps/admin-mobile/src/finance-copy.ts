export function businessFinanceCopy(value:string|null|undefined){
 return String(value||"").replace(/transferred to (?:connected )?Stripe\s*balance/gi,"Awaiting weekly payout").replace(/\bStripe(?:’s|'s)?\s*balance\b/gi,"earnings awaiting payout").replace(/\bStripe(?:’s|'s)?\b/gi,"the payment service");
}
export type PayoutSchedule={interval?:string|null;weeklyAnchor?:string|null;weeklyPayoutDays?:string[]|null;monthlyPayoutDays?:number[]|null};
const weekdays=new Set(["monday","tuesday","wednesday","thursday","friday","saturday","sunday"]);
const title=(value:string)=>value[0]!.toUpperCase()+value.slice(1);
export function bankPayoutScheduleCopy(schedule:PayoutSchedule|null|undefined,status?:string|null){
 if(status!=="verified")return "Schedule not confirmed";
 if(schedule?.interval==="weekly"){
  const reported=schedule.weeklyPayoutDays;
  let days:string[]=[];
  if(Array.isArray(reported)&&reported.length){if(reported.length<=7&&reported.every(day=>typeof day==="string"&&weekdays.has(day)))days=[...new Set(reported)];}
  else if((reported==null||Array.isArray(reported)&&!reported.length)&&typeof schedule.weeklyAnchor==="string"&&weekdays.has(schedule.weeklyAnchor))days=[schedule.weeklyAnchor];
  if(!days.length)return "Weekly · day not confirmed";
  const names=days.map(title),last=names.pop()!;
  return `Weekly on ${names.length?`${names.join(", ")} and `:""}${last}`;
 }
 return ({daily:"Daily",monthly:"Monthly",manual:"Manual payouts"})[schedule?.interval||""]||"Schedule not confirmed";
}
export function businessSettlementLabel(value:{state:string;label?:string|null}){
 return ({not_confirmed:"No earnings confirmed",no_net_earnings:"No net earnings remaining",cash_direct:"Cash received by your restaurant",cash_due:"Cash due to your restaurant",simulated:"Preview earnings · no bank payout",needs_review:"Earnings need review",transferred_to_balance:"Awaiting weekly payout",held:"Earnings on hold",processing:"Preparing your earnings",pending_transfer:"Awaiting earnings allocation",awaiting_completion:"Awaiting order completion"})[value.state]||businessFinanceCopy(value.label)||"Awaiting earnings update";
}
