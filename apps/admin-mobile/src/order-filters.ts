export type OrderDatePreset="all"|"today"|"yesterday"|"this_week"|"last_week"|"last_30_days"|"custom";
export type OrderDateRange={from:string;to:string};
export const orderDatePresets:Array<[OrderDatePreset,string]>=[["all","All dates"],["today","Today"],["yesterday","Yesterday"],["this_week","This week"],["last_week","Last week"],["last_30_days","Last 30 days"],["custom","Custom dates"]];

export function londonCalendarDate(now:Date=new Date()):string{
  if(!Number.isFinite(now.getTime()))throw Error("The current date could not be read.");
  const parts=Object.fromEntries(new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/London",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(now).map(part=>[part.type,part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function validDate(value:string):boolean{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  const date=new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;
}
function shift(value:string,days:number):string{
  const date=new Date(`${value}T12:00:00Z`);date.setUTCDate(date.getUTCDate()+days);return date.toISOString().slice(0,10);
}
export function orderDateRange(preset:OrderDatePreset,now:Date=new Date(),custom:OrderDateRange={from:"",to:""}):OrderDateRange{
  if(preset==="all")return {from:"",to:""};
  if(preset==="custom"){
    if(!validDate(custom.from)||!validDate(custom.to))throw Error("Choose a valid From date and To date.");
    if(custom.from>custom.to)throw Error("The From date must be on or before the To date.");
    return {...custom};
  }
  const today=londonCalendarDate(now),weekday=new Date(`${today}T12:00:00Z`).getUTCDay(),monday=shift(today,-((weekday+6)%7));
  if(preset==="today")return {from:today,to:today};
  if(preset==="yesterday"){const yesterday=shift(today,-1);return {from:yesterday,to:yesterday};}
  if(preset==="this_week")return {from:monday,to:today};
  if(preset==="last_week")return {from:shift(monday,-7),to:shift(monday,-1)};
  return {from:shift(today,-29),to:today};
}
export function orderHistoryQuery({page,status,q,from,to}:{page:number;status:string;q:string;from:string;to:string}):string{
  const query=q.trim();
  if(query.length>100)throw Error("Keep your search to 100 characters or fewer.");
  if(!Number.isSafeInteger(page)||page<1||page>100000)throw Error("Choose a valid order page.");
  if(!["all","placed","accepted","preparing","ready","out_for_delivery","completed","rejected"].includes(status))throw Error("Choose a valid order status.");
  if(from||to)orderDateRange("custom",new Date(),{from,to});
  const params=new URLSearchParams({page:String(page),pageSize:"25",status});
  if(query)params.set("q",query);
  // Calendar dates stay untouched. The server applies inclusive UK dates and
  // converts each boundary separately, including 23/25-hour daylight changes.
  if(from)params.set("from",from);if(to)params.set("to",to);
  return params.toString();
}
