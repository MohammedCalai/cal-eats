const days=new Set(["monday","tuesday","wednesday","thursday","friday","saturday","sunday"]);
const title=value=>value[0].toUpperCase()+value.slice(1);
const list=values=>values.length===1?values[0]:`${values.slice(0,-1).join(", ")} and ${values.at(-1)}`;
export function describePayoutSchedule(schedule){
  if(!schedule)return null;
  if(schedule.interval==="manual")return "Manual bank payouts";
  if(schedule.interval==="daily")return "Daily";
  if(schedule.interval==="weekly"){
    const weekly=Array.isArray(schedule.weeklyPayoutDays)&&schedule.weeklyPayoutDays.length?schedule.weeklyPayoutDays:schedule.weeklyAnchor?[schedule.weeklyAnchor]:[];
    if(!weekly.length||weekly.some(day=>!days.has(day)))return null;
    return `Weekly on ${list(weekly.map(title))}`;
  }
  if(schedule.interval==="monthly"){
    const monthly=schedule.monthlyPayoutDays;
    if(!Array.isArray(monthly)||!monthly.length||monthly.some(day=>!Number.isInteger(day)||day<1||day>31))return null;
    return `Monthly on ${monthly.length===1?"day":"days"} ${list(monthly.map(String))}`;
  }
  return null;
}
export function payoutScheduleState(value){
  const plan=describePayoutSchedule(value?.plannedPayoutSchedule)||"Weekly on Monday";
  const description=describePayoutSchedule(value?.payoutSchedule),verified=value?.payoutScheduleStatus==="verified"&&Boolean(description)&&Number.isFinite(Date.parse(value?.payoutScheduleVerifiedAt));
  return {plan,verified,actual:verified?description:null,verifiedAt:verified?value.payoutScheduleVerifiedAt:null,mismatch:verified&&description!==plan,message:verified?null:typeof value?.payoutScheduleMessage==="string"?value.payoutScheduleMessage:"The current provider schedule has not been verified. Refresh after bank setup to check it."};
}
