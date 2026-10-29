import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { api, dashboardCsv, json } from "./api";
import { shareDashboardCsvFile } from "./share-dashboard-csv";
import { readable, type PageInfo } from "./model";
import { Button, Card, Chip, Chips, colour, ErrorText, Page, Pagination, styles, Title, useForegroundRefresh, useRemote } from "./ui";
import { LiveOrders } from "./LiveOrders";

type Period = "today" | "yesterday" | "this_week" | "last_week";
type Destination = "orders" | "menu" | "messages" | "customers" | "offers" | "cases";
type OperationalOrder = { id: string; createdAt: string; status: string; fulfillment: string };
type Dashboard = {
 generatedAt?: string;
  range: { period: Period; label: string; fromDate: string; toDate: string };
  summary: { ordersPlaced: number; confirmedOrders: number; completedOrders: number; cancelledOrders: number };
  operations: { liveOrders: number; confirmedInKitchen: number; readyForHandover: number; pendingConfirmation: number; overdueConfirmation: number; activeOrders: number; unreadMessages: number; openRefundCases: number };
  topItems: Array<{ name: string; quantity: number }>;
  orders: { items: OperationalOrder[]; pagination: PageInfo };
};
const periods: Array<[Period, string]> = [["yesterday", "Yesterday"], ["today", "Today"], ["this_week", "This week"], ["last_week", "Last week"]];

export function DashboardScreen({ token, restaurantId, canManage, onNavigate, onOrder, onFinance }: { token: string; restaurantId: string; canManage: boolean; onNavigate: (screen: Destination) => void; onOrder: (id: string) => void; onFinance: () => void }) {
  const [period, setPeriod] = useState<Period>("today"), [page, setPage] = useState(1);
  const result = useRemote<Dashboard>(`/api/restaurant/restaurants/${restaurantId}/dashboard?period=${period}&view=operations&page=${page}&pageSize=20`, token);
  useForegroundRefresh(result.reload, 5000);
  const current = result.value?.range.period === period && result.value?.orders.pagination.page === page && !result.error ? result.value : null;

  const [sharing, setSharing] = useState<"metrics" | "orders" | null>(null), [shareError, setShareError] = useState("");
  const exportRequest = useRef<AbortController | null>(null), context = useRef({ restaurantId, period, token, canManage });
  context.current = { restaurantId, period, token, canManage };
  useEffect(() => { setShareError(""); setSharing(null); return () => { exportRequest.current?.abort(); exportRequest.current = null; }; }, [restaurantId, period, token, canManage]);
  async function shareCsv(kind: "metrics" | "orders") {
    if (!canManage || exportRequest.current) return;
    const requested = { restaurantId, period, token }, controller = new AbortController();
    exportRequest.current = controller; setSharing(kind); setShareError("");
    try {
      const result = await dashboardCsv({ ...requested, kind, signal: controller.signal });
      const isCurrent = () => !controller.signal.aborted && exportRequest.current === controller && context.current.canManage && context.current.restaurantId === requested.restaurantId && context.current.period === requested.period && context.current.token === requested.token;
      await shareDashboardCsvFile(result.csv, result.filename, isCurrent);
    } catch (error) { if (exportRequest.current === controller && !controller.signal.aborted) setShareError((error as Error).message); }
    finally { if (exportRequest.current === controller) { exportRequest.current = null; setSharing(null); } }
  }
  function choose(value: Period) { setPeriod(value); setPage(1); }
  return <Page loading={result.loading} onRefresh={() => void result.reload()}>
    <Title title="Dashboard">Your restaurant at a glance</Title>
    {canManage&&current&&<View style={[styles.card,{borderColor:current.operations.unreadMessages?colour.blue:colour.border}]}><Text style={styles.heading}>Customer messages</Text><Text style={styles.muted}>{current.operations.unreadMessages} unread message{current.operations.unreadMessages===1?"":"s"}</Text><Button onPress={()=>onNavigate("messages")}>Open customer inbox</Button></View>}
    {current && <LiveOrders operations={current.operations} onOpen={() => onNavigate("orders")}/>}
    <Chips>{periods.map(([value, label]) => <Chip key={value} selected={value === period} onPress={() => choose(value)}>{label}</Chip>)}</Chips>
    {canManage && <Card><Text style={styles.heading}>Export {periods.find(([value]) => value === period)?.[1].toLowerCase()}</Text><Text style={styles.hint}>Save a CSV file or share it with another app. Exports use the selected period.</Text><ErrorText message={shareError}/><Button quiet disabled={Boolean(sharing)} busy={sharing === "metrics"} onPress={() => void shareCsv("metrics")}>Save or share statistics CSV</Button><Button quiet disabled={Boolean(sharing)} busy={sharing === "orders"} onPress={() => void shareCsv("orders")}>Save or share orders CSV</Button></Card>}
    <ErrorText message={result.error}/>
    {!current && result.loading && <ActivityIndicator color={colour.cyan}/>}
    {current && <>
      <View style={{flexDirection:"row",gap:12,alignItems:"stretch"}}><Hero title="Orders placed" value={String(current.summary.ordersPlaced)} hint="Confirmed orders" detail={String(current.summary.confirmedOrders)}/><Hero title="Completed orders" value={String(current.summary.completedOrders)} hint="Preparing now" detail={String(current.operations.confirmedInKitchen)}/></View>
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
        <Text style={styles.hint}>Orders placed in this period. Live order counts show the current state across all dates.</Text>
      </Card>
      {canManage && <WeeklyStatement token={token} restaurantId={restaurantId}/>}
      {current.topItems.length > 0 && <Card><Text style={styles.heading}>Popular items</Text>{current.topItems.slice(0, 5).map(item => <Metric key={item.name} label={item.name} value={`${item.quantity} sold`}/>)}</Card>}
      <Text style={styles.heading}>Orders in this period</Text>
      {!current.orders.items.length && <Text style={styles.muted}>No orders in this period.</Text>}
      {current.orders.items.map(order => <Card key={order.id}>
        <Text style={styles.heading}>#{order.id.slice(0, 8).toUpperCase()}</Text><Text style={styles.muted}>{new Date(order.createdAt).toLocaleString("en-GB", { timeZone: "Europe/London" })} · {readable(order.status)} · {readable(order.fulfillment)}</Text>
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
