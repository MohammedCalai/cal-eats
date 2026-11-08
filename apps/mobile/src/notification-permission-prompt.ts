type PhoneNotifications = { status: string; needsBannerSetup?: boolean };

export function notificationPermissionPrompt(state: PhoneNotifications) {
  if (state.status === "blocked") return { action: "settings", label: "Open notification settings", ready: false } as const;
  if (state.needsBannerSetup) return { action: "allow", label: "Allow notifications", ready: false } as const;
  if (state.status === "enabled") return { action: "done", label: "Continue", ready: true } as const;
  if (state.status === "permission_needed" || state.status === "error") return { action: "allow", label: "Allow notifications", ready: false } as const;
  return null;
}

export function showNotificationPermissionPrompt({ userId, loadedFor, acknowledged, blocked, state, requesting }: {
  userId: string | null; loadedFor: string | null; acknowledged: boolean; blocked: boolean;
  state: PhoneNotifications; requesting: boolean;
}) {
  return Boolean(userId && userId === loadedFor && !acknowledged && !blocked && (requesting || notificationPermissionPrompt(state)));
}
