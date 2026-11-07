import { useEffect, useRef } from "react";
import { AppState, Linking, Platform } from "react-native";
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import { api } from "./api";
import { getInstallationId } from "./installation-id";
import { createLiveActivityController } from "./live-activity-controller";
import { isLiveActivityAuthError, LIVE_ACTIVITY_PROJECT_ID, liveOrderPaymentEligible, parseLiveActivityOrderLink } from "./live-activity-model";
import type { LiveActivityFeed, LiveActivityIdentity, LiveActivityRegistration } from "./live-activity-model";
import { liveOrderActivitiesSupported, liveOrderFactory } from "./live-order-activity";
import type { Order } from "./types";

type Options = { token: string | null; userId: string | null; booting: boolean; sessionUncertain: boolean; blocked: boolean; onOpenOrder: (id: string) => void; onSignIn: () => void };
const storeKey = "cal_eats_live_orders_v1";
export function useCustomerLiveActivity(options: Options) {
  const latest = useRef(options); latest.current = options;
  const current = useRef<LiveActivityIdentity | null>(null), generation = useRef(0), disabledToken = useRef<string | null>(null), inFlight = useRef<Promise<void> | null>(null), again = useRef(false);
  const pendingLink = useRef<{ orderId: string; userId: string | null; prompted?: boolean } | null>(null);
  const controllerRef = useRef<ReturnType<typeof createLiveActivityController> | null>(null);
  if (!controllerRef.current) controllerRef.current = createLiveActivityController({
    factory: liveOrderFactory,
    read: async () => { const text = await SecureStore.getItemAsync(storeKey); if (!text) return []; try { return JSON.parse(text); } catch { return []; } },
    write: rows => SecureStore.setItemAsync(storeKey, JSON.stringify(rows), { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK }),
    register: (identity, body) => api<LiveActivityRegistration>("/api/native/live-activities", { method: "POST", token: identity.token, body: JSON.stringify({ ...body, installationId: identity.installationId, platform: "ios", projectId: LIVE_ACTIVITY_PROJECT_ID }) }),
    unregister: (identity, id) => api(`/api/native/live-activities/${encodeURIComponent(id)}`, { method: "DELETE", token: identity.token }),
    orderState: async (identity, id) => { const order = await api<Order>(`/api/orders/${encodeURIComponent(id)}`, { token: identity.token }); return { status: order.status, paymentEligible: liveOrderPaymentEligible(order) }; }
  });
  const controller = controllerRef.current;
  const supported = Platform.OS === "ios" && liveOrderActivitiesSupported && (Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId) === LIVE_ACTIVITY_PROJECT_ID;

  async function openPendingLink() {
    const link = pendingLink.current, o = latest.current;
    if (!link || o.booting || o.sessionUncertain || o.blocked || o.token && disabledToken.current === o.token) return;
    if (!o.token || !o.userId) { if (!link.prompted) { link.prompted = true; o.onSignIn(); } return; }
    if (link.userId && link.userId !== o.userId) { pendingLink.current = null; return; }
    const token = o.token, userId = o.userId;
    try {
      const order = await api<Order>(`/api/orders/${encodeURIComponent(link.orderId)}`, { token });
      if (pendingLink.current !== link || latest.current.token !== token || latest.current.userId !== userId || latest.current.blocked || latest.current.booting || latest.current.sessionUncertain || disabledToken.current === token || order.id !== link.orderId) return;
      pendingLink.current = null; latest.current.onOpenOrder(link.orderId);
    } catch (error) { if (pendingLink.current === link && latest.current.token === token && latest.current.userId === userId && (isLiveActivityAuthError(error) || [404, 410].includes(Number((error as { status?: number }).status)))) pendingLink.current = null; }
  }
  async function refresh() {
    if (!supported) return;
    await openPendingLink();
    const scope = current.current, o = latest.current;
    if (!scope || AppState.currentState !== "active" || o.booting || o.sessionUncertain || o.token !== scope.token || o.userId !== scope.userId || disabledToken.current === scope.token) return;
    if (inFlight.current) { again.current = true; return inFlight.current; }
    const work = (async () => {
      try { const feed = await api<LiveActivityFeed>("/api/native/live-activities", { token: scope.token }); if (current.current === scope && latest.current.token === scope.token) await controller.sync(scope, feed); }
      catch (error) { if (isLiveActivityAuthError(error) && current.current === scope) { disabledToken.current = scope.token; await controller.loseAuthorization(scope); } }
    })();
    inFlight.current = work;
    try { await work; } finally { if (inFlight.current === work) inFlight.current = null; if (again.current) { again.current = false; void refresh(); } }
  }
  useEffect(() => {
    if (!supported || options.booting || options.sessionUncertain) return;
    const version = ++generation.current, token = options.token, userId = options.userId;
    if (disabledToken.current && disabledToken.current !== token) disabledToken.current = null;
    if (!token || !userId) { current.current = null; void controller.activate(null).catch(() => undefined); return; }
    void (async () => {
      const installationId = await getInstallationId();
      if (generation.current !== version || latest.current.token !== token || latest.current.userId !== userId) return;
      const identity = { token, userId, installationId }; current.current = identity;
      await controller.activate(identity); if (generation.current === version) await refresh();
    })().catch(() => undefined);
    return () => { generation.current++; };
  }, [options.token, options.userId, options.booting, options.sessionUncertain, supported, controller]);
  useEffect(() => { if (supported) void openPendingLink(); }, [options.token, options.userId, options.booting, options.blocked, options.sessionUncertain, supported]);
  useEffect(() => {
    if (!supported) return;
    let mounted = true;
    const receive = (url: string) => { const orderId = parseLiveActivityOrderLink(url); if (mounted && orderId) { pendingLink.current = { orderId, userId: latest.current.userId }; void openPendingLink(); } };
    const link = Linking.addEventListener("url", event => receive(event.url));
    void Linking.getInitialURL().then(url => { if (url) receive(url); }).catch(() => undefined);
    const foreground = AppState.addEventListener("change", state => { if (state === "active") void refresh(); });
    const timer = setInterval(() => void refresh(), 15_000);
    return () => { mounted = false; link.remove(); foreground.remove(); clearInterval(timer); };
  }, [supported]);
  async function stop() {
    generation.current++; disabledToken.current = latest.current.token; current.current = null; pendingLink.current = null; again.current = false;
    await controller.stop().catch(() => undefined);
  }
  return { refresh, stop };
}
