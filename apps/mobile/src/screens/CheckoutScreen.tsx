import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, AppState, BackHandler, Linking, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { ApiError, api } from "../api";
import { Button, Card, ErrorBanner, Field, Pill, SectionTitle } from "../components";
import { canCheckout, cartTotals, entryUnitMinor, money, orderItems, requestKey } from "../model";
import { checkoutPayment, configurePaymentChoices, paymentChoices } from "../payments";
import { colours } from "../theme";
import { offerBenefit, offerEndDate, offerMatchesFulfillment } from "../offerPresentation";
import { SchedulePicker, scheduledTimeLabel, type ScheduleChoice, type ScheduleMode } from "../SchedulePicker";
import { initialScheduleChoice } from "../schedule-choice";
import type { Address, CartEntry, Fulfillment, Offer, Order, PaymentMethod, Restaurant } from "../types";
import { createCheckoutAttempt } from "../../../web/checkout-attempt.js";

type Quote = {
  scheduledFor:string|null; scheduleMinimumLeadMinutes:number; scheduleMaxDays:number;
  grossFoodMinor:number; restaurantDiscountMinor:number; subtotalMinor:number; deliveryFeeMinor:number; deliveryDiscountMinor:number; totalMinor:number;
  voucherId?:string|null;platformVoucherMinor?:number;customerPayableMinor?:number;orderValueMinor?:number;voucher?:{id:string;title:string;amountMinor:number;fundingParty:"platform";retainedForMinimumPaymentMinor?:number}|null;
  commissionMinor?:number; commission?:unknown; offerId:string|null;
  promotion:{grantId:string;title:string;campaignType:string;gift?:{menuItemId:string;name:string;quantity:number;valueMinor:number}|null;[key:string]:unknown}|null;
  autoOfferSelection:{candidateLimit:number;truncated:boolean;candidatesChecked:number};
};
function addressComplete(address:Address) { return Boolean(address.line1.trim() && address.line1.trim().length<=120 && (!address.line2 || address.line2.trim().length<=120) && address.city.trim() && address.city.trim().length<=100 && /^([A-Z]{1,2}\d[A-Z\d]?)(\d[A-Z]{2})$/.test(address.postcode.toUpperCase().replace(/\s+/g,""))); }
function quoteSignature(value:Quote) { return JSON.stringify([value.scheduledFor,value.grossFoodMinor,value.restaurantDiscountMinor,value.subtotalMinor,value.deliveryFeeMinor,value.deliveryDiscountMinor,value.totalMinor,value.commissionMinor,value.commission??null,value.offerId,value.promotion,value.voucherId??null,value.platformVoucherMinor??0]); }
function checkedQuote(value:Quote, scheduledFor:string|null) {
  const credit=value?.platformVoucherMinor??0;if(!Number.isSafeInteger(credit)||credit<0||(value?.customerPayableMinor!==undefined&&value.customerPayableMinor!==value.totalMinor)||(credit>0&&(!value.voucherId||value.voucher?.id!==value.voucherId||value.voucher?.amountMinor!==credit)))throw new ApiError("Your voucher credit could not be verified.",0,"MALFORMED_RESPONSE");
  if (!value || value.scheduledFor!==scheduledFor || ![value.grossFoodMinor,value.restaurantDiscountMinor,value.subtotalMinor,value.deliveryFeeMinor,value.deliveryDiscountMinor,value.totalMinor].every(amount=>Number.isSafeInteger(amount)&&amount>=0) || value.totalMinor+(value.platformVoucherMinor??0)!==value.subtotalMinor+value.deliveryFeeMinor || value.subtotalMinor!==value.grossFoodMinor-value.restaurantDiscountMinor || (value.offerId!==null && (typeof value.offerId!=="string"||!value.offerId)) || !value.autoOfferSelection || (value.offerId===null ? value.promotion!==null : value.promotion?.grantId!==value.offerId)) throw new ApiError("Your price, timing and offer could not be verified.",0,"MALFORMED_RESPONSE");
  return value;
}
function transientQuoteError(error:unknown) { return error instanceof ApiError && error.code!=="API_NOT_CONFIGURED" && (error.status===0 || error.status===408 || error.status===429 || error.status>=500); }
type PaymentConfig = { providerMode:string; cardAvailable:boolean; stripeMode:"test"|"live"|null };
function stripeCheckoutUrl(value:string){const url=new URL(value);if(url.protocol!=="https:"||url.hostname!=="checkout.stripe.com"||url.username||url.password)throw Error("Secure checkout returned an unexpected destination.");return url.toString();}

export function CheckoutScreen({ token, restaurant, cart, fulfillment, onBack, onCheckOrders, onOrdered, initialAddress, onOfferResolved, onAddress, onScrollOffset, initialSchedule, onScheduleChange }: { initialSchedule?:ScheduleChoice|null; onScheduleChange?:(choice:ScheduleChoice)=>void; onScrollOffset?:(offset:number)=>void; initialAddress?:Address|null; onOfferResolved?:(offerId?:string)=>void; onAddress?:(address:Address)=>void; token: string; restaurant: Restaurant; cart: CartEntry[]; fulfillment: Fulfillment; onBack: () => void; onCheckOrders: () => void; onOrdered: (order: Order) => void }) {
  const [firstOffers,setFirstOffers]=useState<Offer[]>([]);
  const [addresses, setAddresses] = useState<Address[]>([]),[claimingOffer,setClaimingOffer]=useState(false);
  const [address, setAddress] = useState<Address>(initialAddress?{...initialAddress}:{ label: "Home", line1: "", line2: "", city: "", postcode: "" }); const [saveAddress, setSaveAddress] = useState(false);
  const [phone, setPhone] = useState(""); const [instructions, setInstructions] = useState(""); const [allergyNotes, setAllergyNotes] = useState(""); const [payment, setPayment] = useState<PaymentMethod>("mock_card");
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [attempt] = useState(() => createCheckoutAttempt(() => requestKey("mobile-order"))); const submitting = useRef(false);
  const scheduleScope=`${restaurant.id}:${fulfillment}`;
  const [scheduleDraft,setScheduleDraft]=useState(()=>({scope:scheduleScope,...initialScheduleChoice(initialSchedule,restaurant.acceptingOrders)}));
  const choice=scheduleDraft.scope===scheduleScope?scheduleDraft:initialScheduleChoice(initialSchedule,restaurant.acceptingOrders);
  const scheduleMode=choice.mode,scheduledFor=choice.scheduledFor;
  const scheduleCallback=useRef(onScheduleChange);scheduleCallback.current=onScheduleChange;
  function changeSchedule(patch:Partial<ScheduleChoice>){setScheduleDraft(old=>({...(old.scope===scheduleScope?old:{scope:scheduleScope,...initialScheduleChoice(initialSchedule,restaurant.acceptingOrders)}),...patch}));}
  const setScheduleMode=(mode:ScheduleMode)=>changeSchedule({mode,...(mode==="asap"?{scheduledFor:null}:{})});
  const setScheduledFor=(value:string|null)=>changeSchedule({scheduledFor:value});
  const targetTime=scheduleMode==="scheduled"?scheduledFor:null;
  const recovering = Boolean(attempt.pending), locked = busy || recovering || claimingOffer;
  const [paymentConfig,setPaymentConfig]=useState<PaymentConfig>({providerMode:"unknown",cardAvailable:false,stripeMode:null});
  const estimated = useMemo(() => cartTotals(cart, fulfillment, restaurant), [cart, fulfillment, restaurant]);
  const [quoteResult,setQuoteResult]=useState<{request:string;value:Quote}|null>(null),[quoting,setQuoting]=useState(false),[quoteError,setQuoteError]=useState(""),[quoteRevision,setQuoteRevision]=useState(0);
  const quoteRequest=JSON.stringify({restaurantId:restaurant.id,items:orderItems(cart),fulfillment,scheduledFor:targetTime,autoApplyOffers:true,autoApplyVouchers:true,paymentMethod:payment,...(fulfillment==="delivery"?{deliveryAddress:{line1:address.line1.trim(),...(address.line2?.trim()?{line2:address.line2.trim()}:{}),city:address.city.trim(),postcode:address.postcode.trim().toUpperCase()}}:{})});
  const timingReady=scheduleMode==="scheduled"?Boolean(scheduledFor):restaurant.acceptingOrders;
  const quoteReady=Boolean(cart.length && timingReady && (fulfillment==="collection" || addressComplete(address)));
  const quote=quoteResult?.request===quoteRequest?quoteResult.value:null;
  const latest=useRef({quoteRequest,onOfferResolved,onAddress});latest.current={quoteRequest,onOfferResolved,onAddress};
  useEffect(()=>{if(fulfillment==="delivery")latest.current.onAddress?.({...address});},[fulfillment,address.id,address.label,address.line1,address.line2,address.city,address.postcode]);
  const totals=quote??estimated;
  useEffect(()=>{
    if(recovering||submitting.current)return;
    let active=true,retries=0,timer:ReturnType<typeof setTimeout>|undefined;
    setQuoteResult(null);setQuoteError("");setQuoting(quoteReady);
    async function refresh(){
      if(!active||submitting.current||attempt.pending)return;setQuoting(true);
      try{const value=checkedQuote(await api<Quote>("/api/orders/quote",{method:"POST",token,body:quoteRequest}),targetTime);if(!active)return;setQuoteResult({request:quoteRequest,value});setQuoteError("");latest.current.onOfferResolved?.(value.offerId??undefined);}
      catch(caught){if(!active)return;setQuoteResult(null);const transient=transientQuoteError(caught);setQuoteError(transient?"Your price is not confirmed yet. We’ll check again automatically when the connection is available.":`Your total could not be confirmed. ${(caught as Error).message}`);if(transient&&retries<3)timer=setTimeout(()=>void refresh(),[1500,4000,10000][retries++]);}
      finally{if(active)setQuoting(false);}
    }
    if(quoteReady)timer=setTimeout(()=>void refresh(),350);
    return()=>{active=false;clearTimeout(timer);};
  },[token,quoteRequest,quoteReady,quoteRevision,recovering]);
  useEffect(()=>{const subscription=AppState.addEventListener("change",state=>{if(state==="active"&&!submitting.current&&!attempt.pending)setQuoteRevision(value=>value+1);});return()=>subscription.remove();},[attempt]);
  const localCheck = canCheckout(cart, fulfillment, restaurant, address.postcode, {scheduled:Boolean(targetTime)});
  useEffect(()=>{if(!attempt.pending)setScheduleDraft(old=>old.scope===scheduleScope?old:{scope:scheduleScope,...initialScheduleChoice(initialSchedule,restaurant.acceptingOrders)});},[scheduleScope]);
  useEffect(()=>{if(scheduleDraft.scope===scheduleScope)scheduleCallback.current?.({mode:scheduleDraft.mode,scheduledFor:scheduleDraft.scheduledFor});},[scheduleScope,scheduleDraft.scope,scheduleDraft.mode,scheduleDraft.scheduledFor]);

  useEffect(() => { void Promise.all([
    api<PaymentConfig>("/api/payments/config",{token}).then((value)=>{setPaymentConfig(value);configurePaymentChoices(value.providerMode,value.cardAvailable,value.stripeMode);setPayment(value.cardAvailable?"card":value.providerMode==="local_simulator"?"mock_card":"cash");}),
    api<Address[]>("/api/account/addresses", { token }).then(setAddresses),
    api<Offer[]>(`/api/promotions?restaurantId=${encodeURIComponent(restaurant.id)}`,{token}).then(rows=>setFirstOffers(rows.filter(offer=>offerMatchesFulfillment(offer,fulfillment))))
  ]).catch((caught) => setError((caught as Error).message)); }, [restaurant.id, token]);

  async function claimFirstOffer(campaign:Offer){if(locked)return;setClaimingOffer(true);setQuoteResult(null);try{await api<{id:string}>(`/api/promotions/${campaign.id}/claim`,{method:"POST",token,body:"{}"});setFirstOffers(old=>old.filter(offer=>offer.id!==campaign.id));}catch(e){setError((e as Error).message);}finally{setClaimingOffer(false);setQuoteRevision(value=>value+1);}}

  function chooseAddress(value: Address) { setAddress({ ...value }); }
  function checkOrders() { if (busy) return; Alert.alert("Check your order first", "This checkout may already have created an order. Retry the original request, or check Orders before starting another basket. Checking Orders closes this checkout and clears this basket.", [{ text: "Keep checkout", style: "cancel" }, { text: "Check Orders", onPress: () => { attempt.clear(); onCheckOrders(); } }]); }
  useEffect(() => { const back = BackHandler.addEventListener("hardwareBackPress", () => { if (submitting.current) return true; if (attempt.pending) checkOrders(); else onBack(); return true; }); return () => back.remove(); }, [busy, onBack, onCheckOrders]);
  async function placeOrder() {
    if (submitting.current) return;
    const original = attempt.pending;
    if (!original) {
      if (!localCheck.ok) return setError(localCheck.reason);
      if (paymentConfig.providerMode === "unknown") return setError("Wait for your payment options to load.");
      if (!(quote?.totalMinor===0&&quote.platformVoucherMinor)&&!paymentChoices(restaurant.profile.cashEnabled).find((choice) => choice.id === payment)?.available) return setError("The selected payment method is unavailable. Refresh provider status and try again.");
      if(!quoteReady||!quote||quoting||claimingOffer)return setError("Wait for your price and eligible offers to be confirmed before placing your order.");
    }
    submitting.current = true;
    setBusy(true); setError("");
    let reviewChanged=false;
    try {
      let body = null;
      if (!original) {
        const current=checkedQuote(await api<Quote>("/api/orders/quote",{method:"POST",token,body:quoteRequest}),targetTime);
        if(latest.current.quoteRequest!==quoteRequest)throw Error("Your order details changed. Wait for the updated total before placing your order.");
        setQuoteResult({request:quoteRequest,value:current});latest.current.onOfferResolved?.(current.offerId??undefined);
        if(quoteSignature(current)!==quoteSignature(quote!)){reviewChanged=true;throw Error("Your price or offer changed. Review the updated order, then place your order.");}
        body = {
        restaurantId: restaurant.id,
        expectedTotalMinor: current.totalMinor,
        items: orderItems(cart),
        paymentMethod: current.totalMinor===0&&current.platformVoucherMinor?"voucher":checkoutPayment(payment),
        ...(current.voucherId?{voucherId:current.voucherId}:{}),
        fulfillment,
        scheduledFor:current.scheduledFor,
        ...(fulfillment === "delivery" ? { deliveryAddress: { line1: address.line1, ...(address.line2 ? { line2: address.line2 } : {}), city: address.city, postcode: address.postcode } } : {}),
        ...(phone.trim() ? { customerPhone: phone.trim() } : {}),
        ...(fulfillment === "delivery" && instructions.trim() ? { deliveryInstructions: instructions.trim() } : {}),
        ...(allergyNotes.trim() ? { allergyNotes: allergyNotes.trim() } : {}),
        ...(current.offerId ? { offerId: current.offerId } : {})
        };
      }
      const method = original ? JSON.parse(original.serializedBody).paymentMethod : body!.paymentMethod;
      const order = await attempt.submit<Order>(body, record => api<Order>("/api/orders", { method: "POST", token, idempotencyKey: record.key, body: record.serializedBody }));
      if (order.paymentMethod === "card") {
        try { const checkout = await api<{checkoutUrl:string}>(`/api/orders/${order.id}/checkout`, { method:"POST", token, idempotencyKey:`mobile-checkout-${order.id}`, body:"{}" }); await Linking.openURL(stripeCheckoutUrl(checkout.checkoutUrl)); }
        catch { Alert.alert("Your order is saved", "Secure payment could not be opened. Continue payment from this order in Orders; do not place another copy."); }
      }
      if (saveAddress && fulfillment === "delivery" && !address.id) {
        try { await api<Address>("/api/account/addresses", { method: "POST", token, body: JSON.stringify(address) }); }
        catch { Alert.alert("Order placed", "The order was placed, but this address could not be saved. You can add it later under Account."); }
      }
      onOrdered(order);
    } catch (caught) {
      if (!attempt.pending && !reviewChanged) { setQuoteResult(null);setQuoteRevision(value=>value+1); }
      const message = (caught as Error).message; setError(attempt.pending ? `${message} Your order result is not confirmed. Retry the original order; its items, address, timing and reviewed total are kept unchanged.` : message);
    } finally { submitting.current = false; setBusy(false); }
  }

  const timingHint = targetTime ? scheduledTimeLabel(targetTime) : scheduleMode === "scheduled" ? "Choose an available time above" : "As soon as possible";
  const waitingHint = !timingReady ? "Choose a day and available time. Your total will update automatically." : "Enter your full delivery address and postcode. Your total and eligible offers update automatically.";
  return <ScrollView scrollEventThrottle={32} onScroll={event=>onScrollOffset?.(event.nativeEvent.contentOffset.y)} contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
    <View style={styles.back}><Button tone="quiet" disabled={busy} onPress={recovering ? checkOrders : onBack}>{recovering ? "Check Orders before changing basket" : "‹ Back to basket"}</Button></View>
    <SectionTitle eyebrow={restaurant.name} title="Checkout"/>
    <Text style={styles.intro}>A few details, then you’re ready to order.</Text>
    {recovering ? <Card tone="warning"><Text style={styles.lineName}>Confirm your original order</Text><Text style={styles.meta}>The result of your last request is still unknown. Your original items, address, timing and price are kept for a safe retry.</Text></Card> : null}

    <Card>
      <CheckoutStep number={1} title={fulfillment === "delivery" ? "Delivery & timing" : "Collection & timing"} detail={fulfillment === "delivery" ? "Where and when should your food arrive?" : "Choose when you’d like to collect."}/>
      {fulfillment === "delivery" ? <>
        {addresses.length ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.savedAddresses}>{addresses.map(saved => <Pressable key={saved.id} accessibilityRole="button" accessibilityLabel={`Use ${saved.label}, ${saved.postcode}`} accessibilityState={{selected:address.id === saved.id,disabled:locked}} disabled={locked} onPress={() => chooseAddress(saved)} style={[styles.addressChip, address.id === saved.id && styles.addressActive]}><Text style={styles.addressLabel}>{saved.label}</Text><Text style={styles.meta}>{saved.postcode}</Text></Pressable>)}</ScrollView> : null}
        <Field editable={!locked} label="Address line 1" value={address.line1} onChangeText={line1 => setAddress({ ...address, line1 })} autoComplete="street-address" maxLength={120}/>
        <Field editable={!locked} label="Address line 2 (optional)" value={address.line2} onChangeText={line2 => setAddress({ ...address, line2 })} maxLength={120}/>
        <View style={styles.addressRow}><View style={styles.city}><Field editable={!locked} label="Town or city" value={address.city} onChangeText={city => setAddress({ ...address, city })} maxLength={100}/></View><View style={styles.postcode}><Field editable={!locked} label="Postcode" value={address.postcode} onChangeText={postcode => setAddress({ ...address, postcode })} autoCapitalize="characters" autoComplete="postal-code" maxLength={12}/></View></View>
        {!address.id ? <><View style={styles.switchRow}><Text style={styles.switchLabel}>Save this address for next time</Text><Switch disabled={locked} value={saveAddress} onValueChange={setSaveAddress} trackColor={{ true: colours.blue }}/></View>{saveAddress ? <Field editable={!locked} label="Address label" value={address.label} onChangeText={label => setAddress({ ...address, label })} maxLength={50}/> : null}</> : null}
      </> : <View style={styles.collection}><Text style={styles.lineName}>Collect from {restaurant.name}</Text><Text style={styles.meta}>Bring your order reference. We’ll let you know when your food is ready.</Text></View>}
      <View style={styles.rule}/>
      <SchedulePicker token={token} restaurantId={restaurant.id} fulfillment={fulfillment} acceptingOrders={restaurant.acceptingOrders} mode={scheduleMode} value={targetTime} onModeChange={mode=>{setScheduleMode(mode);setError("");}} onChange={value=>{setScheduledFor(value);setError("");}} disabled={locked} asapMinutes={fulfillment==="delivery"?restaurant.profile.estimatedDeliveryMinutes:restaurant.profile.estimatedCollectionMinutes}/>
    </Card>

    <Card>
      <Text accessibilityRole="header" style={styles.smallTitle}>Contact & notes</Text>
      <Field editable={!locked} label="Phone (optional)" value={phone} onChangeText={setPhone} keyboardType="phone-pad" autoComplete="tel" maxLength={30}/>
      {fulfillment === "delivery" ? <Field editable={!locked} label="Delivery instructions (optional)" value={instructions} onChangeText={setInstructions} multiline maxLength={500}/> : null}
      <Field editable={!locked} label="Allergy notes (optional)" value={allergyNotes} onChangeText={setAllergyNotes} multiline maxLength={500} hint="Speak to the restaurant directly about severe allergies."/>
    </Card>

    <Card>
      <CheckoutStep number={2} title="Payment" detail={quote?.totalMinor===0&&quote.platformVoucherMinor?"Covered by your Cal-Eats voucher.":"Choose how you’d like to pay."}/>
      {quote?.totalMinor===0&&quote.platformVoucherMinor?<View style={styles.offerSummary}><Text style={styles.lineName}>No payment needed</Text><Text style={styles.meta}>Your Cal-Eats voucher covers this order.</Text></View>:<View accessibilityRole="radiogroup" style={styles.paymentChoices}>{paymentChoices(restaurant.profile.cashEnabled).map(choice => <Pressable accessibilityRole="radio" accessibilityState={{ checked: payment === choice.id, disabled: locked || !choice.available }} key={choice.id} disabled={locked || !choice.available} onPress={() => choice.id !== "apple_pay" && setPayment(choice.id)} style={[styles.payment, payment === choice.id && styles.paymentActive, !choice.available && styles.disabled]}><View style={[styles.radio,payment===choice.id&&styles.radioActive]}>{payment===choice.id?<View style={styles.radioDot}/>:null}</View><View style={styles.paymentCopy}><Text style={styles.lineName}>{choice.label}</Text><Text style={styles.meta}>{choice.description}</Text></View></Pressable>)}</View>}
      <Text style={styles.finePrint}>{quote?.totalMinor===0&&quote.platformVoucherMinor?"Your restaurant is credited by Cal-Eats.":paymentConfig.cardAvailable?`Enter card details on the secure checkout page.${paymentConfig.stripeMode === "live" ? "" : " This is a test payment; no real money moves."}`:paymentConfig.providerMode==="local_simulator"?"Mock card is a local simulation. Cash is paid directly to the restaurant.":"Card availability is being checked. Cash, when offered, is paid directly to the restaurant."}</Text>
    </Card>

    {firstOffers.length?<Card tone="info"><Text accessibilityRole="header" style={styles.smallTitle}>An offer for your first order</Text><Text style={styles.meta}>Add an offer to your account. We’ll apply it automatically when this order qualifies.</Text>{firstOffers.map(c=><Button key={c.id} tone="secondary" disabled={locked} onPress={()=>void claimFirstOffer(c)}>Add offer: {c.title} · {offerBenefit(c)} · Ends {offerEndDate(c)}</Button>)}</Card>:null}

    <Card>
      <CheckoutStep number={3} title="Order summary" detail="Check your food and total before placing your order."/>
      <View style={styles.summaryItems}>{cart.map(entry => <View key={entry.item.id} style={styles.line}><View style={styles.itemCopy}><Text style={styles.lineName}>{entry.quantity} × {entry.item.name}</Text><Text style={styles.finePrint}>{entry.item.modifierGroups.flatMap(group => group.options.filter(option => entry.selections[group.id]?.includes(option.id)).map(option => option.name)).join(", ") || "No extras"}</Text></View><Text style={styles.price}>{money(entryUnitMinor(entry) * entry.quantity)}</Text></View>)}</View>
      {quote?.promotion ? <View style={styles.offerSummary}><View style={styles.offerTitle}><Text style={styles.offerHeading}>Offer applied automatically</Text><Pill tone="green">Applied</Pill></View><Text style={styles.lineName}>{quote.promotion.title}</Text>{quote.promotion.gift?<View style={styles.line}><Text style={styles.lineName}>{quote.promotion.gift.quantity} × {quote.promotion.gift.name} · Free item</Text><Text style={styles.price}>{money(0)}</Text></View>:null}{quote.promotion.campaignType==="buy_one_get_one"?<Text style={styles.finePrint}>Buy one, get one savings are included. Extras remain charged.</Text>:null}</View> : <Text style={styles.finePrint}>{quote?"No eligible offer applies to this order right now.":"Eligible offers are checked automatically with your total."}</Text>}
      <View style={styles.rule}/>
      <View style={styles.destination}><Text style={styles.destinationLabel}>{targetTime?`Scheduled ${fulfillment}`:fulfillment==="delivery"?"Delivery":"Collection"}</Text><Text style={styles.destinationTime}>{timingHint}</Text>{fulfillment==="delivery"&&address.line1.trim()?<Text style={styles.finePrint}>{[address.line1.trim(),address.postcode.trim().toUpperCase()].filter(Boolean).join(", ")}</Text>:null}</View>
      <View style={styles.rule}/>
      <Price label="Food before offers" value={quote?.grossFoodMinor??estimated.subtotalMinor}/>
      {quote?.restaurantDiscountMinor?<Price label="Restaurant promotion" value={-quote.restaurantDiscountMinor}/>:null}
      <Price label={fulfillment==="collection"?"Collection":quote?.deliveryDiscountMinor?"Delivery · offer applied":"Restaurant delivery fee"} value={totals.deliveryFeeMinor}/>
      {quote?.platformVoucherMinor?<View style={styles.offerSummary}><Price label="Cal-Eats voucher" value={-quote.platformVoucherMinor}/><Text style={styles.finePrint}>{quote.voucher?.title} · Restaurant earnings are protected.{quote.voucher?.retainedForMinimumPaymentMinor?" Some credit stays in your wallet so the card payment meets the 30p minimum.":""}</Text></View>:null}
      <View style={styles.total}><Price label={quote?"Verified total":"Estimated total"} value={totals.totalMinor} strong/></View>
      <Text accessibilityLiveRegion="polite" style={styles.finePrint}>{quoting?"Updating your price and checking eligible offers…":!quoteReady?waitingHint:"Prices, timing and eligible offers are checked again before your order is placed."}</Text>
      <ErrorBanner message={quoteError}/>
      <ErrorBanner message={error || (!recovering && !localCheck.ok && timingReady ? localCheck.reason : "")}/>
      <Button accessibilityLabel={recovering?"Retry original order":`Place order for ${money(totals.totalMinor)}`} busy={busy} disabled={!recovering && (!localCheck.ok || !quoteReady || !quote || quoting || claimingOffer || paymentConfig.providerMode === "unknown")} onPress={() => void placeOrder()}>{recovering ? "Retry original order" : "Place order"} · {money(totals.totalMinor)}</Button>
      <Text style={styles.finePrint}>{recovering?"Retrying keeps your original order details and checks the same order.":"Your restaurant will confirm your order after it is received."}</Text>
    </Card>
  </ScrollView>;
}
function CheckoutStep({ number, title, detail }: { number:number; title:string; detail:string }) { return <View style={styles.step}><View style={styles.stepNumber}><Text style={styles.stepNumberText}>{number}</Text></View><View style={styles.stepCopy}><Text accessibilityRole="header" style={styles.cardTitle}>{title}</Text><Text style={styles.finePrint}>{detail}</Text></View></View>; }

function Price({ label, value, strong }: { label: string; value: number; strong?: boolean }) { return <View style={styles.line}><Text style={[styles.meta, strong && styles.lineName]}>{label}</Text><Text style={[styles.price, strong && { fontSize: 19 }]}>{money(value)}</Text></View>; }
const styles = StyleSheet.create({
  page: { padding: 18, paddingBottom: 44, gap: 16, backgroundColor: colours.cream }, back: { alignSelf: "flex-start", marginLeft: -8, marginBottom: -8 }, intro: { color: colours.muted, lineHeight: 21, marginTop: -9, marginBottom: 2 },
  step: { flexDirection: "row", alignItems: "flex-start", gap: 11, marginBottom: 8 }, stepNumber: { height: 30, width: 30, borderRadius: 10, backgroundColor: colours.blue, alignItems: "center", justifyContent: "center", marginTop: 1 }, stepNumberText: { fontSize: 14, fontWeight: "800", color: colours.white }, stepCopy: { flex: 1, gap: 3 },
  cardTitle: { color: colours.ink, fontSize: 19, lineHeight: 26, fontWeight: "800" }, smallTitle: { color: colours.ink, fontSize: 17, lineHeight: 24, fontWeight: "800", marginBottom: 3 },
  line: { flexDirection: "row", gap: 12, justifyContent: "space-between", alignItems: "flex-start" }, lineName: { flexShrink: 1, color: colours.ink, fontWeight: "800", lineHeight: 21 }, meta: { color: colours.muted, lineHeight: 21 }, finePrint: { color: colours.muted, fontSize: 12, lineHeight: 19 }, price: { color: colours.ink, fontWeight: "800", lineHeight: 22 }, rule: { height: 1, backgroundColor: colours.line, marginVertical: 7 },
  savedAddresses: { gap: 8, paddingBottom: 4 }, addressChip: { minWidth: 110, borderWidth: 1, borderColor: colours.line, borderRadius: 12, padding: 11, backgroundColor: colours.panel }, addressActive: { borderColor: colours.blue, backgroundColor: colours.sky }, addressLabel: { color: colours.ink, fontWeight: "800" }, addressRow: { flexDirection: "row", gap: 10 }, city: { flex: 1.2, minWidth: 0 }, postcode: { flex: 1, minWidth: 0 }, switchRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12, minHeight: 44 }, switchLabel: { flex: 1, color: colours.ink, fontWeight: "700", lineHeight: 21 }, collection: { padding: 12, gap: 5, borderRadius: 12, backgroundColor: colours.cream },
  paymentChoices: { gap: 10 }, payment: { flexDirection: "row", alignItems: "flex-start", gap: 11, padding: 14, borderWidth: 1, borderColor: colours.line, borderRadius: 12 }, paymentActive: { borderColor: colours.blue, backgroundColor: colours.sky }, paymentCopy: { flex: 1, gap: 4 }, radio: { height: 20, width: 20, borderRadius: 10, borderWidth: 1.5, borderColor: colours.muted, alignItems: "center", justifyContent: "center", marginTop: 1 }, radioActive: { borderColor: colours.blue }, radioDot: { height: 10, width: 10, borderRadius: 5, backgroundColor: colours.blue }, disabled: { opacity: .5 },
  summaryItems: { gap: 14, paddingVertical: 5 }, itemCopy: { flex: 1, gap: 3 }, offerSummary: { backgroundColor: colours.sky, padding: 12, borderRadius: 12, gap: 8, marginTop: 4 }, offerTitle: { flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "space-between" }, offerHeading: { flex: 1, color: colours.blueDark, fontWeight: "700", lineHeight: 21 }, destination: { gap: 4 }, destinationLabel: { color: colours.muted, textTransform: "capitalize", fontSize: 12, fontWeight: "700", lineHeight: 19 }, destinationTime: { color: colours.ink, fontSize: 15, fontWeight: "800", lineHeight: 22 }, total: { paddingVertical: 12, marginTop: 3, borderTopWidth: 1, borderTopColor: colours.line }
});
