import { useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { api, json } from "./api";
import { money, readable, type PageInfo } from "./model";
import { Button, Card, Chip, Chips, colour, ErrorText, Page, Pagination, styles, Title, useForegroundRefresh, useRemote } from "./ui";
import { LiveOrders } from "./LiveOrders";

type Period = "today" | "yesterday" | "this_week" | "last_week";
type Destination = "orders" | "menu" | "messages" | "customers" | "offers" | "cases";
type OrderEarning = { id: string; createdAt: string; status: string; fulfillment: string; totalMinor?: number; refundsMinor?: number; commissionMinor?: number; netEarningsMinor?: number; paymentMethod?: string; payoutLabel?: string };
type Dashboard = {
 generatedAt?: string; comparison?: {fromDate:string;toDate:string;salesChangePercent:number|null;ordersChangePercent:number|null}; marketing?: {offerOrders:number;offerSalesMinor:number;discountMinor:number;activeOffers:number};
  range: { period: Period; label: string; fromDate: string; toDate: string };
  summary: { ordersPlaced: number; confirmedOrders: number; completedOrders: number; cancelledOrders: number };
  operations: { liveOrders: number; confirmedInKitchen: number; readyForHandover: number; pendingConfirmation: number; overdueConfirmation: number; activeOrders: number; unreadMessages: number; openRefundCases: number };
  finance: null | { period: { grossSalesMinor: number; refundsMinor: number; commissionMinor: number; netEarningsMinor: number; cashSalesMinor: number; cashCollectedMinor: number; cardSalesMinor: number; averageOrderMinor: number }; balance: { availableMinor: number; pendingMinor: number; heldMinor: number; bankPaidMinor: number; bankPendingMinor: number; cashCommissionOutstandingMinor: number; providerMode?: string } };
  topItems: Array<{ name: string; quantity: number }>;
  orders: { items: OrderEarning[]; pagination: PageInfo };
};
const periods: Array<[Period, string]> = [["yesterday", "Yesterday"], ["today", "Today"], ["this_week", "This week"], ["last_week", "Last week"]];

export function DashboardScreen({ token, restaurantId, canManage, onNavigate, onOrder, onFinance }: { token: string; restaurantId: string; canManage: boolean; onNavigate: (screen: Destination) => void; onOrder: (id: string) => void; onFinance: () => void }) {
  const [period, setPeriod] = useState<Period>("today"), [page, setPage] = useState(1);
  const result = useRemote<Dashboard>(`/api/restaurant/restaurants/${restaurantId}/dashboard?period=${period}&page=${page}&pageSize=20`, token);
  useForegroundRefresh(result.reload, 5000);
  const current = result.value?.range.period === period && result.value?.orders.pagination.page === page && !result.error ? result.value : null;
  const finance = canManage ? current?.finance : null;
  function choose(value: Period) { setPeriod(value); setPage(1); }
  return <Page loading={result.loading} onRefresh={() => void result.reload()}>
    <Title title="Dashboard">Your restaurant at a glance</Title>
    {canManage&&current&&<View style={[styles.card,{borderColor:current.operations.unreadMessages?colour.blue:colour.border}]}><Text style={styles.heading}>Customer messages</Text><Text style={styles.muted}>{current.operations.unreadMessages} unread message{current.operations.unreadMessages===1?"":"s"}</Text><Button onPress={()=>onNavigate("messages")}>Open customer inbox</Button></View>}
    {current && <LiveOrders operations={current.operations} onOpen={() => onNavigate("orders")}/>}
    <Chips>{periods.map(([value, label]) => <Chip key={value} selected={value === period} onPress={() => choose(value)}>{label}</Chip>)}</Chips>
    <ErrorText message={result.error}/>
    {!current && result.loading && <ActivityIndicator color={colour.cyan}/>}
    {current && <>
      <View style={{flexDirection:"row",gap:12,alignItems:"stretch"}}>{finance&&<Hero title="Total sales" value={money(finance.period.grossSalesMinor)} change={current.comparison?.salesChangePercent} hint="Net earnings" detail={money(finance.period.netEarningsMinor)}/>}<Hero title="Orders placed" value={String(current.summary.ordersPlaced)} change={current.comparison?.ordersChangePercent} hint={finance?"Average order":"Confirmed orders"} detail={finance?money(finance.period.averageOrderMinor):String(current.summary.confirmedOrders)}/></View>
{current.comparison&&<Text style={styles.hint}>Compared with {current.comparison.fromDate} – {current.comparison.toDate} · same period last week</Text>}
{current.marketing&&canManage&&<Card><Text style={styles.heading}>Marketing overview</Text><Metric label="Sales from offer orders" value={money(current.marketing.offerSalesMinor)}/><Metric label="Orders using offers" value={String(current.marketing.offerOrders)}/><Metric label="Active customer offers" value={String(current.marketing.activeOffers)}/><Metric label="Food discounts" value={money(current.marketing.discountMinor)}/><Text style={styles.hint}>Confirmed order sales before refunds. Ingredient costs are not estimated.</Text><Button quiet onPress={()=>onNavigate("offers")}>Manage offers</Button></Card>}
<Text style={styles.hint}>{current.range.fromDate} – {current.range.toDate} · UK time · weeks start Monday</Text>
      <Card><Text style={styles.heading}>Needs attention now</Text>
        <Button quiet onPress={() => onNavigate("orders")}>{current.operations.pendingConfirmation} orders to confirm{current.operations.overdueConfirmation ? ` · ${current.operations.overdueConfirmation} overdue` : ""}</Button>
        <Text style={styles.text}>{current.operations.activeOrders} active orders</Text>
        {canManage && <><Button quiet onPress={() => onNavigate("messages")}>{current.operations.unreadMessages} unread messages</Button><Button quiet onPress={() => onNavigate("cases")}>{current.operations.openRefundCases} open refund cases</Button></>}
      </Card>
      <Card><Text style={styles.heading}>{current.range.label}</Text>
        <Metric label="Orders placed" value={String(current.summary.ordersPlaced)}/>
        <Metric label="Confirmed orders" value={String(current.summary.confirmedOrders)}/>
        <Metric label="Completed orders" value={String(current.summary.completedOrders)}/>
        <Metric label="Cancelled orders" value={String(current.summary.cancelledOrders)}/>
        {finance && <><Metric label="Sales" value={money(finance.period.grossSalesMinor)}/><Metric label="Refunds" value={money(finance.period.refundsMinor)}/><Metric label="Commission" value={money(finance.period.commissionMinor)}/><Metric label="Net earnings" value={money(finance.period.netEarningsMinor)}/><Metric label="Average confirmed order" value={money(finance.period.averageOrderMinor)}/><Metric label="Cash orders" value={money(finance.period.cashSalesMinor)}/><Metric label="Cash recorded collected" value={money(finance.period.cashCollectedMinor)}/><Metric label="Card orders" value={money(finance.period.cardSalesMinor)}/></>}
        <Text style={styles.hint}>Orders placed in this period. Sales include confirmed orders and their current refunds. Cash is collected directly by your restaurant.</Text>
      </Card>
      {finance && <Card><Text style={styles.heading}>Current balance · all dates</Text>
        <Metric label="Available" value={money(finance.balance.availableMinor)}/><Metric label="Pending" value={money(finance.balance.pendingMinor)}/><Metric label="Held" value={money(finance.balance.heldMinor)}/><Metric label="Bank payouts recorded" value={money(finance.balance.bankPaidMinor)}/><Metric label="Bank payouts pending" value={money(finance.balance.bankPendingMinor)}/>
        <Text style={styles.hint}>A transfer to your connected balance is separate from a payout to your bank. {finance.balance.providerMode !== "stripe_live" ? "This preview uses test or simulated payment records." : ""}</Text>
        <Button onPress={onFinance}>Bank details and payout history</Button>
      </Card>}
      {canManage && <WeeklyStatement token={token} restaurantId={restaurantId}/>}
      {current.topItems.length > 0 && <Card><Text style={styles.heading}>Popular items</Text>{current.topItems.slice(0, 5).map(item => <Metric key={item.name} label={item.name} value={`${item.quantity} sold`}/>)}</Card>}
      <Text style={styles.heading}>{canManage ? "Earnings by order" : "Orders in this period"}</Text>
      {!current.orders.items.length && <Text style={styles.muted}>No orders in this period.</Text>}
      {current.orders.items.map(order => <Card key={order.id}>
        <Text style={styles.heading}>#{order.id.slice(0, 8).toUpperCase()}</Text><Text style={styles.muted}>{new Date(order.createdAt).toLocaleString("en-GB", { timeZone: "Europe/London" })} · {readable(order.status)} · {readable(order.fulfillment)}</Text>
        {canManage && <><Metric label="Order total" value={money(order.totalMinor)}/><Metric label="Refunds" value={money(order.refundsMinor)}/><Metric label="Commission" value={money(order.commissionMinor)}/><Metric label="Net earnings" value={money(order.netEarningsMinor)}/><Text style={styles.text}>{order.payoutLabel || "No payout recorded"}</Text></>}
        <Button quiet onPress={() => onOrder(order.id)}>View order</Button>
      </Card>)}
      <Pagination value={current.orders.pagination} page={page} onPage={setPage} busy={result.loading}/>
      <Button quiet onPress={() => onNavigate("menu")}>Update menu and availability</Button>
    </>}
  </Page>;
}

function Metric({ label, value }: { label: string; value: string }) { return <View style={[styles.row, { justifyContent: "space-between" }]}><Text style={[styles.muted, { flex: 1 }]}>{label}</Text><Text style={styles.text}>{value}</Text></View>; }

type StatementSettings = { enabled: boolean; recipient: string; nextScheduledAt: string | null; email: { realDeliveryEnabled: boolean; configured: boolean } };
function WeeklyStatement({ token, restaurantId }: { token: string; restaurantId: string }) {
  const route = `/api/restaurant/restaurants/${restaurantId}/weekly-statements/settings`;
  const settings = useRemote<StatementSettings>(route, token);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function toggle() {
    if (!settings.value || busy) return;
    setBusy(true); setError("");
    try { settings.setValue(await api<StatementSettings>(route, json(token, "PATCH", { enabled: !settings.value.enabled }))); }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }
  return <Card><Text style={styles.heading}>Your weekly statement</Text>
    <Text style={styles.muted}>Monday at 9 a.m. UK time, covering the previous Monday–Sunday.</Text>
    <ErrorText message={error || settings.error}/>
    {settings.value && <><Text style={styles.text}>{settings.value.recipient}</Text><Text style={styles.text}>{settings.value.enabled ? "Weekly schedule on" : "Weekly schedule paused"}</Text>
      {settings.value.nextScheduledAt && <Text style={styles.hint}>Next statement: {new Date(settings.value.nextScheduledAt).toLocaleString("en-GB", { timeZone: "Europe/London" })}</Text>}
      <Text style={styles.hint}>{settings.value.email.realDeliveryEnabled && settings.value.email.configured ? "Email delivery is enabled." : "Email delivery is not active yet. Statements are saved as previews until sending is connected."}</Text>
      <Button quiet busy={busy} disabled={settings.loading} onPress={() => void toggle()}>{settings.value.enabled ? "Pause weekly statements" : "Enable weekly statements"}</Button>
    </>}
    {!settings.value && settings.loading && <ActivityIndicator color={colour.cyan}/>}
  </Card>;
}

function Hero({title,value,change,hint,detail}:{title:string;value:string;change?:number|null;hint:string;detail:string}){return <View style={[styles.card,{flex:1,minWidth:0,gap:12,padding:16}]}><Text style={styles.muted}>{title}</Text><Text adjustsFontSizeToFit numberOfLines={1} style={{color:colour.text,fontSize:32,fontWeight:"800"}}>{value}</Text>{change!==undefined&&<Text style={{color:change!==null&&change<0?colour.danger:colour.success,fontSize:13}}>{change===null?"New":`${change>0?"↑ ":change<0?"↓ ":""}${Math.abs(change)}%`}</Text>}<View style={{borderTopWidth:1,borderTopColor:colour.border,paddingTop:10,gap:5}}><Text style={styles.hint}>{hint}</Text><Text style={styles.text}>{detail}</Text></View></View>;}
