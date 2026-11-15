// Created exclusively by the server's exact route policy, never a request field.
const scope=Symbol("restaurant membership capability scope");
export function scopedCapabilitySession(session,restaurantId,capability,column){return {...session,[scope]:{restaurantId,capability,column}};}
export function hasCapabilityScope(session,restaurantId,membership){return session?.user?.role==="restaurant"&&session[scope]?.restaurantId===restaurantId&&membership?.[session[scope].column]===1;}
