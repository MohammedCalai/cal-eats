import { parseCustomerPushTarget } from "./push-model.ts";

export const CUSTOMER_QUIET_PUSH_CHANNEL = "cal-eats-updates-quiet";
export const customerQuietPushChannelSettings = {
  name: "Cal-Eats updates (silent)", importance: 4, sound: null,
  enableVibrate: false, lightColor: "#2865E9"
} as const;
export type CustomerPushChannel = { id: string; importance: number; sound: string | null; enableVibrate: boolean };

export function customerPushChannelAttention(channel: CustomerPushChannel | null): "missing" | "disabled" | "audible" | null {
  if (!channel || channel.id !== CUSTOMER_QUIET_PUSH_CHANNEL || !Number.isInteger(channel.importance) || channel.importance < 0 || channel.importance > 5) return "missing";
  if (channel.importance <= 0) return "disabled";
  if (channel.sound !== null || channel.enableVibrate !== false) return "audible";
  return null;
}

export function customerPushChannelId(trigger: unknown): string | null {
  if (!trigger || typeof trigger !== "object") return null;
  const value = trigger as { type?: unknown; remoteMessage?: { notification?: { channelId?: unknown } | null; data?: { channelId?: unknown } } };
  if (value.type !== "push") return null;
  // Match the installed Expo Android FirebaseNotificationTrigger precedence.
  const id = value.remoteMessage?.notification?.channelId ?? value.remoteMessage?.data?.channelId;
  return typeof id === "string" ? id : null;
}

export function customerForegroundPushBehavior(data: unknown, foregroundUserId: string | null, platform: string, androidApiLevel: number | string, channelId: string | null, channel: CustomerPushChannel | null) {
  const target = parseCustomerPushTarget(data), visible = Boolean(target && target.recipientUserId === foregroundUserId);
  // Expo57 uses this flag to allow Android heads-up presentation as well as
  // audio. On Android8+ audio/vibration are controlled by the native channel.
  // Allow it only after checking the exact incoming channel is still silent;
  // old Android, changed/unknown channels and all iOS alerts stay sound=false.
  const silentAndroidBanner = visible && platform === "android" && Number(androidApiLevel) >= 26
    && channelId === CUSTOMER_QUIET_PUSH_CHANNEL && customerPushChannelAttention(channel) === null;
  return { shouldShowBanner: visible, shouldShowList: visible, shouldPlaySound: silentAndroidBanner, shouldSetBadge: false };
}
