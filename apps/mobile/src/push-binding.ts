export type PushDeviceRegistration = { installationId: string; expoPushToken: string; platform: "ios" | "android"; projectId: string; soundEnabled: boolean };
export type PushDeviceResult = { registered: true; installationId: string; expiresAt: string; pushEnabled: boolean };

// Serialize registration and revocation so signing out cannot be followed by a
// delayed device registration from the session that just signed out.
export function createPushDeviceBinding(
  register: (session: string, device: PushDeviceRegistration) => Promise<PushDeviceResult>,
  revoke: (session: string, installationId: string) => Promise<unknown>
) {
  let activeSession: string | null = null;
  let pending: Promise<unknown> = Promise.resolve();
  function enqueue<T>(operation: () => Promise<T>) {
    const next = pending.catch(() => undefined).then(operation); pending = next; return next;
  }
  return {
    activate(session: string) { activeSession = session; },
    bind(session: string, device: PushDeviceRegistration) {
      return enqueue(async () => {
        if (activeSession !== session) return null;
        const result = await register(session, device);
        if (activeSession !== session) { await revoke(session, device.installationId); return null; }
        return result;
      });
    },
    unbind(session: string, installationId: string) {
      if (activeSession === session) activeSession = null;
      return enqueue(() => revoke(session, installationId));
    }
  };
}
