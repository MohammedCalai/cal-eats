import { promotionBadge } from "./loyalty-ui.js";
const escape = value => String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const money = value => new Intl.NumberFormat("en-GB",{style:"currency",currency:"GBP"}).format(value/100);

export async function mountMarketingPreferences(root,{api}={}) {
  try {
    let value=await api("/api/account/marketing-preferences");if(!root.isConnected)return;
    root.innerHTML=`<form class="card stack"><h2>Promotion preferences</h2><p>Choose optional restaurant promotions. Order updates are separate. You can withdraw either choice at any time.</p><label class="radio-card"><input type="checkbox" name="inAppPromotions" ${value.inAppPromotions?"checked":""}> Restaurant offers in the app</label><label class="radio-card"><input type="checkbox" name="pushPromotions" ${value.pushPromotions?"checked":""}> Promotional push notifications</label><small>Push delivery also requires device permission and a connected push service.</small><button class="primary">Save promotion preferences</button><p role="status"></p></form>`;
    const form=root.querySelector("form");form.onsubmit=async event=>{event.preventDefault();const button=form.querySelector("button"),status=form.querySelector("[role=status]");button.disabled=true;try{const data=new FormData(form);value=await api("/api/account/marketing-preferences",{method:"PATCH",body:JSON.stringify({inAppPromotions:data.has("inAppPromotions"),pushPromotions:data.has("pushPromotions"),source:"browser-account"})});status.textContent="Preferences saved.";window.dispatchEvent(new Event("cal-eats-notifications-read"));}catch(error){status.textContent=error.message;}finally{button.disabled=false;}};
  } catch(error){if(root.isConnected)root.textContent=`Promotion preferences unavailable: ${error.message}`;}
}

export async function mountFirstOrderPromotions(root,{api,restaurantId,onClaim}) {
  try {const campaigns=await api(`/api/promotions?restaurantId=${encodeURIComponent(restaurantId)}`);if(!root.isConnected||!campaigns.length)return;
    root.innerHTML=`<section class="card"><h2>First-order offers</h2>${campaigns.map(c=>`<article><h3>${escape(c.title)}</h3><p>${escape(c.message)}</p><p>${escape(promotionBadge(c))} · £${(c.minSubtotalMinor/100).toFixed(2)} minimum</p><button class="secondary" data-claim="${escape(c.id)}">Add to my offers</button><p role="status"></p></article>`).join("")}</section>`;
    root.querySelectorAll("[data-claim]").forEach(button=>{button.onclick=async()=>{button.disabled=true;try{const grant=await api(`/api/promotions/${encodeURIComponent(button.dataset.claim)}/claim`,{method:"POST",body:"{}"});onClaim({...campaigns.find(c=>c.id===button.dataset.claim),...grant,restaurantId,status:"available"});}catch(error){button.parentElement.querySelector("[role=status]").textContent=error.message;button.disabled=false;}};});
  }catch{/* Discovery remains usable when no promotion is available. */}
}

export function quoteAddressComplete(request) {
  if(request.fulfillment === "collection")return true;
  const address=request.deliveryAddress;
  return Boolean(address && String(address.line1||"").trim() && String(address.line1).trim().length<=120 && (!address.line2||String(address.line2).trim().length<=120) && String(address.city||"").trim() && String(address.city).trim().length<=100 && /^([A-Z]{1,2}\d[A-Z\d]?)(\d[A-Z]{2})$/.test(String(address.postcode||"").toUpperCase().replace(/\s+/g,"")));
}
export function checkoutQuoteSignature(value) {
  return JSON.stringify([value.grossFoodMinor,value.restaurantDiscountMinor,value.subtotalMinor,value.deliveryFeeMinor,value.deliveryDiscountMinor,value.totalMinor,value.commissionMinor,value.commission??null,value.offerId??value.promotion?.grantId??null,value.promotion??null]);
}
function checkedAutomaticQuote(value) {
  if(!value||![value.grossFoodMinor,value.restaurantDiscountMinor,value.subtotalMinor,value.deliveryFeeMinor,value.deliveryDiscountMinor,value.totalMinor].every(amount=>Number.isSafeInteger(amount)&&amount>=0)||value.totalMinor!==value.subtotalMinor+value.deliveryFeeMinor||value.subtotalMinor!==value.grossFoodMinor-value.restaurantDiscountMinor||!value.autoOfferSelection||(value.offerId!==null&&(typeof value.offerId!=="string"||!value.offerId))||(value.offerId===null?value.promotion!==null:value.promotion?.grantId!==value.offerId))throw new TypeError("Your price and offer could not be verified.");
  return value;
}
export function mountCheckoutQuote(form,{api,body,mode="checkout"}) {
  const basket=mode==="basket",panel=document.createElement("section");panel.className="notice server-quote";panel.setAttribute("aria-live","polite");
  const button=form.querySelector(basket?'[data-action="begin-checkout"]':"#place-order"),totals=form.querySelector(basket?".basket-prices":".totals"),heading=basket?button?.querySelector("strong"):form.closest("section")?.querySelector(".section-head > strong"),offerPanel=form.querySelector(".basket-applied-offer"),initialTotals=totals?.innerHTML,initialHeading=heading?.textContent,initialLabel=button?.textContent||"Place order";
  if(basket)totals?.before(panel);else button?.before(panel);
  let sequence=0,timer,retryTimer,last=null,stopped=false,pending=false,activeRequest=null,retries=0;
  const delays=[1500,4000,10000];
  function resetView(){if(totals)totals.innerHTML=initialTotals;if(heading)heading.textContent=initialHeading;if(offerPanel)offerPanel.innerHTML="";if(button&&!basket){button.disabled=true;button.textContent=initialLabel;}}
  function draw(value){
    const rows=`${basket?"<h2>Order summary</h2>":""}<${basket?"p":"div"}><span>Food before offers</span><${basket?"strong":"span"}>${money(value.grossFoodMinor)}</${basket?"strong":"span"}></${basket?"p":"div"}>${value.restaurantDiscountMinor?`<${basket?"p":"div"}><span>Restaurant promotion</span><${basket?"strong":"span"}>−${money(value.restaurantDiscountMinor)}</${basket?"strong":"span"}></${basket?"p":"div"}>`:""}<${basket?"p":"div"}><span>Delivery${value.deliveryDiscountMinor?" · offer applied":""}</span><${basket?"strong":"span"}>${money(value.deliveryFeeMinor)}</${basket?"strong":"span"}></${basket?"p":"div"}><${basket?"p":"div"} class="${basket?"basket-estimate":"grand"}"><span>${basket?"Verified total":"Order total"}</span><${basket?"strong":"span"}>${money(value.totalMinor)}</${basket?"strong":"span"}></${basket?"p":"div"}>`;
    if(totals)totals.innerHTML=rows;
    if(heading)heading.textContent=money(value.totalMinor);
    const promotion=value.promotion,benefit=promotion?`<div class="quote-applied-offer"><strong>Eligible offer applied automatically</strong><p>${escape(promotion.title)}</p>${promotion.gift?`<p class="quote-free-item"><span>${escape(promotion.gift.quantity)} × ${escape(promotion.gift.name)} <small>Free item</small></span><strong>${money(0)}</strong></p>`:""}${promotion.campaignType==="buy_one_get_one"?'<small>Buy one, get one savings are included. Extras remain charged.</small>':""}</div>`:"";
    panel.innerHTML=basket?`<strong>Price checked</strong><p>${promotion?"Your eligible offer is included below.":"Eligible offers apply automatically when their conditions are met."}</p>`:`<strong>Your total: ${money(value.totalMinor)}</strong><p>Prices and eligible offers checked for this order.</p>${benefit}`;
    if(offerPanel)offerPanel.innerHTML=benefit;
    if(button&&!basket)button.textContent=`Place order · ${money(value.totalMinor)}`;
  }
  async function refresh(){
    if(stopped||!form.isConnected)return null;
    clearTimeout(timer);clearTimeout(retryTimer);
    const own=++sequence;activeRequest?.abort();last=null;resetView();
    const request=body();
    if(!quoteAddressComplete(request)){pending=false;panel.textContent=basket?"Eligible offers apply automatically. Enter a complete delivery address at checkout to confirm your total.":"Enter your full delivery address and postcode. Your total and eligible offers update automatically.";return null;}
    const fingerprint=JSON.stringify({...request,autoApplyOffers:true}),controller=new AbortController();activeRequest=controller;const timeout=setTimeout(()=>controller.abort(),15000);pending=true;
    panel.textContent="Updating your price and checking eligible offers…";
    try{
      const value=checkedAutomaticQuote(await api("/api/orders/quote",{method:"POST",body:fingerprint,signal:controller.signal}));
      if(stopped||own!==sequence||!form.isConnected)return null;
      last={fingerprint,value};retries=0;draw(value);if(button&&!basket)button.disabled=false;return last;
    }catch(error){
      if(!stopped&&own===sequence){
        last=null;const transient=controller.signal.aborted||error instanceof TypeError||error.status===0||[408,429].includes(error.status)||error.status>=500;
        panel.textContent=transient?"Your price is not confirmed yet. We’ll check again automatically when the connection is available.":`Your total could not be confirmed. ${error.message}`;
        if(transient&&retries<delays.length)retryTimer=setTimeout(()=>void refresh(),delays[retries++]);
      }
      return null;
    }finally{clearTimeout(timeout);if(activeRequest===controller)activeRequest=null;if(own===sequence)pending=false;}
  }
  function changed(event){
    if(event?.target&&!['line1','line2','city','postcode'].includes(event.target.name)&&event.target.id!=="saved-address")return;
    clearTimeout(timer);clearTimeout(retryTimer);sequence++;activeRequest?.abort();pending=false;last=null;retries=0;resetView();
    panel.textContent="Your total updates automatically when your delivery address is complete.";
    timer=setTimeout(()=>void refresh(),350);
  }
  function foreground(){if(!document.hidden&&!pending&&!stopped){retries=0;void refresh();}}
  form.addEventListener("input",changed);form.addEventListener("change",changed);window.addEventListener("online",foreground);window.addEventListener("focus",foreground);document.addEventListener("visibilitychange",foreground);void refresh();
  return {get totalMinor(){return last?.value.totalMinor??null;},get offerId(){return last?.value.offerId??last?.value.promotion?.grantId??null;},refresh,async confirm(){if(pending||!last)return false;const before=last;const checked=await refresh();if(!checked)return false;if(before.fingerprint!==checked.fingerprint||checkoutQuoteSignature(before.value)!==checkoutQuoteSignature(checked.value)){panel.insertAdjacentHTML("beforeend","<p>Your price or offer changed. Review the updated order, then place your order.</p>");return false;}return true;},close(){stopped=true;sequence++;clearTimeout(timer);clearTimeout(retryTimer);activeRequest?.abort();form.removeEventListener("input",changed);form.removeEventListener("change",changed);window.removeEventListener("online",foreground);window.removeEventListener("focus",foreground);document.removeEventListener("visibilitychange",foreground);}};
}
