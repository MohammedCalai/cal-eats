import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, AppState, BackHandler, Linking, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { ApiError, api } from "../api";
import { Button, Card, ErrorBanner, Field, Pill, SectionTitle } from "../components";
import { canCheckout, cartTotals, entryUnitMinor, money, orderItems, requestKey } from "../model";
import { checkoutPayment, configurePaymentChoices, paymentChoices } from "../payments";
import { colours } from "../theme";
import { offerBenefit, offerEndDate, offerMatchesFulfillment } from "../offerPresentation";
import type { Address, CartEntry, Fulfillment, Offer, Order, PaymentMethod, Restaurant } from "../types";
import { createCheckoutAttempt } from "../../../web/checkout-attempt.js";

type Quote = {
  grossFoodMinor:number; restaurantDiscountMinor:number; subtotalMinor:number; deliveryFeeMinor:number; deliveryDiscountMinor:number; totalMinor:number;
  commissionMinor?:number; commission?:unknown; offerId:string|null;
  promotion:{grantId:string;title:string;campaignType:string;gift?:{menuItemId:string;name:string;quantity:number;valueMinor:number}|null;[key:string]:unknown}|null;
  autoOfferSelection:{candidateLimit:number;truncated:boolean;candidatesChecked:number};
};
function addressComplete(address:Address) { return Boolean(address.line1.trim() && address.line1.trim().length<=120 && (!address.line2 || address.line2.trim().length<=120) && address.city.trim() && address.city.trim().length<=100 && /^([A-Z]{1,2}\d[A-Z\d]?)(\d[A-Z]{2})$/.test(address.postcode.toUpperCase().replace(/\s+/g,""))); }
function quoteSignature(value:Quote) { return JSON.stringify([value.grossFoodMinor,value.restaurantDiscountMinor,value.subtotalMinor,value.deliveryFeeMinor,value.deliveryDiscountMinor,value.totalMinor,value.commissionMinor,value.commission??null,value.offerId,value.promotion]); }
function checkedQuote(value:Quote) {
  if (!value || ![value.grossFoodMinor,value.restaurantDiscountMinor,value.subtotalMinor,value.deliveryFeeMinor,value.deliveryDiscountMinor,value.totalMinor].every(amount=>Number.isSafeInteger(amount)&&amount>=0) || value.totalMinor!==value.subtotalMinor+value.deliveryFeeMinor || value.subtotalMinor!==value.grossFoodMinor-value.restaurantDiscountMinor || (value.offerId!==null && (typeof value.offerId!=="string"||!value.offerId)) || !value.autoOfferSelection || (value.offerId===null ? value.promotion!==null : value.promotion?.grantId!==value.offerId)) throw new ApiError("Your price and offer could not be verified.",0,"MALFORMED_RESPONSE");
  return value;
}
function transientQuoteError(error:unknown) { return error instanceof ApiError && error.code!=="API_NOT_CONFIGURED" && (error.status===0 || error.status===408 || error.status===429 || error.status>=500); }
type PaymentConfig = { providerMode:string; cardAvailable:boolean; stripeMode:"test"|"live"|null };
function stripeCheckoutUrl(value:string){const url=new URL(value);if(url.protocol!=="https:"||url.hostname!=="checkout.stripe.com"||url.username||url.password)throw Error("Stripe returned an unexpected checkout destination.");return url.toString();}

export function CheckoutScreen({ token, restaurant, cart, fulfillment, onBack, onCheckOrders, onOrdered, initialAddress, onOfferResolved, onAddress }: { initialAddress?:Address|null; onOfferResolved?:(offerId?:string)=>void; onAddress?:(address:Address)=>void; token: string; restaurant: Restaurant; cart: CartEntry[]; fulfillment: Fulfillment; onBack: () => void; onCheckOrders: () => void; onOrdered: (order: Order) => void }) {
  const [firstOffers,setFirstOffers]=useState<Offer[]>([]);
  const [addresses, setAddresses] = useState<Address[]>([]),[claimingOffer,setClaimingOffer]=useState(false);
  const [address, setAddress] = useState<Address>(initialAddress?{...initialAddress}:{ label: "Home", line1: "", line2: "", city: "", postcode: "" }); const [saveAddress, setSaveAddress] = useState(false);
  const [phone, setPhone] = useState(""); const [instructions, setInstructions] = useState(""); const [allergyNotes, setAllergyNotes] = useState(""); const [payment, setPayment] = useState<PaymentMethod>("mock_card");
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [attempt] = useState(() => createCheckoutAttempt(() => requestKey("mobile-order"))); const submitting = useRef(false);
  const recovering = Boolean(attempt.pending), locked = busy || recovering || claimingOffer;
  const [paymentConfig,setPaymentConfig]=useState<PaymentConfig>({providerMode:"unknown",cardAvailable:false,stripeMode:null});
  const estimated = useMemo(() => cartTotals(cart, fulfillment, restaurant), [cart, fulfillment, restaurant]);
  const [quoteResult,setQuoteResult]=useState<{request:string;value:Quote}|null>(null),[quoting,setQuoting]=useState(false),[quoteError,setQuoteError]=useState(""),[quoteRevision,setQuoteRevision]=useState(0);
  const quoteRequest=JSON.stringify({restaurantId:restaurant.id,items:orderItems(cart),fulfillment,autoApplyOffers:true,...(fulfillment==="delivery"?{deliveryAddress:{line1:address.line1.trim(),...(address.line2?.trim()?{line2:address.line2.trim()}:{}),city:address.city.trim(),postcode:address.postcode.trim().toUpperCase()}}:{})});
  const quoteReady=Boolean(cart.length && (fulfillment==="collection" || addressComplete(address)));
  const quote=quoteResult?.request===quoteRequest?quoteResult.value:null;
  const latest=useRef({quoteRequest,onOfferResolved,onAddress});latest.current={quoteRequest,onOfferResolved,onAddress};
  const totals=quote??estimated;
  useEffect(()=>{
    if(recovering||submitting.current)return;
    let active=true,retries=0,timer:ReturnType<typeof setTimeout>|undefined;
    setQuoteResult(null);setQuoteError("");setQuoting(quoteReady);
    async function refresh(){
      if(!active||submitting.current||attempt.pending)return;setQuoting(true);
      try{const value=checkedQuote(await api<Quote>("/api/orders/quote",{method:"POST",token,body:quoteRequest}));if(!active)return;setQuoteResult({request:quoteRequest,value});setQuoteError("");latest.current.onOfferResolved?.(value.offerId??undefined);if(fulfillment==="delivery")latest.current.onAddress?.({...address});}
      catch(caught){if(!active)return;setQuoteResult(null);const transient=transientQuoteError(caught);setQuoteError(transient?"Your price is not confirmed yet. We’ll check again automatically when the connection is available.":`Your total could not be confirmed. ${(caught as Error).message}`);if(transient&&retries<3)timer=setTimeout(()=>void refresh(),[1500,4000,10000][retries++]);}
      finally{if(active)setQuoting(false);}
    }
    if(quoteReady)timer=setTimeout(()=>void refresh(),350);
    return()=>{active=false;clearTimeout(timer);};
  },[token,quoteRequest,quoteReady,quoteRevision,recovering]);
  useEffect(()=>{const subscription=AppState.addEventListener("change",state=>{if(state==="active"&&!submitting.current&&!attempt.pending)setQuoteRevision(value=>value+1);});return()=>subscription.remove();},[attempt]);
  const localCheck = canCheckout(cart, fulfillment, restaurant, address.postcode);

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
      if (!paymentChoices(restaurant.profile.cashEnabled).find((choice) => choice.id === payment)?.available) return setError("The selected payment method is unavailable. Refresh provider status and try again.");
      if(!quoteReady||!quote||quoting||claimingOffer)return setError("Wait for your price and eligible offers to be confirmed before placing your order.");
    }
    submitting.current = true;
    setBusy(true); setError("");
    let reviewChanged=false;
    try {
      let body = null;
      if (!original) {
        const current=checkedQuote(await api<Quote>("/api/orders/quote",{method:"POST",token,body:quoteRequest}));
        if(latest.current.quoteRequest!==quoteRequest)throw Error("Your order details changed. Wait for the updated total before placing your order.");
        setQuoteResult({request:quoteRequest,value:current});latest.current.onOfferResolved?.(current.offerId??undefined);
        if(quoteSignature(current)!==quoteSignature(quote!)){reviewChanged=true;throw Error("Your price or offer changed. Review the updated order, then place your order.");}
        body = {
        restaurantId: restaurant.id,
        expectedTotalMinor: current.totalMinor,
        items: orderItems(cart),
        paymentMethod: checkoutPayment(payment),
        fulfillment,
        ...(fulfillment === "delivery" ? { deliveryAddress: { line1: address.line1, ...(address.line2 ? { line2: address.line2 } : {}), city: address.city, postcode: address.postcode } } : {}),
        ...(phone.trim() ? { customerPhone: phone.trim() } : {}),
        ...(fulfillment === "delivery" && instructions.trim() ? { deliveryInstructions: instructions.trim() } : {}),
        ...(allergyNotes.trim() ? { allergyNotes: allergyNotes.trim() } : {}),
        ...(current.offerId ? { offerId: current.offerId } : {})
        };
      }
      const method = original ? JSON.parse(original.serializedBody).paymentMethod : body!.paymentMethod;
      const order = await attempt.submit<Order>(body, record => api<Order>("/api/orders", { method: "POST", token, idempotencyKey: record.key, body: record.serializedBody }));
      if (method === "card") {
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
      const message = (caught as Error).message; setError(attempt.pending ? `${message} Your order result is not confirmed. Retry the original order; its items, address and reviewed total are kept unchanged.` : message);
    } finally { submitting.current = false; setBusy(false); }
  }

  return <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
    <Button tone="quiet" disabled={busy} onPress={recovering ? checkOrders : onBack}>{recovering ? "Check Orders before changing basket" : "← Back to basket"}</Button><SectionTitle eyebrow="Checkout" title="Review your order"/>
    <Card>{cart.map((entry) => <View key={entry.item.id} style={styles.line}><View style={{ flex: 1 }}><Text style={styles.lineName}>{entry.quantity} × {entry.item.name}</Text><Text style={styles.meta}>{entry.item.modifierGroups.flatMap((group) => group.options.filter((option) => entry.selections[group.id]?.includes(option.id)).map((option) => option.name)).join(", ") || "No extras"}</Text></View><Text style={styles.price}>{money(entryUnitMinor(entry) * entry.quantity)}</Text></View>)}<View style={styles.rule}/><Price label="Food before offers" value={quote?.grossFoodMinor??estimated.subtotalMinor}/>{quote?.restaurantDiscountMinor?<Price label="Restaurant promotion" value={-quote.restaurantDiscountMinor}/>:null}<Price label={quote?.deliveryDiscountMinor?"Delivery · offer applied":"Delivery"} value={totals.deliveryFeeMinor}/><Price label={quote?"Verified total":"Estimated total"} value={totals.totalMinor} strong/>{quoting?<Text accessibilityLiveRegion="polite" style={styles.meta}>Updating your price and checking eligible offers…</Text>:!quoteReady?<Text style={styles.meta}>Enter your full delivery address and postcode. Your total and eligible offers update automatically.</Text>:null}<ErrorBanner message={quoteError}/><Text style={styles.meta}>Prices, availability and eligible offers are checked again before your order is placed.</Text></Card>
    {fulfillment === "delivery" ? <Card><Text style={styles.cardTitle}>Delivery address</Text>{addresses.length ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>{addresses.map((saved) => <Pressable key={saved.id} disabled={locked} onPress={() => chooseAddress(saved)} style={[styles.addressChip, address.id === saved.id && styles.addressActive]}><Text style={styles.addressLabel}>{saved.label}</Text><Text style={styles.meta}>{saved.postcode}</Text></Pressable>)}</ScrollView> : null}
      <Field editable={!locked} label="Label" value={address.label} onChangeText={(label) => setAddress({ ...address, label })} maxLength={50}/><Field editable={!locked} label="Address line 1" value={address.line1} onChangeText={(line1) => setAddress({ ...address, line1 })} autoComplete="street-address" maxLength={120}/><Field editable={!locked} label="Address line 2 (optional)" value={address.line2} onChangeText={(line2) => setAddress({ ...address, line2 })} maxLength={120}/><Field editable={!locked} label="Town or city" value={address.city} onChangeText={(city) => setAddress({ ...address, city })} maxLength={100}/><Field editable={!locked} label="Postcode" value={address.postcode} onChangeText={(postcode) => setAddress({ ...address, postcode })} autoCapitalize="characters" autoComplete="postal-code" maxLength={12}/>
      {!address.id ? <View style={styles.switchRow}><Text style={styles.switchLabel}>Save this address</Text><Switch disabled={locked} value={saveAddress} onValueChange={setSaveAddress} trackColor={{ true: colours.blue }}/></View> : null}<Field editable={!locked} label="Delivery instructions (optional)" value={instructions} onChangeText={setInstructions} multiline maxLength={500}/></Card> : <Card tone="info"><Text style={styles.cardTitle}>Collection</Text><Text style={styles.meta}>The order status will show when it is ready. Bring the order reference.</Text></Card>}
    <Card><Text style={styles.cardTitle}>Contact and allergy notes</Text><Field editable={!locked} label="Phone (optional)" value={phone} onChangeText={setPhone} keyboardType="phone-pad" autoComplete="tel" maxLength={30}/><Field editable={!locked} label="Allergy notes (optional)" value={allergyNotes} onChangeText={setAllergyNotes} multiline maxLength={500} hint="This does not replace speaking to the restaurant about severe allergies."/></Card>
    {firstOffers.length?<Card><Text style={styles.cardTitle}>First-order offers</Text><Text style={styles.meta}>Add an offer to your account. Eligible offers are then applied automatically.</Text>{firstOffers.map(c=><Button key={c.id} tone="secondary" disabled={locked} onPress={()=>void claimFirstOffer(c)}>Add to my offers: {c.title} · {offerBenefit(c)} · Ends {offerEndDate(c)}</Button>)}</Card>:null}
    <Card tone="info"><Text style={styles.cardTitle}>{quote?.promotion?"Eligible offer applied automatically":"Automatic offers"}</Text>{quote?.promotion?<><Text style={styles.lineName}>{quote.promotion.title}</Text>{quote.promotion.gift?<View style={styles.line}><Text style={styles.lineName}>{quote.promotion.gift.quantity} × {quote.promotion.gift.name} · Free item</Text><Text style={styles.price}>{money(0)}</Text></View>:null}{quote.promotion.campaignType==="buy_one_get_one"?<Text style={styles.meta}>Buy one, get one savings are included. Extras remain charged.</Text>:null}</>:<Text style={styles.meta}>{quote?"No eligible offer applies to this order right now.":"Eligible offers are checked automatically with your total."}</Text>}</Card>
    <Card><Text style={styles.cardTitle}>Payment</Text>{paymentChoices(restaurant.profile.cashEnabled).map((choice) => <Pressable accessibilityRole="radio" accessibilityState={{ checked: payment === choice.id, disabled: locked || !choice.available }} key={choice.id} disabled={locked || !choice.available} onPress={() => choice.id !== "apple_pay" && setPayment(choice.id)} style={[styles.payment, payment === choice.id && styles.paymentActive, !choice.available && styles.disabled]}><View style={{ flex: 1 }}><Text style={styles.lineName}>{choice.label}</Text><Text style={styles.meta}>{choice.description}</Text></View>{payment === choice.id ? <Pill>Selected</Pill> : null}</Pressable>)}</Card>
    <ErrorBanner message={error || (!recovering && !localCheck.ok ? localCheck.reason : "")}/><Button accessibilityLabel={recovering?"Retry original order":`Place order for ${money(totals.totalMinor)}`} busy={busy} disabled={!recovering && (!localCheck.ok || !quoteReady || !quote || quoting || claimingOffer || paymentConfig.providerMode === "unknown")} onPress={() => void placeOrder()}>{recovering ? "Retry original order" : "Place order"} · {money(totals.totalMinor)}</Button><Text style={styles.meta}>{paymentConfig.cardAvailable?`Card details are entered only on Stripe’s hosted ${paymentConfig.stripeMode||"test"} checkout. Returning does not prove payment; refresh the server status.`:paymentConfig.providerMode==="local_simulator"?"Mock card is deterministic local simulation. Cash is paid directly to the restaurant.":"Card capability is unavailable until provider status is confirmed. Cash, when offered, is paid directly to the restaurant."}</Text>
  </ScrollView>;
}
function Price({ label, value, strong }: { label: string; value: number; strong?: boolean }) { return <View style={styles.line}><Text style={[styles.meta, strong && styles.lineName]}>{label}</Text><Text style={[styles.price, strong && { fontSize: 19 }]}>{money(value)}</Text></View>; }
const styles = StyleSheet.create({ page: { padding: 18, paddingBottom: 44, gap: 14, backgroundColor: colours.cream }, line: { flexDirection: "row", gap: 12, justifyContent: "space-between" }, lineName: { flexShrink: 1, color: colours.ink, fontWeight: "800", lineHeight: 21 }, meta: { color: colours.muted, lineHeight: 21 }, price: { color: colours.ink, fontWeight: "800" }, rule: { height: 1, backgroundColor: colours.line, marginVertical: 2 }, cardTitle: { color: colours.ink, fontSize: 19, lineHeight: 26, fontWeight: "800" }, addressChip: { minWidth: 110, borderWidth: 1, borderColor: colours.line, borderRadius: 12, padding: 11, backgroundColor: colours.panel }, addressActive: { borderColor: colours.blue, backgroundColor: colours.sky }, addressLabel: { color: colours.ink, fontWeight: "800" }, switchRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12, minHeight: 44 }, switchLabel: { flex: 1, color: colours.ink, fontWeight: "700", lineHeight: 21 }, offer: { borderWidth: 1, borderColor: colours.line, padding: 12, borderRadius: 12, flexDirection: "row", gap: 10 }, offerActive: { borderColor: colours.blue, backgroundColor: colours.sky }, payment: { flexDirection: "row", gap: 10, padding: 12, borderWidth: 1, borderColor: colours.line, borderRadius: 12 }, paymentActive: { borderColor: colours.blue, backgroundColor: colours.sky }, disabled: { opacity: .5 } });
