import { parseCustomerPushTarget } from "./push-model.ts";

export const LEGACY_CUSTOMER_QUIET_PUSH_CHANNEL = "cal-eats-updates-quiet";
export const CUSTOMER_QUIET_PUSH_CHANNEL = "cal-eats-updates-quiet-v2";
export type CustomerPushImportance = { NONE: number; MIN: number; LOW: number; DEFAULT: number; HIGH: number; MAX: number };
export function customerQuietPushChannelSettings(importance: CustomerPushImportance) {
  // Expo's enum is translated by its native module. Never substitute Android's
  // raw NotificationManager integers (native HIGH=4 is Expo LOW).
  return { name: "Cal-Eats quiet updates", importance: importance.HIGH, sound: null, enableVibrate: false, lightColor: "#2865E9" } as const;
}
export type CustomerPushChannel = { id: string; importance: number; sound: string | null; enableVibrate: boolean };

export const isCustomerQuietPushChannel = (id: string | null): id is string => id === CUSTOMER_QUIET_PUSH_CHANNEL || id === LEGACY_CUSTOMER_QUIET_PUSH_CHANNEL;
export function customerPushChannelAttention(channel: CustomerPushChannel | null, importance: CustomerPushImportance): "missing" | "disabled" | "audible" | null {
  if (!channel || !isCustomerQuietPushChannel(channel.id)) return "missing";
  if (channel.importance === importance.NONE) return "disabled";
  if (![importance.MIN, importance.LOW, importance.DEFAULT, importance.HIGH, importance.MAX].includes(channel.importance)) return "missing";
  if (channel.sound !== null || channel.enableVibrate !== false) return "audible";
  return null;
}

export function customerPushChannelPlan(current: CustomerPushChannel | null, legacy: CustomerPushChannel | null, ask: boolean, importance: CustomerPushImportance) {
  if (current) return { channelId: CUSTOMER_QUIET_PUSH_CHANNEL, channel: current, create: false, canMigrate: false };
  if (!legacy) return { channelId: CUSTOMER_QUIET_PUSH_CHANNEL, channel: null, create: true, canMigrate: false };
  // The SDK cannot tell whether a low channel was created by Android20 or
  // lowered by its owner. Require an affirmative setup action before replacing
  // that exact quiet LOW channel; never migrate disabled/audible/other choices.
  const canMigrate = customerPushChannelAttention(legacy, importance) === null && legacy.importance === importance.LOW;
  return canMigrate && ask
    ? { channelId: CUSTOMER_QUIET_PUSH_CHANNEL, channel: null, create: true, canMigrate: false }
    : { channelId: LEGACY_CUSTOMER_QUIET_PUSH_CHANNEL, channel: legacy, create: false, canMigrate };
}

export function customerPushChannelId(trigger: unknown): string | null {
  if (!trigger || typeof trigger !== "object") return null;
  const value = trigger as { type?: unknown; remoteMessage?: { notification?: { channelId?: unknown } | null; data?: { channelId?: unknown } } };
  if (value.type !== "push") return null;
  // Match the installed Expo Android FirebaseNotificationTrigger precedence.
  const id = value.remoteMessage?.notification?.channelId ?? value.remoteMessage?.data?.channelId;
  return typeof id === "string" ? id : null;
}

export function customerForegroundPushBehavior(data: unknown, foregroundUserId: string | null, platform: string, androidApiLevel: number | string, channelId: string | null, channel: CustomerPushChannel | null, importance: CustomerPushImportance) {
  const target = parseCustomerPushTarget(data), visible = Boolean(target && target.recipientUserId === foregroundUserId);
  // Expo57 uses this flag to allow Android heads-up presentation as well as
  // audio. On Android8+ audio/vibration are controlled by the native channel.
  // Allow it only after checking the exact incoming channel is still silent;
  // old Android, changed/unknown channels and all iOS alerts stay sound=false.
  const silentAndroidBanner = visible && platform === "android" && Number(androidApiLevel) >= 26
    && isCustomerQuietPushChannel(channelId) && channel?.id === channelId
    && customerPushChannelAttention(channel, importance) === null && channel.importance >= importance.HIGH;
  return { shouldShowBanner: visible, shouldShowList: visible, shouldPlaySound: silentAndroidBanner, shouldSetBadge: false };
}
