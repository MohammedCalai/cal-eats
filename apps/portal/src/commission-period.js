const parts=value=>Object.fromEntries(new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/London",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).formatToParts(new Date(value)).filter(part=>part.type!=="literal").map(part=>[part.type,part.value]));
export function londonCommissionDay(value=new Date()){const p=parts(value);return `${p.year}-${p.month}-${p.day}`;}
export function londonCommissionTime(value=new Date()){const p=parts(value);return `${p.hour}:${p.minute}`;}
function londonInstant(day,time,label){
  const [year,month,date]=day.split("-").map(Number),[hour,minute]=time.split(":").map(Number),target=Date.UTC(year,month-1,date,hour,minute);
  // Probe both sides of a clock change, then require an exact local-time match.
  const offsets=new Set([-2,0,2].map(days=>{const instant=target+days*86400000,p=parts(instant);return Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second)-instant;}));
  const candidates=[...offsets].map(offset=>target-offset).filter(instant=>{const p=parts(instant);return `${p.year}-${p.month}-${p.day}`===day&&`${p.hour}:${p.minute}`===time&&p.second==="00";});
  if(!candidates.length)throw Error(`${label} time does not exist in Europe/London when the clocks change. Choose another time.`);
  if(candidates.length>1)throw Error(`${label} time occurs twice in Europe/London when the clocks change. Choose another time.`);
  return new Date(candidates[0]).toISOString();
}
export function commissionFreePeriod(startDay,weeks,startTime="00:00"){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(startDay)||!Number.isInteger(weeks)||weeks<1||weeks>52)throw Error("Choose a start date and 1–52 free weeks.");
  if(!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(startTime))throw Error("Choose a valid start time (HH:mm), in Europe/London.");
  const start=new Date(`${startDay}T00:00:00Z`);if(!Number.isFinite(+start)||start.toISOString().slice(0,10)!==startDay)throw Error("Choose a valid start date.");
  const endDay=new Date(+start+weeks*7*86400000).toISOString().slice(0,10);return {startsAt:londonInstant(startDay,startTime,"Start"),endsAt:londonInstant(endDay,startTime,"End")};
}
export function formatCommissionTime(value){return new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/London",dateStyle:"medium",timeStyle:"short"}).format(new Date(value));}
