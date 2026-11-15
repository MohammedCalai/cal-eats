import {minorUnits} from "./model.ts";
export type EditableCampaign={title:string;message:string;startsAt:string|null;expiresAt:string;redemptionLimit:number;budgetMinor:number|null;weeklyBudgetMinor:number|null};
export type CampaignEditDraft={title:string;message:string;startsAt:string;expiresAt:string;redemptionLimit:string;budget:string;weeklyBudget:string};
export function campaignEditDraft(value:EditableCampaign):CampaignEditDraft{return {title:value.title,message:value.message,startsAt:value.startsAt||"",expiresAt:value.expiresAt,redemptionLimit:String(value.redemptionLimit),budget:value.budgetMinor==null?"":(value.budgetMinor/100).toFixed(2),weeklyBudget:value.weeklyBudgetMinor==null?"":(value.weeklyBudgetMinor/100).toFixed(2)};}
export function campaignEditFingerprint(value:EditableCampaign){return JSON.stringify([value.title,value.message,value.startsAt,value.expiresAt,value.redemptionLimit,value.budgetMinor??null,value.weeklyBudgetMinor??null]);}
export function campaignEditPayload(draft:CampaignEditDraft,original:EditableCampaign,now=Date.now()){
 if(Date.parse(original.expiresAt)<=now)throw new Error("This campaign has ended and is view-only. Create a new campaign for another offer.");
 const title=draft.title.trim(),message=draft.message.trim(),start=!original.startsAt&&!draft.startsAt?null:Date.parse(draft.startsAt),end=Date.parse(draft.expiresAt),limit=Number(draft.redemptionLimit);
 if(!title||title.length>80||!message||message.length>500)throw new Error("Use a title of 1–80 characters and a customer message of 1–500 characters.");
 if((start!==null&&!Number.isFinite(start))||!Number.isFinite(end)||end<=now||(start!==null&&(end<=start||end-start>366*86400000)))throw new Error("Choose an end date after the start and current time, within one year of the start.");
 if(!Number.isInteger(limit)||limit<1||limit>100000)throw new Error("Choose between 1 and 100,000 redemptions.");
 const budget=draft.budget.trim()?minorUnits(draft.budget,"Total budget",100_000_000):null,weeklyBudget=draft.weeklyBudget.trim()?minorUnits(draft.weeklyBudget,"Weekly budget",100_000_000):null;
 if(budget===0||weeklyBudget===0)throw new Error("A budget must be above £0, or leave it blank for no limit.");
 const body:Partial<EditableCampaign>={};
 if(title!==original.title)body.title=title;if(message!==original.message)body.message=message;
 if(draft.startsAt!==(original.startsAt||"")){if(original.startsAt&&Date.parse(original.startsAt)<=now)throw new Error("The start time of an active campaign cannot be changed.");if(start===null)throw new Error("Choose a valid campaign start time.");body.startsAt=new Date(start).toISOString();}
 if(draft.expiresAt!==original.expiresAt)body.expiresAt=new Date(end).toISOString();if(limit!==original.redemptionLimit)body.redemptionLimit=limit;
 if(budget!==(original.budgetMinor??null))body.budgetMinor=budget;if(weeklyBudget!==(original.weeklyBudgetMinor??null))body.weeklyBudgetMinor=weeklyBudget;
 return body;
}
