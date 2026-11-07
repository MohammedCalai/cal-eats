import { useEffect, useRef, useState } from "react";
import { AppState, Linking, Platform } from "react-native";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { getInstallationId } from "./installation-id";
import { api } from "./api";
import { createPushDeviceBinding, type PushDeviceResult } from "./push-binding";
import { createCustomerPushTapQueue, customerPushProject, parseCustomerPushTarget, type CustomerPushTarget } from "./push-model";

export type CustomerPushState = { status: "checking" | "enabled" | "pending" | "permission_needed" | "blocked" | "unavailable" | "error"; message: string };
type Options = { token: string | null; userId: string | null; booting: boolean; blocked: boolean; unreadCount: number; onOpen: (target: CustomerPushTarget) => void; onReceived: () => Promise<unknown>; onSignIn: () => void };
const native = Platform.OS === "ios" || Platform.OS === "android";
let foregroundCustomer: string | null = null;
let lastResponse: Notifications.NotificationResponse | null = null;
const responseListeners = new Set<(response: Notifications.NotificationResponse) => void>();

// Register before App mounts so a tap that launches a closed iPhone app is kept.
if (native) {
  Notifications.setNotificationHandler({ handleNotification: async notification => {
    const target = parseCustomerPushTarget(notification.request.content.data);
    const visible = Boolean(target && target.recipientUserId === foregroundCustomer);
    return { shouldShowBanner: visible, shouldShowList: visible, shouldPlaySound: false, shouldSetBadge: false };
  } });
  Notifications.addNotificationResponseReceivedListener(response => { lastResponse = response; responseListeners.forEach(listener => listener(response)); });
  try { lastResponse = Notifications.getLastNotificationResponse(); } catch { /* A browser preview has no native notification response. */ }
}

function clearResponse(key: string) {
  if (lastResponse?.notification.request.identifier !== key) return;
  lastResponse = null;
  try { Notifications.clearLastNotificationResponse(); } catch { /* It can be cleared on a later launch. */ }
  void Notifications.dismissNotificationAsync(key).catch(() => undefined);
}

export function useCustomerPush(options: Options) {
  const latest = useRef(options); latest.current = options;
  const generation = useRef(0), disabledSession = useRef<string | null>(null), runRegistration = useRef<((ask: boolean) => Promise<void>) | null>(null);
  const [state, setState] = useState<CustomerPushState>(native ? { status: "checking", message: "Checking phone notifications…" } : { status: "unavailable", message: "Phone notifications are available in the installed Cal-Eats app." });
  const [responseVersion, setResponseVersion] = useState(0), [queue] = useState(createCustomerPushTapQueue);
  const authPromptKey = useRef<string | null>(null);
  const [binding] = useState(() => createPushDeviceBinding(
    (token, device) => api<PushDeviceResult>("/api/native/push/devices", { method: "POST", token, body: JSON.stringify(device) }),
    (token, installationId) => api(`/api/native/push/devices/${encodeURIComponent(installationId)}`, { method: "DELETE", token })
  ));

  useEffect(() => {
    foregroundCustomer = options.token && disabledSession.current !== options.token ? options.userId : null;
    return () => { foregroundCustomer = null; };
  }, [options.token, options.userId]);

  useEffect(() => {
    if (!native) return;
    const receive = (response: Notifications.NotificationResponse) => {
      if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER || disabledSession.current && disabledSession.current === latest.current.token) return;
      if (queue.receive(response.notification.request.identifier, response.notification.request.content.data)) setResponseVersion(value => value + 1);
    };
    responseListeners.add(receive); if (lastResponse) receive(lastResponse);
    const received = Notifications.addNotificationReceivedListener(notification => {
      const target = parseCustomerPushTarget(notification.request.content.data), current = latest.current;
      if (current.token && current.token !== disabledSession.current && target?.recipientUserId === current.userId) void current.onReceived().catch(() => undefined);
    });
    return () => { responseListeners.delete(receive); received.remove(); };
  }, [queue]);

  useEffect(() => {
    const current = latest.current, key = queue.waitingKey();
    if (current.booting || !key || current.blocked) return;
    if (!current.token || !current.userId) { if (authPromptKey.current !== key) { authPromptKey.current = key; current.onSignIn(); } return; }
    if (disabledSession.current === current.token) return;
    const response = queue.take(current.userId, false); clearResponse(key);
    if (!response) return;
    current.onOpen(response.target);
    void api(`/api/notifications/${encodeURIComponent(response.target.notificationId)}`, { method: "PATCH", token: current.token, body: JSON.stringify({ read: true }) }).then(() => latest.current.onReceived()).catch(() => undefined);
  }, [options.token, options.userId, options.booting, options.blocked, responseVersion, queue]);

  useEffect(() => {
    if (!native || !options.token || !options.userId) return;
    const token = options.token, scope = ++generation.current;
    if (disabledSession.current && disabledSession.current !== token) disabledSession.current = null;
    const current = () => generation.current === scope && latest.current.token === token && disabledSession.current !== token;
    binding.activate(token);
    let inFlight: Promise<void> | null = null, rerun = false, rerunAsk = false;
    let devicePushToken: Notifications.DevicePushToken | undefined;
    async function connect(ask: boolean) {
      if (Constants.appOwnership === "expo") { if (current()) setState({ status: "unavailable", message: "Phone notifications need the installed Cal-Eats app. They are unavailable in this preview." }); return; }
      const projectId = customerPushProject(Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId, Platform.OS);
      if (!projectId) { if (current()) setState({ status: "unavailable", message: "Phone notifications are not configured in this build yet." }); return; }
      if (current()) setState({ status: "checking", message: "Connecting phone notifications…" });
      if (Platform.OS === "android") {
        await Notifications.setNotificationChannelAsync("cal-eats-updates-quiet", { name: "Cal-Eats updates (silent)", importance: Notifications.AndroidImportance.HIGH, sound: null, enableVibrate: false, lightColor: "#2865E9" });
      }
      if (!current()) return;
      let permission = await Notifications.getPermissionsAsync();
      if (current() && permission.canAskAgain && (permission.status === "undetermined" || ask && permission.status !== "granted")) permission = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: true, allowSound: false } });
      if (!current()) return;
      if (!permission.granted && permission.ios?.status !== Notifications.IosAuthorizationStatus.PROVISIONAL) {
        await getInstallationId().then(id => binding.unbind(token, id)).catch(() => undefined); if (!current()) return;
        setState({ status: permission.canAskAgain ? "permission_needed" : "blocked", message: "Allow Cal-Eats notifications in your phone settings to receive order updates, messages and offers when the app is closed." }); return;
      }
      const installationId = await getInstallationId();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const pushToken = await Promise.race([
        Notifications.getExpoPushTokenAsync({ projectId, ...(devicePushToken ? { devicePushToken } : {}) }),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Push connection timed out")), 15_000); })
      ]).finally(() => clearTimeout(timeout));
      if (!current()) return;
      binding.activate(token);
      const result = await binding.bind(token, { installationId, expoPushToken: pushToken.data, platform: Platform.OS as "ios" | "android", projectId, soundEnabled: false });
      if (!current() || !result) return;
      setState(result.pushEnabled ? { status: "enabled", message: "Order updates, messages and eligible offers can appear on your phone, even when Cal-Eats is closed." } : { status: "pending", message: "Your phone is connected. Cal-Eats is finishing notification setup." });
    }
    function run(ask: boolean): Promise<void> {
      if (!current()) return Promise.resolve();
      if (inFlight) { rerun = true; rerunAsk ||= ask; return inFlight; }
      inFlight = connect(ask).catch(() => { if (current()) setState({ status: "error", message: "Phone notifications could not be connected. Check your connection and try again." }); }).finally(() => {
        inFlight = null; if (rerun && current()) { const askAgain = rerunAsk; rerun = false; rerunAsk = false; void run(askAgain); }
      });
      return inFlight;
    }
    runRegistration.current = run; void run(false);
    const foreground = AppState.addEventListener("change", value => { if (value === "active") void run(false); });
    const rolled = Notifications.addPushTokenListener(value => { devicePushToken = value; void run(false); });
    return () => {
      generation.current++; if (runRegistration.current === run) runRegistration.current = null; foreground.remove(); rolled.remove();
      void getInstallationId().then(id => binding.unbind(token, id)).catch(() => undefined);
    };
  }, [options.token, options.userId, binding]);

  useEffect(() => { if (native) void Notifications.setBadgeCountAsync(options.token ? options.unreadCount : 0).catch(() => undefined); }, [options.token, options.unreadCount]);

  async function requestPermission() {
    if (state.status === "blocked" || state.status === "enabled") {
      try { await Linking.openSettings(); } catch { setState({ status: "error", message: "Phone settings could not be opened. Open Settings on your phone and choose Cal-Eats." }); }
    } else await runRegistration.current?.(true);
  }
  async function unregister() {
    const token = latest.current.token; disabledSession.current = token; generation.current++; foregroundCustomer = null; queue.clear(); authPromptKey.current = null;
    if (lastResponse) clearResponse(lastResponse.notification.request.identifier);
    await Promise.allSettled([
      token ? getInstallationId().then(id => binding.unbind(token, id)) : Promise.resolve(),
      native ? Notifications.dismissAllNotificationsAsync() : Promise.resolve(),
      native ? Notifications.setBadgeCountAsync(0) : Promise.resolve()
    ]);
  }
  return { state, requestPermission, unregister };
}
