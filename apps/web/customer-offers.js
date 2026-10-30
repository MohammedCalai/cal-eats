import { money } from "./model.js";

const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const parsedDate = value => { const date = new Date(value); return value !== null && value !== undefined && value !== "" && Number.isFinite(date.getTime()) ? date : null; };
const initials = value => String(value || "Restaurant").trim().split(/[\s-]+/).filter(Boolean).slice(0, 2).map(word => [...word][0]).join("").toUpperCase();
const dateText = date => date.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London", timeZoneName: "short" });

function offerValue(offer) {
  if(offer.campaignType==="buy_one_get_one")return "Buy 1, get 1 free";
  if(offer.campaignType==="buy_one_get_free_item")return offer.campaignRules?.buyItemName?`Buy ${offer.campaignRules.buyItemName}, get ${offer.itemName||"a free item"} free`:`Free ${offer.itemName||"item"} with a qualifying purchase`;
  if(offer.campaignType==="free_delivery")return "Free delivery";
  if(offer.campaignType==="happy_hour"&&Number.isSafeInteger(offer.value))return `${offer.value/100}% off · Happy hour`;
  if(offer.campaignType==="percent_items"&&Number.isSafeInteger(offer.value))return `${offer.value/100}% off selected items`;
  if (offer.offerType === "percent_off" && Number.isSafeInteger(offer.value) && offer.value > 0) return `${offer.value / 100}% off`;
  if (offer.offerType === "fixed_off" && Number.isSafeInteger(offer.value) && offer.value > 0) return `${money(offer.value)} off`;
  if ((!offer.offerType || offer.offerType === "free_item") && offer.itemName) return `Free ${offer.itemName}`;
  return "Restaurant offer";
}

function offerState(offer, now) {
  const start = parsedDate(offer.startsAt), end = parsedDate(offer.expiresAt);
  // The API remains authoritative for grant/redemption status. Dates also prevent
  // a stale list from offering an elapsed or not-yet-started promotion.
  if (offer.status === "redeemed") return { group: "past", label: "Used", start, end };
  if (offer.status === "reserved") return { group: "reserved", label: "In an order", start, end };
  if (offer.status === "expired" || (end && end.getTime() <= now)) return { group: "past", label: "Expired", start, end };
  if (offer.status !== "available" || !end) return { group: "past", label: "Unavailable", start, end };
  if (start && start.getTime() > now) return { group: "upcoming", label: "Coming soon", start, end };
  return { group: (offer.campaignRules?.audienceSegment??offer.recipientSegment) === "selected" ? "personal" : "restaurant", label: "Use offer", start, end, available: true };
}

function timeHtml(label, date) {
  return date ? `<span>${label} <time datetime="${date.toISOString()}">${escape(dateText(date))}</time></span>` : '<span>End date unavailable</span>';
}

function conditionsHtml(offer){const rules=offer.campaignRules||{},names=Array.isArray(rules.eligibleItemNames)?rules.eligibleItemNames.filter(x=>typeof x==="string"):[],notes=[];if(offer.campaignType==="buy_one_get_one")notes.push("Add two of the same eligible item. Extras remain charged.");if(["free_item_with_purchase","buy_one_get_free_item"].includes(offer.campaignType))notes.push("Requires a paid food purchase.");if(offer.campaignType==="free_delivery")notes.push("Delivery only. The restaurant’s delivery area and minimum still apply.");if(!notes.length&&!names.length)return "";return `<details class="customer-offer-conditions"><summary>Offer conditions</summary>${notes.map(note=>`<p>${escape(note)}</p>`).join("")}${names.length?`<p><strong>Eligible items:</strong> ${names.map(escape).join(", ")}</p>`:""}</details>`;}

function rowHtml({ offer, state }) {
  const name = offer.restaurantName || "Restaurant", minimum = Number.isSafeInteger(offer.minSubtotalMinor) && offer.minSubtotalMinor >= 0 ? offer.minSubtotalMinor : null;
  const minimumText = minimum === 0 ? "No minimum food spend" : minimum !== null ? `Min. ${money(minimum)} food spend` : "Check minimum food spend";
  const endLabel = state.end && state.end.getTime() <= state.now ? "Ended" : "Ends";
  return `<article class="customer-offer-item${state.available ? " is-available" : " is-unavailable"}${state.group === "personal" ? " is-personal" : ""}" data-offer-id="${escape(offer.id)}"><button type="button" class="customer-offer-dismiss" data-action="dismiss-offer" data-id="${escape(offer.id)}" aria-label="${escape(`Remove ${offer.title||"offer"} from your offers`)}" title="${state.group==="reserved"?"This offer is attached to an order and cannot be removed yet.":"Remove offer permanently"}"${state.group==="reserved"?" disabled":""}><span aria-hidden="true">×</span></button><button type="button" class="customer-offer-row"${state.available ? ` data-action="choose-offer" data-id="${escape(offer.id)}"` : " disabled"} aria-label="${escape(`${state.label}: ${offer.title || "Restaurant offer"} from ${name}`)}"><span class="customer-offer-avatar" aria-hidden="true">${escape(initials(name))}</span><span class="customer-offer-copy"><span class="customer-offer-restaurant">${escape(name)}</span><strong class="customer-offer-title">${escape(offer.title || "Restaurant offer")}</strong><span class="customer-offer-value">${escape(offerValue(offer))}<span> · ${escape(minimumText)}</span></span>${offer.message ? `<span class="customer-offer-note">${escape(offer.message)}</span>` : ""}<span class="customer-offer-dates">${state.group === "upcoming" ? timeHtml("Starts", state.start) : ""}${timeHtml(endLabel, state.end)}</span></span><span class="customer-offer-trailing"><span class="customer-offer-status">${escape(state.label)}</span>${state.available ? '<span class="customer-offer-chevron" aria-hidden="true">›</span>' : ""}</span></button>${state.group==="reserved"?'<p class="customer-offer-reserved-note">Attached to an order · available to remove after the order is resolved.</p>':""}${conditionsHtml(offer)}</article>`;
}

export function customerOffersHtml(offers, { now = Date.now(),showPast=false } = {}) {
  const currentTime = parsedDate(now)?.getTime() ?? Date.now();
  const unique = [...new Map((Array.isArray(offers) ? offers : []).filter(offer => offer && typeof offer.id === "string" && offer.id).map(offer => [offer.id, offer])).values()];
  const rows = unique.filter(offer=>!offer.dismissedAt).map(offer => ({ offer, state: { ...offerState(offer, currentTime), now: currentTime } })).filter(row=>showPast||row.state.group!=="past");
  const definitions = [
    ["personal", "Personalised for you", "Offers sent directly to you."],
    ["restaurant", "Restaurant offers", "Available with your next qualifying order."],
    ["upcoming", "Coming soon", "Your next offers, with their start and end times."],
    ["reserved", "In an order", "These offers are already attached to an order."],
    ["past", "Past offers", "Used and unavailable offers."]
  ];
  if (!rows.length) return `<div class="customer-offers-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M20 13l-7 7a2 2 0 0 1-3 0l-7-7V4h9l8 7a2 2 0 0 1 0 2Z"/><circle cx="7.5" cy="8" r="1.2"/></svg><strong>No offers to show</strong><p>Your restaurant offers will appear here when they are available.</p></div>`;
  return definitions.map(([group, title, description]) => {
    const entries = rows.filter(row => row.state.group === group).sort((a, b) => (group === "past" ? (b.state.end?.getTime() || 0) - (a.state.end?.getTime() || 0) : (a.state.end?.getTime() || Infinity) - (b.state.end?.getTime() || Infinity)) || a.offer.id.localeCompare(b.offer.id));
    return entries.length ? `<section class="customer-offer-group" aria-label="${title}"><header><div><h2>${title}</h2><p>${description}</p></div><span>${entries.length} offer${entries.length === 1 ? "" : "s"}</span></header><div class="customer-offer-rows">${entries.map(rowHtml).join("")}</div></section>` : "";
  }).join("");
}
