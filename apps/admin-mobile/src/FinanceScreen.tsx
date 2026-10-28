import { useState } from "react";
import { ActivityIndicator, Linking, Text, View } from "react-native";
import { api, json } from "./api";
import { money, operationKey, readable } from "./model";
import { Button, Card, colour, ErrorText, Page, Sheet, styles, Title, useForegroundRefresh, useRemote } from "./ui";

type Banking = { providerMode: string; configured: boolean; connected: boolean; canManageBankDetails: boolean; account: { status: string; chargesEnabled: boolean; payoutsEnabled: boolean }; bankDetailsAvailable: boolean; bankAccounts: Array<{ id: string; bankName: string | null; last4: string | null; country: string | null; currency: string | null; status: string; defaultForCurrency: boolean }>; payoutSchedule: { interval: string; weeklyAnchor: string }; refreshedAt: string | null; note: string };
type Payout = { id: string; amountMinor: number; currency: string; status: string; createdAt: string; expectedArrivalAt: string | null; paidAt: string | null; failure: string | null; destinationLast4?: string };
type PayoutPage = { items: Payout[]; hasMore: boolean; nextCursor: string | null; providerMode?: string };
export type OrderBreakdown = {
  orderId: string; restaurantId: string; providerMode: string;
  totals: { grossFoodMinor: number; restaurantDiscountMinor: number; foodChargedMinor: number; deliveryFeeMinor: number; customerChargedMinor: number; refundedTotalMinor: number; retainedCustomerPaymentMinor: number };
  commission: { rateBasisPoints: number; base: string; commissionableMinor: number; originalMinor: number; reversedMinor: number; retainedMinor: number; policyVersion: string; developmentAssumption: boolean; recognised: boolean };
  promotion: null | { title: string; offerType: string; discountMinor: number; freeItemRetailValueMinor: number; freeItems: Array<{ name: string; quantity: number; retailValueMinor: number }>; fundingParty: string };
  earnings: { originalMinor: number; refundImpactMinor: number; currentMinor: number; confirmed: boolean; providerFeeChargedToRestaurantMinor: number; providerFeeBorneBy: string };
  refunds: Array<{ id: string; foodMinor: number; deliveryMinor: number; commissionReversalMinor: number; createdAt: string }>;
  settlement: { state: string; label: string; transferredMinor: number; reversedTransferMinor: number; note: string };
};

const date = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("en-GB", { timeZone: "Europe/London", dateStyle: "medium", timeStyle: "short" }) : "Not available";
const currency = (value: number, code = "GBP") => new Intl.NumberFormat("en-GB", { style: "currency", currency: code }).format(value / 100);
function Figure({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) { return <View style={[styles.row, { alignItems: "flex-start", justifyContent: "space-between" }]}><Text style={[strong ? styles.text : styles.muted, { flex: 1 }]}>{label}</Text><Text style={strong ? styles.heading : styles.text}>{value}</Text></View>; }

export function FinanceScreen({ token, restaurantId, onClose }: { token: string; restaurantId: string; onClose: () => void }) {
  const root = `/api/restaurant/restaurants/${restaurantId}/finance/stripe`;
  const banking = useRemote<Banking>(`${root}/banking`, token);
  const [cursors, setCursors] = useState<Array<string | null>>([null]), [page, setPage] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const cursor = cursors[page];
  const payouts = useRemote<PayoutPage>(`${root}/payouts?pageSize=20${cursor ? `&startingAfter=${encodeURIComponent(cursor)}` : ""}`, token);
  const bank = banking.error ? null : banking.value;
  async function openStripe() {
    if (busy || !bank?.configured) return;
    setBusy(true); setError("");
    try {
      const action = bank.canManageBankDetails ? "dashboard" : "onboarding";
      const result = await api<{ url: string }>(`${root}/${action}`, json(token, "POST", {}, operationKey()));
      const target = new URL(result.url);
      if (target.protocol !== "https:" || !["connect.stripe.com", "dashboard.stripe.com"].includes(target.hostname) || target.username || target.password) throw new Error("The secure Stripe link could not be verified.");
      await Linking.openURL(target.href);
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }
  function refresh() { void banking.reload(); void payouts.reload(); }
  useForegroundRefresh(refresh, 60000);
  return <Sheet title="Bank and payouts" onClose={onClose}><Page loading={banking.loading || payouts.loading} onRefresh={refresh}>
    <Title title="Bank and payouts">Your Stripe bank destination and reported bank payouts.</Title>
    <ErrorText message={error || banking.error}/>
    {banking.loading && !bank && <ActivityIndicator color={colour.cyan}/>}
    {bank && <>
      {bank.providerMode !== "stripe_live" && <Text style={styles.hint}>Test or simulator mode. These records do not establish a real bank payment.</Text>}
      <Card><Text style={styles.heading}>Bank account</Text><Text style={styles.muted}>{bank.note}</Text>
        {bank.bankAccounts.length ? bank.bankAccounts.map(account => <View key={account.id} style={{ gap: 7 }}><Text style={styles.text}>{account.bankName || "Bank account"}{account.last4 ? ` · •••• ${account.last4}` : " · Account ending unavailable"}</Text><Text style={styles.muted}>{account.currency?.toUpperCase() || "Currency not reported"} · {account.country || "Country not reported"} · {readable(account.status)}{account.defaultForCurrency ? " · Default destination" : ""}</Text></View>) : <Text style={styles.text}>{bank.connected ? "No bank details are available from Stripe yet." : "No Stripe bank account is connected."}</Text>}
        <Text style={styles.hint}>Full bank details are managed on Stripe's secure pages.</Text>
        <Button busy={busy} disabled={!bank.configured} onPress={() => void openStripe()}>{bank.canManageBankDetails ? "Manage bank details in Stripe" : "Complete Stripe setup"}</Button>
        <Figure label="Account status" value={readable(bank.account.status)}/><Figure label="Payouts enabled" value={bank.account.payoutsEnabled ? "Yes" : "No"}/>
        <Text style={styles.hint}>Payout schedule: {readable(bank.payoutSchedule.interval)} · {readable(bank.payoutSchedule.weeklyAnchor)}. Arrival depends on Stripe and your bank.</Text>
        {bank.refreshedAt && <Text style={styles.hint}>Last refreshed: {date(bank.refreshedAt)}</Text>}
      </Card>
    </>}
    <Text style={styles.heading}>Bank payout history</Text><ErrorText message={payouts.error}/>
    {payouts.loading ? <ActivityIndicator color={colour.cyan}/> : !payouts.error && <>
      {!payouts.value?.items.length && <Card><Text style={styles.text}>No bank payouts are recorded for this page.</Text><Text style={styles.hint}>Cash payments and transfers into your Stripe balance are separate from bank payouts.</Text></Card>}
      {payouts.value?.items.map(payout => <Card key={payout.id}><Text style={styles.heading}>{currency(payout.amountMinor, payout.currency)}</Text><Text style={styles.badge}>{readable(payout.status)}</Text><Text selectable style={styles.hint}>{payout.id}</Text><Figure label="Payout created" value={date(payout.createdAt)}/><Figure label="Expected bank arrival" value={date(payout.expectedArrivalAt)}/>{payout.paidAt ? <Figure label="Stripe reported paid" value={date(payout.paidAt)}/> : payout.status === "paid" ? <Text style={styles.hint}>Stripe reports this payout as paid; an exact paid-event time is unavailable.</Text> : null}{payout.destinationLast4 && <Text style={styles.muted}>Destination ending {payout.destinationLast4}</Text>}{payout.failure && <ErrorText message={payout.failure}/>}</Card>)}
    </>}
    <View style={styles.row}><Button quiet disabled={page === 0 || payouts.loading} onPress={() => setPage(page - 1)}>Previous</Button><Text style={styles.muted}>Page {page + 1}</Text><Button quiet disabled={!payouts.value?.hasMore || !payouts.value.nextCursor || payouts.loading} onPress={() => { const next = payouts.value?.nextCursor; if (next) { setCursors(old => [...old.slice(0, page + 1), next]); setPage(page + 1); } }}>Next</Button></View>
  </Page></Sheet>;
}

export function OrderEarningsBreakdown({ token, restaurantId, orderId }: { token: string; restaurantId: string; orderId: string }) {
  const result = useRemote<OrderBreakdown>(`/api/restaurant/restaurants/${restaurantId}/finance/orders/${orderId}/breakdown`, token);
  const detail = result.error ? null : result.value;
  return <Card><Text style={styles.heading}>Commission and offers</Text><ErrorText message={result.error}/>{result.loading && !detail && <ActivityIndicator color={colour.cyan}/>}
    {detail && <>
      <Figure label="Food before discounts" value={money(detail.totals.grossFoodMinor)}/><Figure label="Restaurant-funded discount" value={detail.totals.restaurantDiscountMinor ? `−${money(detail.totals.restaurantDiscountMinor)}` : money(0)}/><Figure label="Food charged" value={money(detail.totals.foodChargedMinor)}/><Figure label="Delivery" value={money(detail.totals.deliveryFeeMinor)}/><Figure label="Customer total" value={money(detail.totals.customerChargedMinor)} strong/>
      <Text style={styles.muted}>Commission: {detail.commission.rateBasisPoints / 100}% of {detail.commission.base === "food_plus_delivery" ? "discounted food plus delivery" : "discounted food"} ({money(detail.commission.commissionableMinor)}).</Text>
      <Figure label="Original commission" value={money(detail.commission.originalMinor)}/><Figure label="Commission reversed" value={money(detail.commission.reversedMinor)}/><Figure label="Commission retained" value={money(detail.commission.retainedMinor)}/>
      {detail.promotion && <View style={{ gap: 7 }}><Text style={styles.heading}>{detail.promotion.title || "Restaurant offer"}</Text><Text style={styles.muted}>{readable(detail.promotion.offerType)} · funded by your restaurant</Text><Figure label="Discount applied" value={money(detail.promotion.discountMinor)}/>{detail.promotion.freeItems.map((item, index) => <Text key={`${item.name}:${index}`} style={styles.text}>{item.quantity} × {item.name} · free promotional item</Text>)}{detail.promotion.freeItemRetailValueMinor > 0 && <Text style={styles.hint}>Free-item retail value: {money(detail.promotion.freeItemRetailValueMinor)}. This is not your ingredient cost and is not deducted twice.</Text>}</View>}
      <Figure label="Customer refunds" value={money(detail.totals.refundedTotalMinor)}/><Figure label="Refund impact on earnings" value={money(detail.earnings.refundImpactMinor)}/><Figure label="Your remaining earnings" value={money(detail.earnings.currentMinor)} strong/>
      <Text style={styles.hint}>{detail.earnings.confirmed ? "Figures use this order's saved prices and promotion, including confirmed refund adjustments." : "Earnings are not confirmed until the order and payment are confirmed."} Payment processing costs are borne by the platform under this order's model.</Text>
      <Text style={styles.text}>{detail.settlement.label}</Text><Text style={styles.hint}>{detail.settlement.note}</Text>
      {detail.refunds.map(refund => <Text key={refund.id} style={styles.muted}>Refund {money(refund.foodMinor + refund.deliveryMinor)} · commission reversal {money(refund.commissionReversalMinor)} · {date(refund.createdAt)}</Text>)}
    </>}
    <Button quiet disabled={result.loading} onPress={() => void result.reload()}>Refresh breakdown</Button>
  </Card>;
}
